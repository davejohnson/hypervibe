import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { AzureEngineCredentialsSchema, type AzureEngineCredentials } from '../adapters/providers/azure/azure-engine.adapter.js';
import { azureDeployAppName, azureResourceGroupName } from '../adapters/providers/azure/azure-setup.client.js';
import {
  azureRemovalTokens, deleteAzureCiRoles, deleteAzureDirectoryObject, deleteAzureProjectVault, deleteAzureResourceGroup, deleteAzureRoleAssignments,
  purgeAzureProjectVault, readAzureGroupContents, readAzureSetup,
  type AzureRemovalOutcome, type AzureRemovalTokens, type AzureSetupRemovalTarget,
} from '../adapters/providers/azure/azure-setup-removal.client.js';
import { azureProjectVaultName } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { getDataDir } from '../adapters/storage/paths.js';
import type { Project } from '../domain/entities/project.entity.js';
import { signInToAzure, type AzureSignInResult, type AzureSignInSession } from './azure-sign-in.js';

export interface AzureSetupRemovalDependencies {
  /** The same browser sign-in setup uses: a subscription Owner, tokens in memory only. */
  signIn: (project: Project) => Promise<AzureSignInResult>;
  tokens: (session: AzureSignInSession, tenantId: string, fetchImpl: typeof fetch) => Promise<AzureRemovalTokens>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  dataDir?: string;
}

export interface AzureSetupRemovalResult {
  success: boolean;
  mode: 'preview' | 'confirm';
  /** `blocked`: nothing was deleted. `pending`: a deletion was sent and its outcome could not be read. */
  status?: 'blocked' | 'pending';
  error?: string;
  message?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  previewId?: string;
  /** Present while Hypervibe waits for the person to sign in. */
  signInUrl?: string;
  /** Exactly what confirming deletes, in order. */
  willDelete?: string[];
  /** Deletions that cannot be undone, listed apart from the rest. */
  willPurge?: string[];
  /** What stays in Azure afterwards, and why. */
  leftBehind?: string[];
  /** What still depends on the setup and stops the removal. */
  found?: string[];
  removed?: string[];
  notRemoved?: string[];
  warnings?: string[];
  removedConnections?: string[];
}

const PREVIEW_MINUTES = 10;
const environmentRepo = new EnvironmentRepository();
const projectRepo = new ProjectRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Environments Hypervibe still records on Azure for any project that uses this resource group. A torn-down one keeps only `tornDownAt`. */
function recordedEnvironments(resourceGroup: string): string[] {
  return projectRepo.findAll().filter((project) => azureResourceGroupName(project.name) === resourceGroup)
    .flatMap((project) => environmentRepo.findByProjectId(project.id)
      .filter((environment) => Object.keys(asRecord(asRecord(environment.platformBindings).azure)).some((key) => key !== 'tornDownAt'))
      .map((environment) => `${project.name}/${environment.name}`));
}

/** The access setup saved on this computer for the project's resource group: the record of what setup created. */
function savedSetups(resourceGroup: string, subscriptionId: string): Array<{ id: string; scope: string | null; credentials: AzureEngineCredentials }> {
  return connectionRepo.findAllByProvider('azure').flatMap((connection) => {
    try {
      const credentials = AzureEngineCredentialsSchema.parse(getSecretStore().decryptObject(connection.credentialsEncrypted));
      return credentials.resourceGroup === resourceGroup && (!subscriptionId || credentials.subscriptionId.toLowerCase() === subscriptionId) ? [{ id: connection.id, scope: connection.scope ?? null, credentials }] : [];
    } catch { return []; }
  });
}

const defaultDependencies: AzureSetupRemovalDependencies = {
  signIn: (project) => signInToAzure({ context: { project: project.name, purpose: `remove Hypervibe's setup for ${project.name} from your Azure subscription` } }),
  tokens: azureRemovalTokens, fetch: (...args) => globalThis.fetch(...args), now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

interface Step { id: string; text: string; run: () => Promise<AzureRemovalOutcome> }

/**
 * Removes what one-time Azure setup created for a project, once nothing depends
 * on it: the deploy identity's roles, the fixed CI roles, the project Key Vault,
 * the resource group, and the deploy app with its service principal. Preview
 * first; confirming needs that preview's id, and everything is read again from
 * Azure before the first delete.
 */
export async function runAzureSetupRemoval(
  params: { project: Project; subscriptionId?: string; previewId?: string; confirm?: boolean },
  overrides: Partial<AzureSetupRemovalDependencies> = {},
): Promise<AzureSetupRemovalResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const mode = params.confirm === true ? 'confirm' : 'preview';
  const requested = params.subscriptionId?.trim().toLowerCase() ?? '';
  const resourceGroup = azureResourceGroupName(params.project.name);
  const blocked = (error: string, extra: Partial<AzureSetupRemovalResult> = {}): AzureSetupRemovalResult => ({ success: false, mode, status: 'blocked', error, resourceGroup, ...extra });
  if (requested && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requested)) return blocked('azureSubscriptionId is not a subscription id.');
  if (mode === 'confirm' && (!params.previewId || !requested)) return blocked('Preview the removal first, then confirm with that preview\'s previewId and subscriptionId.');
  if (mode === 'preview' && params.previewId) return blocked('previewId is only used when confirming.');

  const saved = savedSetups(resourceGroup, requested);
  const distinct = new Set(saved.map(({ credentials }) => [credentials.tenantId, credentials.subscriptionId, credentials.clientId, credentials.deployPrincipalId].join('|').toLowerCase()));
  if (!saved.length) return blocked(`Hypervibe has no saved Azure setup for ${params.project.name}${requested ? ` in subscription ${requested}` : ''} on this computer, so it has no record of what it created and will not delete anything.`);
  if (distinct.size > 1) return blocked(`Hypervibe has more than one saved Azure setup for ${params.project.name}. ${requested ? 'They disagree about what setup created, so nothing was deleted.' : `Say which subscription with azureSubscriptionId: ${[...new Set(saved.map(({ credentials }) => credentials.subscriptionId))].join(', ')}.`}`);
  const { tenantId, subscriptionId, clientId, deployPrincipalId } = saved[0]!.credentials;
  const target: AzureSetupRemovalTarget = { tenantId, subscriptionId, resourceGroup, clientId, servicePrincipalId: deployPrincipalId,
    vaultName: azureProjectVaultName(subscriptionId, params.project.name), appName: azureDeployAppName(params.project.name) };
  const portal = `https://portal.azure.com/#@${tenantId}/resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const base = { subscriptionId, resourceGroup };

  const environments = recordedEnvironments(resourceGroup);
  if (environments.length) return blocked(`These environments still run on this Azure setup: ${environments.join(', ')}. Tear each one down first (hv_plan scope="teardown").`, { ...base, found: environments.map((name) => `environment ${name}`) });

  let signedIn: AzureSignInResult;
  try { signedIn = await deps.signIn(params.project); } catch { return blocked('Hypervibe could not open the Azure sign-in page.', base); }
  if (signedIn.status === 'waiting') return blocked(`Sign in to Azure as an Owner of the subscription in the page that opened (${signedIn.url}), then run this again. Nothing was deleted.`, { ...base, signInUrl: signedIn.url });
  if (signedIn.status !== 'signed_in') return blocked(`The Azure sign-in did not finish (${signedIn.message}). Nothing was deleted.`, base);
  let tokens: AzureRemovalTokens;
  // Entra's own reasons carry no token; azureTokenFor already strips trace ids.
  try { tokens = await deps.tokens(signedIn.session, tenantId, deps.fetch); } catch (error) { return blocked(`${error instanceof Error ? error.message : 'Microsoft did not issue a token.'} Nothing was deleted.`, base); }
  const wait = { sleep: deps.sleep };

  const seen = await readAzureSetup(deps.fetch, tokens, target);
  if (seen.state === 'unknown') return blocked(`${seen.reason} What exists in Azure is unknown, so nothing was deleted.`, base);
  if (seen.group === 'not-ours') return blocked(`A resource group named ${resourceGroup} exists but does not carry Hypervibe's setup tag, so Hypervibe left it and everything else alone. Look at it here: ${portal}/overview`, base);
  if (seen.application && !seen.application.ours) return blocked(`The app registration Hypervibe saved (${clientId}) is no longer named ${target.appName} or tagged as Hypervibe's, so nothing was deleted.`, base);
  if (seen.servicePrincipal === 'not-ours') return blocked('The deploy identity Hypervibe saved does not belong to its app registration, so nothing was deleted.', base);
  const strangers = seen.ciRoles.filter((role) => !role.ours).map((role) => role.name);
  if (strangers.length) return blocked(`These roles no longer match what Hypervibe's setup created, so nothing was deleted: ${strangers.join(', ')}.`, base);
  if (seen.otherResources.length) {
    return blocked(`Resource group ${resourceGroup} still holds things Hypervibe's setup did not create, so nothing was deleted. Remove them first: ${portal}/overview`, { ...base, found: seen.otherResources });
  }
  if (seen.otherGroupAssignments.length) {
    return blocked(`Someone other than Hypervibe's deploy identity still has access to resource group ${resourceGroup}, so nothing was deleted. Remove that access first: ${portal}/users`, { ...base, found: seen.otherGroupAssignments });
  }
  if (seen.identityAssignmentsElsewhere.length) {
    return blocked('Hypervibe\'s deploy identity was given access outside its resource group, which setup never does. Something else may use it, so nothing was deleted.', { ...base, found: seen.identityAssignmentsElsewhere.map((scope) => `access on ${scope}`) });
  }

  const purge = Boolean(seen.vault ? !seen.vault.purgeProtected : seen.deletedVault && !seen.deletedVault.purgeProtected);
  const kept: string[] = [];
  const steps: Step[] = [];
  if (seen.identityAssignments.length) steps.push({ id: `roles:${seen.identityAssignments.join(',')}`, text: `The deploy identity's ${seen.identityAssignments.length} role assignment(s) on ${resourceGroup}`,
    run: () => deleteAzureRoleAssignments(deps.fetch, tokens, seen.identityAssignments, wait) });
  if (seen.ciRoles.length) steps.push({ id: `ci-roles:${seen.ciRoles.map((role) => role.guid).join(',')}`, text: `Custom roles: ${seen.ciRoles.map((role) => role.name).join(', ')}`,
    run: () => deleteAzureCiRoles(deps.fetch, tokens, target, seen.ciRoles.map((role) => role.guid), seen.group === 'ours', wait) });
  let vaultDeletedNow = false;
  if (seen.vault) steps.push({ id: 'key-vault', text: `Key Vault ${target.vaultName} and every secret still in it`, run: async () => {
    const outcome = await deleteAzureProjectVault(deps.fetch, tokens, target, wait);
    vaultDeletedNow = outcome.state === 'removed';
    return outcome;
  } });
  const purgeStep: Step = { id: 'key-vault-purge', text: `Purge the deleted Key Vault ${target.vaultName}: its secrets cannot be recovered afterwards, and its name becomes free to use again`,
    run: () => purgeAzureProjectVault(deps.fetch, tokens, target, wait, vaultDeletedNow) };
  if (purge) steps.push(purgeStep);
  if (seen.group === 'ours') steps.push({ id: 'resource-group', text: `Resource group ${resourceGroup}`, run: async () => {
    // Read again right before the delete: a group that gained anything since the preview is not deleted.
    const now = await readAzureGroupContents(deps.fetch, tokens, target);
    if ('reason' in now) return { state: 'failed', reason: now.reason };
    if (now.contents.length) return { state: 'failed', reason: `Resource group ${resourceGroup} is not empty (${now.contents.slice(0, 10).join(', ')}), so it was not deleted.` };
    return deleteAzureResourceGroup(deps.fetch, tokens, target, wait);
  } });
  const directory = (kind: 'applications' | 'servicePrincipals', objectId: string, what: string) => async (): Promise<AzureRemovalOutcome> => {
    const outcome = await deleteAzureDirectoryObject(deps.fetch, tokens, kind, objectId, what, wait);
    if (outcome.state === 'removed' && outcome.kept) kept.push(`${what} is deleted, but Microsoft keeps it in deleted items for 30 days before removing it for good. To remove it now, open Deleted applications: https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade`);
    return outcome;
  };
  if (seen.servicePrincipal === 'ours') steps.push({ id: 'service-principal', text: `The deploy identity (service principal of ${target.appName}), for good`, run: directory('servicePrincipals', deployPrincipalId, 'The deploy identity') });
  if (seen.application) steps.push({ id: 'application', text: `App registration ${target.appName}, with its client secret and GitHub sign-in, for good`, run: directory('applications', seen.application.objectId, `App registration ${target.appName}`) });

  const vaults = 'https://portal.azure.com/#browse/Microsoft.KeyVault%2Fvaults';
  const leftBehind = ['The Azure services that setup turned on in the subscription (such as Microsoft.App) stay on: they are free, and other apps in the subscription may use them.'];
  if (seen.vault?.purgeProtected) leftBehind.push(`Key Vault ${target.vaultName} has purge protection, so Azure keeps it soft-deleted for ${seen.vault.retentionDays} days after it is deleted and then removes it. Until then its name cannot be reused. See it under Key vaults, Manage deleted vaults: ${vaults}`);
  else if (!seen.vault && seen.deletedVault?.purgeProtected) leftBehind.push(`Key Vault ${target.vaultName} is soft-deleted and has purge protection. Azure removes it${seen.deletedVault.scheduledPurgeDate ? ` on ${seen.deletedVault.scheduledPurgeDate.slice(0, 10)}` : ' when its retention ends'}; until then its name cannot be reused. See it under Key vaults, Manage deleted vaults: ${vaults}`);
  if (seen.sameNameApplication) leftBehind.push(`An app registration named ${target.appName} (${seen.sameNameApplication}) is not the one Hypervibe's setup saved, so it is left alone.`);

  const previewFile = path.join(deps.dataDir ?? getDataDir(), 'azure-setup-removal', `${params.project.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const reviewedPlan = JSON.stringify([tenantId, subscriptionId, resourceGroup, clientId, deployPrincipalId, ...steps.map((step) => step.id)]);
  const willDelete = steps.filter((step) => step !== purgeStep).map((step) => step.text);
  const willPurge = purge ? [purgeStep.text] : [];
  const forget = (): string[] => saved.flatMap((entry) => {
    if (!connectionRepo.delete(entry.id)) return [];
    auditRepo.create({ action: 'connection.deleted', resourceType: 'connection', resourceId: entry.id, details: { provider: 'azure', scope: entry.scope, reason: 'azure-setup-removed' } });
    return [`azure (${entry.scope ?? 'global'})`];
  });

  if (mode === 'preview') {
    const previewId = randomUUID();
    fs.mkdirSync(path.dirname(previewFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(previewFile, JSON.stringify({ previewId, plan: reviewedPlan, expiresAt: deps.now() + PREVIEW_MINUTES * 60_000 }), { mode: 0o600 });
    return { success: true, mode, ...base, previewId, willDelete, willPurge, leftBehind,
      message: steps.length
        ? `Nothing depends on Hypervibe's Azure setup for ${params.project.name} any more. Confirming deletes the ${steps.length} thing(s) listed, in that order.`
        : `Nothing of Hypervibe's Azure setup for ${params.project.name} is left in Azure. Confirming removes the access saved on this computer.`,
      warnings: [
        ...(seen.vault ? [`Deleting Key Vault ${target.vaultName} deletes every secret still in it, including keys you added yourself.${purge ? ' Purging it makes that permanent.' : ''}`] : []),
        'Hypervibe will also remove its saved Azure access for this project from this computer. Deploying to Azure again needs a new setup.',
      ] };
  }

  let reviewed = false;
  try {
    const stored = JSON.parse(fs.readFileSync(previewFile, 'utf8')) as { previewId?: unknown; plan?: unknown; expiresAt?: unknown };
    reviewed = stored.previewId === params.previewId && stored.plan === reviewedPlan && typeof stored.expiresAt === 'number' && stored.expiresAt >= deps.now();
  } catch { /* no preview */ }
  // A preview is used once, whatever happens next.
  fs.rmSync(previewFile, { force: true });
  if (!reviewed) return blocked('That preview is missing, expired, or Azure no longer matches it. Preview the removal again.', base);

  const removed: string[] = [];
  for (const [index, step] of steps.entries()) {
    const outcome = await step.run();
    if (outcome.state === 'removed') { removed.push(step.text); continue; }
    const notRemoved = steps.slice(index).map((later) => later.text);
    auditRepo.create({ action: 'azure.setup.removal-stopped', resourceType: 'project', resourceId: params.project.id, details: { ...base, removed, notRemoved, outcome: outcome.state } });
    return { success: false, mode, ...(outcome.state === 'unconfirmed' ? { status: 'pending' as const } : {}), ...base, removed, notRemoved, ...(kept.length ? { leftBehind: kept } : {}),
      error: `${outcome.reason} Hypervibe stopped there${removed.length ? `, after removing ${removed.length} thing(s)` : ' and removed nothing'}. Preview the removal again to see what is left and finish.` };
  }
  const removedConnections = forget();
  auditRepo.create({ action: 'azure.setup.removed', resourceType: 'project', resourceId: params.project.id, details: { ...base, clientId, removed, removedConnections } });
  return { success: true, mode, ...base, removed, removedConnections, leftBehind: [...leftBehind, ...kept],
    message: `Hypervibe's Azure setup for ${params.project.name} is removed${removed.length ? '' : ' (nothing of it was left in Azure)'}, along with its saved access on this computer.` };
}
