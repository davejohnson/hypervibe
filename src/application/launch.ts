import { firstProviderSpecValidationFailure } from '../domain/services/provider-spec-validation.js';
import type { CommandContext } from './context.js';
import { collectOutsideKeys } from './engine-secrets.js';
import { isNetworkError } from '../utils/fetch-retry.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { ConvergeExecutor, type ActionReceipt } from '../domain/plan/converge.executor.js';
import { runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { connectCloudflareInBrowser } from './local-connect-page.js';
import { resolveDnsConnection } from '../adapters/dns-observation/connections.js';
import { dnsZoneIdentity } from '../domain/services/dns-policy.service.js';
import { applyDnsPlan } from './dns-hosting.js';
import { grantCiReleaseAccess, previewCiReleaseAccess, renderReleaseWorkflow, writeReleaseWorkflow } from './infrastructure-engine-ci.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { connectAzure } from './azure-connect.js';
import { connectAws } from './aws-connect.js';
import { awsProfileFor, resolveAwsEngineContext } from './infrastructure-engine-aws.js';
import { azureProfileFor, resolveAzureConnection } from './infrastructure-engine-azure.js';
import { generatedContainerDockerfile } from '../domain/services/generated-container.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import { isCloudPreparedForRegion, isCloudPreparedForCache, isCloudPreparedForQueues, isCloudPreparedForStorage, isCloudPreparedForStorageS3, isCloudPreparedForWorkerWake } from '../domain/services/cloud-prepare.js';
import {
  applyInfrastructureEngine,
  ENGINE_PLAN_SCOPE,
  type InfrastructurePlanResult,
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
  | { status: 'needs_access'; accessId: LaunchAccessId; access: string; grants: Record<string, unknown> }
  | { status: 'needs_subscription'; subscriptions: Array<{ subscriptionId: string; displayName: string }>; message: string }
  | { status: 'needs_connection'; provider: string; url?: string; message: string }
  | { status: 'needs_confirmation'; planId: string; confirmActions: string[]; changes: Array<{ id: string; change: string }>; estimatedMonthlyCost: CostLine[] }
  | { status: 'blocked'; message: string; details?: unknown }
  | { status: 'needs_secrets'; keys: string[]; url?: string; message: string }
  /** Returned only when a caller asked to stop after a phase (for example migration). */
  | { status: 'ready'; phase: 'prepare' | 'infrastructure'; infrastructureRounds: number }
  | { status: 'pending'; message: string; receipts: ActionReceipt[]; planId?: string; confirmActions?: string[] }
  | { status: 'live'; urls: Record<string, string>; releases: EngineReleaseResult[]; domain?: { name: string; status: 'serving' | 'certificate_pending' }; infrastructureRounds: number;
      ciWorkflow?: { path: string; changed: boolean; branch: string } };

export const LAUNCH_ACCESS_IDS = ['gcp-setup', 'gcp-region', 'storage', 'storage-s3', 'memorystore', 'queues', 'workers', 'ci-release', 'azure-setup', 'aws-setup'] as const;
export type LaunchAccessId = typeof LAUNCH_ACCESS_IDS[number];

export interface CostLine { item: string; estimate: string }

/** Approximate list prices for an AWS testing environment (us-east-1). Never a quote. */
export function estimateAwsMonthlyCost(environment: EnvironmentSpec): CostLine[] {
  const lines: CostLine[] = [];
  const workloads = Object.values(environment.services);
  const web = workloads.filter((service) => (service.workloadKind ?? 'web') === 'web').length;
  if (web) lines.push({ item: `${web} web service(s) on Lambda`, estimate: '$0 while idle; the first million requests and 400,000 GB-seconds a month are free, then about $0.20 per million requests plus compute time' });
  const workers = workloads.filter((service) => service.workloadKind === 'worker').length;
  if (workers) lines.push({ item: `${workers} worker(s) on Fargate that start when jobs are due`, estimate: '$0 while idle; about 1–2 cents per hour while working' });
  const cron = workloads.filter((service) => service.workloadKind === 'cron').length;
  if (cron) lines.push({ item: `${cron} scheduled job(s) on Fargate`, estimate: '$0 between runs; a few cents a month for short runs' });
  if (environment.database) lines.push({ item: 'Aurora Serverless Postgres that pauses when idle', estimate: '$0 compute while paused, plus about $0.10 per GB stored per month; about 6–12 cents per hour while in use' });
  const buckets = Object.keys(environment.storage ?? {}).length;
  if (buckets) lines.push({ item: `${buckets} S3 bucket(s)`, estimate: 'about $0.023 per GB stored per month' });
  lines.push({ item: 'Image registry, builds, settings, logs', estimate: 'usually under $1 per month' });
  return lines;
}

/** Approximate list prices for an Azure testing environment (East US 2). Never a quote. */
export function estimateAzureMonthlyCost(environment: EnvironmentSpec): CostLine[] {
  const lines: CostLine[] = [];
  const workloads = Object.values(environment.services);
  const web = workloads.filter((service) => (service.workloadKind ?? 'web') === 'web').length;
  if (web) lines.push({ item: `${web} Container App(s) that scale to zero`, estimate: '$0 while idle; the first 2 million requests and 180,000 vCPU-seconds a month are free, then about $0.40 per million requests plus CPU time' });
  const workers = workloads.filter((service) => service.workloadKind === 'worker').length;
  if (workers) lines.push({ item: `${workers} worker(s) that start when jobs are due`, estimate: '$0 while idle; about 3 cents per hour while working (0.25 vCPU)' });
  const cron = workloads.filter((service) => service.workloadKind === 'cron').length;
  if (cron) lines.push({ item: `${cron} scheduled job(s)`, estimate: '$0 between runs; a few cents a month for short runs' });
  if (environment.database) lines.push({ item: 'Postgres (Burstable B1ms, 32 GB), shared by all of the project\'s testing environments', estimate: 'about $16 per month for the project' });
  lines.push({ item: 'Container Registry (Basic), shared by the project', estimate: 'about $5 per month for the project' });
  const buckets = Object.keys(environment.storage ?? {}).length;
  if (buckets) lines.push({ item: `${buckets} Blob storage container(s)`, estimate: 'about $0.02 per GB stored per month' });
  lines.push({ item: 'Key Vault, logs, image builds', estimate: 'usually under $1 per month' });
  return lines;
}

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
    // Saved infrastructure applies retain their exact continuation identity below.
    // A failure elsewhere stops the journey without asserting a write's outcome.
    return { status: 'pending', message: 'The connection dropped while talking to the cloud provider or Cloudflare. Check hv_status before continuing the launch.', receipts: [] };
  }
}

async function runLaunch(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  environmentName: string;
  billingAccountName?: string;
  /** Azure: the subscription the person chose after needs_subscription. */
  azureSubscriptionId?: string;
  /** AWS: the account a needs_access "aws-setup" result was shown for. */
  awsAccountId?: string;
  confirmActions?: string[];
  /** Exact persisted plan returned for review; its approval never transfers to another plan. */
  planId?: string;
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
    return { status: 'blocked', message: 'hv_launch runs environments managed by the OpenTofu engine. Choose hosting.provider="cloudrun" with hv_spec first.' };
  }
  // Each cloud has its own access; never fall through to Google Cloud setup.
  const cloud = environmentSpec.hosting.provider === 'azure' ? 'Azure' : environmentSpec.hosting.provider === 'aws' ? 'AWS' : undefined;
  if (cloud) {
    const profile = cloud === 'Azure' ? azureProfileFor(params.environmentName) : awsProfileFor(params.environmentName);
    if (profile === 'production') {
      return { status: 'blocked', message: `hv_launch runs only ${cloud} testing environments for now; ${params.environmentName} uses the production profile, which is not built yet. Launch a testing environment (for example "dev" or "preview").` };
    }
    if (environmentSpec.deploy?.strategy === 'branch') {
      return { status: 'blocked', message: `Releases from GitHub Actions are not built for ${cloud} yet. Set deploy.strategy="manual" with hv_spec; hv_deploy releases from this computer.` };
    }
  }

  const validation = firstProviderSpecValidationFailure(params.spec, params.environmentName);
  if (validation) return { status: 'blocked', message: validation.message, details: validation.details };

  if (params.confirmActions?.length && !params.planId) {
    return { status: 'blocked', message: 'Infrastructure approval requires the planId returned with those confirmActions. Run hv_launch without confirmation inputs to review a plan.' };
  }
  let reviewedPlan: InfrastructurePlanResult | undefined;
  if (params.planId) {
    const loaded = new ConvergeExecutor().loadPlan(params.planId);
    if ('error' in loaded) return { status: 'blocked', message: loaded.error };
    const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
    if (![ENGINE_PLAN_SCOPE, 'dns-engine'].includes(loaded.document.scope ?? '') || loaded.run.projectId !== params.project.id
      || loaded.document.environmentName !== params.environmentName || !environment || loaded.run.environmentId !== environment.id) {
      return { status: 'blocked', message: 'The saved plan belongs to a different project, environment or lifecycle scope. Review a new hv_launch plan.' };
    }
    if (loaded.document.specRevision !== params.specRevision) return { status: 'blocked', message: 'The spec changed after this plan was reviewed. Run hv_launch without confirmation inputs to review the current changes.' };
    reviewedPlan = { planRunId: params.planId, environmentName: loaded.document.environmentName,
      specRevision: loaded.document.specRevision, actions: loaded.document.actions,
      confirmActions: loaded.document.actions.filter((action) => action.type !== 'noop' && (action.requiresConfirm || action.billable || action.dataBearing)).map((action) => action.id),
      warnings: loaded.document.warnings ?? [] };
    if (params.confirmActions?.length) {
      const expected = reviewedPlan.actions.filter((action) => reviewedPlan!.confirmActions.includes(action.id)).map(approvalToken).sort();
      if (JSON.stringify([...params.confirmActions].sort()) !== JSON.stringify(expected)) {
        return { status: 'blocked', message: 'confirmActions must match the exact actions returned for this saved planId. Review that plan before applying it.' };
      }
    }
  }

  // Account selection and infrastructure/access approval are separate authorities.
  const resourceAccess = neededResourceAccess(environmentSpec);
  const approvedAccess = new Set<string>(params.approveAccess ?? []);

  const prepared = environmentSpec.hosting.provider === 'azure' ? await prepareAzureLaunch(params, approvedAccess)
    : environmentSpec.hosting.provider === 'aws' ? await prepareAwsLaunch(ctx, params, approvedAccess)
      : await prepareGcpLaunch(ctx, params, environmentSpec, approvedAccess, resourceAccess);
  if (prepared) return prepared;

  if (params.stopAfter === 'prepare') return { status: 'ready', phase: 'prepare', infrastructureRounds: 0 };

  // 2. Infrastructure, in as many reviewed rounds as staging requires.
  let rounds = 0;
  let certificatePending = false;
  for (; rounds < 6; rounds++) {
    const usingReviewedPlan = reviewedPlan !== undefined;
    let planned = reviewedPlan ?? await planInfrastructureEngine(ctx, params);
    reviewedPlan = undefined;
    // Collect only after planning has verified the owned containers. A saved
    // container plan must finish before its values or dependent work can begin.
    if ('blocked' in planned && planned.missingOutsideKeys?.length) {
      const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
      const imported = (environment?.platformBindings as { engine?: EngineBinding } | undefined)?.engine?.importedSecrets;
      const collected = await collectOutsideKeys(ctx, { project: params.project, spec: params.spec, environmentName: params.environmentName,
        keys: planned.missingOutsideKeys, ...(imported ? { importedSecrets: imported } : {}),
        ...(params.sourceDirectory ? { sourceDirectory: params.sourceDirectory } : {}), purpose: `launch ${params.environmentName}` });
      if (collected.status !== 'collected') return collected;
      planned = await planInfrastructureEngine(ctx, params);
    }
    if ('blocked' in planned) return { status: 'blocked', message: planned.blocked.join('\n') };
    const pending = planned.actions.filter((action) => action.type !== 'noop');
    const onlyCertificate = pending.length > 0 && pending.every((action) => action.metadata?.operation === 'gcpDomainReady');
    if (pending.length === 0 || (onlyCertificate && certificatePending)) break;
    const tokens = planned.actions.filter((action) => planned.confirmActions.includes(action.id)).map(approvalToken);
    const approvedExactly = usingReviewedPlan && JSON.stringify([...(params.confirmActions ?? [])].sort()) === JSON.stringify([...tokens].sort());
    if (tokens.length && !approvedExactly) {
      return {
        status: 'needs_confirmation',
        planId: planned.planRunId,
        confirmActions: tokens,
        changes: pending.map(summarize),
        estimatedMonthlyCost: environmentSpec.hosting.provider === 'azure' ? estimateAzureMonthlyCost(environmentSpec)
          : environmentSpec.hosting.provider === 'aws' ? estimateAwsMonthlyCost(environmentSpec) : estimateMonthlyCost(environmentSpec),
      };
    }
    let applied: Awaited<ReturnType<typeof applyInfrastructureEngine>>;
    try {
      const loaded = new ConvergeExecutor().loadPlan(planned.planRunId);
      if ('error' in loaded) return { status: 'blocked', message: loaded.error };
      const apply = loaded.document.scope === 'dns-engine' ? applyDnsPlan : applyInfrastructureEngine;
      applied = await apply(ctx, {
        project: params.project, spec: params.spec, specRevision: params.specRevision,
        planId: planned.planRunId, confirmActions: planned.confirmActions,
      });
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      return { status: 'pending', planId: planned.planRunId, confirmActions: tokens,
        message: 'The infrastructure apply lost its connection. Continue with this same planId and its approved confirmActions so the saved operation can be checked.', receipts: [] };
    }
    if (applied.kind === 'blocked') return { status: 'blocked', message: applied.reason };
    if (applied.result.error) return { status: 'blocked', message: applied.result.error };
    const receipts = applied.result.receipts;
    const failed = receipts.find((receipt) => receipt.status === 'failed' || receipt.status === 'blocked');
    if (failed) return { status: 'blocked', message: failed.error ?? failed.message ?? `${failed.actionId} did not complete.`, details: receipts };
    const stillPending = receipts.filter((receipt) => receipt.status === 'pending');
    if (!applied.result.success && !stillPending.length) return { status: 'blocked', message: 'The saved infrastructure plan did not complete. Inspect its results before continuing.', details: receipts };
    // A slow certificate must not hold back the app itself; anything else stops here.
    if (stillPending.some((receipt) => !receipt.actionId.startsWith('domain-ready:'))) {
      return { status: 'pending', planId: planned.planRunId, confirmActions: tokens, message: 'Some changes are still settling. Continue with this same planId and its approved confirmActions.', receipts };
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

/** Google Cloud project, region, DNS and add-on access. Returns a stop point, or undefined once everything is in place. */
async function prepareGcpLaunch(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], environmentSpec: EnvironmentSpec,
  approvedAccess: Set<string>, resourceAccess: Array<{ id: string; label: string }>): Promise<LaunchResult | undefined> {
  // 1. Select billing, then review and approve the exact project setup plan.
  // Only a connection scoped to this repository counts; global ones point at other projects.
  if (!await engineGcpAdapter(params.project)) {
    const preview = await runGcpBootstrap({ region: environmentSpec.hosting.region ?? 'us-central1', project: params.project });
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
    const setupApproved = approvedAccess.has('gcp-setup');
    const setup = await runGcpBootstrap({ region: environmentSpec.hosting.region ?? 'us-central1', project: params.project, gcpProjectId: target, billingAccountName: params.billingAccountName, confirm: setupApproved });
    if (!setup.success) return { status: 'blocked', message: String(setup.error ?? 'GCP setup failed.'), details: setup };
    if (!setupApproved) return {
      status: 'needs_access', accessId: 'gcp-setup',
      access: 'Create the Google Cloud project prerequisites and attach the selected billing account through this reviewed OpenTofu plan. Billing selection does not approve infrastructure or permissions.',
      grants: setup,
    };
  }

  // A connected project can host several environments in different regions.
  // Each regional repository belongs to retained project-shared engine state.
  const region = environmentSpec.hosting.region ?? 'us-central1';
  if (!isCloudPreparedForRegion(ctx.repos.projects.findById(params.project.id) ?? params.project, region)) {
    const confirm = approvedAccess.has('gcp-region');
    const prepared = await runCloudPrepare({ project: params.project, provider: 'cloudrun',
      gcpProjectId: await scopedGcpProjectId(params.project), region, adminAuth: 'default', confirm });
    if (!prepared.success) return { status: 'blocked', message: String(prepared.error ?? 'Regional Google Cloud setup failed.'), details: prepared };
    if (!confirm) return { status: 'needs_access', accessId: 'gcp-region',
      access: `Prepare build resources in ${region} using this saved OpenTofu plan. Shared resources in other regions are retained.`, grants: prepared };
  }

  // DNS access is scoped independently from the hosting project.
  const domainName = environmentSpec.domain?.trim().toLowerCase();
  if (domainName) {
    if (!environmentSpec.dns) return { status: 'blocked', message: 'Set environment.dns to the exact DNS provider and zone for this domain. Hosting does not select DNS.' };
    const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
    const connection = await resolveDnsConnection({ context: ctx, zone: dnsZoneIdentity(environmentSpec.dns),
      connectionScope: environmentSpec.dns.connectionScope, scopeHints: [repository, domainName, environmentSpec.dns.zone.name].filter((value): value is string => Boolean(value)) });
    if ('blocked' in connection) {
      if (environmentSpec.dns.provider !== 'cloudflare') return { status: 'needs_connection', provider: environmentSpec.dns.provider, message: connection.blocked };
      const connected = await connectCloudflareInBrowser({ domain: domainName, waitMs: 3 * 60 * 1000, context: {
        project: params.project.name, ...(repository ? { repository } : {}), environment: params.environmentName,
        purpose: `serve the ${params.environmentName} environment at ${domainName}`,
      } });
      if (connected.status !== 'connected') return { status: 'needs_connection', provider: 'cloudflare', ...(connected.url ? { url: connected.url } : {}), message: connected.message };
    }
  }

  // Each access approval applies its saved engine preview; never refresh that
  // preview between the user's approval and application.
  const accessRequests = [
    { id: 'storage' as const, needed: Object.keys(environmentSpec.storage ?? {}).length > 0,
      ready: isCloudPreparedForStorage, options: { gcsAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage the app storage buckets and let the app read and write its files.' },
    { id: 'storage-s3' as const, needed: Object.values(environmentSpec.storage ?? {}).some((storage) => storage.access === 's3'),
      ready: isCloudPreparedForStorageS3, options: { gcsAccess: 's3' as const },
      description: 'Let Hypervibe manage S3-compatible credentials for the app storage.' },
    { id: 'memorystore' as const, needed: Boolean(environmentSpec.cache),
      ready: isCloudPreparedForCache, options: { memorystoreAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage a private Redis cache and connect the app to it.' },
    { id: 'workers' as const, needed: Object.values(environmentSpec.services).some((service) => service.onDemand),
      ready: isCloudPreparedForWorkerWake, options: { workerAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage the scheduled checks and permissions for workers that run only while they have work.' },
    { id: 'queues' as const, needed: Object.keys(environmentSpec.queues ?? {}).length > 0,
      ready: (project: Project) => isCloudPreparedForQueues(project, 'cloudrun'), options: { queueAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage Pub/Sub queues and let the app send and receive messages.' },
  ];
  for (const request of accessRequests) {
    if (!request.needed || request.ready(ctx.repos.projects.findById(params.project.id) ?? params.project)) continue;
    const confirm = approvedAccess.has(request.id);
    const result = await runCloudPrepare({ region: environmentSpec.hosting.region ?? 'us-central1', project: params.project, provider: 'cloudrun',
      gcpProjectId: await scopedGcpProjectId(params.project), ...request.options, adminAuth: 'default', confirm });
    if (!result.success) return { status: 'blocked', message: String(result.error ?? 'Google Cloud access setup failed.'), details: result };
    if (!confirm) return { status: 'needs_access', accessId: request.id, access: request.description, grants: result };
  }
  return undefined;
}

/**
 * AWS access: reused when this account is already connected; otherwise one AWS
 * sign-in in the browser, where the person approves the exact setup. The chat
 * fallback is approveAccess "aws-setup" for the account it was shown for.
 */
async function prepareAwsLaunch(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], approvedAccess: Set<string>): Promise<LaunchResult | undefined> {
  const existing = await resolveAwsEngineContext(ctx, params.project, params.environmentName);
  if (!('blocked' in existing)) return undefined;
  const shownAccount = approvedAccess.has('aws-setup') ? params.awsAccountId : undefined;
  if (approvedAccess.has('aws-setup') && !shownAccount) return { status: 'blocked', message: 'Approving AWS setup needs the awsAccountId it was shown for.' };
  const connected = await connectAws({ project: params.project, spec: params.spec, ...(shownAccount ? { approveAccountId: shownAccount } : {}) });
  switch (connected.status) {
    case 'connected': return undefined;
    case 'waiting': return { status: 'needs_connection', provider: 'aws', url: connected.url, message: connected.message };
    case 'failed': return { status: 'blocked', message: connected.message };
    case 'needs_approval':
      return { status: 'needs_access', accessId: 'aws-setup', access: connected.message,
        grants: { accountId: connected.accountId, region: connected.region, changes: connected.changes } };
  }
}

/**
 * Azure access: one Microsoft sign-in in the browser, where the person also
 * approves the exact setup. The chat fallback needs approveAccess "azure-setup"
 * together with the subscription it was shown for.
 */
async function prepareAzureLaunch(params: Parameters<typeof runLaunch>[1], approvedAccess: Set<string>): Promise<LaunchResult | undefined> {
  if (!('blocked' in resolveAzureConnection(params.project))) return undefined;
  const approved = approvedAccess.has('azure-setup');
  if (approved && !params.azureSubscriptionId) return { status: 'blocked', message: 'Approving Azure setup needs the azureSubscriptionId it was shown for.' };
  const connected = await connectAzure({ project: params.project, spec: params.spec,
    ...(params.azureSubscriptionId ? { subscriptionId: params.azureSubscriptionId } : {}), ...(approved ? { approved: true } : {}) });
  switch (connected.status) {
    case 'connected': return undefined;
    case 'waiting': return { status: 'needs_connection', provider: 'azure', url: connected.url, message: connected.message };
    case 'failed': return { status: 'blocked', message: connected.message };
    case 'needs_subscription':
      return { status: 'needs_subscription', message: connected.message,
        subscriptions: connected.subscriptions.map(({ subscriptionId, displayName }) => ({ subscriptionId, displayName })) };
    case 'needs_approval':
      return { status: 'needs_access', accessId: 'azure-setup', access: connected.message,
        grants: { subscriptionId: connected.subscriptionId, subscriptionName: connected.subscriptionName, location: connected.location, changes: connected.changes } };
  }
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
    try {
      const confirm = params.approveAccess?.includes('ci-release') === true;
      const granted = await grantCiReleaseAccess({
        projectId: params.project.id, adminToken: await getDefaultAdminAccessToken(), gcpProjectId: context.gcpProjectId, repository,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, confirm,
      });
      if (!confirm) return {
        status: 'needs_access', accessId: 'ci-release',
        access: `Let GitHub Actions in ${repository} push images and release this app without storing a key in GitHub.`,
        grants: { ...previewCiReleaseAccess(context.gcpProjectId, repository, context.runtimeServiceAccountEmail), planId: granted.planId, actions: granted.actions },
      };
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
