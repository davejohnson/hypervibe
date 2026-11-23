import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import {
  awsRemovalClients, readAwsSetup, removeAwsSetupItems, type AwsKeptSnapshot, type AwsRemovalClients, type AwsSetupItem, type AwsSetupNote,
} from '../adapters/providers/aws/aws-setup-removal.client.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { getDataDir } from '../adapters/storage/paths.js';
import type { Project } from '../domain/entities/project.entity.js';
import { signInToAws, type AwsSignInResult, type AwsSignInSession } from './aws-sign-in.js';

export interface AwsSetupRemovalDependencies {
  /** The same in-memory administrator sign-in that setup uses. */
  signIn: (params: { region: string; accountId: string; project: string }) => Promise<AwsSignInResult>;
  clients: (session: AwsSignInSession) => AwsRemovalClients;
  now: () => number;
  dataDir?: string;
}

export interface AwsSetupRemovalResult {
  success: boolean;
  mode: 'preview' | 'confirm';
  /** `blocked`: nothing was deleted. `pending`: a removal stopped part-way; `removed` and `notRemoved` say where. */
  status?: 'blocked' | 'pending';
  error?: string;
  message?: string;
  awsAccountId?: string;
  previewId?: string;
  /** Preview: exactly what confirming deletes, in order. */
  willDelete?: string[];
  removed?: string[];
  notRemoved?: string[];
  /** Has an expected name but is not (only) Hypervibe's, so it stays. */
  leftAlone?: AwsSetupNote[];
  /** Database snapshots: they hold data and are never deleted here. */
  leftBehind?: AwsKeptSnapshot[];
  /** What still depends on the setup and stops the removal. */
  found?: string[];
  /** Regions searched for databases and snapshots. */
  regionsChecked?: string[];
  warnings?: string[];
  removedConnections?: string[];
  /** Open this to sign in to AWS, then call again. */
  signInUrl?: string;
}

const PREVIEW_MINUTES = 10;
const environmentRepo = new EnvironmentRepository();
const projectRepo = new ProjectRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** What Hypervibe records locally about the account: environments in any project, saved access, and regions it ran in. */
function localRecords(accountId: string) {
  const environments: string[] = []; const regions = new Set<string>();
  for (const project of projectRepo.findAll()) {
    for (const environment of environmentRepo.findByProjectId(project.id)) {
      const bindings = asRecord(environment.platformBindings);
      // Teardown stamps the environment and empties its engine record; a later deploy fills the engine record again.
      const tornDown = typeof asRecord(bindings.aws).tornDownAt === 'string' && !Object.keys(asRecord(bindings.engine)).length;
      // An AWS environment whose account is not readable counts: unknown is not "somewhere else".
      if (bindings.provider === 'aws' && !tornDown && (bindings.projectId === accountId || typeof bindings.projectId !== 'string')) environments.push(`${project.name}/${environment.name}`);
      // A torn-down environment's final snapshot region is searched whichever account it was in.
      const snapshotRegion = asRecord(asRecord(bindings.aws).finalSnapshot).region;
      if (typeof snapshotRegion === 'string' && /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(snapshotRegion)) regions.add(snapshotRegion);
    }
  }
  const connections: Array<{ id: string; scope: string }> = [];
  for (const connection of connectionRepo.findAllByProvider('aws')) {
    let saved: { accountId?: unknown; region?: unknown };
    try { saved = getSecretStore().decryptObject<{ accountId?: unknown; region?: unknown }>(connection.credentialsEncrypted); } catch { continue; }
    if (saved.accountId !== accountId) continue;
    connections.push({ id: connection.id, scope: connection.scope ?? 'global' });
    if (typeof saved.region === 'string' && /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(saved.region)) regions.add(saved.region);
  }
  return { environments, connections, regions: [...regions].sort() };
}

const defaultDependencies: AwsSetupRemovalDependencies = {
  signIn: ({ region, accountId, project }) => signInToAws({ region, context: { project, purpose: `remove Hypervibe's setup from AWS account ${accountId}` } }),
  clients: awsRemovalClients,
  now: () => Date.now(),
};

/**
 * Removes Hypervibe's one-time setup from an AWS account once nothing depends on
 * it. Preview first; confirming needs that preview's id, every check is made
 * again against AWS, and only the exact list that was previewed is deleted.
 * Database snapshots are data and are never deleted here.
 */
export async function runAwsSetupRemoval(
  params: { project: Project; awsAccountId?: string; previewId?: string; confirm?: boolean },
  overrides: Partial<AwsSetupRemovalDependencies> = {},
): Promise<AwsSetupRemovalResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const mode = params.confirm === true ? 'confirm' : 'preview';
  const accountId = params.awsAccountId?.trim() ?? '';
  const blocked = (error: string, extra: Partial<AwsSetupRemovalResult> = {}): AwsSetupRemovalResult =>
    ({ success: false, mode, status: 'blocked', error, ...(accountId ? { awsAccountId: accountId } : {}), ...extra });
  if (!/^\d{12}$/.test(accountId)) return blocked('Give the exact 12-digit AWS account id as awsAccountId.');
  if (mode === 'confirm' && !params.previewId) return blocked('Preview the removal first, then confirm with that preview\'s previewId.');
  if (mode === 'preview' && params.previewId) return blocked('previewId is only used when confirming.');

  const previewFile = path.join(deps.dataDir ?? getDataDir(), 'aws-setup-removal', `${accountId}.json`);
  const records = localRecords(accountId);
  if (records.environments.length) {
    return blocked(`These environments still run in AWS account ${accountId}: ${records.environments.join(', ')}. Tear each one down first (hv_plan scope="teardown").`,
      { found: records.environments.map((name) => `environment ${name}`) });
  }

  let signedIn: AwsSignInResult;
  try { signedIn = await deps.signIn({ region: records.regions[0] ?? 'us-east-1', accountId, project: params.project.name }); } catch { return blocked('Hypervibe could not sign in to AWS.'); }
  if (signedIn.status === 'waiting') return blocked(`Sign in to AWS account ${accountId} as an administrator, then run this again: ${signedIn.url}`, { signInUrl: signedIn.url });
  if (signedIn.status !== 'signed_in') return blocked('The AWS sign-in did not finish. Run this again to sign in.');
  if (signedIn.session.accountId !== accountId) {
    return blocked(`You are signed in to AWS account ${signedIn.session.accountId}, not ${accountId}. Nothing was changed. Run this again once that sign-in has ended, and sign in to ${accountId}.`);
  }
  const clients = deps.clients(signedIn.session);

  const setup = await readAwsSetup(clients, accountId, records.regions);
  if (setup.state === 'unknown') return blocked(`${setup.reason} What is in the account is unknown, so nothing was deleted.`);
  if (setup.blockers.length) {
    return blocked(`AWS account ${accountId} still holds things that need Hypervibe's setup, so nothing was deleted. Tear down the environments they belong to first.`, { found: setup.blockers });
  }
  const forget = setup.localUserGoes ? records.connections : [];
  const fingerprint = createHash('sha256').update(JSON.stringify([setup.items.map((item) => [item.label, item.steps.map((step) => step.what)]), forget.map((entry) => entry.id)])).digest('hex');
  const details = {
    awsAccountId: accountId, regionsChecked: records.regions,
    ...(setup.leftAlone.length ? { leftAlone: setup.leftAlone } : {}), ...(setup.snapshots.length ? { leftBehind: setup.snapshots } : {}),
  };
  const kept = [
    ...(setup.leftAlone.length ? [`Left alone because ${setup.leftAlone.length === 1 ? 'it does' : 'they do'} not look like only Hypervibe's: ${setup.leftAlone.map((entry) => `${entry.name} (${entry.reason}) ${entry.url}`).join('; ')}.`] : []),
    ...(setup.snapshots.length ? [`Database snapshots hold your data and are kept; they cost a little to store. Delete them yourself when you no longer need them: ${setup.snapshots.map((entry) => `${entry.identifier} (${entry.region}) ${entry.url}`).join('; ')}.`] : []),
    records.regions.length ? `Hypervibe looked for databases and snapshots only in ${records.regions.join(', ')}, where it has run from this computer.`
      : 'Hypervibe has no record of a region for this account, so it did not look for databases or snapshots.',
  ];

  if (mode === 'preview') {
    const previewId = randomUUID();
    fs.mkdirSync(path.dirname(previewFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(previewFile, JSON.stringify({ previewId, accountId, fingerprint, expiresAt: deps.now() + PREVIEW_MINUTES * 60_000 }), { mode: 0o600 });
    return { success: true, mode, ...details, previewId, willDelete: setup.items.map((item) => item.label),
      message: setup.items.length ? `Nothing is deleted yet. Confirming deletes ${setup.items.length} thing${setup.items.length === 1 ? '' : 's'} Hypervibe set up in AWS account ${accountId}.`
        : `Nothing of Hypervibe's is left to delete in AWS account ${accountId}.${forget.length ? ' Confirming removes the access saved on this computer.' : ''}`,
      warnings: [
        ...kept,
        ...(setup.items.length ? ['This cannot be undone. Every computer and GitHub repository that deploys to this account through Hypervibe loses access. Setting up again takes one sign-in.'] : []),
        ...(forget.length ? [`Hypervibe will also remove the AWS access saved on this computer (${forget.map((entry) => entry.scope).join(', ')}).`] : []),
      ] };
  }

  let saved: { previewId?: unknown; accountId?: unknown; fingerprint?: unknown; expiresAt?: unknown } | undefined;
  try { saved = JSON.parse(fs.readFileSync(previewFile, 'utf8')) as typeof saved; } catch { saved = undefined; }
  // A preview is used once, whatever happens next.
  fs.rmSync(previewFile, { force: true });
  if (!saved || saved.previewId !== params.previewId || saved.accountId !== accountId || typeof saved.expiresAt !== 'number' || saved.expiresAt < deps.now()) {
    return blocked('That preview is missing, expired or for a different account. Preview the removal again.', details);
  }
  if (saved.fingerprint !== fingerprint) return blocked('What would be removed has changed since the preview, so nothing was deleted. Preview the removal again.', details);

  const outcome = await removeAwsSetupItems(clients, setup.items);
  if (outcome.failed) {
    const notRemoved = setup.items.map((item: AwsSetupItem) => item.label).filter((label) => !outcome.removed.includes(label));
    auditRepo.create({ action: 'aws.setup.removal-stopped', resourceType: 'project', resourceId: params.project.id, details: { awsAccountId: accountId, removed: outcome.removed, notRemoved, step: outcome.failed.step, error: outcome.failed.error } });
    return { success: false, mode, status: 'pending', ...details, removed: outcome.removed, notRemoved,
      error: `The removal stopped: AWS did not confirm "${outcome.failed.step}" (${outcome.failed.error}). ${outcome.removed.length ? `Removed so far: ${outcome.removed.join('; ')}.` : 'Nothing was fully removed.'} Preview the removal again to finish; it picks up where this stopped.` };
  }
  const removedConnections: string[] = [];
  for (const entry of forget) {
    if (!connectionRepo.delete(entry.id)) continue;
    removedConnections.push(`aws (${entry.scope})`);
    auditRepo.create({ action: 'connection.deleted', resourceType: 'connection', resourceId: entry.id, details: { provider: 'aws', scope: entry.scope, reason: 'aws-setup-removed' } });
  }
  auditRepo.create({ action: 'aws.setup.removed', resourceType: 'project', resourceId: params.project.id, details: { awsAccountId: accountId, removed: outcome.removed, leftAlone: setup.leftAlone.map((entry) => entry.name), leftBehind: setup.snapshots.map((entry) => entry.identifier), removedConnections } });
  return { success: true, mode, ...details, removed: outcome.removed, removedConnections,
    message: `${setup.leftAlone.length ? 'Hypervibe removed what it set up' : 'Hypervibe\'s setup is removed'} from AWS account ${accountId}${removedConnections.length ? ', and its saved access is removed from this computer' : ''}.`,
    warnings: kept };
}
