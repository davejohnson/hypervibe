import { engineBucketName } from '../domain/services/resource-names.js';
import { gcpDatabaseLocation, gcpDatabaseOnSharedServer, gcpDatabasePlanBlocker, type GcpDatabaseBinding } from '../domain/services/gcp-database-location.js';
import { pubsubQueueResourceIds } from '../domain/services/queue-env.js';
import { buildGcpPreparationConfiguration } from '../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { buildGcpObservationDashboard, type GcpMetricTarget } from '../adapters/providers/gcp/tofu/gcp-observer-dashboard.config.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { isDeepStrictEqual } from 'node:util';
import { readGcpProject } from '../adapters/providers/gcp/gcp-data.client.js';
import { buildGcpObserverConfiguration, disableGcpObserverConfiguration, googleObserverBinding, observerKey, retainObserverRemovals, type GoogleObserver } from '../adapters/providers/gcp/tofu/gcp-observer.config.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { getGcpProjectSetupContribution, runGcpProjectSetup } from '../domain/services/gcp-project-setup.service.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { runtimeObservationIntent, runtimeObserverSchema } from '../domain/spec/runtime-observation.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { CommandContext } from './context.js';
import type { LaunchResult } from './launch.js';

interface Setup { project: Project; spec: ProjectSpec; environmentName: string; approveAccess?: string[]; browserAccess?: string; gcpSetupPlanId?: string }

function appliedGcpMetricTargets(env: EnvironmentSpec, name: string, scope: Record<string, unknown>, project: string, region: string, environmentId: string) {
  const engine = scope.engine as (GcpDatabaseBinding & { cache?: { instanceName?: string }; storage?: string[]; queues?: string[] }) | undefined;
  const targets: GcpMetricTarget[] = [];
  const need = (native: string | undefined, field: string) => {
    if (!native || !/^[a-zA-Z0-9_.-]+$/.test(native)) throw new Error('Apply the native identity for ' + field + ' before planning its monitoring.');
    return native;
  };
  if (env.database) {
    const db = gcpDatabaseLocation(project, engine);
    if (!db) throw new Error('Apply the Cloud SQL database before planning its monitoring.');
    const blocked = gcpDatabasePlanBlocker(project, engine, environmentId);
    if (blocked) throw new Error(blocked);
    targets.push({ kind: 'database', name: 'postgres', native: need(db.instanceName, 'Cloud SQL'), region: db.region ?? region,
      ...(gcpDatabaseOnSharedServer(engine) && { tenantDatabase: need(db.databaseName, 'the shared PostgreSQL database') }) });
  }
  if (env.cache) targets.push({ kind: 'cache', name: 'redis', native: need(engine?.cache?.instanceName, 'Memorystore Redis'), region });
  for (const bucket of Object.keys(env.storage ?? {}).sort()) {
    const native = engine?.storage?.includes(bucket) ? engineBucketName(project, name, bucket) : undefined;
    targets.push({ kind: 'storage', name: bucket, native: need(native, 'Cloud Storage ' + bucket), region });
  }
  for (const queue of Object.keys(env.queues ?? {}).sort()) {
    const id = engine?.queues?.includes(queue) ? pubsubQueueResourceIds({ name, platformBindings: { projectId: project } }, queue, project).subscriptionId : undefined;
    targets.push({ kind: 'queue', name: queue, native: need(id, 'Pub/Sub ' + queue), region });
  }
  return targets;
}

export function gcpObserverNeedsRevocation(projectId: string, name: string, scope?: Record<string, unknown>) {
  if (scope?.runtimeObserver || scope?.runtimeObserverSetupPending) return true;
  const target = scope?.projectId;
  if (typeof target !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target)) return false;
  const key = observerKey(projectId, name);
  const saved = getGcpProjectSetupContribution(projectId, target, key);
  if (!saved) return false;
  const file = saved.files[key.replaceAll('_', '-') + '.tf.json'] as { resource?: { google_service_account?: Record<string, { disabled?: boolean }> } } | undefined;
  const dashboard = saved.files['observer-dashboard-' + key.replaceAll('_', '-') + '.tf.json'];
  return Boolean(dashboard || (file && file.resource?.google_service_account?.[key]?.disabled !== true) || scope?.runtimeObserver !== null);
}

type SetupReview = Extract<LaunchResult, { status: 'needs_access' | 'blocked' }>;
export async function ensureGcpRuntimeObserver(ctx: CommandContext, params: Setup): Promise<SetupReview | undefined> {
  const { project, spec, environmentName } = params;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
  const env = spec.environments[environmentName]!;
  const collector = Boolean(env.runtimeObservation && Object.keys(env.services).length);
  const intent = collector ? runtimeObservationIntent(spec, environmentName) : undefined;
  const scope = environment?.platformBindings;
  const disappeared = params.gcpSetupPlanId ? { status: 'blocked' as const, message: 'The saved monitoring target changed. Run hv_plan again.' } : undefined;
  const hasNativeTargets = env.database || env.cache || Object.keys(env.storage ?? {}).length || Object.keys(env.queues ?? {}).length;
  if ((!env.runtimeObservation || !collector && !hasNativeTargets) && !scope?.projectId && !scope?.runtimeObserver && !scope?.runtimeObserverSetupPending) return disappeared;
  const gcpProject = scope?.projectId;
  if (!environment || !scope || typeof gcpProject !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProject)
    || scope.provider !== 'cloudrun' || (env.hosting.gcpProjectId && env.hosting.gcpProjectId !== gcpProject)) {
    if (!env.runtimeObservation && !scope?.runtimeObserver) return disappeared;
    return { status: 'blocked', message: 'The observer needs the applied Google Cloud project and workload bindings. Review and apply the environment infrastructure first.' };
  }
  const key = observerKey(project.id, environmentName);
  const previous = getGcpProjectSetupContribution(project.id, gcpProject, key);
  if (!env.runtimeObservation && !previous) {
    if (scope.runtimeObserver) return { status: 'blocked', message: 'The observer binding has no matching Google setup record. Restore the project setup state before removing access.' };
    return disappeared;
  }
  let config;
  let binding: GoogleObserver | null = null;
  let access: string[];
  let admin: string | undefined;
  const region = scope.environmentId;
  if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region) || (env.hosting.region && env.hosting.region !== region)) throw new Error('The observer region does not match the applied Google environment.');
  const targets = env.runtimeObservation ? appliedGcpMetricTargets(env, environmentName, scope, gcpProject, region, environment.id) : [];
  if (intent) {
    const resources = scope.services as Record<string, { serviceId?: string; workerPoolName?: string; jobName?: string }> | undefined;
    const services: GoogleObserver['services'] = {};
    for (const [name, service] of Object.entries(env.services)) {
      const kind = service.workloadKind ?? 'web';
      const native = resources?.[name];
      const collection = kind === 'cron' ? 'jobs' : kind === 'worker' ? 'workerPools' : 'services';
      const short = kind === 'cron' ? native?.jobName : kind === 'worker' ? native?.workerPoolName : native?.serviceId;
      if (!short || !/^[a-z][a-z0-9-]{0,62}$/.test(short)) throw new Error('The runtime observer requires an applied Cloud Run workload identity for ' + name + '.');
      services[name] = { workloadKind: kind, region, serviceId: `projects/${gcpProject}/locations/${region}/${collection}/${short}` };
    }
    const github = getGitHubAdapter(intent.repository);
    if ('error' in github) throw new Error(github.error);
    const [owner, repo] = intent.repository.split('/');
    const repository = await github.adapter.getRepository(owner!, repo!);
    if (repository.full_name !== intent.repository || !Number.isSafeInteger(repository.id) || repository.id! <= 0 || repository.default_branch !== intent.branch) {
      throw new Error('GitHub must verify the observer’s repository ID, exact repository name and current default branch before access is granted.');
    }
    admin = await getDefaultAdminAccessToken();
    const response = await readGcpProject(admin, gcpProject);
    const target = response.ok && await response.json() as { name?: string; projectId?: string; state?: string };
    if (!target || target.projectId !== gcpProject || target.state !== 'ACTIVE' || !/^projects\/[1-9]\d*$/.test(target.name ?? '')) throw new Error('Google could not verify the exact active project for the observer.');
    binding = googleObserverBinding({ key, project: gcpProject, number: target.name!.slice(9), intent, environmentId: environment.id, services });
    runtimeObserverSchema.parse(binding);
    config = buildGcpObserverConfiguration(binding, key, String(repository.id), targets);
    access = [
      `Only ${intent.repository}/.github/workflows/hypervibe-observe-${environmentName}.yml on refs/heads/${intent.branch} in GitHub repository ${repository.id} can mint ${binding.gcp.serviceAccount}, on a hosted first-attempt schedule or manual run.`,
      `Grant logging.logEntries.list across ${gcpProject}. Google grants this read at project scope. The collector queries only the bound workloads and can read non-private project logs.`,
      ...Object.values(services).filter(s => s.workloadKind === 'cron').map(s => 'Grant run.executions.list on ' + s.serviceId + '.'),
      `Create the native monitoring dashboard and alert policies. The collector runs every ${env.runtimeObservation?.intervalMinutes ?? 5} minutes on GitHub-hosted runners. Provider monitoring operations may incur charges.`,
      ...(env.runtimeObservation?.hostedReview ? ['Send redacted findings and terminal job results to the hosted daily review for this repository and environment.'] : []),
    ];
  } else if (env.runtimeObservation && targets.length) {
    const base = previous ? disableGcpObserverConfiguration(previous, key) : buildGcpPreparationConfiguration({
      gcpProjectId: gcpProject, deployServiceAccountEmail: '', enableApis: ['monitoring.googleapis.com'],
      grantRoles: [], runtimeGrantRoles: [], runtimeServiceAccountGrantRoles: [],
    });
    const dashboard = buildGcpObservationDashboard({ repository: project.name, environmentName, services: {}, gcp: { projectId: gcpProject } }, key, targets);
    config = { files: { ...base.files, ...dashboard.files }, resources: { ...base.resources, ...dashboard.resources } };
    access = ['Reconcile native Cloud Monitoring charts and alert policies. No GitHub collector is needed for this resource-only environment.',
      ...(scope.runtimeObserver ? ['Revoke all workload collector access, disable its identity and stop the generated workflow.'] : [])];
  } else {
    if (!previous) return disappeared;
    config = disableGcpObserverConfiguration(previous, key);
    access = ['Revoke impersonation and all observer log and execution grants. Disable the dedicated identity, pool and provider. Remove the observer dashboard and alert policies. Keep disabled identity names available for reactivation.'];
  }
  access.push(...targets.map(t => `Monitor ${t.kind} ${t.name} (${t.native}) in Google project ${gcpProject}.`));
  for (const t of targets) if (t.tenantDatabase) access.push('Monitor deadlocks for PostgreSQL database ' + t.tenantDatabase + ' on ' + t.native + '. Its server CPU is shared across tenants.');
  const allowDestroyAddresses = retainObserverRemovals(config, previous, key);
  if (!env.runtimeObservation && scope.runtimeObserver === null && !scope.runtimeObserverSetupPending && isDeepStrictEqual(config, previous)) return disappeared;
  const browser = params.browserAccess === 'runtime-observer' && Boolean(params.gcpSetupPlanId);
  const confirm = browser || Boolean(params.approveAccess?.includes('runtime-observer'));
  if (confirm && !params.gcpSetupPlanId) return { status: 'blocked', message: 'Confirm runtime monitoring with the gcpSetupPlanId from its saved access preview.' };
  const token = admin ?? await getDefaultAdminAccessToken();
  // The setup manifest is written before native apply. A failed reactivation must still be revocable even if the
  // last published binding was null. Record the in-flight operation without changing the exported identity.
  if (confirm && scope.runtimeObserver === null) ctx.repos.environments.updatePlatformBindings(environment.id, { runtimeObserverSetupPending: true });
  const result = await runGcpProjectSetup({ projectId: project.id, projectName: project.name, gcpProjectId: gcpProject,
    contribution: { id: key, configuration: config }, auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token }, redact: [token] },
    runtimeObservationAccess: access, allowDestroyAddresses, confirm,
    ...(confirm && { gcpSetupPlanId: params.gcpSetupPlanId, requireBrowserApproval: browser }) });
  if (!result.success) return { status: 'blocked', message: result.error ?? 'Google runtime observer setup did not complete.' };
  const applied = result.actions?.every(action => action.type === 'noop') && isDeepStrictEqual(previous, config) && !scope.runtimeObserverSetupPending && isDeepStrictEqual(scope.runtimeObserver, binding);
  if (!confirm && !applied) return {
    status: 'needs_access', accessId: 'runtime-observer', access: access.join(' '), grants: { gcpProjectId: gcpProject, access, planId: result.planId, htmlPath: result.htmlPath, actions: result.actions },
    confirmationHint: `Review the observer setup. Approve runtime-observer with gcpSetupPlanId ${result.planId}.`,
  };
  if (confirm) ctx.repos.environments.updatePlatformBindings(environment.id, { runtimeObserver: binding, runtimeObserverSetupPending: false });
  return;
}

/** Infrastructure settles first. Only the following saved plan can authorize the exact project-owner changes. */
export async function planGcpRuntimeObserver(ctx: CommandContext, params: Setup): Promise<PlanAction | { blocked: string[] } | undefined> {
  // An hv_launch caller may also carry a prior approval. A plan always previews and cannot forward it.
  const { project, spec, environmentName } = params;
  const review = await ensureGcpRuntimeObserver(ctx, { project, spec, environmentName });
  if (!review) return;
  if (review.status === 'blocked') return { blocked: [review.message] };
  const { planId, gcpProjectId, actions, htmlPath } = review.grants;
  if (typeof planId !== 'string' || typeof gcpProjectId !== 'string' || !Array.isArray(actions)) {
    return { blocked: ['The project monitoring review did not return a saved native plan. Run hv_plan again.'] };
  }
  const changes = (actions as PlanAction[]).filter(action => action.type !== 'noop');
  return { id: 'gcp-monitoring:' + planId, type: 'update', resource: { kind: 'environment', name: params.environmentName, provider: 'gcp' },
    reason: [review.access, ...changes.map(a => a.type + ' ' + a.resource.name + '.'),
      'Apply the saved Google project setup with administrator access. Operating native alert policies may incur charges.'].join(' '),
    verified: true, requiresConfirm: true, billable: changes.some(a => a.billable),
    metadata: { operation: 'gcpRuntimeObserverSetup', gcpProjectId, setupPlanId: planId, ...(htmlPath ? { htmlPath } : {}) } };
}

export async function applyGcpRuntimeObserver(ctx: CommandContext, params: Setup, action: PlanAction, confirmed: readonly string[]): Promise<ActionResult> {
  const id = action.metadata?.setupPlanId;
  if (typeof id !== 'string' || action.id !== 'gcp-monitoring:' + id || !confirmed.includes(action.id) || !action.requiresConfirm) {
    return { success: false, status: 'blocked', message: 'Approve the exact saved Google project monitoring action before applying it.' };
  }
  const result = await ensureGcpRuntimeObserver(ctx, { ...params, gcpSetupPlanId: id, approveAccess: ['runtime-observer'] });
  return result ? { success: false, status: 'blocked', message: result.status === 'blocked' ? result.message : result.access }
    : { success: true, message: 'Applied the reviewed Google project monitoring settings.' };
}
