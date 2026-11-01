import { cloudRunExecutionBelongsToJob, cloudRunTaskBelongsToExecution } from './cloudrun-resource-identity.js';
import { createHash } from 'node:crypto';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { EnvironmentTaskOptions } from '../../../domain/ports/hosting.port.js';
import type { JobResult } from '../../../domain/ports/provider.port.js';
import { recoveryRuntimeExecutionTargetSchema, type RecoveryRuntimeTarget } from '../../../domain/ports/recovery-runtime.port.js';
import { recoverySourceIdentitySchema } from '../../../domain/services/recovery-source.js';
import { objectRecoveryIdentitySchema } from '../../../domain/services/object-recovery-set.service.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { GcpRuntimeError, gcpRuntimeRequest } from './gcp-runtime-client.js';
import { CloudRunRecoveryRuntime, type CloudRunRecoveryDependencies } from './cloudrun-recovery-runtime.js';
import type { RecoveryDiagnostic } from '../../../domain/ports/recovery-diagnostics.port.js';

const RUN = 'https://run.googleapis.com/v2/';
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GcpRuntimeError('Cloud Run recovery observation is incomplete.');
  return value as Record<string, any>;
};
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A single private helper execution. Setup belongs to recoveryRuntime actions. */
export async function runCloudRunRecoveryTask(input: {
  dependencies: CloudRunRecoveryDependencies;
  runtime: CloudRunRecoveryRuntime;
  environment: Environment;
  command: string;
  options: EnvironmentTaskOptions;
}): Promise<JobResult> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.min(input.options.timeoutMs ?? 45 * 60_000, 45 * 60_000);
  let stage: RecoveryDiagnostic['stage'] = 'task-preflight';
  let mutationAttempted = false;
  let ownedJob: { name: string; uid: string; labels: Record<string, string> } | undefined;
  let execution: Record<string, any> | undefined;
  let executionAttempted = false;
  let terminal = false;
  let succeeded = false;
  let cleanupVerified = true;
  let token: string | undefined;
  let failure: RecoveryDiagnostic | undefined;
  const { projectId, region } = input.dependencies.connection();
  const prefix = `projects/${projectId}/locations/${region}/`;
  const pause = () => new Promise(resolve => setTimeout(resolve, Math.max(1, input.options.pollIntervalMs ?? 2000)));
  const api = async (name: string, init: RequestInit = {}) => gcpRuntimeRequest(`${RUN}${name}`, token ?? await input.dependencies.token(), init, input.dependencies.request);
  async function operation(value: unknown, expected?: string, executionPrefix?: string): Promise<Record<string, any> | undefined> {
    let current = record(value);
    const name = current.name;
    if (!nonempty(name) || !name.startsWith(`${prefix}operations/`) || !/^[a-zA-Z0-9_-]+$/.test(name.slice(`${prefix}operations/`.length))) throw new GcpRuntimeError('Cloud Run recovery operation did not identify the exact project and region.');
    for (;;) {
      if (current.name !== name || current.error) throw new GcpRuntimeError('Cloud Run recovery operation failed or changed identity.');
      if (current.done === true) {
        if (!expected && !executionPrefix) return current.response ? record(current.response) : undefined;
        const response = record(current.response);
        if ((expected && response.name !== expected) || (executionPrefix && (!nonempty(response.name) || !response.name.startsWith(executionPrefix) || response.name.slice(executionPrefix.length).includes('/')))) throw new GcpRuntimeError('Cloud Run recovery operation returned another resource.');
        return response;
      }
      if (Date.now() >= deadline) throw new GcpRuntimeError('Cloud Run recovery operation remains pending.');
      await pause(); current = record(await api(name));
    }
  }
  function template(value: any) {
    if (!value || !Array.isArray(value.containers) || value.containers.length !== 1) throw new GcpRuntimeError('Cloud Run recovery task template is incomplete.');
    const container = value.containers[0];
    return { serviceAccount: value.serviceAccount, maxRetries: value.maxRetries ?? 0, timeout: value.timeout,
      vpcAccess: value.vpcAccess ?? null, volumes: value.volumes ?? [],
      container: { image: container.image, command: container.command, args: container.args, env: container.env,
        resources: container.resources, volumeMounts: container.volumeMounts ?? [] } };
  }
  try {
    const options = input.options.managedRecoveryTask;
    if (!options || input.options.declaredTask || input.command !== 'node /opt/hypervibe/dist/ci/backup-runner.js'
      || options.variableMode !== 'references' || options.sweep !== false
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.executionId)
      || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(options.expectedImage)
      || options.registryCredentials || Object.keys(options.selectedSecretValues ?? {}).length > 0
      || Object.keys(options.variables).length !== 1 || typeof options.variables.HYPERVIBE_BACKUP_CONFIG !== 'string') throw new GcpRuntimeError('Cloud Run recovery requires the reviewed immutable helper and native prepared credentials.');
    const prepared = recoveryRuntimeExecutionTargetSchema.parse(options.executionTarget);
    const config = record(JSON.parse(options.variables.HYPERVIBE_BACKUP_CONFIG));
    const source = recoverySourceIdentitySchema.parse(options.databaseSource);
    const destination = objectRecoveryIdentitySchema.parse(config.destination);
    if (prepared.environmentId !== input.environment.id || prepared.region !== region || prepared.provider !== 'cloudrun' || prepared.providerScope.projectId !== projectId || prepared.providerScope.region !== region
      || prepared.providerScope.environmentId !== input.environment.id || config.runId !== options.executionId
      || config.version !== 1 || config.operation !== 'recovery-set' || !same(config.database?.source, source)
      || !same(config.nativeAccess, prepared.worker) || config.archiveBucket !== destination.externalId
      || !Array.isArray(config.objects) || config.objects.length > 32
      || options.variableReferences.length !== 0) throw new GcpRuntimeError('Cloud Run recovery configuration differs from its prepared authority.');
    const objects = config.objects.map((object: any) => {
      const identity = objectRecoveryIdentitySchema.parse(object.identity);
      if (typeof object.name !== 'string' || object.bucket !== identity.externalId) throw new GcpRuntimeError('Cloud Run recovery object source differs.');
      return { name: object.name, identity };
    });
    const target: RecoveryRuntimeTarget = { environment: input.environment, database: source, destination, objects,
      runnerImage: options.expectedImage, privateInputFingerprints: { databaseUrl: prepared.configuration.credentialHash } };
    const secret = await input.runtime.verifyExecution(target, prepared);
    const vpcAccess = JSON.parse(prepared.configuration.vpcAccess);
    const jobId = `hv-recovery-${createHash('sha256').update(`${input.environment.id}:${options.executionId}`).digest('hex').slice(0, 32)}`;
    const name = `${prefix}jobs/${jobId}`;
    const labels = { 'hypervibe-recovery': options.executionId, 'hypervibe-environment': input.environment.id };
    const taskTemplate = { serviceAccount: prepared.identity.principal, maxRetries: 0, timeout: '2700s',
      ...(vpcAccess ? { vpcAccess } : {}), containers: [{ image: options.expectedImage, command: ['node'], args: ['/opt/hypervibe/dist/ci/backup-runner.js'],
        resources: { limits: { cpu: '2', memory: '4Gi' } }, env: [
          { name: 'HYPERVIBE_BACKUP_CONFIG', value: options.variables.HYPERVIBE_BACKUP_CONFIG },
          { name: 'HYPERVIBE_BACKUP_DATABASE_URL', valueSource: { secretKeyRef: secret } },
        ] }] };
    const body = { labels, template: { labels, taskCount: 1, parallelism: 1, template: taskTemplate } };
    token = await input.dependencies.token();
    if (await api(name) !== null) throw new GcpRuntimeError('This recovery execution already has a provider job; it will not be rerun or adopted.');
    stage = 'task-create'; mutationAttempted = true; cleanupVerified = false;
    const created = await operation(await api(`${prefix}jobs?jobId=${jobId}`, { method: 'POST', body: JSON.stringify(body) }), name);
    if (!created || !nonempty(created.uid)) throw new GcpRuntimeError('Cloud Run recovery create returned no immutable identity.');
    ownedJob = { name, uid: created.uid, labels };
    const observed = record(await api(name));
    if (observed.name !== name || observed.uid !== created.uid || !same(observed.labels, labels)
      || !nonempty(observed.etag) || !nonempty(observed.generation) || observed.observedGeneration !== observed.generation || observed.reconciling === true || observed.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
      || observed.template?.taskCount !== 1 || observed.template?.parallelism !== 1
      || !same(template(observed.template?.template), template(taskTemplate))) throw new GcpRuntimeError('Cloud Run recovery job did not converge to its exact reviewed template.');
    await input.runtime.verifyExecution(target, prepared);
    stage = 'task-execution'; executionAttempted = true;
    execution = await operation(await api(`${name}:run`, { method: 'POST', body: JSON.stringify({ etag: observed.etag }) }), undefined, `${name}/executions/`);
    if (!execution || !nonempty(execution.uid)) throw new GcpRuntimeError('Cloud Run recovery execution has no immutable identity.');
    const executionName = execution.name, executionUid = execution.uid;
    for (;;) {
      execution = record(await api(executionName));
      if (execution.name !== executionName || execution.uid !== executionUid || !cloudRunExecutionBelongsToJob(execution, name)
        || !same(execution.labels, labels) || execution.taskCount !== 1 || !same(template(execution.template), template(taskTemplate))) throw new GcpRuntimeError('Cloud Run recovery execution identity or template changed.');
      const completed = Array.isArray(execution.conditions) ? execution.conditions.filter((condition: any) => condition.type === 'Completed') : [];
      if (completed.length !== 1) throw new GcpRuntimeError('Cloud Run recovery completion observation is incomplete.');
      if (nonempty(execution.completionTime) && execution.reconciling !== true && ['CONDITION_SUCCEEDED', 'CONDITION_FAILED'].includes(completed[0].state)) {
        terminal = true;
        if (completed[0].state !== 'CONDITION_SUCCEEDED' || execution.succeededCount !== 1 || (execution.failedCount ?? 0) !== 0
          || (execution.cancelledCount ?? 0) !== 0 || (execution.runningCount ?? 0) !== 0 || (execution.retriedCount ?? 0) !== 0) throw new GcpRuntimeError('Cloud Run recovery execution did not complete successfully once.');
        break;
      }
      if (Date.now() >= deadline) throw new GcpRuntimeError('Cloud Run recovery execution remains pending.');
      await pause();
    }
    const response = record(await api(`${executionName}/tasks?pageSize=2`));
    if (!Array.isArray(response.tasks) || response.tasks.length !== 1 || response.nextPageToken) throw new GcpRuntimeError('Cloud Run recovery task inventory is incomplete or ambiguous.');
    const task = record(response.tasks[0]);
    const attempt = record(task.lastAttemptResult); const status = record(attempt.status);
    // Native tasks can omit uid. Their full name under the exact UID-verified
    // execution is required; no task-level mutation uses a missing UID.
    if (!cloudRunTaskBelongsToExecution(task, executionName, name) || !nonempty(task.completionTime)
      || task.reconciling === true || (task.index ?? 0) !== 0 || (task.retried ?? 0) !== 0 || !same(template(task), template(taskTemplate))
      || (status.code ?? 0) !== 0 || (attempt.exitCode ?? 0) !== 0 || (attempt.termSignal ?? 0) !== 0
      || !Array.isArray(task.containers) || task.containers.length !== 1 || task.containers[0].image !== options.expectedImage) throw new GcpRuntimeError('Cloud Run recovery task did not report the exact successful helper exit.');
    succeeded = true;
  } catch {
    failure = { stage, category: stage === 'task-preflight' ? 'invalid-input' : 'unknown' };
  } finally {
    // A lost run response cannot authorize cancellation/deletion of an unknown
    // execution. Leave that exact job for owner-authorized reconciliation.
    if (ownedJob && (!executionAttempted || terminal)) {
      stage = 'task-cleanup';
      try {
        if (execution) {
          const observed = record(await api(execution.name));
          if (observed.name !== execution.name || observed.uid !== execution.uid || !cloudRunExecutionBelongsToJob(observed, ownedJob.name) || !nonempty(observed.etag)) throw new GcpRuntimeError('Recovery execution cleanup identity changed.');
          await operation(await api(`${execution.name}?etag=${encodeURIComponent(observed.etag)}`, { method: 'DELETE' }));
          if (await api(execution.name) !== null) throw new GcpRuntimeError('Recovery execution remains after deletion.');
        }
        const observed = record(await api(ownedJob.name));
        if (observed.uid !== ownedJob.uid || observed.name !== ownedJob.name || !same(observed.labels, ownedJob.labels) || !nonempty(observed.etag)) throw new GcpRuntimeError('Recovery job cleanup ownership changed.');
        await operation(await api(`${ownedJob.name}?etag=${encodeURIComponent(observed.etag)}`, { method: 'DELETE' }));
        if (await api(ownedJob.name) !== null) throw new GcpRuntimeError('Recovery job remains after deletion.');
        cleanupVerified = true;
      } catch { cleanupVerified = false; failure = { stage: 'task-cleanup', category: 'cleanup' }; }
    }
  }
  const success = succeeded && cleanupVerified;
  return {
    jobId: execution?.name ?? ownedJob?.name ?? '', status: success ? 'completed' : 'failed', runner: 'cloudrun-job', mutationAttempted,
    ...(succeeded ? { exitCode: 0 } : {}), durationMs: Date.now() - startedAt,
    ...(!success ? { diagnostic: { ...(failure ?? { stage: 'task-execution', category: 'unknown' }), task: { status: 'failed' as const, mutationAttempted, cleanupVerified } } } : {}),
    ...(!cleanupVerified ? { cleanupWarning: 'The exact temporary backup job or execution still requires reconciliation.' } : {}),
    receipt: { success, message: success ? 'Completed the native Cloud SQL and GCS recovery helper and verified temporary job cleanup.' : 'Native recovery execution or cleanup could not be verified; inspect its exact execution before retrying.',
      data: { cleanupVerified, applied: success ? 1 : mutationAttempted ? null : 0, skipped: mutationAttempted ? 0 : 1 } },
  };
}
