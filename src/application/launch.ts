import type { CommandContext } from './context.js';
import { collectOutsideKeys, engineOutsideKeys } from './engine-secrets.js';
import { isNetworkError } from '../utils/fetch-retry.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionReceipt } from '../domain/plan/converge.executor.js';
import { runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { cloudflareFor } from './infrastructure-engine-domain.js';
import { connectCloudflareInBrowser } from './local-connect-page.js';
import { grantCiReleaseAccess, previewCiReleaseAccess, renderReleaseWorkflow, writeReleaseWorkflow } from './infrastructure-engine-ci.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { generatedContainerDockerfile } from '../domain/services/generated-container.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import { isCloudPreparedForCache, isCloudPreparedForQueues, isCloudPreparedForStorage, isCloudPreparedForStorageS3, isCloudPreparedForWorkerWake } from '../domain/services/cloud-prepare.js';
import {
  applyInfrastructureEngine,
  isEngineManaged,
  planInfrastructureEngine,
  releaseEngineServices,
  resolveEngineContext,
  engineGcpAdapter,
  type EngineBinding,
  type EngineReleaseResult,
} from './infrastructure-engine.js';

/**
 * One guided path from a desired spec to a working app on an OpenTofu-managed
 * environment. It stops only where a person must decide: choosing a billing
 * account, and approving actions that cost money or delete data. Everything
 * else (connection setup, staged infrastructure rounds, release, health and
 * certificate checks) runs without further input.
 */
export type LaunchResult =
  | { status: 'needs_billing_choice'; gcpProjectId: string; openBillingAccounts: Array<{ name: string; displayName?: string }>; plannedSteps: string[]; includedAccess: string[] }
  | { status: 'needs_access'; accessId: 'storage' | 'storage-s3' | 'memorystore' | 'queues' | 'workers' | 'ci-release'; access: string; grants: Record<string, unknown> }
  | { status: 'needs_connection'; provider: string; url?: string; message: string }
  | { status: 'needs_confirmation'; confirmActions: string[]; changes: Array<{ id: string; change: string }>; estimatedMonthlyCost: CostLine[] }
  | { status: 'blocked'; message: string; details?: unknown }
  | { status: 'needs_secrets'; keys: string[]; url?: string; message: string }
  /** Returned only when a caller asked to stop after a phase (for example migration). */
  | { status: 'ready'; phase: 'prepare' | 'infrastructure'; infrastructureRounds: number }
  | { status: 'pending'; message: string; receipts: ActionReceipt[] }
  | { status: 'live'; urls: Record<string, string>; releases: EngineReleaseResult[]; domain?: { name: string; status: 'serving' | 'certificate_pending' }; infrastructureRounds: number;
      ciWorkflow?: { path: string; changed: boolean; branch: string } };

export interface CostLine { item: string; estimate: string }

/** Approximate list prices for the resources this path creates (us-central1). Never a quote. */
export function estimateMonthlyCost(environment: EnvironmentSpec): CostLine[] {
  const lines: CostLine[] = [];
  const services = Object.values(environment.services).filter((service) => service.workloadKind !== 'worker').length;
  if (services) lines.push({ item: `${services} Cloud Run service(s)`, estimate: '$0 while idle; roughly $0.40 per million requests plus CPU time while serving' });
  // Workers run one always-on instance (us-central1 instance pricing: ~$0.0000180/vCPU-s, ~$0.0000020/GiB-s).
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind !== 'worker') continue;
    const cpu = Number(service.cpu ?? '1');
    const memory = service.memory ?? '512Mi';
    const memoryGiB = memory.endsWith('Gi') ? parseInt(memory, 10) : parseInt(memory, 10) / 1024;
    const monthly = Math.round((cpu * 0.000018 + memoryGiB * 0.000002) * 2_628_000);
    if (service.onDemand) {
      // Workflows: ~43,200 checks a month at ~4 steps, $0.01 per 1,000 steps after 5,000 free.
      lines.push({ item: `Worker ${name} (on demand, ${cpu} vCPU, ${memory}; checks for work every minute)`, estimate: `about $2 per month for the checks, plus about $${(monthly / 730).toFixed(2)} per hour while working` });
      continue;
    }
    lines.push({ item: `Worker ${name} (always on, ${cpu} vCPU, ${memory})`, estimate: `about $${monthly} per month` });
  }
  if (environment.database) lines.push({ item: 'Cloud SQL Postgres (db-f1-micro, 10 GB, daily backups)', estimate: 'about $10–12 per month' });
  if (environment.cache) lines.push({ item: `Memorystore Redis (${environment.cache.tier ?? 'BASIC'}, ${environment.cache.size ?? '1gb'})`, estimate: environment.cache.tier === 'STANDARD_HA' ? 'about $90 per month' : 'about $35 per month' });
  const queues = Object.keys(environment.queues ?? {}).length;
  if (queues) lines.push({ item: `${queues} Pub/Sub queue(s)`, estimate: 'free up to 10 GB of messages per month, then about $40 per TB' });
  const buckets = Object.keys(environment.storage ?? {}).length;
  if (buckets) lines.push({ item: `${buckets} Cloud Storage bucket(s)`, estimate: 'about $0.02 per GB stored per month, plus small per-request charges' });
  lines.push({ item: 'Secret Manager, Artifact Registry, Cloud Build', estimate: 'usually under $1 per month for a small app' });
  if (environment.domain) lines.push({ item: `Custom domain ${environment.domain}`, estimate: '$0 (Google-managed certificate; DNS on your existing Cloudflare zone)' });
  return lines;
}

/**
 * What a person approves. Creating something is approved by its id; replacing,
 * deleting or adopting needs a token naming that kind of change, so approval to
 * create a database never authorizes replacing or deleting it later.
 */
export function approvalToken(action: PlanAction): string {
  if (action.type === 'replace' || action.type === 'destroy') return `${action.type}:${action.id}`;
  if (action.metadata?.engineAdopt === true) return `adopt:${action.id}`;
  if (action.metadata?.engineMajorUpgrade === true) return `upgrade:${action.id}`;
  return action.id;
}

function summarize(action: PlanAction): { id: string; change: string } {
  return { id: action.id, change: action.reason };
}

/** Add-on access the environment's resources need, in the order hv_launch grants it. */
export function neededResourceAccess(environment: EnvironmentSpec): Array<{ id: string; label: string }> {
  const needed: Array<{ id: string; label: string }> = [];
  if (Object.keys(environment.storage ?? {}).length) needed.push({ id: 'storage', label: 'create and manage the app\'s storage buckets' });
  if (Object.values(environment.storage ?? {}).some((storage) => storage.access === 's3')) needed.push({ id: 'storage-s3', label: 'create S3-style access keys for the app' });
  if (environment.cache) needed.push({ id: 'memorystore', label: 'create a private Redis cache' });
  if (Object.values(environment.services).some((service) => service.onDemand)) needed.push({ id: 'workers', label: 'start and stop background workers when they have work' });
  if (Object.keys(environment.queues ?? {}).length) needed.push({ id: 'queues', label: 'create Pub/Sub queues the app can use' });
  return needed;
}

export async function launchEnvironment(ctx: CommandContext, params: Parameters<typeof runLaunch>[1]): Promise<LaunchResult> {
  try {
    return await runLaunch(ctx, params);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    // Only reads are retried automatically; a dropped write is safe to repeat because every
    // run re-observes what exists and adopts or skips instead of duplicating.
    return { status: 'pending', message: 'The internet connection dropped while talking to Google or Cloudflare. Nothing was duplicated; run hv_launch again once the connection is stable.', receipts: [] };
  }
}

async function runLaunch(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  environmentName: string;
  billingAccountName?: string;
  confirmActions?: string[];
  /** Access ids from needs_access results the user approved (for example "storage", "ci-release"). */
  approveAccess?: string[];
  /** Stop after connecting and granting access, or after infrastructure, instead of releasing code. */
  stopAfter?: 'prepare' | 'infrastructure';
  revision?: string;
  sourceDirectory?: string;
}): Promise<LaunchResult> {
  const environmentSpec = params.spec.environments[params.environmentName];
  if (!environmentSpec) return { status: 'blocked', message: `The spec has no environment "${params.environmentName}".` };
  if (!isEngineManaged(environmentSpec)) {
    return { status: 'blocked', message: 'hv_launch runs environments managed by the OpenTofu engine. Set hosting.engine="opentofu" with hv_spec first.' };
  }

  // Extra Google Cloud access the app's resources need. A new project lists it with the billing
  // choice, so choosing the billing account approves it once instead of one prompt per resource.
  const resourceAccess = neededResourceAccess(environmentSpec);
  const approvedAccess = new Set<string>([...(params.approveAccess ?? []), ...(params.billingAccountName ? resourceAccess.map((entry) => entry.id) : [])]);

  // 1. Connect GCP, asking only for the billing account.
  // Only a connection scoped to this repository counts; global ones point at other projects.
  if (!await engineGcpAdapter(params.project)) {
    const preview = await runGcpBootstrap({ project: params.project });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'GCP setup preview failed.'), details: preview };
    const target = (preview as { target?: { projectId?: string } }).target?.projectId;
    const accounts = ((preview as { openBillingAccounts?: Array<{ name: string; displayName?: string }> }).openBillingAccounts ?? []);
    if (!target) return { status: 'blocked', message: 'GCP setup could not choose a project id.', details: preview };
    if (!params.billingAccountName) {
      if (accounts.length === 0) {
        return { status: 'blocked', message: 'Your Google login cannot see any open billing account. Open https://console.cloud.google.com/billing to create one or get access, then run hv_launch again.' };
      }
      return {
        status: 'needs_billing_choice', gcpProjectId: target, openBillingAccounts: accounts,
        plannedSteps: [...((preview as { plannedSteps?: string[] }).plannedSteps ?? []),
          ...(resourceAccess.length ? [`Grant the access the app's resources need: ${resourceAccess.map((entry) => entry.label).join('; ')}`] : [])],
        includedAccess: resourceAccess.map((entry) => entry.id),
      };
    }
    const confirmed = await runGcpBootstrap({ project: params.project, gcpProjectId: target, billingAccountName: params.billingAccountName, confirm: true });
    if (!confirmed.success) return { status: 'blocked', message: String(confirmed.error ?? 'GCP setup failed.'), details: confirmed };
  }

  // 1a. DNS access for a custom domain: open the one-step connect page instead of explaining tokens.
  const domainName = environmentSpec.domain?.trim().toLowerCase();
  if (domainName && 'error' in await cloudflareFor(domainName)) {
    const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
    const connected = await connectCloudflareInBrowser({ domain: domainName, waitMs: 3 * 60 * 1000, context: {
      project: params.project.name, ...(repository ? { repository } : {}), environment: params.environmentName,
      purpose: `serve the ${params.environmentName} environment at ${domainName}`,
    } });
    if (connected.status !== 'connected') {
      return { status: 'needs_connection', provider: 'cloudflare', ...(connected.url ? { url: connected.url } : {}), message: connected.message };
    }
  }

  // 1b. Extra access some resources need (bucket lifecycle), shown before it is granted.
  if (Object.keys(environmentSpec.storage ?? {}).length && !isCloudPreparedForStorage(ctx.repos.projects.findById(params.project.id) ?? params.project)) {
    const preview = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), gcsAccess: 'lifecycle' });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'The storage access preview failed.'), details: preview };
    if (!approvedAccess.has('storage')) {
      const plan = (preview as { plan?: Record<string, unknown> }).plan ?? {};
      return {
        status: 'needs_access',
        accessId: 'storage',
        access: 'Let Hypervibe create and manage Cloud Storage buckets in this project, and let the app read and write their files.',
        grants: { deploymentIdentity: plan.grantRoles, appRuntime: plan.runtimeGrantRoles },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), gcsAccess: 'lifecycle', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting storage access failed.'), details: granted };
  }

  if (Object.values(environmentSpec.storage ?? {}).some((storage) => storage.access === 's3')
    && !isCloudPreparedForStorageS3(ctx.repos.projects.findById(params.project.id) ?? params.project)) {
    const gcpProjectId = await scopedGcpProjectId(params.project);
    if (!approvedAccess.has('storage-s3')) {
      return {
        status: 'needs_access', accessId: 'storage-s3',
        access: 'Let Hypervibe create S3-style access keys for your app, so code written for S3 or Railway buckets works with Google Cloud Storage unchanged.',
        grants: { deploymentIdentity: ['roles/storage.hmacKeyAdmin'] },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId, gcsAccess: 's3', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting S3-compatible access failed.'), details: granted };
  }
  if (environmentSpec.cache && !isCloudPreparedForCache(ctx.repos.projects.findById(params.project.id) ?? params.project)) {
    const preview = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), memorystoreAccess: 'lifecycle' });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'The Redis access preview failed.'), details: preview };
    if (!approvedAccess.has('memorystore')) {
      const plan = (preview as { plan?: Record<string, unknown> }).plan ?? {};
      return {
        status: 'needs_access', accessId: 'memorystore',
        access: 'Let Hypervibe create a private Redis cache in this project and connect your app to it over the project network.',
        grants: { deploymentIdentity: plan.grantRoles, apis: plan.enableApis },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), memorystoreAccess: 'lifecycle', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting Redis access failed.'), details: granted };
  }

  if (Object.values(environmentSpec.services).some((service) => service.onDemand) && !isCloudPreparedForWorkerWake(ctx.repos.projects.findById(params.project.id) ?? params.project)) {
    const preview = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), workerAccess: 'lifecycle' });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'The on-demand worker access preview failed.'), details: preview };
    if (!approvedAccess.has('workers')) {
      const plan = (preview as { plan?: Record<string, unknown> }).plan ?? {};
      return {
        status: 'needs_access', accessId: 'workers',
        access: 'Let Hypervibe run background workers only while they have work: a small scheduled Google Workflow checks for pending work every minute and starts or stops the worker. Your app identity gets read-only access to the database for that check.',
        grants: { deploymentIdentity: plan.grantRoles, appRuntime: plan.runtimeGrantRoles, appRuntimeOnItself: plan.runtimeSelfGrantRoles, apis: plan.enableApis },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), workerAccess: 'lifecycle', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting on-demand worker access failed.'), details: granted };
  }

  if (Object.keys(environmentSpec.queues ?? {}).length && !isCloudPreparedForQueues(ctx.repos.projects.findById(params.project.id) ?? params.project, 'cloudrun')) {
    const preview = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), queueAccess: 'lifecycle' });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'The queue access preview failed.'), details: preview };
    if (!approvedAccess.has('queues')) {
      const plan = (preview as { plan?: Record<string, unknown> }).plan ?? {};
      return {
        status: 'needs_access', accessId: 'queues',
        access: 'Let Hypervibe create Pub/Sub queues in this project, and let your app send and receive their messages.',
        grants: { deploymentIdentity: plan.grantRoles, appRuntime: plan.runtimeGrantRoles },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcpProjectId: await scopedGcpProjectId(params.project), queueAccess: 'lifecycle', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting queue access failed.'), details: granted };
  }

  if (params.stopAfter === 'prepare') return { status: 'ready', phase: 'prepare', infrastructureRounds: 0 };

  // Keys only an outside service can issue: one local page for every missing one, before anything is built.
  {
    const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
    const imported = (environment?.platformBindings as { engine?: { importedSecrets?: string[] } } | undefined)?.engine?.importedSecrets;
    if (engineOutsideKeys(params.spec, params.environmentName, imported).length) {
      const collected = await collectOutsideKeys(ctx, { project: params.project, spec: params.spec, environmentName: params.environmentName,
        ...(imported ? { importedSecrets: imported } : {}), ...(params.sourceDirectory ? { sourceDirectory: params.sourceDirectory } : {}), purpose: `launch ${params.environmentName}` });
      if (collected.status === 'blocked') return collected;
      if (collected.status === 'needs_secrets') return collected;
    }
  }

  // 2. Infrastructure, in as many reviewed rounds as staging requires.
  const approved = new Set(params.confirmActions ?? []);
  let rounds = 0;
  let certificatePending = false;
  for (; rounds < 6; rounds++) {
    const planned = await planInfrastructureEngine(ctx, params);
    if ('blocked' in planned) return { status: 'blocked', message: planned.blocked.join('\n') };
    const pending = planned.actions.filter((action) => action.type !== 'noop');
    const onlyCertificate = pending.length > 0 && pending.every((action) => action.metadata?.operation === 'gcpDomainReady');
    if (pending.length === 0 || (onlyCertificate && certificatePending)) break;
    const tokens = planned.actions.filter((action) => planned.confirmActions.includes(action.id)).map(approvalToken);
    const missing = tokens.filter((token) => !approved.has(token));
    if (missing.length) {
      return {
        status: 'needs_confirmation',
        confirmActions: tokens,
        changes: pending.map(summarize),
        estimatedMonthlyCost: estimateMonthlyCost(environmentSpec),
      };
    }
    const applied = await applyInfrastructureEngine(ctx, {
      project: params.project, spec: params.spec, specRevision: params.specRevision,
      planId: planned.planRunId, confirmActions: planned.confirmActions,
    });
    if (applied.kind === 'blocked') return { status: 'blocked', message: applied.reason };
    const receipts = applied.result.receipts;
    const failed = receipts.find((receipt) => receipt.status === 'failed' || receipt.status === 'blocked');
    if (failed) return { status: 'blocked', message: failed.error ?? failed.message ?? `${failed.actionId} did not complete.`, details: receipts };
    const stillPending = receipts.filter((receipt) => receipt.status === 'pending');
    // A slow certificate must not hold back the app itself; anything else stops here.
    if (stillPending.some((receipt) => !receipt.actionId.startsWith('domain-ready:'))) {
      return { status: 'pending', message: 'Some changes are still settling. Run hv_launch again in a few minutes.', receipts };
    }
    certificatePending = stillPending.length > 0;
  }

  if (params.stopAfter === 'infrastructure') return { status: 'ready', phase: 'infrastructure', infrastructureRounds: rounds };

  // 3. Release the current code and verify it.
  const released = await releaseEngineServices(ctx, {
    project: params.project, spec: params.spec, specRevision: params.specRevision,
    environmentName: params.environmentName, ...(params.revision ? { revision: params.revision } : {}),
    ...(params.sourceDirectory ? { sourceDirectory: params.sourceDirectory } : {}),
  });
  if ('blocked' in released) return { status: 'blocked', message: released.blocked };
  const failedRelease = released.results.find((result) => result.status !== 'released');
  if (failedRelease) return { status: 'blocked', message: failedRelease.message, details: released.results };
  const urls: Record<string, string> = Object.fromEntries(released.results.filter((r) => r.url).map((r) => [r.service, r.url!]));

  // 4. Keyless CI releases on push, when the spec asks for branch deploys.
  let ciWorkflow: { path: string; changed: boolean; branch: string } | undefined;
  if (environmentSpec.deploy?.strategy === 'branch') {
    const ci = await ensureCiRelease(ctx, params, environmentSpec);
    if ('status' in ci) return ci;
    ciWorkflow = ci;
  }
  const domain = environmentSpec.domain?.trim().toLowerCase();
  if (domain && !certificatePending) urls.custom = `https://${domain}`;
  return {
    status: 'live',
    urls,
    releases: released.results,
    ...(domain ? { domain: { name: domain, status: certificatePending ? 'certificate_pending' as const : 'serving' as const } } : {}),
    infrastructureRounds: rounds,
    ...(ciWorkflow ? { ciWorkflow } : {}),
  };
}

/** The exact Google Cloud project of this repository's own connection, never a global one. */
async function scopedGcpProjectId(project: Project): Promise<string | undefined> {
  return (await engineGcpAdapter(project))?.engineConnection().projectId;
}

/** What the release workflow updates: every bound service, scheduled job and worker pool. */
export function ciReleaseTargets(environmentSpec: EnvironmentSpec, bindings: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> | undefined,
  target: { region: string; gcpProjectId: string; environmentName: string }) {
  return Object.entries(environmentSpec.services).flatMap(([name, service]) => {
    const bound = bindings?.[name];
    const resource = bound?.serviceId ?? bound?.jobName ?? bound?.workerPoolName;
    const kind = bound?.serviceId ? 'services' as const : bound?.jobName ? 'jobs' as const : 'workerPools' as const;
    return resource ? [{
      name, resource, kind, ...(kind === 'services' && service.workloadKind !== 'worker' ? { healthPath: service.healthCheckPath ?? '/' } : {}),
      image: `${target.region}-docker.pkg.dev/${target.gcpProjectId}/hypervibe/${target.environmentName}-${name}`.toLowerCase(),
    }] : [];
  });
}

async function ensureCiRelease(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], environmentSpec: EnvironmentSpec): Promise<{ path: string; changed: boolean; branch: string } | LaunchResult> {
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
  if (!repository) return { status: 'blocked', message: 'CI releases need this project on GitHub (set gitRemoteUrl with hv_spec).' };
  if (!params.sourceDirectory) return { status: 'blocked', message: 'CI releases need the local repository so Hypervibe can add the workflow file.' };
  const context = await resolveEngineContext(ctx, params.project, params.spec, params.environmentName);
  if ('blocked' in context) return { status: 'blocked', message: context.blocked };
  const environment = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  const binding = (environment.platformBindings as { engine?: EngineBinding; services?: Record<string, { serviceId?: string }> });
  let ci = binding.engine?.ci;
  if (ci?.repository !== repository) {
    if (!params.approveAccess?.includes('ci-release')) {
      return {
        status: 'needs_access',
        accessId: 'ci-release',
        access: `Let GitHub Actions in ${repository} release new versions of this app on every push, without storing any key in GitHub. It can only push images and update the running app.`,
        grants: previewCiReleaseAccess(context.gcpProjectId, repository, context.runtimeServiceAccountEmail) as unknown as Record<string, unknown>,
      };
    }
    try {
      const granted = await grantCiReleaseAccess({
        adminToken: await getDefaultAdminAccessToken(), gcpProjectId: context.gcpProjectId, repository,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
      });
      ci = { repository, provider: granted.provider, releaseIdentity: granted.releaseIdentity };
    } catch (error) {
      return { status: 'blocked', message: error instanceof Error ? error.message : String(error) };
    }
    ctx.repos.environments.updatePlatformBindings(environment.id, { engine: { ...(binding.engine ?? {}), kind: 'opentofu', ci } });
  }
  const runtime = params.spec.runtime as ProjectRuntime | undefined;
  // Each service gets its own generated Dockerfile, since web and workers start differently.
  const services = ciReleaseTargets(environmentSpec, binding.services, { region: context.region, gcpProjectId: context.gcpProjectId, environmentName: params.environmentName })
    .map((target) => {
      if (!runtime) return target;
      try { return { ...target, generatedDockerfile: generatedContainerDockerfile(runtime, environmentSpec.services[target.name]?.startCommand) }; } catch { return target; }
    });
  const branch = environmentSpec.deploy?.branch ?? 'main';
  const content = renderReleaseWorkflow({
    environmentName: params.environmentName, branch, gcpProjectId: context.gcpProjectId, region: context.region,
    provider: ci.provider, releaseIdentity: ci.releaseIdentity, services,
  });
  return { ...writeReleaseWorkflow(params.sourceDirectory, params.environmentName, content), branch };
}
