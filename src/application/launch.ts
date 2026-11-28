import { browserApprovedRunActions } from './browser-approved-run.js';
import { environmentDomains, sharedDatabaseSpecProblems } from '../domain/services/infrastructure-engine-selection.js';
import { effectiveBranchCiAutoDeploy } from '../domain/spec/spec.schema.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { createHash } from 'node:crypto';
import { strictHealthCheck } from '../domain/services/release-health.js';
import { firstProviderSpecValidationFailure } from '../domain/services/provider-spec-validation.js';
import type { CommandContext } from './context.js';
import { buildTokenKey, collectOutsideKeys } from './engine-secrets.js';
import { isNetworkError } from '../utils/fetch-retry.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { requiresActionConfirmation, type PlanAction } from '../domain/plan/plan.types.js';
import { ConvergeExecutor, type ActionReceipt } from '../domain/plan/converge.executor.js';
import { runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { connectCloudflareInBrowser } from './local-connect-page.js';
import { resolveDnsConnection } from '../adapters/dns-observation/connections.js';
import { dnsZoneIdentity } from '../domain/services/dns-policy.service.js';
import { applyDnsPlan } from './dns-hosting.js';
import { grantCiReleaseAccess, previewCiReleaseAccess, renderReleaseWorkflow, writeReleaseWorkflow } from './infrastructure-engine-ci.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { ensureGcpRuntimeObserver } from './gcp-runtime-observer.js';
import { connectAzure } from './azure-connect.js';
import { connectAws } from './aws-connect.js';
import { awsProfileFor, resolveAwsEngineContext } from './infrastructure-engine-aws.js';
import { azureProfileFor, resolveAzureConnection } from './infrastructure-engine-azure.js';
import { awsAccessCurrent } from '../adapters/providers/aws/aws-setup.client.js';
import { azureCiSetupReady, azureMonitoringSetupReady } from '../adapters/providers/azure/azure-setup.client.js';
import { cloudEngineFor } from './cloud-engines.js';
import { engineCiIntent } from '../domain/spec/engine-ci.js';
import { parseEngineCiBinding } from '../domain/spec/engine-ci-binding.js';
import { environmentDeploymentContractHashForApply } from '../domain/services/deployment-contract.service.js';
import { generatedContainerDockerfile } from '../domain/services/generated-container.js';
import { gcpEnvironmentBindingConflict } from '../domain/services/gcp-environment-target.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import { isCloudPreparedForRegion, isCloudPreparedForCache, isCloudPreparedForQueues, isCloudPreparedForStorage, isCloudPreparedForWorkerWake } from '../domain/services/cloud-prepare.js';
import {
  applyInfrastructureEngine,
  gcpUnboundStateConflict,
  observeStorageS3Access,
  ENGINE_PLAN_SCOPE,
  type InfrastructurePlanResult,
  isEngineManaged,
  planInfrastructureEngine,
  releaseCommandFor,
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
  | { status: 'needs_access'; accessId: LaunchAccessId; access: string; grants: Record<string, unknown>; confirmationHint?: string }
  | { status: 'needs_subscription'; subscriptions: Array<{ subscriptionId: string; displayName: string }>; message: string }
  | { status: 'needs_connection'; provider: string; url?: string; message: string }
  | { status: 'needs_confirmation'; planId: string; htmlPath?: string; confirmActions: string[]; changes: Array<{ id: string; change: string }>; estimatedMonthlyCost: CostLine[] }
  | { status: 'blocked'; message: string; details?: unknown; next?: ['hv_connections'] }
  | { status: 'needs_secrets'; keys: string[]; url?: string; message: string }
  /** Returned only when a caller asked to stop after a phase (for example migration). */
  | { status: 'ready'; phase: 'prepare' | 'infrastructure'; infrastructureRounds: number }
  | { status: 'pending'; message: string; receipts: ActionReceipt[]; planId?: string; htmlPath?: string; confirmActions?: string[] }
  | { status: 'live'; urls: Record<string, string>; releases: EngineReleaseResult[]; domain?: { name: string; status: 'serving' | 'certificate_pending' }; domains?: Array<{ name: string; status: 'serving' | 'certificate_pending' }>; infrastructureRounds: number;
      ciWorkflow?: { path: string; changed: boolean; branch: string } };

export const GCP_REVIEWED_ACCESS = ['gcp-setup', 'gcp-region', 'storage', 'storage-s3', 'memorystore', 'queues', 'workers', 'ci-release', 'runtime-observer'] as const;
export const LAUNCH_ACCESS_IDS = [...GCP_REVIEWED_ACCESS, 'azure-setup', 'aws-setup'] as const;
export type LaunchAccessId = typeof LAUNCH_ACCESS_IDS[number];

export interface CostLine { item: string; estimate: string }

/** Approximate list prices for an AWS testing environment (us-east-1). Never a quote. */
export function estimateAwsMonthlyCost(environment: EnvironmentSpec): CostLine[] {
  const lines: CostLine[] = [];
  const workloads = Object.values(environment.services);
  const web = workloads.filter((service) => (service.workloadKind ?? 'web') === 'web').length;
  if (web) lines.push({ item: `${web} web service(s) on Fargate, always running`, estimate: 'about $15 a month each (a quarter CPU, 1 GB and a public address), plus about $25 a month for one load balancer shared by every web service in the AWS account' });
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind !== 'worker') continue;
    if (service.workerPaused) lines.push({ item: `Worker ${name} (paused)`, estimate: '$0 for worker compute after all its tasks stop' });
    else if (service.onDemand) lines.push({ item: `Worker ${name} (on demand)`, estimate: '$0 for worker compute while idle, about 1–2 cents per hour while working' });
    else lines.push({ item: `Worker ${name} (always on)`, estimate: 'one Fargate task running around the clock at about 1–2 cents per hour' });
  }
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
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind !== 'worker') continue;
    if (service.onDemand) lines.push({ item: `Worker ${name} (on demand)`, estimate: '$0 for worker compute at zero replicas, about 3 cents per hour while working (0.25 vCPU)' });
    else lines.push({ item: `Worker ${name} (always on)`, estimate: 'one replica running around the clock, subject to Container Apps active and idle rates and the monthly free grant' });
  }
  const cron = workloads.filter((service) => service.workloadKind === 'cron').length;
  if (cron) lines.push({ item: `${cron} scheduled job(s)`, estimate: '$0 between runs; a few cents a month for short runs' });
  lines.push({ item: 'Private network for the apps (load balancer and two public addresses), shared by all of the project\'s testing environments', estimate: 'about $26 per month for the project' });
  if (environment.database) lines.push({ item: 'Postgres (Burstable B1ms, 32 GB) that the internet cannot reach, shared by all of the project\'s testing environments', estimate: 'about $24 per month for the project, including its private endpoint' });
  lines.push({ item: 'Container Registry (Basic), shared by the project', estimate: 'about $5 per month for the project' });
  if (environment.deploy?.strategy === 'branch') lines.push({ item: 'Dedicated Container Registry (Basic) for this CI environment', estimate: 'an additional registry charge; shown in the reviewed infrastructure plan' });
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
    if (service.workerPaused) {
      lines.push({ item: `Worker ${name} (paused)`, estimate: '$0 for worker compute while paused' });
      continue;
    }
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
  if (environment.database?.placement === 'app') lines.push({ item: 'Its own Postgres database on the app\'s one shared Cloud SQL server (db-f1-micro, 10 GB, daily backups)', estimate: 'about $10–12 per month for the server, charged once for the whole app, not per environment' });
  else if (environment.database) lines.push({ item: 'Cloud SQL Postgres (db-f1-micro, 10 GB, daily backups)', estimate: 'about $10–12 per month' });
  if (environment.cache) lines.push({ item: `Memorystore Redis (${environment.cache.tier ?? 'BASIC'}, ${environment.cache.size ?? '1gb'})`, estimate: environment.cache.tier === 'STANDARD_HA' ? 'about $90 per month' : 'about $35 per month' });
  const queues = Object.keys(environment.queues ?? {}).length;
  if (queues) lines.push({ item: `${queues} Pub/Sub queue(s)`, estimate: 'free up to 10 GB of messages per month, then about $40 per TB' });
  const buckets = Object.keys(environment.storage ?? {}).length;
  if (buckets) lines.push({ item: `${buckets} Cloud Storage bucket(s)`, estimate: 'about $0.02 per GB stored per month, plus small per-request charges' });
  lines.push({ item: 'Secret Manager, Artifact Registry, Cloud Build', estimate: 'usually under $1 per month for a small app' });
  for (const { domain } of environmentDomains(environment)) lines.push({ item: `Custom domain ${domain}`, estimate: '$0 for the Google-managed certificate. DNS uses your existing zone.' });
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
  gcpSetupPlanId?: string;
  browserAccess?: string;
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
    try { engineCiIntent(params.spec, params.environmentName); }
    catch (error) { return { status: 'blocked', message: error instanceof Error ? error.message : 'CI release intent is invalid.' }; }
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
    if (![ENGINE_PLAN_SCOPE, 'dns-engine', 'domain-registration'].includes(loaded.document.scope ?? '') || loaded.run.projectId !== params.project.id
      || loaded.document.environmentName !== params.environmentName || !environment || loaded.run.environmentId !== environment.id) {
      return { status: 'blocked', message: 'The saved plan belongs to a different project, environment or lifecycle scope. Review a new hv_launch plan.' };
    }
    if (loaded.document.specRevision !== params.specRevision) return { status: 'blocked', message: 'The spec changed after this plan was reviewed. Run hv_launch without confirmation inputs to review the current changes.' };
    reviewedPlan = { planRunId: params.planId, environmentName: loaded.document.environmentName,
      specRevision: loaded.document.specRevision, actions: loaded.document.actions,
      confirmActions: loaded.document.actions.filter(requiresActionConfirmation).map(action => action.id),
      warnings: loaded.document.warnings ?? [] };
    if (params.confirmActions === undefined && browserApprovedRunActions(loaded.run, params.project.id)) {
      params = { ...params, confirmActions: reviewedPlan.actions.filter(action => reviewedPlan!.confirmActions.includes(action.id)).map(approvalToken) };
    }
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

  // Accept an existing native setup review opened before monitoring joined the normal infrastructure plan.
  if (environmentSpec.hosting.provider === 'cloudrun' && params.gcpSetupPlanId
    && (params.browserAccess === 'runtime-observer' || approvedAccess.has('runtime-observer'))) {
    const observation = await ensureGcpRuntimeObserver(ctx, params);
    if (observation) return observation;
  }

  // 2. Infrastructure, in as many reviewed rounds as staging requires.
  let rounds = 0;
  const pendingCertificates = new Set<string>();
  const limit = 6 + 2 * (environmentSpec.domains?.length ?? 0);
  for (; rounds < limit; rounds++) {
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
    if (!pending.length) { pendingCertificates.clear(); break; }
    if (onlyCertificate && pendingCertificates.size) {
      pendingCertificates.clear();
      for (const action of pending) pendingCertificates.add(String(action.metadata?.domain));
      break;
    }
    const tokens = planned.actions.filter((action) => planned.confirmActions.includes(action.id)).map(approvalToken);
    const approvedExactly = usingReviewedPlan && JSON.stringify([...(params.confirmActions ?? [])].sort()) === JSON.stringify([...tokens].sort());
    if (tokens.length && !approvedExactly) {
      return {
        status: 'needs_confirmation',
        planId: planned.planRunId, ...ctx.repos.runs.planReport(planned.planRunId),
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
      return { status: 'pending', planId: planned.planRunId, ...ctx.repos.runs.planReport(planned.planRunId), confirmActions: tokens,
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
      return { status: 'pending', planId: planned.planRunId, ...ctx.repos.runs.planReport(planned.planRunId), confirmActions: tokens, message: 'Some changes are still settling. Continue with this same planId and its approved confirmActions.', receipts };
    }
    pendingCertificates.clear();
    for (const receipt of stillPending) pendingCertificates.add(receipt.actionId.slice('domain-ready:'.length));
  }

  if (rounds === limit) return { status: 'blocked', message: 'Further infrastructure stages remain unverified. Run hv_launch again to review the next stage.' };
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
  const domains = environmentDomains(environmentSpec).map(({ domain }) => ({ name: domain,
    status: pendingCertificates.has(domain) ? 'certificate_pending' as const : 'serving' as const }));
  const primary = environmentSpec.domain ? domains[0] : undefined;
  if (primary?.status === 'serving') urls.custom = `https://${primary.name}`;
  return {
    status: 'live',
    urls,
    releases: released.results,
    ...(primary ? { domain: primary } : {}), ...(environmentSpec.domains?.length ? { domains } : {}),
    infrastructureRounds: rounds,
    ...(ciWorkflow ? { ciWorkflow } : {}),
  };
}

/** Google Cloud project, region, DNS and add-on access. Returns a stop point, or undefined once everything is in place. */
function browserAccessPlan(params: { browserAccess?: string; gcpSetupPlanId?: string }, access: string) {
  if (params.gcpSetupPlanId && params.browserAccess === access) return { gcpSetupPlanId: params.gcpSetupPlanId, requireBrowserApproval: true };
}

async function prepareGcpLaunch(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], environmentSpec: EnvironmentSpec,
  approvedAccess: Set<string>, resourceAccess: Array<{ id: string; label: string }>): Promise<LaunchResult | undefined> {
  // 1. Select billing, then review and approve the exact project setup plan.
  const environmentProjectId = environmentSpec.hosting.gcpProjectId;
  const region = environmentSpec.hosting.region ?? 'us-central1';
  const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  const binding = environment?.platformBindings;
  const boundConflict = gcpEnvironmentBindingConflict(binding, environmentProjectId, region)
    ?? gcpUnboundStateConflict(environment, environmentProjectId);
  if (boundConflict) return { status: 'blocked', message: boundConflict };
  const bootstrapTarget = environmentProjectId ? { environment: params.environmentName, environmentProjectId } : {};
  const preparationTarget = environmentProjectId ? { environmentName: params.environmentName, environmentProjectId } : {};
  const adapter = await engineGcpAdapter(params.project, environmentProjectId);
  if (binding?.projectId && adapter && !environmentProjectId) {
    const conflict = gcpEnvironmentBindingConflict(binding, adapter.engineConnection().projectId, region);
    if (conflict) return { status: 'blocked', message: conflict };
  }
  if (!adapter) {
    const preview = await runGcpBootstrap({ ...bootstrapTarget, region, project: params.project });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'GCP setup preview failed.'), details: preview };
    const target = (preview as { target?: { projectId?: string } }).target?.projectId;
    const accounts = ((preview as { openBillingAccounts?: Array<{ name: string; displayName?: string }> }).openBillingAccounts ?? []);
    if (!target) return { status: 'blocked', message: 'GCP setup could not choose a project id.', details: preview };
    const conflict = gcpEnvironmentBindingConflict(binding, target, region);
    if (conflict) return { status: 'blocked', message: conflict };
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
    const setupPlanId = !params.browserAccess || params.browserAccess === 'gcp-setup' ? params.gcpSetupPlanId : undefined;
    const browserSetup = Boolean(setupPlanId) && !approvedAccess.has('gcp-setup');
    const setupApproved = approvedAccess.has('gcp-setup') || browserSetup;
    const setup = await runGcpBootstrap({ ...bootstrapTarget, region, project: params.project, gcpProjectId: target, billingAccountName: params.billingAccountName, confirm: setupApproved,
      ...(setupPlanId ? { gcpSetupPlanId: setupPlanId } : {}),
      ...(browserSetup && { requireBrowserApproval: true }),
    });
    if (!setup.success) return {
      status: 'blocked', message: String(setup.error ?? 'GCP setup failed.'), details: setup,
      next: setup.projectRecovery ? ['hv_connections'] : undefined,
    };
    if (!setupApproved) return {
      status: 'needs_access', accessId: 'gcp-setup',
      access: 'Create the Google Cloud project prerequisites and attach the selected billing account through this reviewed OpenTofu plan. Billing selection does not approve infrastructure or permissions.',
      grants: setup,
      ...(setup.requiresPlanId === true && typeof setup.planId === 'string' ? {
        confirmationHint: `Review the remaining setup. After approval, pass gcpSetupPlanId ${JSON.stringify(setup.planId)} with approveAccess including "gcp-setup".`,
      } : {}),
    };
  }

  // A connected project can host several environments in different regions.
  // Each regional repository belongs to retained project-shared engine state.
  if (!isCloudPreparedForRegion(ctx.repos.projects.findById(params.project.id) ?? params.project, region, environmentProjectId)) {
    const browser = browserAccessPlan(params, 'gcp-region');
    const confirm = Boolean(browser) || approvedAccess.has('gcp-region');
    const prepared = await runCloudPrepare({ ...preparationTarget, project: params.project, provider: 'cloudrun',
      gcpProjectId: environmentProjectId ?? await scopedGcpProjectId(params.project), region, adminAuth: 'default', confirm, ...browser });
    if (!prepared.success) return { status: 'blocked', message: String(prepared.error ?? 'Regional Google Cloud setup failed.'), details: prepared };
    if (!confirm) return { status: 'needs_access', accessId: 'gcp-region',
      access: `Prepare build resources in ${region} using this saved OpenTofu plan. Shared resources in other regions are retained.`, grants: prepared };
  }

  // DNS access is scoped independently from the hosting project.
  for (const { domain: domainName, dns } of environmentDomains(environmentSpec)) {
    if (!dns) return { status: 'blocked', message: 'Set environment.dns to the exact DNS provider and zone for this domain. Hosting does not select DNS.' };
    const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
    const connection = await resolveDnsConnection({ context: ctx, zone: dnsZoneIdentity(dns),
      connectionScope: dns.connectionScope, scopeHints: [repository, domainName, dns.zone.name].filter((value): value is string => Boolean(value)) });
    if ('blocked' in connection) {
      if (dns.provider !== 'cloudflare') return { status: 'needs_connection', provider: dns.provider, message: connection.blocked };
      const connected = await connectCloudflareInBrowser({ domain: domainName, waitMs: 3 * 60 * 1000, context: {
        project: params.project.name, ...(repository ? { repository } : {}), environment: params.environmentName,
        purpose: `serve the ${params.environmentName} environment at ${domainName}`,
      } });
      if (connected.status !== 'connected') return { status: 'needs_connection', provider: 'cloudflare', ...(connected.url ? { url: connected.url } : {}), message: connected.message };
    }
  }

  // Refused before any access is requested: a grant must never be approved for something the plan will then turn down.
  const sharedDatabaseProblems = sharedDatabaseSpecProblems(params.spec, params.environmentName);
  if (sharedDatabaseProblems.length) return { status: 'blocked', message: sharedDatabaseProblems.join(' ') };

  // Each access approval applies its saved engine preview; never refresh that
  // preview between the user's approval and application.
  const accessRequests = [
    { id: 'storage' as const, needed: Object.keys(environmentSpec.storage ?? {}).length > 0,
      ready: isCloudPreparedForStorage, options: { gcsAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage the app storage buckets and let the app read and write its files.' },
    { id: 'storage-s3' as const, needed: Object.values(environmentSpec.storage ?? {}).some((storage) => storage.access === 's3'),
      options: { gcsAccess: 's3' as const },
      description: 'Let Hypervibe manage S3-compatible credentials for the app storage.' },
    { id: 'memorystore' as const, needed: Boolean(environmentSpec.cache),
      ready: isCloudPreparedForCache, options: { memorystoreAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage a private Redis cache and connect the app to it.' },
    { id: 'workers' as const, needed: Object.values(environmentSpec.services).some((service) => service.onDemand),
      ready: isCloudPreparedForWorkerWake, options: { workerAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage the scheduled checks and permissions for workers that run only while they have work.' },
    { id: 'queues' as const, needed: Object.keys(environmentSpec.queues ?? {}).length > 0,
      ready: (project: Project, projectId?: string) => isCloudPreparedForQueues(project, 'cloudrun', projectId), options: { queueAccess: 'lifecycle' as const },
      description: 'Let Hypervibe manage Pub/Sub queues and let the app send and receive messages.' },
  ];
  const storageS3Access = async () => {
    const context = await resolveEngineContext(ctx, params.project, params.spec, params.environmentName);
    if ('blocked' in context) return { state: 'blocked' as const, message: context.blocked };
    return observeStorageS3Access(await context.adapter.engineAccessToken(), context, params.environmentName, environmentSpec);
  };
  for (const request of accessRequests) {
    if (!request.needed) continue;
    if (request.id === 'storage-s3') {
      const access = await storageS3Access();
      if (access.state === 'ready') continue;
      if (access.state === 'blocked') return { status: 'blocked', message: access.message };
    } else if (request.ready(ctx.repos.projects.findById(params.project.id) ?? params.project, environmentProjectId)) continue;
    const browser = browserAccessPlan(params, request.id);
    const confirm = Boolean(browser) || approvedAccess.has(request.id);
    const result = await runCloudPrepare({ ...preparationTarget, region, project: params.project, provider: 'cloudrun',
      gcpProjectId: environmentProjectId ?? await scopedGcpProjectId(params.project), ...request.options, adminAuth: 'default', confirm, ...browser });
    if (!result.success) return { status: 'blocked', message: String(result.error ?? 'Google Cloud access setup failed.'), details: result };
    if (!confirm) return { status: 'needs_access', accessId: request.id, access: request.description, grants: result };
    if (request.id === 'storage-s3') {
      const verified = await storageS3Access();
      if (verified.state === 'blocked') return { status: 'blocked', message: verified.message };
      if (verified.state === 'needs_access') return { status: 'blocked', message: 'The S3 access grant is not yet effective for the deploy identity. Retry after the Google Cloud permission takes effect.' };
    }
  }
  return undefined;
}

/**
 * AWS access: reused when this account is already connected; otherwise one AWS
 * sign-in in the browser, where the person approves the exact setup. The chat
 * fallback is approveAccess "aws-setup" for the account it was shown for.
 */
async function prepareAwsLaunch(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], approvedAccess: Set<string>): Promise<LaunchResult | undefined> {
  const existing = await resolveAwsEngineContext(ctx, params.project, params.environmentName, params.spec);
  if (!('blocked' in existing)) {
    const env = params.spec.environments[params.environmentName];
    if (!env?.runtimeObservation || !Object.keys(env.services).length) return undefined;
    const readiness = await awsAccessCurrent(existing.credentials, existing.connection.accountId, true);
    if (readiness === 'current') return undefined;
    if (typeof readiness === 'object') return { status: 'blocked', message: readiness.unknown };
  } else if (existing.placement) return { status: 'blocked', message: existing.blocked };
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
  const access = resolveAzureConnection(params.project);
  if (!('blocked' in access)) {
    const env = params.spec.environments[params.environmentName];
    if (env?.deploy?.strategy !== 'branch' && !env?.runtimeObservation) return undefined;
    try {
      const needsCollector = Boolean(env?.runtimeObservation && Object.keys(env.services).length);
      const setupReady = !env?.runtimeObservation || await azureMonitoringSetupReady(access.connection);
      if (setupReady && (env?.deploy?.strategy !== 'branch' && !needsCollector || await azureCiSetupReady(access.connection, fetch, needsCollector))) return undefined;
    }
    catch { return { status: 'blocked', message: 'Azure CI access could not be verified. Retry when Azure can be read; no access change was attempted.' }; }
  }
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

/**
 * The release command step of a generated workflow. A declared command that cannot be
 * run (its job is not built yet) blocks generation: a workflow that silently skipped
 * migrations would release code against an unmigrated database.
 */
export function ciReleaseCommand(environmentSpec: EnvironmentSpec, releaseJob: string | undefined, services: Array<{ name: string; kind: 'services' | 'jobs' | 'workerPools' }>): { job: string; service: string } | { blocked: string } | undefined {
  if (!releaseCommandFor(environmentSpec)) return undefined;
  // Same choice as the engine: the release command runs on the web service's image, or the first non-job service.
  const migrationService = services.find((service) => environmentSpec.services[service.name]?.workloadKind === 'web') ?? services.find((service) => service.kind !== 'jobs');
  if (!releaseJob || !migrationService) {
    return { blocked: 'The release-command job does not exist yet, so the release workflow was not written: it would skip the release command. Run hv_plan scope="infrastructure" and hv_apply first.' };
  }
  return { job: releaseJob, service: migrationService.name };
}

/** What the release workflow updates: every bound service, scheduled job and worker pool. */
export function ciReleaseTargets(environmentSpec: EnvironmentSpec, bindings: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> | undefined,
  target: { region: string; gcpProjectId: string; environmentName: string }) {
  return Object.entries(environmentSpec.services).flatMap(([name, service]) => {
    const bound = bindings?.[name];
    const resource = bound?.serviceId ?? bound?.jobName ?? bound?.workerPoolName;
    const kind = bound?.serviceId ? 'services' as const : bound?.jobName ? 'jobs' as const : 'workerPools' as const;
    return resource ? [{
      name, resource, kind, ...(kind === 'services' && service.workloadKind !== 'worker' ? { healthPath: service.healthCheckPath ?? '/', ...(strictHealthCheck(service) ? { strictHealth: true } : {}) } : {}),
      ...(kind !== 'jobs' && service.startCommand ? { startCommand: service.startCommand } : {}),
      image: `${target.region}-docker.pkg.dev/${target.gcpProjectId}/hypervibe/${target.environmentName}-${name}`.toLowerCase(),
    }] : [];
  });
}

async function ensureCiRelease(ctx: CommandContext, params: Parameters<typeof runLaunch>[1], environmentSpec: EnvironmentSpec): Promise<{ path: string; changed: boolean; branch: string } | LaunchResult> {
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
  if (!repository) return { status: 'blocked', message: 'CI releases need this project on GitHub (set gitRemoteUrl with hv_spec).' };
  if (!params.sourceDirectory) return { status: 'blocked', message: 'CI releases need the local repository so Hypervibe can add the workflow file.' };
  const engine = cloudEngineFor(params.spec, params.environmentName);
  if (engine?.ciWorkflow) {
    const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
    try {
      const binding = parseEngineCiBinding(environment?.platformBindings.engineCi);
      if (binding.provider !== engine.id || binding.environmentName !== params.environmentName || binding.repository !== repository
        || binding.appliedContractHash !== environmentDeploymentContractHashForApply(params.spec, params.environmentName)) throw new Error('Applied CI binding is stale.');
      return await engine.ciWorkflow(params.sourceDirectory, binding);
    }
    catch { return { status: 'blocked', message: 'CI needs complete applied resource and access bindings. Run hv_plan and hv_apply, then hv_launch again to generate the workflow.' }; }
  }
  const context = await resolveEngineContext(ctx, params.project, params.spec, params.environmentName);
  if ('blocked' in context) return { status: 'blocked', message: context.blocked };
  const environment = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  const binding = (environment.platformBindings as { engine?: EngineBinding; services?: Record<string, { serviceId?: string }> });
  let ci = binding.engine?.ci;
  const github = getGitHubAdapter(repository);
  if ('error' in github) return { status: 'blocked', message: github.error };
  const [owner, repo] = repository.split('/');
  const observed = await github.adapter.getRepository(owner!, repo!).catch(() => undefined);
  if (!observed || observed.full_name?.toLowerCase() !== repository.toLowerCase() || !Number.isSafeInteger(observed.id) || observed.id! <= 0) {
    return { status: 'blocked', message: 'GitHub could not verify the exact repository identity for CI access.' };
  }
  const repositoryId = String(observed.id);
  const releases = Object.entries(params.spec.environments).filter(([, env]) => env.hosting.provider === 'cloudrun' && env.deploy?.strategy === 'branch')
    .sort(([a], [b]) => a.localeCompare(b)).map(([environmentName, env]) => ({
      environmentName, branch: env.deploy!.branch ?? 'main', autoDeploy: effectiveBranchCiAutoDeploy(environmentName, env.deploy!.autoDeploy),
    }));
  const trust = createHash('sha256').update(JSON.stringify([repositoryId, repository, releases])).digest('hex');
  if (!ci || ci.trust !== trust) {
    try {
      const browser = browserAccessPlan(params, 'ci-release');
      const confirm = Boolean(browser) || params.approveAccess?.includes('ci-release') === true;
      const granted = await grantCiReleaseAccess({
        projectId: params.project.id, projectName: params.project.name, adminToken: await getDefaultAdminAccessToken(), gcpProjectId: context.gcpProjectId, repository: observed.full_name!, repositoryId, releases,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, confirm, ...browser,
      });
      if (!confirm) return {
        status: 'needs_access', accessId: 'ci-release',
        access: `Let GitHub Actions in ${repository} push images and release this app without storing a key in GitHub.`,
        grants: { ...previewCiReleaseAccess(context.gcpProjectId, observed.full_name!, context.runtimeServiceAccountEmail, releases),
          gcpProjectId: context.gcpProjectId, planId: granted.planId, htmlPath: granted.htmlPath, actions: granted.actions },
      };
      ci = { repository, trust, provider: granted.provider, releaseIdentity: granted.releaseIdentity };
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
  const packageTokenSecret = buildTokenKey(params.spec, params.environmentName);
  const releaseCommand = ciReleaseCommand(environmentSpec, binding.engine?.releaseJob, services);
  if (releaseCommand && 'blocked' in releaseCommand) return { status: 'blocked', message: releaseCommand.blocked };
  const content = renderReleaseWorkflow({
    environmentName: params.environmentName, branch, autoDeploy: environmentSpec.deploy?.autoDeploy, gcpProjectId: context.gcpProjectId, region: context.region,
    provider: ci.provider, releaseIdentity: ci.releaseIdentity, services,
    ...(packageTokenSecret ? { packageTokenSecret } : {}),
    ...(releaseCommand ? { releaseCommand } : {}),
  });
  return { ...writeReleaseWorkflow(params.sourceDirectory, params.environmentName, content), branch };
}
