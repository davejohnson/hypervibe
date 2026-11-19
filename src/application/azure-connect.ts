import type { EngineConnectStep } from './cloud-engines.js';
import { AzureEngineCredentialsSchema } from '../adapters/providers/azure/azure-engine.adapter.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { signInToAzure, type AzureSignInSession } from './azure-sign-in.js';
import { escapeHtml } from './local-paste-page.js';
import { applyAzureSetup, listAzureSubscriptions, planAzureSetup, type AzureSetupChange, type AzureSetupPlan, type AzureSubscription } from '../adapters/providers/azure/azure-setup.client.js';

/**
 * Closest Azure region to the app's other environments; West US 2 otherwise. East US 2 was the default until it refused a
 * new pay-as-you-go subscription the smallest database every time it was tried (docs/opentofu-engine-azure.md). List prices match.
 */
export function chooseAzureLocation(spec?: ProjectSpec): string {
  const regions = Object.values(spec?.environments ?? {}).map((environment) => (environment as { hosting?: { region?: string } }).hosting?.region ?? '');
  const near: Array<[RegExp, string]> = [
    [/^(europe-west2|eu-west-2|uksouth)/, 'uksouth'], [/^(europe-west[0-9]*|eu-west-|westeurope)/, 'westeurope'],
    [/^(europe-north|eu-north|europe-central|eu-central|northeurope|swedencentral)/, 'northeurope'],
    [/^(asia-northeast1|ap-northeast-1|japaneast)/, 'japaneast'], [/^(asia-southeast|ap-southeast-1|southeastasia)/, 'southeastasia'],
    [/^(australia|ap-southeast-2|australiaeast)/, 'australiaeast'], [/^(us-west|westus)/, 'westus2'], [/^(northamerica-northeast|ca-central|canadacentral)/, 'canadacentral'],
  ];
  for (const region of regions) for (const [pattern, azure] of near) if (pattern.test(region)) return azure;
  return 'westus2';
}

/** Azure engine environments in the spec, which get a GitHub Actions credential at setup. */
export function azureEnvironments(spec?: ProjectSpec): string[] {
  return Object.entries(spec?.environments ?? {})
    .filter(([, environment]) => environment.hosting.provider === 'azure')
    .map(([name]) => name).sort();
}

export type AzureConnectResult =
  | { status: 'waiting'; url: string; message: string }
  | { status: 'failed'; message: string }
  | { status: 'needs_subscription'; subscriptions: AzureSubscription[]; message: string }
  | { status: 'needs_approval'; subscriptionId: string; subscriptionName: string; location: string; signedInAs: string; changes: Array<Pick<AzureSetupChange, 'id' | 'change' | 'state'>>; message: string }
  | { status: 'connected'; subscriptionId: string; location: string; resourceGroup: string; message: string };

/**
 * One-time Azure setup for a project: sign in once, preview the exact access
 * Hypervibe will create, and (with the approved subscription) create it, store
 * the client secret encrypted and verify the deploy identity works.
 */
export async function connectAzure(params: {
  project: Project;
  spec?: ProjectSpec;
  /** The exact subscription: chosen by the person when they have several, and repeated to approve a chat preview. */
  subscriptionId?: string;
  /** True only after the person approved the preview in chat. */
  approved?: boolean;
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<AzureConnectResult> {
  const location = chooseAzureLocation(params.spec);
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec?.gitRemoteUrl) ?? undefined;
  const environments = azureEnvironments(params.spec);
  const choose = async (session: AzureSignInSession): Promise<AzureSubscription | AzureConnectResult> => {
    const { subscriptions, unreachable } = await listAzureSubscriptions(session);
    if (params.subscriptionId) {
      const chosen = subscriptions.find((subscription) => subscription.subscriptionId === params.subscriptionId);
      return chosen ?? { status: 'failed', message: `Subscription ${params.subscriptionId} is not enabled or not visible to ${session.username}.` };
    }
    if (subscriptions.length === 1) return subscriptions[0]!;
    if (!subscriptions.length) {
      return { status: 'failed', message: `${session.username} has no enabled Azure subscription${unreachable.length ? ` Hypervibe could reach (${unreachable.join('; ')})` : ''}. Create one at https://portal.azure.com/#create/Microsoft.Subscription, then connect again.` };
    }
    // Which subscription pays is the person's decision, never a default.
    return { status: 'needs_subscription', subscriptions, message: `${session.username} has ${subscriptions.length} Azure subscriptions. Which one should ${params.project.name} run in (and be billed to)?` };
  };
  const planFor = (session: AzureSignInSession, subscription: AzureSubscription) =>
    planAzureSetup(session, { subscription, project: params.project.name, location, environments, ...(repository ? { repository } : {}) });

  let finished: AzureConnectResult | undefined;
  let early: AzureConnectResult | undefined;
  const signedIn = await signInToAzure({
    ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}), ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
    context: { project: params.project.name, ...(repository ? { repository } : {}), purpose: `set up Hypervibe on your Azure subscription for ${params.project.name}` },
    // One sign-in, one click: with a single subscription the person approves the exact changes right after signing in.
    review: async (session) => {
      const subscription = await choose(session);
      if ('status' in subscription) { early = subscription; return undefined; }
      const plan = await planFor(session, subscription);
      const pending = plan.changes.filter((change) => change.state !== 'ok');
      return {
        // The person knows their app, not Azure region codes: the app leads, the region is a small aside.
        titleHtml: `Set up Hypervibe for ${escapeHtml(params.project.name)}`,
        leadHtml: `Hypervibe creates its own limited access in your Azure subscription <span title="Subscription ${escapeHtml(subscription.subscriptionId)}">${escapeHtml(subscription.displayName)}</span> and stops using this sign-in. These cost nothing. `
          + `<span class="muted small nowrap" title="The Azure region (a group of data centers) where Hypervibe runs this app. Hypervibe picked it; there is nothing to choose.">Region: ${escapeHtml(location)}</span>`,
        items: pending.map((change) => escapeHtml(change.change)),
        approveLabel: `Approve and set up (${pending.length} change${pending.length === 1 ? '' : 's'})`,
        apply: async () => {
          finished = await finishSetup(params.project, session, plan);
          return { ok: finished.status === 'connected', message: finished.message };
        },
      };
    },
  });
  if (signedIn.status !== 'signed_in') return signedIn;
  if (finished) return finished;
  const subscription = early ?? await choose(signedIn.session);
  if ('status' in subscription) return subscription;
  const plan = await planFor(signedIn.session, subscription);
  if (params.approved && params.subscriptionId === subscription.subscriptionId) return finishSetup(params.project, signedIn.session, plan);
  return {
    status: 'needs_approval', subscriptionId: subscription.subscriptionId, subscriptionName: subscription.displayName, location, signedInAs: plan.signedInAs,
    changes: plan.changes.map(({ id, change, state }) => ({ id, change, state })),
    message: `Signed in to Azure as ${plan.signedInAs}. Approve these ${plan.changes.filter((change) => change.state !== 'ok').length} changes in ${subscription.displayName} to set up Hypervibe's access (they cost nothing).`,
  };
}

async function finishSetup(project: Project, session: AzureSignInSession, plan: AzureSetupPlan): Promise<AzureConnectResult> {
  const scope = parseGitHubRepoFromRemote(project.gitRemoteUrl ?? undefined) ?? project.name;
  // Reuse this computer's secret for the same deploy identity while it is valid for another month.
  const secretStore = getSecretStore();
  const stored = new ConnectionRepository().findAllByProvider('azure').map((connection) => {
    try { return AzureEngineCredentialsSchema.parse(secretStore.decryptObject(connection.credentialsEncrypted)); } catch { return undefined; }
  }).find((credentials) => credentials?.subscriptionId === plan.subscriptionId && credentials.resourceGroup === plan.resourceGroup
    && Date.parse(credentials.clientSecretExpiresAt) - Date.now() > 30 * 24 * 3600 * 1000);
  const applied = await applyAzureSetup(session, plan, { createSecret: !stored });
  const secret = applied.secret ? { clientSecret: applied.secret.value, clientSecretExpiresAt: applied.secret.expiresAt }
    : stored && stored.clientId === applied.clientId ? { clientSecret: stored.clientSecret, clientSecretExpiresAt: stored.clientSecretExpiresAt } : undefined;
  if (!secret) return { status: 'failed', message: 'Hypervibe could not create or find its Azure client secret. Run setup again.' };
  const saved = await saveConnection('azure', {
    tenantId: plan.tenantId, subscriptionId: plan.subscriptionId, clientId: applied.clientId, deployPrincipalId: applied.servicePrincipalId, ...secret, resourceGroup: plan.resourceGroup, location: plan.location,
  }, scope, { credentialsSource: 'azure-setup' });
  if (!saved.success) return { status: 'failed', message: 'Azure access was created, but Hypervibe could not save it on this computer. Run setup again; it reuses what exists.' };
  const verified = await verifyConnection('azure', scope);
  if (verified.kind !== 'verified') return { status: 'failed', message: 'Azure access was created and saved, but the deploy identity could not be used yet. Run setup again in a few minutes.' };
  return { status: 'connected', subscriptionId: plan.subscriptionId, location: plan.location, resourceGroup: plan.resourceGroup,
    message: `Hypervibe can now deploy ${project.name} to Azure (${plan.subscriptionName}, ${plan.location}). The sign-in is no longer used.` };
}

/** Azure's guided connection as one engine step; `input.azureSubscriptionId` chooses and `input.azureApproved` approves. */
export async function connectAzureStep(params: { project: Project; spec?: ProjectSpec; input: Record<string, unknown> }): Promise<EngineConnectStep> {
  const subscriptionId = typeof params.input.azureSubscriptionId === 'string' ? params.input.azureSubscriptionId : undefined;
  const approved = params.input.azureApproved === true;
  if (approved && !subscriptionId) return { status: 'invalid', result: {}, message: 'azureApproved needs the azureSubscriptionId from the preview.' };
  const result = await connectAzure({ project: params.project, ...(params.spec ? { spec: params.spec } : {}),
    ...(subscriptionId ? { subscriptionId } : {}), ...(approved ? { approved: true } : {}) });
  if (result.status === 'needs_subscription') {
    return { status: 'needs_choice', result,
      hint: 'Ask the user which subscription to use (it is billed for the app); list each by name. Then call again with azureSubscriptionId set to their choice.',
      ask: 'Ask the user which Azure subscription the app should run in and be billed to.' };
  }
  if (result.status === 'needs_approval') {
    return { status: 'needs_approval', result,
      hint: 'Show the user the subscription, region and each change in one short list, then ask them to approve. On approval call again with azureSubscriptionId set to this subscriptionId and azureApproved=true.',
      ask: `Ask the user to approve setting up Hypervibe in Azure subscription ${result.subscriptionName}.` };
  }
  if (result.status === 'waiting') {
    return { status: 'waiting', result, hint: 'Tell the user an Azure sign-in page is open in their browser (give the link). Call action="connect" again after they sign in.',
      ask: 'Ask the user to sign in to Azure in the browser tab that opened, then continue.' };
  }
  return result.status === 'connected' ? { status: 'connected', result, next: ['hv_spec'] } : { status: 'failed', result, message: result.message };
}
