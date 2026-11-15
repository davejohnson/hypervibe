import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CredentialTracking, CredentialVerification } from '../domain/spec/credential.schema.js';
import type { ObservedState } from '../domain/ports/observe.port.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { runtimeRolloutRequirements } from '../domain/services/runtime-rollout.service.js';
import { credentialRuntimeServices } from '../domain/services/credential-runtime-consumers.js';
import { classifyDeploymentStatus, runHttpCheck } from '../domain/services/health.service.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { compileEnvironmentTaskWorkflow } from '../domain/services/environment-task-workflow.service.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const applicationCredentialReceiptSchema = z.object({ version: z.literal(1), role: z.string(), operationId: z.string().uuid(), deploymentId: z.string().min(1),
  completedAt: z.string().datetime({ offset: true }), status: z.enum(['passed', 'failed']), counts: z.record(z.string(), z.number().int().nonnegative()) });
class OperationAssertionError extends Error {}
type Receipt = z.infer<typeof applicationCredentialReceiptSchema>;
type Deployment = { provider: string; projectId: string; environmentId?: string; serviceId: string; deploymentId: string; coverage: 'traffic' | 'instances'; url?: string };
export type CredentialOperationResult = { state: 'unknown' | 'failed' | 'verified'; reason: string; role: string; operationId?: string;
  checks?: Array<{ environment: string; service: string; kind: string; state: 'unknown' | 'failed' | 'verified'; deploymentId?: string; completedAt?: string; counts?: Record<string, number> }> };

/** Native observations bind application receipts to exact workloads; a homepage never supplies this evidence. */
export function observedCredentialDeployment(environment: Environment, provider: string, service: string, observed: ObservedState | null): Deployment {
  const bindings = parseHostingBindings(environment); const selected = bindings.services?.[service];
  const serviceId = selected?.serviceId ?? selected?.jobName;
  if (!serviceId || bindings.provider !== provider || !observed || observed.provider !== provider || observed.projectId !== bindings.projectId
    || bindings.environmentId && observed.environmentId !== bindings.environmentId || !observed.projectExists
    || observed.completeness?.serviceIdentities !== 'complete' && (observed.partial || observed.completeness?.services !== 'complete')) throw new Error();
  const matches = observed.services.filter(item => item.name === service && item.externalId === serviceId);
  if (matches.length !== 1) throw new Error();
  const current = matches[0]!; const deployment = current.deployment;
  if (!deployment?.id || !deployment.activeDeploymentCoverage || !deployment.activeDeploymentIds) throw new Error();
  const completedExecution = current.workloadKind === 'cron' && classifyDeploymentStatus(deployment.status ?? '') === 'healthy' && deployment.activeDeploymentIds.length === 0;
  if (!completedExecution && (current.status !== 'running' || deployment.activeDeploymentIds.length !== 1 || deployment.activeDeploymentIds[0] !== deployment.id)) throw new Error();
  let url: string | undefined;
  const candidate = current.url ?? selected?.url;
  if (candidate) {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    url = parsed.origin;
  }
  return { provider, projectId: bindings.projectId!, ...(bindings.environmentId ? { environmentId: bindings.environmentId } : {}), serviceId,
    deploymentId: deployment.id, coverage: deployment.activeDeploymentCoverage, ...(url ? { url } : {}) };
}

function descriptorFor(spec: ProjectSpec, role: string): CredentialTracking {
  const descriptors = Object.values(spec.secrets).flatMap(slot => slot.credential?.role === role ? [slot.credential] : []);
  if (!descriptors.length || descriptors.some(value => !isDeepStrictEqual(value, descriptors[0]))) throw new Error();
  return descriptors[0]!;
}
function checksFor(spec: ProjectSpec, descriptor: CredentialTracking, nativeConsumers: Array<{ environment: string; service: string; externalId: string }> = []): CredentialVerification[] {
  const checks = descriptor.verification ?? [];
  const coverage = new Set(checks.map(check => `${check.environment}/${check.service}`));
  const consumers = new Set((descriptor.containerPull ?? []).map(value => `${value.environment}/${value.service}`));
  for (const consumer of nativeConsumers) consumers.add(`${consumer.environment}/${consumer.service}`);
  if (descriptor.kind === 'database-password' && !nativeConsumers.length) throw new Error();
  for (const [key, slot] of Object.entries(spec.secrets)) if (slot.credential?.role === descriptor.role) for (const environment of slot.environments)
    for (const service of credentialRuntimeServices(spec, environment, key, descriptor)) consumers.add(`${environment}/${service}`);
  if (!checks.length || [...consumers].some(consumer => !coverage.has(consumer))) throw new Error();
  for (const check of checks) {
    if (!spec.environments[check.environment]?.services[check.service]) throw new Error();
    if (check.kind === 'environment-task') {
      const task = spec.github?.actions[check.task];
      if (task?.kind !== 'environment-task' || !task.enabled || task.environment !== check.environment || task.service !== check.service
        || task.inputs[check.operationIdInput]?.type !== 'string' || !task.receiptPrefix
        || Object.keys(check.requiredCounts).some(key => !task.receiptCountKeys.includes(key))) throw new Error();
    }
  }
  return checks;
}
function acceptedOperation(ctx: CommandContext, project: Project, descriptor: CredentialTracking) {
  const environments = ctx.repos.environments.findByProjectId(project.id);
  const histories = environments.map(environment => record(record(environment.platformBindings.credentialUpdates)[descriptor.role])).filter(value => value.planId);
  if (!histories.length || histories.some(value => value.state !== 'accepted' || !z.string().uuid().safeParse(value.planId).success || typeof value.acceptedAt !== 'string')) throw new Error();
  const operationIds = [...new Set(histories.map(value => String(value.planId)))];
  if (operationIds.length !== 1) throw new Error();
  const withoutChecks = (value: unknown) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => key !== 'verification'));
  if (histories.some(value => !isDeepStrictEqual(withoutChecks(value.descriptor), withoutChecks(descriptor)))) throw new Error();
  const acceptedAt = Math.max(...histories.map(value => Date.parse(String(value.acceptedAt))));
  if (!Number.isFinite(acceptedAt)) throw new Error();
  const nativeConsumers: Array<{ environment: string; service: string; externalId: string }> = [];
  if (descriptor.kind === 'database-password') for (const environment of environments) {
    const history = record(record(environment.platformBindings.credentialUpdates)[descriptor.role]);
    const native = record(history.nativeDatabase);
    if (!history.planId) continue;
    if (!Array.isArray(native.consumers) || !native.consumers.length || record(native.target).environmentId !== environment.id) throw new Error();
    const bindings = parseHostingBindings(environment);
    for (const value of native.consumers) {
      const consumer = record(value);
      if (typeof consumer.service !== 'string' || typeof consumer.externalId !== 'string' || bindings.services?.[consumer.service]?.serviceId !== consumer.externalId) throw new Error();
      nativeConsumers.push({ environment: environment.name, service: consumer.service, externalId: consumer.externalId });
    }
  }
  return { operationId: operationIds[0]!, acceptedAt, nativeConsumers };
}
async function deploymentFor(ctx: CommandContext, project: Project, spec: ProjectSpec, check: CredentialVerification, observations?: Record<string, ObservedState | null>) {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, check.environment);
  if (!environment) throw new Error();
  const desired = spec.environments[check.environment]!;
  const observed = observations && Object.hasOwn(observations, check.environment) ? observations[check.environment]!
    : (await new PlanService().observeEnvironment(project, environment, desired, { hostingOnly: true })).observed;
  if (runtimeRolloutRequirements({ environment, provider: desired.hosting.provider, observed }).some(item => item.service === check.service)) throw new Error();
  return { environment, observed, deployment: observedCredentialDeployment(environment, desired.hosting.provider, check.service, observed) };
}
function validateReceipt(value: unknown, descriptor: CredentialTracking, check: CredentialVerification, accepted: { operationId: string; acceptedAt: number }, deployment: Deployment): Receipt {
  const receipt = applicationCredentialReceiptSchema.parse(value); const completedAt = Date.parse(receipt.completedAt); const now = Date.now();
  if (receipt.role !== descriptor.role || receipt.operationId !== accepted.operationId || receipt.deploymentId !== deployment.deploymentId
    || completedAt < accepted.acceptedAt || completedAt > now + 30000 || now - completedAt > check.maxAgeSeconds * 1000) throw new Error();
  if (receipt.status === 'failed' || Object.entries(check.requiredCounts).some(([key, minimum]) => (receipt.counts[key] ?? -1) < minimum)) throw new OperationAssertionError();
  return { ...receipt, counts: Object.fromEntries(Object.keys(check.requiredCounts).map(key => [key, receipt.counts[key]!])) };
}
async function readTaskReceipt(spec: ProjectSpec, check: Extract<CredentialVerification, { kind: 'environment-task' }>) {
  const repository = spec.github?.repository; const task = spec.github?.actions[check.task];
  if (!repository || task?.kind !== 'environment-task') throw new Error();
  const result = getGitHubAdapter(repository); if ('error' in result) throw new Error();
  const github = result.adapter; const [owner, repo] = repository.split('/');
  const workflow = `.github/workflows/hypervibe-${check.task}.yml`;
  const listing = await github.listWorkflowRuns(owner!, repo!, workflow, { per_page: 1 }); const latest = listing.workflow_runs[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error();
  const run = await github.getWorkflowRun(owner!, repo!, latest.id);
  if (run.id !== latest.id || run.path !== workflow || run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'workflow_dispatch' || run.run_attempt !== 1 || run.repository.full_name !== repository
    || run.head_repository.full_name !== repository || run.head_branch !== spec.environments[check.environment]?.deploy?.branch) throw new Error();
  if (await github.getFileContent(owner!, repo!, workflow, run.head_sha) !== compileEnvironmentTaskWorkflow(check.task, task)) throw new Error();
  const listingArtifacts = await github.listWorkflowRunArtifacts(owner!, repo!, run.id);
  const candidates = listingArtifacts.artifacts.filter(artifact => artifact.name === `hypervibe-task-receipt-${run.id}-${run.run_attempt}` && !artifact.expired);
  if (listingArtifacts.total_count !== listingArtifacts.artifacts.length || candidates.length !== 1 || candidates[0]!.workflow_run?.id !== run.id || candidates[0]!.workflow_run?.head_sha !== run.head_sha) throw new Error();
  const artifact = record(await github.readJsonArtifact(owner!, repo!, candidates[0]!.id, 'hypervibe-task-receipt.json'));
  if (artifact.status !== 'completed' || artifact.task !== check.task || artifact.environment !== check.environment || artifact.executionId !== String(run.id)
    || !Array.isArray(artifact.credentialOperations)) throw new Error();
  return artifact.credentialOperations;
}

/** hv_health reads application-authored receipts; it never starts a business operation or task. */
export async function verifyCredentialOperations(ctx: CommandContext, project: Project, spec: ProjectSpec, role: string, timeoutMs = 20000): Promise<CredentialOperationResult> {
  let descriptor: CredentialTracking; let checks: CredentialVerification[]; let accepted: ReturnType<typeof acceptedOperation>;
  try { descriptor = descriptorFor(spec, role); accepted = acceptedOperation(ctx, project, descriptor); checks = checksFor(spec, descriptor, accepted.nativeConsumers); }
  catch { return { role, state: 'unknown', reason: 'Declare operation checks for every runtime consumer and complete acceptance of this exact credential update before verifying application receipts.' }; }
  const results: NonNullable<CredentialOperationResult['checks']> = [];
  for (const check of checks) {
    const result: NonNullable<CredentialOperationResult['checks']>[number] = { environment: check.environment, service: check.service, kind: check.kind, state: 'unknown' };
    let inspectedDeployment: Deployment | undefined;
    let receiptDeployment: Deployment | undefined;
    try {
      const before = await deploymentFor(ctx, project, spec, check);
      inspectedDeployment = before.deployment;
      result.deploymentId = before.deployment.deploymentId;
      let value: unknown;
      if (check.kind === 'http-receipt') {
        const receiptService = check.receiptService ?? check.service;
        const originDeployment = receiptService === check.service ? before.deployment
          : observedCredentialDeployment(before.environment, before.deployment.provider, receiptService, before.observed);
        receiptDeployment = originDeployment;
        const bound = parseHostingBindings(before.environment).services?.[receiptService]?.url;
        if (!bound || !originDeployment.url) throw new Error();
        const origin = new URL(bound); const observedUrl = new URL(originDeployment.url);
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== observedUrl.origin) throw new Error();
        const response = await runHttpCheck({ name: 'credential-operation-receipt', url: new URL(check.path, origin.origin).toString(), method: 'GET', timeoutMs,
          followRedirects: false, expectedStatusMin: 200, expectedStatusMax: 200, bodyPreviewBytes: 0, maxResponseBytes: 16384,
          headers: { 'X-Hypervibe-Credential-Operation': accepted.operationId, 'Cache-Control': 'no-cache' } });
        if (!response.ok || response.redirected) throw new Error(); value = response.json;
      } else {
        const values = await readTaskReceipt(spec, check);
        const matching = values.filter(value => record(value).role === role && record(value).operationId === accepted.operationId);
        if (matching.length !== 1) throw new Error(); value = matching[0];
      }
      const receipt = validateReceipt(value, descriptor, check, accepted, before.deployment);
      const after = await deploymentFor(ctx, project, spec, check);
      if (!isDeepStrictEqual(before.deployment, after.deployment)) throw new Error();
      if (check.kind === 'http-receipt' && receiptDeployment && !isDeepStrictEqual(receiptDeployment, check.receiptService
        ? observedCredentialDeployment(after.environment, after.deployment.provider, check.receiptService, after.observed) : after.deployment)) throw new Error();
      ctx.repos.audit.create({ action: 'credential.operation.verified', resourceType: 'credential-role', resourceId: `${project.id}/${role}`,
        details: { operationId: accepted.operationId, check, deployment: before.deployment, receipt } });
      Object.assign(result, { state: 'verified', deploymentId: receipt.deploymentId, completedAt: receipt.completedAt, counts: receipt.counts });
    } catch (error) {
      result.state = error instanceof OperationAssertionError ? 'failed' : 'unknown';
      if (result.state === 'failed') ctx.repos.audit.create({ action: 'credential.operation.failed', resourceType: 'credential-role', resourceId: `${project.id}/${role}`,
        details: { operationId: accepted.operationId, check, deployment: inspectedDeployment } });
    }
    results.push(result);
  }
  return { role, operationId: accepted.operationId, state: results.every(result => result.state === 'verified') ? 'verified' : results.some(result => result.state === 'failed') ? 'failed' : 'unknown', checks: results,
    reason: results.every(result => result.state === 'verified') ? 'Declared application counts passed for this accepted operation and the exact current deployments. Credential authentication, traffic coverage and old-instance retirement remain separate evidence.'
      : 'One or more application receipts, deployment identities, activation requirements or declared counts remain unverified. Run the separately approved application check, then read its receipt again.' };
}

/** Inventory reads retained evidence and native observations only. No app request, task, validation or persistence. */
export async function credentialOperationEvidence(ctx: CommandContext, project: Project, spec: ProjectSpec, role: string, observations?: Record<string, ObservedState | null>): Promise<CredentialOperationResult> {
  try {
    const descriptor = descriptorFor(spec, role); const accepted = acceptedOperation(ctx, project, descriptor); const checks = checksFor(spec, descriptor, accepted.nativeConsumers);
    const events = ctx.repos.audit.findByResource('credential-role', `${project.id}/${role}`, 100).filter(event => ['credential.operation.verified', 'credential.operation.failed'].includes(event.action))
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime() || Number(right.action === 'credential.operation.failed') - Number(left.action === 'credential.operation.failed'));
    const results: NonNullable<CredentialOperationResult['checks']> = [];
    for (const check of checks) {
      const current = await deploymentFor(ctx, project, spec, check, observations);
      const event = events.find(value => value.details.operationId === accepted.operationId && isDeepStrictEqual(value.details.check, check)
        && isDeepStrictEqual(value.details.deployment, current.deployment));
      if (!event) throw new Error();
      if (event.action === 'credential.operation.failed') throw new OperationAssertionError();
      const receipt = validateReceipt(event.details.receipt, descriptor, check, accepted, current.deployment);
      results.push({ environment: check.environment, service: check.service, kind: check.kind, state: 'verified', deploymentId: receipt.deploymentId, completedAt: receipt.completedAt, counts: receipt.counts });
    }
    return { role, state: 'verified', operationId: accepted.operationId, checks: results, reason: 'Every declared runtime consumer has a current matching application-operation receipt for the accepted credential update.' };
  } catch (error) { return { role, state: error instanceof OperationAssertionError ? 'failed' : 'unknown', reason: 'No complete, current successful application-operation coverage matches the accepted credential and native deployment identities. Use hv_health credential=<role> to read declared receipts.' }; }
}
