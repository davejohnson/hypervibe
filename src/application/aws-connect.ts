import { AwsEngineCredentialsSchema, type AwsEngineCredentials } from '../adapters/providers/aws/aws-engine.adapter.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { signInToAws, type AwsSignInSession } from './aws-sign-in.js';
import { escapeHtml } from './local-paste-page.js';
import { ACCOUNT_DEPLOY_ROLE, applyAwsSetup, awsAccessCurrent, planAwsSetup, retireProjectRoles, type AwsSetupChange, type AwsSetupPlan } from './aws-setup.js';
import { awsEngineAuthentication } from '../adapters/providers/aws/tofu/aws-engine.backend.js';

/** Closest AWS region to the app's other environments; us-east-1 otherwise (newest services launch there first). */
export function chooseAwsRegion(spec?: ProjectSpec): string {
  const regions = Object.values(spec?.environments ?? {}).map((environment) => (environment as { hosting?: { region?: string } }).hosting?.region ?? '');
  const near: Array<[RegExp, string]> = [
    [/^(europe-west[0-9]*|eu-west-)/, 'eu-west-1'], [/^(europe-north|europe-central|eu-central|eu-north)/, 'eu-central-1'],
    [/^(asia-northeast1|ap-northeast-1)/, 'ap-northeast-1'], [/^(asia-southeast|ap-southeast-1)/, 'ap-southeast-1'], [/^(australia|ap-southeast-2)/, 'ap-southeast-2'],
    [/^(us-west|northamerica-northeast2)/, 'us-west-2'],
  ];
  for (const region of regions) for (const [pattern, aws] of near) if (pattern.test(region)) return aws;
  return 'us-east-1';
}

export type AwsConnectResult =
  | { status: 'waiting'; url: string; message: string }
  | { status: 'failed'; message: string }
  | { status: 'needs_approval'; accountId: string; region: string; signedInAs: string; changes: Array<Pick<AwsSetupChange, 'id' | 'change' | 'state'>>; message: string }
  | { status: 'connected'; accountId: string; region: string; roleArn: string; message: string };

/**
 * One-time AWS setup for a project: sign in once, preview the exact access
 * Hypervibe will create, and (with the approved accountId) create it, store
 * the local key encrypted and verify the deploy role works.
 */
export async function connectAws(params: {
  project: Project;
  spec?: ProjectSpec;
  /** The exact account from a chat preview; present only after the person approves there. */
  approveAccountId?: string;
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<AwsConnectResult> {
  const region = chooseAwsRegion(params.spec);
  const repo = parseGitHubRepoFromRemote(params.project.gitRemoteUrl ?? params.spec?.gitRemoteUrl) ?? undefined;
  // Access is per account: a new project reuses it without signing in, unless it needs an update.
  const reused = await reuseAccountAccess(params.project, repo);
  if (reused) return reused;
  const planFor = (session: AwsSignInSession) => planAwsSetup(session, { project: params.project.name, region, ...(repo ? { repository: repo } : {}) });
  let finished: AwsConnectResult | undefined;
  const signedIn = await signInToAws({
    region, ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}), ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
    context: { project: params.project.name, ...(repo ? { repository: repo } : {}), purpose: `set up Hypervibe on your AWS account for ${params.project.name}` },
    // One sign-in, one click: the person approves the exact changes on the page right after signing in.
    review: async (session) => {
      const plan = await planFor(session);
      const pending = plan.changes.filter((change) => change.state !== 'ok');
      return {
        titleHtml: `Set up Hypervibe in ${escapeHtml(region)}`,
        leadHtml: `Hypervibe creates its own limited access in account ${escapeHtml(plan.accountId)} and stops using this sign-in. These cost nothing.`,
        items: (pending.length ? pending : plan.changes).map((change) => escapeHtml(change.change)),
        approveLabel: pending.length ? `Approve and set up (${pending.length} change${pending.length === 1 ? '' : 's'})` : 'Confirm and save access',
        apply: async () => {
          finished = await finishSetup(params.project, session, plan, repo);
          return { ok: finished.status === 'connected', message: finished.message };
        },
      };
    },
  });
  if (signedIn.status !== 'signed_in') return signedIn;
  if (finished) return finished;
  const plan = await planFor(signedIn.session);
  if (params.approveAccountId === plan.accountId) return finishSetup(params.project, signedIn.session, plan, repo);
  return {
    status: 'needs_approval', accountId: plan.accountId, region, signedInAs: plan.signedInAs,
    changes: plan.changes.map(({ id, change, state }) => ({ id, change, state })),
    message: `Signed in to AWS account ${plan.accountId}. Approve these ${plan.changes.filter((change) => change.state !== 'ok').length} changes to set up Hypervibe's access (they cost nothing).`,
  };
}

/** The scope a connection is saved under: every repository of the GitHub owner, or the project when it has no remote. */
export function awsConnectionScope(project: Pick<Project, 'name'>, repo?: string): string {
  return repo ? `${repo.split('/')[0]}/*` : project.name;
}

/**
 * Reuses the account-wide deploy role for another project: no sign-in, no AWS
 * change. Only when exactly one AWS account is connected (otherwise the person
 * picks by signing in to it) and its access is current for this Hypervibe.
 */
async function reuseAccountAccess(project: Project, repo?: string): Promise<AwsConnectResult | undefined> {
  const secretStore = getSecretStore();
  const repository = new ConnectionRepository();
  const accounts = new Map<string, AwsEngineCredentials>();
  for (const connection of repository.findAllByProvider('aws').filter((entry) => entry.status === 'verified')) {
    try {
      const credentials = AwsEngineCredentialsSchema.parse(secretStore.decryptObject(connection.credentialsEncrypted));
      if (credentials.roleArn.endsWith(`:role/hypervibe/${ACCOUNT_DEPLOY_ROLE}`)) accounts.set(credentials.accountId, credentials);
    } catch { /* not deploy access */ }
  }
  if (accounts.size !== 1) return undefined;
  const credentials = [...accounts.values()][0]!;
  let auth;
  try { auth = await awsEngineAuthentication(credentials); } catch { return undefined; }
  const access = await awsAccessCurrent({ accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! }, credentials.accountId);
  if (access !== 'current') return undefined;
  const scope = awsConnectionScope(project, repo);
  const existing = repository.findBestVerifiedMatch('aws', repo ?? project.name);
  if (!existing || existing.scope !== scope) {
    const saved = await saveConnection('aws', credentials, scope, { credentialsSource: 'aws-setup' });
    if (!saved.success) return undefined;
    const verified = await verifyConnection('aws', scope);
    if (verified.kind !== 'verified') return undefined;
  }
  return { status: 'connected', accountId: credentials.accountId, region: credentials.region, roleArn: credentials.roleArn,
    message: `Hypervibe already has access to AWS account ${credentials.accountId} (${credentials.region}) and uses it for ${project.name}; no sign-in needed.` };
}

async function finishSetup(project: Project, session: AwsSignInSession, plan: AwsSetupPlan, repo?: string): Promise<AwsConnectResult> {
  // The local key belongs to the account-wide hypervibe-local user; reuse it when another project already stored it.
  const secretStore = getSecretStore();
  const stored = new ConnectionRepository().findAllByProvider('aws').map((connection) => {
    try { return AwsEngineCredentialsSchema.parse(secretStore.decryptObject(connection.credentialsEncrypted)); } catch { return undefined; }
  }).find((credentials): credentials is AwsEngineCredentials => credentials?.accountId === plan.accountId);
  const applied = await applyAwsSetup(session, plan, { hasStoredKey: Boolean(stored) });
  const key = applied.key ?? (stored ? { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey } : undefined);
  if (!key) return { status: 'failed', message: 'Hypervibe could not create or find its AWS access key.' };
  const scope = awsConnectionScope(project, repo);
  const saved = await saveConnection('aws', { ...key, roleArn: applied.roleArn, accountId: plan.accountId, region: plan.region }, scope, { credentialsSource: 'aws-setup' });
  if (!saved.success) return { status: 'failed', message: 'AWS access was created, but Hypervibe could not save it on this computer. Run setup again; it reuses what exists.' };
  const verified = await verifyConnection('aws', scope);
  if (verified.kind !== 'verified') return { status: 'failed', message: 'AWS access was created and saved, but the deploy role could not be used yet. Run setup again in a minute.' };
  // Every other project on this account moves to the account role, then the per-project roles go.
  for (const connection of new ConnectionRepository().findAllByProvider('aws')) {
    if (connection.scope === scope) continue;
    let credentials: AwsEngineCredentials;
    try { credentials = AwsEngineCredentialsSchema.parse(secretStore.decryptObject(connection.credentialsEncrypted)); } catch { continue; }
    if (credentials.accountId !== plan.accountId || credentials.roleArn === applied.roleArn) continue;
    const moved = await saveConnection('aws', { ...credentials, ...key, roleArn: applied.roleArn }, connection.scope ?? undefined, { credentialsSource: 'aws-setup' });
    if (!moved.success) return { status: 'failed', message: 'AWS access was updated, but another project\'s saved access could not be moved to it. Run setup again.' };
  }
  if (plan.retiringRoles.length) await retireProjectRoles(session, plan);
  return { status: 'connected', accountId: plan.accountId, region: plan.region, roleArn: applied.roleArn,
    message: `Hypervibe can now deploy ${project.name} to AWS account ${plan.accountId} (${plan.region}). The sign-in is no longer used.` };
}
