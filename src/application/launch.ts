import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionReceipt } from '../domain/plan/converge.executor.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { isCloudPreparedForStorage } from '../domain/services/cloud-prepare.js';
import {
  applyInfrastructureEngine,
  isEngineManaged,
  planInfrastructureEngine,
  releaseEngineServices,
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
  | { status: 'needs_billing_choice'; gcpProjectId: string; openBillingAccounts: Array<{ name: string; displayName?: string }>; plannedSteps: string[] }
  | { status: 'needs_access'; access: string; grants: Record<string, unknown> }
  | { status: 'needs_confirmation'; confirmActions: string[]; changes: Array<{ id: string; change: string }>; estimatedMonthlyCost: CostLine[] }
  | { status: 'blocked'; message: string; details?: unknown }
  | { status: 'pending'; message: string; receipts: ActionReceipt[] }
  | { status: 'live'; urls: Record<string, string>; releases: EngineReleaseResult[]; domain?: { name: string; status: 'serving' | 'certificate_pending' }; infrastructureRounds: number };

export interface CostLine { item: string; estimate: string }

/** Approximate list prices for the resources this path creates (us-central1). Never a quote. */
export function estimateMonthlyCost(environment: EnvironmentSpec): CostLine[] {
  const lines: CostLine[] = [];
  const services = Object.keys(environment.services).length;
  if (services) lines.push({ item: `${services} Cloud Run service(s)`, estimate: '$0 while idle; roughly $0.40 per million requests plus CPU time while serving' });
  if (environment.database) lines.push({ item: 'Cloud SQL Postgres (db-f1-micro, 10 GB, daily backups)', estimate: 'about $10–12 per month' });
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
  return action.id;
}

function summarize(action: PlanAction): { id: string; change: string } {
  return { id: action.id, change: action.reason };
}

export async function launchEnvironment(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  environmentName: string;
  billingAccountName?: string;
  confirmActions?: string[];
  /** The user approved the extra Google Cloud access a needs_access result described. */
  approveAccess?: boolean;
  revision?: string;
  sourceDirectory?: string;
}): Promise<LaunchResult> {
  const environmentSpec = params.spec.environments[params.environmentName];
  if (!environmentSpec) return { status: 'blocked', message: `The spec has no environment "${params.environmentName}".` };
  if (!isEngineManaged(environmentSpec)) {
    return { status: 'blocked', message: 'hv_launch runs environments managed by the OpenTofu engine. Set hosting.engine="opentofu" with hv_spec first.' };
  }

  // 1. Connect GCP, asking only for the billing account.
  const connected = await adapterFactory.getProviderAdapter('cloudrun', params.project);
  if (!connected.success) {
    const preview = await runGcpBootstrap({ project: params.project });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'GCP setup preview failed.'), details: preview };
    const target = (preview as { target?: { projectId?: string } }).target?.projectId;
    const accounts = ((preview as { openBillingAccounts?: Array<{ name: string; displayName?: string }> }).openBillingAccounts ?? []);
    if (!target) return { status: 'blocked', message: 'GCP setup could not choose a project id.', details: preview };
    if (!params.billingAccountName) {
      if (accounts.length === 0) {
        return { status: 'blocked', message: 'Your Google login cannot see any open billing account. Open https://console.cloud.google.com/billing to create one or get access, then run hv_launch again.' };
      }
      return { status: 'needs_billing_choice', gcpProjectId: target, openBillingAccounts: accounts, plannedSteps: (preview as { plannedSteps?: string[] }).plannedSteps ?? [] };
    }
    const confirmed = await runGcpBootstrap({ project: params.project, gcpProjectId: target, billingAccountName: params.billingAccountName, confirm: true });
    if (!confirmed.success) return { status: 'blocked', message: String(confirmed.error ?? 'GCP setup failed.'), details: confirmed };
  }

  // 1b. Extra access some resources need (bucket lifecycle), shown before it is granted.
  if (Object.keys(environmentSpec.storage ?? {}).length && !isCloudPreparedForStorage(ctx.repos.projects.findById(params.project.id) ?? params.project)) {
    const preview = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcsAccess: 'lifecycle' });
    if (!preview.success) return { status: 'blocked', message: String(preview.error ?? 'The storage access preview failed.'), details: preview };
    if (!params.approveAccess) {
      const plan = (preview as { plan?: Record<string, unknown> }).plan ?? {};
      return {
        status: 'needs_access',
        access: 'Let Hypervibe create and manage Cloud Storage buckets in this project, and let the app read and write their files.',
        grants: { deploymentIdentity: plan.grantRoles, appRuntime: plan.runtimeGrantRoles },
      };
    }
    const granted = await runCloudPrepare({ project: params.project, provider: 'cloudrun', gcsAccess: 'lifecycle', adminAuth: 'default', confirm: true });
    if (!granted.success) return { status: 'blocked', message: String(granted.error ?? 'Granting storage access failed.'), details: granted };
  }

  // 2. Infrastructure, in as many reviewed rounds as staging requires.
  const approved = new Set(params.confirmActions ?? []);
  let rounds = 0;
  let certificatePending = false;
  for (; rounds < 4; rounds++) {
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
  const domain = environmentSpec.domain?.trim().toLowerCase();
  if (domain && !certificatePending) urls.custom = `https://${domain}`;
  return {
    status: 'live',
    urls,
    releases: released.results,
    ...(domain ? { domain: { name: domain, status: certificatePending ? 'certificate_pending' as const : 'serving' as const } } : {}),
    infrastructureRounds: rounds,
  };
}
