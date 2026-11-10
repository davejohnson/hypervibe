import { AwsEngineCredentialsSchema, type AwsEngineCredentials } from '../adapters/providers/aws/aws-engine.adapter.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { signInToAws, type AwsSignInSession } from './aws-sign-in.js';
import { escapeHtml } from './local-paste-page.js';
import { applyAwsSetup, planAwsSetup, type AwsSetupChange, type AwsSetupPlan } from './aws-setup.js';

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

async function finishSetup(project: Project, session: AwsSignInSession, plan: AwsSetupPlan, repo?: string): Promise<AwsConnectResult> {
  // The local key belongs to the account-wide hypervibe-local user; reuse it when another project already stored it.
  const secretStore = getSecretStore();
  const stored = new ConnectionRepository().findAllByProvider('aws').map((connection) => {
    try { return AwsEngineCredentialsSchema.parse(secretStore.decryptObject(connection.credentialsEncrypted)); } catch { return undefined; }
  }).find((credentials): credentials is AwsEngineCredentials => credentials?.accountId === plan.accountId);
  const applied = await applyAwsSetup(session, plan, { hasStoredKey: Boolean(stored) });
  const key = applied.key ?? (stored ? { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey } : undefined);
  if (!key) return { status: 'failed', message: 'Hypervibe could not create or find its AWS access key.' };
  const scope = repo ?? project.name;
  const saved = await saveConnection('aws', { ...key, roleArn: applied.roleArn, accountId: plan.accountId, region: plan.region }, scope, { credentialsSource: 'aws-setup' });
  if (!saved.success) return { status: 'failed', message: 'AWS access was created, but Hypervibe could not save it on this computer. Run setup again; it reuses what exists.' };
  const verified = await verifyConnection('aws', scope);
  if (verified.kind !== 'verified') return { status: 'failed', message: 'AWS access was created and saved, but the deploy role could not be used yet. Run setup again in a minute.' };
  return { status: 'connected', accountId: plan.accountId, region: plan.region, roleArn: applied.roleArn,
    message: `Hypervibe can now deploy ${project.name} to AWS account ${plan.accountId} (${plan.region}). The sign-in is no longer used.` };
}
