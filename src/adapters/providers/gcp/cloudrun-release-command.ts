import { cloudRunExecutionBelongsToJob } from './cloudrun-resource-identity.js';
import { hashEnvValue } from '../../../domain/ports/observe.port.js';
import type { GcpPreparedApplicationConfiguration } from './gcp-prepared-release.js';

/** Versioned provider metadata key for the non-secret release-command digest. */
export const CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION = 'hypervibe.dev/release-command-sha256-v1';

/** Provider-resolved source commit that produced the deployed immutable image. */
export const CLOUD_RUN_SOURCE_COMMIT_ANNOTATION = 'hypervibe.dev/source-commit-sha-v1';

export function cloudRunReleaseCommandHash(command: string): string {
  return hashEnvValue(command.trim());
}

/** Deterministic Cloud Run Job id that remains collision-safe after the 63-character limit. */
export function cloudRunMigrationJobName(serviceName: string): string {
  const normalized = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new Error('Cloud Run migration jobs require a service name');

  const suffix = '-migration';
  if (`${normalized}${suffix}`.length <= 63) return `${normalized}${suffix}`;

  const hashSuffix = `-${hashEnvValue(normalized).slice(0, 10)}${suffix}`;
  const prefix = normalized
    .slice(0, 63 - hashSuffix.length)
    .replace(/-+$/g, '');
  return `${prefix}${hashSuffix}`;
}

type CloudRunReleaseJobShape = {
  name?: string;
  template?: {
    taskCount?: number;
    template?: {
      containers?: Array<Record<string, unknown>>;
      volumes?: Array<Record<string, unknown>>;
      serviceAccount?: string;
      serviceAccountName?: string;
      vpcAccess?: Record<string, unknown>;
      maxRetries?: number;
      timeout?: string;
    };
  };
};

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(comparable);
    return entries.every((entry) => (
      entry !== null
      && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).name === 'string'
    ))
      ? entries.sort((left, right) => (
          String((left as Record<string, unknown>).name)
            .localeCompare(String((right as Record<string, unknown>).name))
        ))
      : entries;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, comparable(entry)])
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function sameOptionalList(left: unknown, right: unknown): boolean {
  const normalizedLeft = Array.isArray(left) && left.length === 0 ? undefined : left;
  const normalizedRight = Array.isArray(right) && right.length === 0 ? undefined : right;
  return same(normalizedLeft, normalizedRight);
}

/**
 * Return the first release-job field that did not converge to the reviewed
 * candidate. Provider-populated output fields are ignored; every executable
 * input is compared before the job may run.
 */
export function cloudRunReleaseJobConfigurationMismatch(
  observedValue: unknown,
  expectedResourceName: string,
  expectedValue: unknown
): string | null {
  const observed = observedValue as CloudRunReleaseJobShape;
  const expectedSpec = expectedValue as CloudRunReleaseJobShape;
  if (observed.name !== expectedResourceName) return 'resource identity';
  if ((observed.template?.taskCount ?? 1) !== (expectedSpec.template?.taskCount ?? 1)) return 'task count';
  const actualTask = observed.template?.template;
  const expectedTask = expectedSpec.template?.template;
  if (!actualTask || !expectedTask) return 'task';
  if (actualTask.containers?.length !== 1 || expectedTask.containers?.length !== 1) {
    return 'task containers';
  }
  const actualContainer = actualTask.containers[0]!;
  const expectedContainer = expectedTask.containers[0]!;
  for (const field of ['workingDir', 'sourceCode', 'ports', 'livenessProbe', 'startupProbe', 'readinessProbe', 'dependsOn', 'baseImageUri', 'sandboxLauncher']) {
    const value = actualContainer[field];
    if (value !== undefined && value !== '' && value !== false && !(Array.isArray(value) && value.length === 0)) return `container ${field}`;
  }
  for (const field of ['image', 'command', 'args'] as const) {
    if (!same(actualContainer[field], expectedContainer[field])) return `container ${field}`;
  }
  for (const field of ['env', 'volumeMounts'] as const) {
    if (!sameOptionalList(actualContainer[field], expectedContainer[field])) return `container ${field}`;
  }
  const actualResources = actualContainer.resources as Record<string, unknown> | undefined;
  const expectedResources = expectedContainer.resources as Record<string, unknown> | undefined;
  if (actualResources?.cpuIdle !== undefined) return 'container resources.cpuIdle';
  if (!same(actualResources?.limits, expectedResources?.limits)) return 'container resource limits';
  if (!sameOptionalList(actualTask.volumes, expectedTask.volumes)) return 'task volumes';
  const actualServiceAccount = actualTask.serviceAccount ?? actualTask.serviceAccountName;
  const expectedServiceAccount = expectedTask.serviceAccount ?? expectedTask.serviceAccountName;
  if (actualServiceAccount !== expectedServiceAccount) return 'task serviceAccount';
  for (const field of ['vpcAccess', 'maxRetries', 'timeout'] as const) {
    if (!same(actualTask[field], expectedTask[field])) return `task ${field}`;
  }
  return null;
}

/** Executions are immutable snapshots, unlike the parent Job. Validate its
 * actual task, not a current job that another administrator could have changed.
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions
 */
export function cloudRunPreparedExecutionVerified(value: unknown, jobResource: string, expected: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const execution = value as Record<string, any>;
  return cloudRunExecutionBelongsToJob(execution, jobResource)
    && typeof execution.uid === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(execution.uid)
    && execution.reconciling !== true
    && typeof execution.completionTime === 'string' && Number.isFinite(Date.parse(execution.completionTime))
    && execution.taskCount === 1 && execution.succeededCount === 1
    && ['runningCount', 'failedCount', 'cancelledCount', 'retriedCount'].every(key => (execution[key] ?? 0) === 0)
    && Array.isArray(execution.conditions) && execution.conditions.filter((condition: any) => condition?.type === 'Completed').length === 1
    && execution.conditions.some((condition: any) => condition?.type === 'Completed' && condition.state === 'CONDITION_SUCCEEDED')
    && cloudRunReleaseJobConfigurationMismatch({ name: jobResource, template: { template: execution.template } }, jobResource, expected) === null;
}

/** Native v2 executions omit Cloud SQL mounts. Read the *same immutable*
 * execution through v1, whose documented annotation retains the attachment.
 * Never substitute the mutable parent Job's current settings for this proof.
 * https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.executions/get
 * https://docs.cloud.google.com/run/docs/reference/rpc/google.cloud.run.v1#executiontemplatespec
 */
export async function verifyCloudRunPreparedExecution(input: {
  execution: unknown; jobResource: string; jobUid: string; projectNumber: string;
  expected: unknown; token: string; request: typeof fetch;
}): Promise<boolean> {
  const { execution: value, jobResource, expected } = input;
  if (cloudRunPreparedExecutionVerified(value, jobResource, expected)) return true;
  if (!value || typeof value !== 'object') return false;
  const execution = value as Record<string, any>;
  if (!cloudRunExecutionBelongsToJob(execution, jobResource) || typeof execution.uid !== 'string'
    || !/^[1-9][0-9]*$/.test(input.projectNumber) || !input.jobUid) return false;
  const task = (expected as CloudRunReleaseJobShape)?.template?.template;
  const volumes = task?.volumes, mounts = task?.containers?.[0]?.volumeMounts;
  const instances = (volumes?.[0]?.cloudSqlInstance as { instances?: unknown })?.instances;
  if (!Array.isArray(instances) || !instances.length || instances.some(i => typeof i !== 'string')
    || !same(volumes, [{ name: 'cloudsql', cloudSqlInstance: { instances } }])
    || !same(mounts, [{ name: 'cloudsql', mountPath: '/cloudsql' }])
    || !sameOptionalList(execution.template?.volumes, undefined)
    || !Array.isArray(execution.template?.containers) || execution.template.containers.length !== 1
    || !sameOptionalList(execution.template.containers[0]?.volumeMounts, undefined)) return false;
  const [, projectId, region, jobId] = jobResource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/)!;
  const executionId = execution.name.split('/').at(-1);
  const response = await input.request(`https://${region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/executions/${executionId}`, {
    headers: { Authorization: `Bearer ${input.token}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return false;
  const v1 = await response.json() as Record<string, any>, metadata = v1?.metadata;
  const owners = metadata?.ownerReferences;
  const annotation = metadata?.annotations?.['run.googleapis.com/cloudsql-instances'];
  if (v1?.kind !== 'Execution' || v1.apiVersion !== 'run.googleapis.com/v1'
    || metadata?.name !== executionId || metadata.namespace !== input.projectNumber || metadata.uid !== execution.uid
    || !Array.isArray(owners) || owners.length !== 1 || owners[0]?.kind !== 'Job'
    || owners[0].name !== jobId || owners[0].uid !== input.jobUid || owners[0].controller !== true
    || typeof annotation !== 'string' || !same(annotation.split(',').sort(), [...instances].sort())) return false;
  return cloudRunPreparedExecutionVerified({ ...execution, template: { ...execution.template, volumes,
    containers: [{ ...execution.template.containers[0], volumeMounts: mounts }] } }, jobResource, expected);
}

export function cloudRunPreparedReleaseJobSpec(configuration: GcpPreparedApplicationConfiguration, image: string, command: string) {
  const container = configuration.template.containers[0]!;
  return { template: { template: { containers: [{ image, command: ['/bin/sh'], args: ['-lc', command], env: container.env,
    resources: { limits: container.resources.limits }, ...(container.volumeMounts ? { volumeMounts: container.volumeMounts } : {}) }],
    serviceAccount: configuration.template.serviceAccount, ...(configuration.template.volumes ? { volumes: configuration.template.volumes } : {}),
    maxRetries: 0, timeout: '3600s' } } };
}

/** Provider defaults are not an execution receipt. This bounded read proves only
 * that an exact job is ready and reports no prior execution; ownership adoption
 * needs its own reviewed metadata action, and jobs.run still needs release authority.
 * Job.executionCount, latestCreatedExecution and ExecutionTemplate.taskCount:
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs
 */
export function cloudRunUnexecutedReleaseJob(value: unknown, expectedName: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const job = value as Record<string, any>;
  return job.name === expectedName && typeof job.uid === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(job.uid)
    && typeof job.etag === 'string' && job.etag.length > 0 && job.etag.length <= 2048
    && job.generation === '1' && job.observedGeneration === '1' && (job.reconciling ?? false) === false
    && job.terminalCondition?.state === 'CONDITION_SUCCEEDED' && (job.executionCount ?? 0) === 0
    && (job.latestCreatedExecution === undefined || job.latestCreatedExecution !== null
      && typeof job.latestCreatedExecution === 'object' && !Array.isArray(job.latestCreatedExecution)
      && Object.keys(job.latestCreatedExecution).length === 0) && !job.startExecutionToken && !job.runExecutionToken && !job.deleteTime
    && (job.template?.taskCount ?? 1) === 1 && [0, 1].includes(job.template?.parallelism ?? 0);
}
