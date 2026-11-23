import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environments: Record<string, Array<{ name: string; platformBindings: Record<string, unknown> }>> = {};
const connections: Array<{ id: string; provider: string; scope: string; credentialsEncrypted: string }> = [];
const audits: Array<{ action: string; details?: unknown }> = [];
vi.mock('../../adapters/db/repositories/environment.repository.js', () => ({ EnvironmentRepository: class { findByProjectId(id: string) { return environments[id] ?? []; } } }));
vi.mock('../../adapters/db/repositories/project.repository.js', () => ({ ProjectRepository: class { findAll() { return [{ id: 'p1', name: 'demo' }, { id: 'p2', name: 'billforge' }]; } } }));
vi.mock('../../adapters/db/repositories/connection.repository.js', () => ({ ConnectionRepository: class {
  findAllByProvider(provider: string) { return connections.filter((entry) => entry.provider === provider); }
  delete(id: string) { const index = connections.findIndex((entry) => entry.id === id); if (index < 0) return false; connections.splice(index, 1); return true; }
} }));
vi.mock('../../adapters/db/repositories/audit.repository.js', () => ({ AuditRepository: class { create(entry: { action: string }) { audits.push(entry); } } }));
vi.mock('../../adapters/secrets/secret-store.js', () => ({ getSecretStore: () => ({ decryptObject: (value: string) => JSON.parse(value) }) }));
vi.mock('../aws-sign-in.js', () => ({ signInToAws: vi.fn() }));

const { runAwsSetupRemoval } = await import('../aws-setup-removal.js');

const ACCOUNT = '123456789012';
const SESSION_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const project = { id: 'p1', name: 'demo' } as never;
const TAGS = [{ Key: 'managed-by', Value: 'hypervibe' }];
const DEPLOY_POLICY = `arn:aws:iam::${ACCOUNT}:policy/hypervibe/hypervibe-deploy`;
const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/hypervibe/hypervibe-app-boundary`;
const ECS_POLICY = 'arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices';
const OIDC = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const githubTrust = (subjects: string | string[]) => ({ Sid: 'GitHubActions', Effect: 'Allow', Principal: { Federated: OIDC }, Action: 'sts:AssumeRoleWithWebIdentity',
  Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' }, StringLike: { 'token.actions.githubusercontent.com:sub': subjects } } });

/**
 * A stand-in AWS account that answers in the shapes of AWS's API reference, not of
 * Hypervibe's code. IAM: ListRoles (no Tags; AssumeRolePolicyDocument URL-encoded per
 * RFC 3986), GetRole, ListAttachedRolePolicies, ListRolePolicies, GetPolicy
 * (AttachmentCount, PermissionsBoundaryUsageCount), ListEntitiesForPolicy,
 * ListPolicyVersions, GetUser, ListAccessKeys, ListUserPolicies,
 * ListAttachedUserPolicies, ListGroupsForUser, ListOpenIDConnectProviders,
 * GetOpenIDConnectProvider. Missing things raise NoSuchEntity. Deletes refuse with
 * DeleteConflict exactly where the API reference says they do: DeleteRole with a
 * policy attached, DeletePolicy while attached or with a non-default version,
 * DeleteUser with an access key or inline policy. RDS: DescribeDBClusters and
 * DescribeDBClusterSnapshots (lists under DBClusters / DBClusterSnapshots, a Marker
 * only while more exists).
 */
interface Role { Path: string; Tags?: typeof TAGS; trust: unknown; attached: string[]; inline: string[]; boundary?: string }
interface Account {
  roles: Record<string, Role>;
  policies: Record<string, { Description?: string; versions: string[] }>;
  users: Record<string, { Path: string; Tags?: typeof TAGS; keys: string[]; inline: string[]; attached: string[]; groups: string[] }>;
  oidc: Record<string, { Tags?: typeof TAGS }>;
  clusters: Record<string, Array<{ DBClusterIdentifier: string; TagList?: typeof TAGS }>>;
  snapshots: Record<string, Array<{ DBClusterSnapshotIdentifier: string; TagList?: typeof TAGS }>>;
  calls: string[];
  /** Command name -> what happens instead of the normal answer. */
  instead: Record<string, () => unknown>;
}
const missing = () => new NoSuchEntityException({ message: 'The entity cannot be found.', $metadata: {} });
const refuse = (name: string) => Object.assign(new Error(`${name}: request refused`), { name });

function account(): Account {
  return {
    roles: {
      'hypervibe-deploy': { Path: '/hypervibe/', Tags: TAGS, attached: [DEPLOY_POLICY], inline: [], trust: { Version: '2012-10-17', Statement: [
        { Sid: 'ThisComputer', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 'sts:AssumeRole', Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${ACCOUNT}:user/hypervibe/hypervibe-local` } } },
        // IAM hands a one-entry condition list back as a bare string.
        githubTrust('repo:davejohnson/*'),
      ] } },
      'hypervibe-web-infrastructure': { Path: '/hypervibe/', Tags: TAGS, attached: [ECS_POLICY], inline: [], trust: { Version: '2012-10-17', Statement: [
        { Sid: 'AllowAccessInfrastructureForECSExpressServices', Effect: 'Allow', Principal: { Service: 'ecs.amazonaws.com' }, Action: 'sts:AssumeRole' }] } },
      OrganizationAccountAccessRole: { Path: '/', attached: ['arn:aws:iam::aws:policy/AdministratorAccess'], inline: [], trust: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'sts:AssumeRole' }] } },
    },
    policies: { [DEPLOY_POLICY]: { Description: 'Hypervibe: deploy and run apps', versions: ['v1', 'v2', 'v3'] }, [BOUNDARY]: { Description: 'Hypervibe: the most any app role may do', versions: ['v1'] } },
    users: { 'hypervibe-local': { Path: '/hypervibe/', Tags: TAGS, keys: [KEY_ID], inline: ['assume-hypervibe-deploy-roles'], attached: [], groups: [] } },
    oidc: { [OIDC]: { Tags: TAGS } },
    clusters: {}, snapshots: { 'us-west-2': [{ DBClusterSnapshotIdentifier: 'hv-demo-shared-postgres-final', TagList: TAGS }, { DBClusterSnapshotIdentifier: 'my-own-backup' }] },
    calls: [], instead: {},
  };
}

function clientsFor(aws: Account) {
  const usersOf = (arn: string) => Object.entries(aws.roles).filter(([, role]) => role.attached.includes(arn) || role.boundary === arn).map(([RoleName]) => ({ RoleName, RoleId: `AROA${RoleName}` }));
  const iam = { send: async (command: { constructor: { name: string }; input: Record<string, string> }) => {
    const name = command.constructor.name.replace(/Command$/, ''); const input = command.input;
    aws.calls.push(`${name} ${input.RoleName ?? input.UserName ?? input.PolicyArn?.split('/').at(-1) ?? input.OpenIDConnectProviderArn?.split('/').at(-1) ?? ''}`.trim());
    if (aws.instead[name]) return aws.instead[name]!();
    const role = input.RoleName ? aws.roles[input.RoleName] : undefined;
    const policy = input.PolicyArn ? aws.policies[input.PolicyArn] : undefined;
    const user = input.UserName ? aws.users[input.UserName] : undefined;
    const roleShape = (RoleName: string, entry: Role) => ({ Path: entry.Path, RoleName, RoleId: `AROA${RoleName}`, Arn: `arn:aws:iam::${ACCOUNT}:role${entry.Path}${RoleName}`, CreateDate: new Date(0),
      AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(entry.trust)) });
    switch (name) {
      case 'ListRoles': return { Roles: Object.entries(aws.roles).map(([RoleName, entry]) => roleShape(RoleName, entry)), IsTruncated: false };
      case 'GetRole': if (!role) throw missing(); return { Role: { ...roleShape(input.RoleName!, role), ...(role.Tags ? { Tags: role.Tags } : {}) } };
      case 'ListAttachedRolePolicies': if (!role) throw missing(); return { AttachedPolicies: role.attached.map((PolicyArn) => ({ PolicyName: PolicyArn.split('/').at(-1), PolicyArn })), IsTruncated: false };
      case 'ListRolePolicies': if (!role) throw missing(); return { PolicyNames: role.inline, IsTruncated: false };
      case 'DetachRolePolicy': if (!role || !role.attached.includes(input.PolicyArn!)) throw missing(); role.attached = role.attached.filter((arn) => arn !== input.PolicyArn); return {};
      case 'DeleteRole': if (!role) throw missing(); if (role.attached.length || role.inline.length) throw refuse('DeleteConflictException'); delete aws.roles[input.RoleName!]; return {};
      case 'GetPolicy': if (!policy) throw missing(); return { Policy: { PolicyName: input.PolicyArn!.split('/').at(-1), PolicyId: 'ANPAEXAMPLE', Arn: input.PolicyArn, Path: '/hypervibe/', DefaultVersionId: policy.versions.at(-1),
        AttachmentCount: Object.values(aws.roles).filter((entry) => entry.attached.includes(input.PolicyArn!)).length, PermissionsBoundaryUsageCount: Object.values(aws.roles).filter((entry) => entry.boundary === input.PolicyArn).length,
        IsAttachable: true, ...(policy.Description ? { Description: policy.Description } : {}), Tags: [] } };
      case 'ListEntitiesForPolicy': if (!policy) throw missing(); return { PolicyGroups: [], PolicyUsers: [], PolicyRoles: usersOf(input.PolicyArn!), IsTruncated: false };
      case 'ListPolicyVersions': if (!policy) throw missing(); return { Versions: policy.versions.map((VersionId, index) => ({ VersionId, IsDefaultVersion: index === policy.versions.length - 1, CreateDate: new Date(0) })), IsTruncated: false };
      case 'DeletePolicyVersion': if (!policy || !policy.versions.includes(input.VersionId!)) throw missing(); if (policy.versions.at(-1) === input.VersionId) throw refuse('DeleteConflictException'); policy.versions = policy.versions.filter((id) => id !== input.VersionId); return {};
      case 'DeletePolicy': if (!policy) throw missing(); if (usersOf(input.PolicyArn!).length || policy.versions.length > 1) throw refuse('DeleteConflictException'); delete aws.policies[input.PolicyArn!]; return {};
      case 'GetUser': if (!user) throw missing(); return { User: { Path: user.Path, UserName: input.UserName, UserId: 'AIDAEXAMPLE', Arn: `arn:aws:iam::${ACCOUNT}:user${user.Path}${input.UserName}`, CreateDate: new Date(0), ...(user.Tags ? { Tags: user.Tags } : {}) } };
      case 'ListAccessKeys': if (!user) throw missing(); return { AccessKeyMetadata: user.keys.map((AccessKeyId) => ({ UserName: input.UserName, AccessKeyId, Status: 'Active', CreateDate: new Date(0) })), IsTruncated: false };
      case 'ListUserPolicies': if (!user) throw missing(); return { PolicyNames: user.inline, IsTruncated: false };
      case 'ListAttachedUserPolicies': if (!user) throw missing(); return { AttachedPolicies: user.attached.map((PolicyArn) => ({ PolicyName: PolicyArn.split('/').at(-1), PolicyArn })), IsTruncated: false };
      case 'ListGroupsForUser': if (!user) throw missing(); return { Groups: user.groups.map((GroupName) => ({ GroupName, Path: '/', GroupId: 'AGPAEXAMPLE', Arn: `arn:aws:iam::${ACCOUNT}:group/${GroupName}`, CreateDate: new Date(0) })), IsTruncated: false };
      case 'DeleteAccessKey': if (!user || !user.keys.includes(input.AccessKeyId!)) throw missing(); user.keys = user.keys.filter((id) => id !== input.AccessKeyId); return {};
      case 'DeleteUserPolicy': if (!user || !user.inline.includes(input.PolicyName!)) throw missing(); user.inline = user.inline.filter((id) => id !== input.PolicyName); return {};
      case 'DeleteUser': if (!user) throw missing(); if (user.keys.length || user.inline.length) throw refuse('DeleteConflictException'); delete aws.users[input.UserName!]; return {};
      case 'ListOpenIDConnectProviders': return { OpenIDConnectProviderList: Object.keys(aws.oidc).map((Arn) => ({ Arn })) };
      case 'GetOpenIDConnectProvider': { const found = aws.oidc[input.OpenIDConnectProviderArn!]; if (!found) throw missing();
        return { Url: 'token.actions.githubusercontent.com', ClientIDList: ['sts.amazonaws.com'], ThumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'], CreateDate: new Date(0), ...(found.Tags ? { Tags: found.Tags } : {}) }; }
      case 'DeleteOpenIDConnectProvider': if (!aws.oidc[input.OpenIDConnectProviderArn!]) throw missing(); delete aws.oidc[input.OpenIDConnectProviderArn!]; return {};
      default: throw new Error(`The stand-in account has no ${name}.`);
    }
  } };
  const rds = (region: string) => ({ send: async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name.replace(/Command$/, '');
    aws.calls.push(`${name} ${region}`);
    if (aws.instead[name]) return aws.instead[name]!();
    if (name === 'DescribeDBClusters') return { DBClusters: aws.clusters[region] ?? [] };
    if (name === 'DescribeDBClusterSnapshots') return { DBClusterSnapshots: (aws.snapshots[region] ?? []).map((entry) => ({ ...entry, SnapshotType: 'manual', Status: 'available' })) };
    throw new Error(`The stand-in account has no ${name}.`);
  } });
  return { iam, rds };
}

let dataDir: string;
let now: number;
const signIn = vi.fn();
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-aws-removal-')); now = 1_000_000;
  for (const key of Object.keys(environments)) delete environments[key];
  connections.length = 0; audits.length = 0;
  connections.push({ id: 'c1', provider: 'aws', scope: 'davejohnson/*', credentialsEncrypted: JSON.stringify({ accountId: ACCOUNT, region: 'us-west-2', accessKeyId: KEY_ID, secretAccessKey: SESSION_SECRET }) },
    { id: 'c2', provider: 'aws', scope: 'demo', credentialsEncrypted: JSON.stringify({ accountId: ACCOUNT, region: 'us-west-2' }) },
    { id: 'c3', provider: 'aws', scope: 'acme/*', credentialsEncrypted: JSON.stringify({ accountId: '210987654321', region: 'eu-west-1' }) });
  signIn.mockReset();
  signIn.mockResolvedValue({ status: 'signed_in', session: { accessKeyId: 'ASIAEXAMPLESESSION00', secretAccessKey: SESSION_SECRET, sessionToken: 'session-token-value', accountId: ACCOUNT, identityArn: `arn:aws:iam::${ACCOUNT}:root`, expiresAt: '2099-01-01T00:00:00Z' } });
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const run = (aws: Account, input: { previewId?: string; confirm?: boolean } = {}) =>
  runAwsSetupRemoval({ project, awsAccountId: ACCOUNT, ...input }, { signIn, clients: () => clientsFor(aws) as never, now: () => now, dataDir });
const changes = (aws: Account) => aws.calls.filter((call) => /^(Delete|Detach|Put|Create|Update|Attach)/.test(call));
const untouched = (aws: Account) => { expect(changes(aws)).toEqual([]); expect(connections).toHaveLength(3); };
async function confirmed(aws: Account) {
  const preview = await run(aws);
  expect(preview.success).toBe(true);
  return run(aws, { previewId: preview.previewId, confirm: true });
}

describe('removing Hypervibe\'s setup from an AWS account', () => {
  it('previews exactly what it will delete and changes nothing', async () => {
    const aws = account();
    const preview = await run(aws);
    expect(preview).toMatchObject({ success: true, mode: 'preview', awsAccountId: ACCOUNT, previewId: expect.any(String), regionsChecked: ['us-west-2'] });
    expect(preview.willDelete).toEqual([
      'User hypervibe-local and its access key',
      'Role hypervibe-deploy, which Hypervibe deploys with',
      'Role hypervibe-web-infrastructure, which Amazon ECS manages web services with',
      'Policy hypervibe-deploy: what the deploy role may do',
      'Policy hypervibe-app-boundary: the limit on app roles',
      'GitHub sign-in for AWS (the keyless link GitHub Actions deployed through)',
    ]);
    // Only the snapshot Hypervibe took is named, and only as kept, with a link to it.
    expect(preview.leftBehind).toEqual([{ identifier: 'hv-demo-shared-postgres-final', region: 'us-west-2', url: expect.stringMatching(/^https:\/\/us-west-2\.console\.aws\.amazon\.com\/rds\/home\?region=us-west-2#/) }]);
    expect(preview.warnings!.join(' ')).toContain('davejohnson/*, demo');
    untouched(aws);
    expect(signIn).toHaveBeenCalledWith({ region: 'us-west-2', accountId: ACCOUNT, project: 'demo' });
  });

  it('deletes in dependency order on confirm, keeps the snapshot and forgets only this account\'s saved access', async () => {
    const aws = account();
    const result = await confirmed(aws);
    expect(result).toMatchObject({ success: true, mode: 'confirm', removedConnections: ['aws (davejohnson/*)', 'aws (demo)'] });
    // The stand-in refuses a delete made out of order (DeleteConflict), so this order is the one AWS accepts.
    expect(changes(aws)).toEqual([
      'DeleteAccessKey hypervibe-local', 'DeleteUserPolicy hypervibe-local', 'DeleteUser hypervibe-local',
      'DetachRolePolicy hypervibe-deploy', 'DeleteRole hypervibe-deploy',
      'DetachRolePolicy hypervibe-web-infrastructure', 'DeleteRole hypervibe-web-infrastructure',
      'DeletePolicyVersion hypervibe-deploy', 'DeletePolicyVersion hypervibe-deploy', 'DeletePolicy hypervibe-deploy',
      'DeletePolicy hypervibe-app-boundary',
      'DeleteOpenIDConnectProvider token.actions.githubusercontent.com',
    ]);
    expect(Object.keys(aws.roles)).toEqual(['OrganizationAccountAccessRole']);
    expect([aws.policies, aws.users, aws.oidc]).toEqual([{}, {}, {}]);
    expect(aws.snapshots['us-west-2']).toHaveLength(2);
    expect(result.leftBehind).toHaveLength(1);
    expect(connections.map((entry) => entry.id)).toEqual(['c3']);
    expect(audits.map((entry) => entry.action)).toEqual(['connection.deleted', 'connection.deleted', 'aws.setup.removed']);
    // Neither the sign-in nor the saved key reaches the result or the audit trail.
    expect(JSON.stringify([result, audits])).not.toMatch(new RegExp(`${KEY_ID}|session-token-value|ASIAEXAMPLESESSION00|${SESSION_SECRET.replace(/[/+]/g, '.')}`));
  });

  it('is blocked, before any sign-in, while any Hypervibe project records an environment in the account', async () => {
    environments.p2 = [{ name: 'test', platformBindings: { provider: 'aws', projectId: ACCOUNT, environmentId: 'us-west-2' } },
      { name: 'old', platformBindings: { aws: { tornDownAt: '2026-11-12T00:00:00Z', finalSnapshot: { identifier: 'hv-billforge-shared-postgres-final', region: 'us-east-1' } } } }];
    environments.p1 = [{ name: 'elsewhere', platformBindings: { provider: 'aws', projectId: '210987654321' } }];
    const aws = account();
    const result = await run(aws);
    expect(result).toMatchObject({ success: false, status: 'blocked', found: ['environment billforge/test'] });
    expect(result.error).toContain('hv_plan scope="teardown"');
    expect(signIn).not.toHaveBeenCalled(); expect(aws.calls).toEqual([]);
  });

  it('is blocked while AWS still shows an app\'s roles, an older deploy role or a Hypervibe database', async () => {
    const aws = account();
    aws.roles['hv-demo-test-web'] = { Path: '/hypervibe/app/', attached: [], inline: [], trust: {}, boundary: BOUNDARY };
    aws.roles['hypervibe-deploy-billforge'] = { Path: '/hypervibe/', Tags: TAGS, attached: [DEPLOY_POLICY], inline: [], trust: {} };
    aws.clusters['us-west-2'] = [{ DBClusterIdentifier: 'hv-demo-shared-postgres' }, { DBClusterIdentifier: 'renamed', TagList: TAGS }, { DBClusterIdentifier: 'their-own-database' }];
    const result = await run(aws);
    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(result.found).toEqual(['roles of an app that still runs here: hv-demo-test-web', expect.stringContaining('hypervibe-deploy-billforge'), 'databases in us-west-2: hv-demo-shared-postgres, renamed']);
    untouched(aws);
  });

  it.each([
    ['a refused read', 'ListEntitiesForPolicy', () => { throw refuse('AccessDeniedException'); }],
    ['no answer at all', 'GetUser', () => { throw new TypeError('fetch failed'); }],
    ['a list cut short with no way to continue', 'ListRoles', () => ({ Roles: [], IsTruncated: true })],
    ['an answer without its list', 'ListOpenIDConnectProviders', () => ({})],
    ['a policy whose use count disagrees with its listed users', 'ListEntitiesForPolicy', () => ({ PolicyGroups: [], PolicyUsers: [], PolicyRoles: [], IsTruncated: false })],
    ['an unreadable database list', 'DescribeDBClusters', () => { throw refuse('AccessDenied'); }],
    ['an unreadable snapshot list', 'DescribeDBClusterSnapshots', () => ({ DBClusterSnapshots: [{}] })],
  ])('treats %s as unknown and deletes nothing, on preview and on confirm', async (_what, command, answer) => {
    const aws = account();
    const preview = await run(aws);
    aws.instead[command] = answer;
    for (const result of [await run(aws), await run(aws, { previewId: preview.previewId, confirm: true })]) {
      expect(result).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('unknown, so nothing was deleted') });
    }
    untouched(aws);
  });

  it('leaves alone anything with the expected name that is not only Hypervibe\'s, and whatever that still uses', async () => {
    const aws = account();
    // Someone gave the deploy role administrator access: it is no longer what setup made.
    aws.roles['hypervibe-deploy']!.attached.push('arn:aws:iam::aws:policy/AdministratorAccess');
    aws.users['hypervibe-local']!.Tags = undefined;
    const preview = await run(aws);
    expect(preview.willDelete).toEqual(['Role hypervibe-web-infrastructure, which Amazon ECS manages web services with', 'Policy hypervibe-app-boundary: the limit on app roles']);
    expect(preview.leftAlone).toEqual([
      { name: 'user hypervibe-local', reason: 'it does not carry Hypervibe\'s tag', url: 'https://console.aws.amazon.com/iam/home#/users/details/hypervibe-local' },
      { name: 'role hypervibe-deploy', reason: 'it has other policies attached (AdministratorAccess)', url: 'https://console.aws.amazon.com/iam/home#/roles/details/hypervibe-deploy' },
      { name: 'policy hypervibe-deploy', reason: 'it is still used by role hypervibe-deploy', url: expect.stringContaining('#/policies/details/') },
      { name: 'GitHub sign-in for AWS', reason: 'these roles still sign in through it: hypervibe-deploy', url: expect.stringContaining('#/identity_providers/details/OPENID/') },
    ]);
    const result = await run(aws, { previewId: preview.previewId, confirm: true });
    expect(result).toMatchObject({ success: true, removedConnections: [], leftAlone: expect.any(Array) });
    expect(changes(aws)).toEqual(['DetachRolePolicy hypervibe-web-infrastructure', 'DeleteRole hypervibe-web-infrastructure', 'DeletePolicy hypervibe-app-boundary']);
    // The local user stays, so the access saved for it stays too.
    expect(connections).toHaveLength(3);
  });

  it.each([
    ['a changed trust', (aws: Account) => { (aws.roles['hypervibe-deploy']!.trust as { Statement: unknown[] }).Statement.push({ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'sts:AssumeRole' }); }, 'role hypervibe-deploy'],
    ['a role outside /hypervibe/', (aws: Account) => { aws.roles['hypervibe-web-infrastructure']!.Path = '/'; }, 'role hypervibe-web-infrastructure'],
    ['a policy Hypervibe did not describe', (aws: Account) => { aws.policies[BOUNDARY]!.Description = undefined; }, 'policy hypervibe-app-boundary'],
    ['a user in a group', (aws: Account) => { aws.users['hypervibe-local']!.groups.push('admins'); }, 'user hypervibe-local'],
    ['a GitHub sign-in that existed before setup', (aws: Account) => { aws.oidc[OIDC]!.Tags = undefined; }, 'GitHub sign-in for AWS'],
    ['a GitHub sign-in another role uses', (aws: Account) => { aws.roles['terraform-ci'] = { Path: '/', attached: [], inline: [], trust: { Version: '2012-10-17', Statement: [githubTrust(['repo:acme/infra:ref:refs/heads/main'])] } }; }, 'GitHub sign-in for AWS'],
  ])('does not delete %s', async (_what, change, name) => {
    const aws = account(); change(aws);
    const preview = await run(aws);
    expect(preview.leftAlone!.map((entry) => entry.name)).toContain(name);
    expect((await run(aws, { previewId: preview.previewId, confirm: true })).success).toBe(true);
    if (name.startsWith('GitHub')) expect(aws.oidc[OIDC]).toBeDefined();
    else if (name.startsWith('policy')) expect(aws.policies[BOUNDARY]).toBeDefined();
    else if (name.startsWith('user')) expect(aws.users['hypervibe-local']).toBeDefined();
    else expect(aws.roles[name.split(' ')[1]!]).toBeDefined();
  });

  it('deletes nothing without the matching, unexpired, unused preview of the same list', async () => {
    const aws = account();
    expect(await run(aws, { confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('Preview the removal first') });
    const first = await run(aws);
    expect(await run(aws, { previewId: '6f1c2b1e-8f0a-4c56-9d55-0d1f3a6f6a10', confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('missing, expired') });
    // The wrong id used the preview up.
    expect(await run(aws, { previewId: first.previewId, confirm: true })).toMatchObject({ status: 'blocked' });
    const second = await run(aws);
    now += 10 * 60_000 + 1;
    expect(await run(aws, { previewId: second.previewId, confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('expired') });
    const third = await run(aws);
    // A second access key appeared after the preview: not the list that was approved.
    aws.users['hypervibe-local']!.keys.push('AKIAI44QH8DHBEXAMPLE');
    expect(await run(aws, { previewId: third.previewId, confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('has changed since the preview') });
    expect(await run(aws, { previewId: third.previewId })).toMatchObject({ status: 'blocked', error: 'previewId is only used when confirming.' });
    untouched(aws);
  });

  it('stops at the first delete AWS does not confirm, says what was and was not removed, and a second run finishes', async () => {
    const aws = account();
    aws.instead.DeletePolicy = () => { throw refuse('ServiceFailureException'); };
    const stopped = await confirmed(aws);
    expect(stopped).toMatchObject({ success: false, mode: 'confirm', status: 'pending',
      removed: ['User hypervibe-local and its access key', 'Role hypervibe-deploy, which Hypervibe deploys with', 'Role hypervibe-web-infrastructure, which Amazon ECS manages web services with'],
      notRemoved: ['Policy hypervibe-deploy: what the deploy role may do', 'Policy hypervibe-app-boundary: the limit on app roles', 'GitHub sign-in for AWS (the keyless link GitHub Actions deployed through)'] });
    expect(stopped.error).toContain('delete policy hypervibe-deploy'); expect(stopped.error).toContain('ServiceFailureException');
    // Nothing after the failed step was tried, and local access is kept until the removal is whole.
    expect(changes(aws).at(-1)).toBe('DeletePolicy hypervibe-deploy');
    expect(aws.oidc[OIDC]).toBeDefined(); expect(connections).toHaveLength(3);
    expect(audits.map((entry) => entry.action)).toEqual(['aws.setup.removal-stopped']);

    delete aws.instead.DeletePolicy;
    const again = await run(aws);
    // The deploy policy's older versions went before the failure; only what is left is offered.
    expect(again.willDelete).toEqual(['Policy hypervibe-deploy: what the deploy role may do', 'Policy hypervibe-app-boundary: the limit on app roles', 'GitHub sign-in for AWS (the keyless link GitHub Actions deployed through)']);
    const finished = await run(aws, { previewId: again.previewId, confirm: true });
    expect(finished).toMatchObject({ success: true, removedConnections: ['aws (davejohnson/*)', 'aws (demo)'] });
    expect([aws.policies, aws.users, aws.oidc]).toEqual([{}, {}, {}]);
  });

  it('counts a delete answered "no such entity" as done, so a removal whose answer was lost can finish', async () => {
    const aws = account();
    const preview = await run(aws);
    // Gone between the confirm's read and its delete call.
    aws.instead.DeleteOpenIDConnectProvider = () => { delete aws.oidc[OIDC]; throw missing(); };
    expect(await run(aws, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: true });
  });

  it('asks for the sign-in with a link, and refuses a sign-in to another account', async () => {
    const aws = account();
    signIn.mockResolvedValueOnce({ status: 'waiting', url: 'http://127.0.0.1:5123/abc/connect', message: 'waiting' });
    expect(await run(aws)).toMatchObject({ success: false, status: 'blocked', signInUrl: 'http://127.0.0.1:5123/abc/connect', error: expect.stringContaining('http://127.0.0.1:5123/abc/connect') });
    signIn.mockResolvedValueOnce({ status: 'signed_in', session: { accountId: '210987654321' } });
    expect(await run(aws)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('not 123456789012') });
    expect(await runAwsSetupRemoval({ project, awsAccountId: 'my-account' }, { signIn, dataDir })).toMatchObject({ status: 'blocked', error: expect.stringContaining('12-digit') });
    expect(aws.calls).toEqual([]);
  });

  it('says so when it knows no region to look for databases and snapshots in', async () => {
    connections.length = 0;
    const aws = account();
    const preview = await run(aws);
    expect(preview).toMatchObject({ success: true, regionsChecked: [] });
    expect(preview.leftBehind).toBeUndefined();
    expect(preview.warnings!.join(' ')).toContain('did not look for databases or snapshots');
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-1' }));
  });
});
