import {
  DeleteAccessKeyCommand, DeleteOpenIDConnectProviderCommand, DeletePolicyCommand, DeletePolicyVersionCommand, DeleteRoleCommand, DeleteUserCommand, DeleteUserPolicyCommand,
  DetachRolePolicyCommand, GetLoginProfileCommand, GetOpenIDConnectProviderCommand, GetPolicyCommand, GetRoleCommand, GetUserCommand, IAMClient, ListAccessKeysCommand, ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand, ListEntitiesForPolicyCommand, ListGroupsForUserCommand, ListInstanceProfilesForRoleCommand, ListMFADevicesCommand, ListOpenIDConnectProvidersCommand,
  ListPolicyVersionsCommand, ListRolePoliciesCommand, ListRolesCommand, ListServiceSpecificCredentialsCommand, ListSigningCertificatesCommand, ListSSHPublicKeysCommand, ListUserPoliciesCommand, NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { DescribeDBClusterSnapshotsCommand, DescribeDBClustersCommand, RDSClient } from '@aws-sdk/client-rds';
import type { AwsSignInSession } from './aws-signin.client.js';
import {
  ACCOUNT_DEPLOY_ROLE, AWS_APP_ROLE_PATH, AWS_PATH, BOUNDARY, DEPLOY_POLICY, GITHUB_OIDC_HOST, LOCAL_USER, LOCAL_USER_POLICY, WEB_INFRASTRUCTURE_POLICY, WEB_INFRASTRUCTURE_TRUST,
  deployTrustDocument, trustedGitHubOwners,
} from './aws-setup.client.js';
import { AWS_WEB_INFRASTRUCTURE_ROLE } from './tofu/aws-engine.config.js';

/**
 * Reads what one-time setup left in an AWS account and deletes it. Used only by
 * setup removal, with the same in-memory administrator sign-in setup used.
 *
 * Present, absent and unknown stay apart: only AWS's own "no such entity" answer
 * counts as absent, and any other failed or oddly shaped answer makes the whole
 * reading unknown. A name is only where to look; each thing must also match what
 * setup made (path, tag, trust, policies) before it is offered for deletion.
 */
export interface AwsSender { send(command: any): Promise<any> }
export interface AwsRemovalClients { iam: AwsSender; rds(region: string): AwsSender }

export interface AwsSetupItem {
  id: 'local-user' | 'deploy-role' | 'web-infrastructure-role' | 'deploy-policy' | 'boundary-policy' | 'github-oidc';
  /** What the person approves, in plain words. */
  label: string;
  /** The delete calls, in the order AWS needs them. */
  steps: Array<{ what: string; command: () => object }>;
}
export interface AwsSetupNote { name: string; reason: string; url: string }
export interface AwsKeptSnapshot { identifier: string; region: string; url: string }
export type AwsSetupReading =
  | { state: 'unknown'; reason: string }
  | { state: 'known'; items: AwsSetupItem[]; /** Still depends on the setup, so nothing may be removed. */ blockers: string[];
      /** Has an expected name but is not (only) Hypervibe's, so it stays. */ leftAlone: AwsSetupNote[];
      /** Final database snapshots: data, never deleted here. */ snapshots: AwsKeptSnapshot[];
      /** True when the local user is absent or about to be deleted, so the saved key is of no further use. */ localUserGoes: boolean };

const IAM_CONSOLE = 'https://console.aws.amazon.com/iam/home#';
const isMissing = (error: unknown) => error instanceof NoSuchEntityException || (error instanceof Error && (error.name === 'NoSuchEntityException' || error.name === 'NoSuchEntity'));
const errorName = (error: unknown) => error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : 'error';
const few = (names: string[]) => `${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}`;
const tagged = (tags: unknown) => Array.isArray(tags) && tags.some((tag) => tag?.Key === 'managed-by' && tag?.Value === 'hypervibe');
class Unreadable extends Error { override name = 'UnreadableAnswer'; }
const strings = (values: unknown[], key: string): string[] => values.map((value) => {
  const name = (value as Record<string, unknown> | undefined)?.[key];
  if (typeof name !== 'string' || !name) throw new Unreadable();
  return name;
});

/** AWS may return a one-entry list as a bare value and reorder keys; neither is a difference. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(canonical);
    return entries.length === 1 ? entries[0] : entries.every((entry) => typeof entry === 'string') ? [...entries as string[]].sort() : entries;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
const decoded = (document: unknown): unknown => { if (typeof document !== 'string') throw new Unreadable(); return JSON.parse(decodeURIComponent(document)); };
const sameDocument = (document: unknown, expected: unknown) => JSON.stringify(canonical(decoded(document))) === JSON.stringify(canonical(expected));

/** Every page of a list. A list that says more exists without saying where, or is not a list, is unreadable. */
async function pages(client: AwsSender, command: (marker?: string) => object, pick: (page: any) => unknown): Promise<unknown[]> {
  const all: unknown[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 200; page++) {
    const answer = await client.send(command(marker));
    const entries = pick(answer);
    if (!Array.isArray(entries)) throw new Unreadable();
    all.push(...entries);
    // IAM says IsTruncated; RDS only returns a Marker while more exists.
    const more = typeof answer.IsTruncated === 'boolean' ? answer.IsTruncated : Boolean(answer.Marker);
    if (!more) return all;
    if (typeof answer.Marker !== 'string' || !answer.Marker) throw new Unreadable();
    marker = answer.Marker;
  }
  throw new Unreadable();
}
async function orAbsent<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
/** One named thing, or undefined only when AWS says it does not exist. An answer without the thing in it is unreadable, not absent. */
async function one(client: AwsSender, command: object, key: string): Promise<any> {
  const answer = await orAbsent(() => client.send(command));
  if (answer === undefined) return undefined;
  if (!answer?.[key] || typeof answer[key] !== 'object') throw new Unreadable();
  return answer[key];
}

async function readRole(iam: AwsSender, name: string) {
  const role = await one(iam, new GetRoleCommand({ RoleName: name }), 'Role');
  if (!role) return undefined;
  if (role.RoleName !== name || typeof role.Path !== 'string') throw new Unreadable();
  const attached = strings(await pages(iam, (Marker) => new ListAttachedRolePoliciesCommand({ RoleName: name, Marker }), (page) => page.AttachedPolicies), 'PolicyArn');
  const inline = await pages(iam, (Marker) => new ListRolePoliciesCommand({ RoleName: name, Marker }), (page) => page.PolicyNames);
  // AWS refuses to delete a role that is still in an instance profile.
  const profiles = await pages(iam, (Marker) => new ListInstanceProfilesForRoleCommand({ RoleName: name, Marker }), (page) => page.InstanceProfiles);
  return { role, attached, inline, profiles };
}
function roleProblem(found: NonNullable<Awaited<ReturnType<typeof readRole>>>, expectedTrust: unknown, allowed: string): string | undefined {
  if (found.role.Path !== AWS_PATH) return `it is not under ${AWS_PATH}`;
  if (!tagged(found.role.Tags)) return 'it does not carry Hypervibe\'s tag';
  if (!sameDocument(found.role.AssumeRolePolicyDocument, expectedTrust)) return 'who may use it differs from what Hypervibe set';
  const extra = found.attached.filter((arn) => arn !== allowed);
  if (extra.length) return `it has other policies attached (${few(extra.map((arn) => arn.split('/').at(-1)!))})`;
  if (found.inline.length) return 'it has policies of its own that Hypervibe did not add';
  if (found.profiles.length) return 'servers use it through an instance profile Hypervibe did not add';
  return undefined;
}
const roleItem = (id: AwsSetupItem['id'], name: string, attached: string[], label: string): AwsSetupItem => ({ id, label, steps: [
  ...attached.map((arn) => ({ what: `detach ${arn.split('/').at(-1)} from ${name}`, command: () => new DetachRolePolicyCommand({ RoleName: name, PolicyArn: arn }) })),
  { what: `delete role ${name}`, command: () => new DeleteRoleCommand({ RoleName: name }) },
] });

async function readPolicy(iam: AwsSender, arn: string) {
  const policy = await one(iam, new GetPolicyCommand({ PolicyArn: arn }), 'Policy');
  if (!policy) return undefined;
  if (policy.Arn !== arn || typeof policy.AttachmentCount !== 'number' || typeof policy.PermissionsBoundaryUsageCount !== 'number') throw new Unreadable();
  // No usage filter: both ordinary attachments and uses as a permissions boundary are listed.
  const users = (await pages(iam, (Marker) => new ListEntitiesForPolicyCommand({ PolicyArn: arn, Marker }), (page) => {
    if (![page.PolicyRoles, page.PolicyUsers, page.PolicyGroups].every(Array.isArray)) return undefined;
    return [...strings(page.PolicyRoles, 'RoleName').map((name) => `role ${name}`), ...strings(page.PolicyUsers, 'UserName').map((name) => `user ${name}`), ...strings(page.PolicyGroups, 'GroupName').map((name) => `group ${name}`)];
  })) as string[];
  // The two answers must agree, or something uses the policy that the list did not show.
  if (users.length !== policy.AttachmentCount + policy.PermissionsBoundaryUsageCount) throw new Unreadable();
  const versions = await pages(iam, (Marker) => new ListPolicyVersionsCommand({ PolicyArn: arn, Marker }), (page) => page.Versions) as Array<{ VersionId?: unknown; IsDefaultVersion?: unknown }>;
  if (versions.some((version) => typeof version?.VersionId !== 'string' || typeof version.IsDefaultVersion !== 'boolean')) throw new Unreadable();
  return { policy, users, older: versions.filter((version) => !version.IsDefaultVersion).map((version) => version.VersionId as string) };
}

/** What setup left in the account and what still depends on it. `regions` are where Hypervibe is known to have run. */
export async function readAwsSetup(clients: AwsRemovalClients, accountId: string, regions: string[]): Promise<AwsSetupReading> {
  const { iam } = clients;
  const items: AwsSetupItem[] = []; const blockers: string[] = []; const leftAlone: AwsSetupNote[] = []; const snapshots: AwsKeptSnapshot[] = [];
  const note = (name: string, reason: string, url: string) => { leftAlone.push({ name, reason, url }); };
  const planned = (id: AwsSetupItem['id']) => items.some((item) => item.id === id);
  let reading = 'the account\'s roles';
  try {
    const roles = await pages(iam, (Marker) => new ListRolesCommand({ Marker }), (page) => page.Roles) as Array<{ RoleName: string; Path: string; AssumeRolePolicyDocument?: unknown }>;
    strings(roles, 'RoleName'); strings(roles, 'Path');
    // Every environment has runtime roles here, in whatever region it runs and whichever computer made it.
    const appRoles = roles.filter((role) => role.Path.startsWith(AWS_APP_ROLE_PATH)).map((role) => role.RoleName);
    if (appRoles.length) blockers.push(`roles of an app that still runs here: ${few(appRoles)}`);
    const olderRoles = roles.filter((role) => role.Path === AWS_PATH && role.RoleName.startsWith(`${ACCOUNT_DEPLOY_ROLE}-`)).map((role) => role.RoleName);
    if (olderRoles.length) blockers.push(`deploy roles from an earlier Hypervibe version: ${few(olderRoles)} (run hv_connections provider="aws" action="connect" once to replace them)`);

    reading = `user ${LOCAL_USER}`;
    const user = await one(iam, new GetUserCommand({ UserName: LOCAL_USER }), 'User');
    if (user) {
      if (user.UserName !== LOCAL_USER || typeof user.Path !== 'string') throw new Unreadable();
      const keys = strings(await pages(iam, (Marker) => new ListAccessKeysCommand({ UserName: LOCAL_USER, Marker }), (page) => page.AccessKeyMetadata), 'AccessKeyId');
      const inline = await pages(iam, (Marker) => new ListUserPoliciesCommand({ UserName: LOCAL_USER, Marker }), (page) => page.PolicyNames) as string[];
      const attached = await pages(iam, (Marker) => new ListAttachedUserPoliciesCommand({ UserName: LOCAL_USER, Marker }), (page) => page.AttachedPolicies);
      const groups = await pages(iam, (Marker) => new ListGroupsForUserCommand({ UserName: LOCAL_USER, Marker }), (page) => page.Groups);
      // AWS refuses to delete a user that has any of these, and setup adds none of them. Checked before anything of the user's is deleted.
      const password = await orAbsent(() => iam.send(new GetLoginProfileCommand({ UserName: LOCAL_USER })));
      const otherCredentials = [
        await pages(iam, (Marker) => new ListMFADevicesCommand({ UserName: LOCAL_USER, Marker }), (page) => page.MFADevices),
        await pages(iam, (Marker) => new ListSSHPublicKeysCommand({ UserName: LOCAL_USER, Marker }), (page) => page.SSHPublicKeys),
        await pages(iam, (Marker) => new ListSigningCertificatesCommand({ UserName: LOCAL_USER, Marker }), (page) => page.Certificates),
        // Not paginated.
        await pages(iam, () => new ListServiceSpecificCredentialsCommand({ UserName: LOCAL_USER }), (page) => page.ServiceSpecificCredentials),
      ].some((list) => list.length);
      const problem = password || otherCredentials ? 'it has a password or other sign-in credentials Hypervibe did not add' : user.Path !== AWS_PATH ? `it is not under ${AWS_PATH}` : !tagged(user.Tags) ? 'it does not carry Hypervibe\'s tag'
        : attached.length || groups.length || inline.some((name) => name !== LOCAL_USER_POLICY) ? 'it has permissions or groups Hypervibe did not add' : undefined;
      if (problem) note(`user ${LOCAL_USER}`, problem, `${IAM_CONSOLE}/users/details/${LOCAL_USER}`);
      else items.push({ id: 'local-user', label: `User ${LOCAL_USER}${keys.length ? ` and its ${keys.length === 1 ? 'access key' : `${keys.length} access keys`}` : ''}`, steps: [
        // Key ids stay out of every message.
        ...keys.map((key, index) => ({ what: `delete access key ${index + 1} of ${LOCAL_USER}`, command: () => new DeleteAccessKeyCommand({ UserName: LOCAL_USER, AccessKeyId: key }) })),
        ...inline.map((name) => ({ what: `delete the policy of ${LOCAL_USER}`, command: () => new DeleteUserPolicyCommand({ UserName: LOCAL_USER, PolicyName: name }) })),
        { what: `delete user ${LOCAL_USER}`, command: () => new DeleteUserCommand({ UserName: LOCAL_USER }) },
      ] });
    }
    const localUserGoes = !user || planned('local-user');

    const deployPolicyArn = `arn:aws:iam::${accountId}:policy${AWS_PATH}${DEPLOY_POLICY}`;
    reading = `role ${ACCOUNT_DEPLOY_ROLE}`;
    const deploy = await readRole(iam, ACCOUNT_DEPLOY_ROLE);
    if (deploy) {
      const problem = roleProblem(deploy, deployTrustDocument(accountId, trustedGitHubOwners(deploy.role.AssumeRolePolicyDocument)), deployPolicyArn);
      if (problem) note(`role ${ACCOUNT_DEPLOY_ROLE}`, problem, `${IAM_CONSOLE}/roles/details/${ACCOUNT_DEPLOY_ROLE}`);
      else items.push(roleItem('deploy-role', ACCOUNT_DEPLOY_ROLE, deploy.attached, `Role ${ACCOUNT_DEPLOY_ROLE}, which Hypervibe deploys with`));
    }
    reading = `role ${AWS_WEB_INFRASTRUCTURE_ROLE}`;
    const web = await readRole(iam, AWS_WEB_INFRASTRUCTURE_ROLE);
    if (web) {
      const problem = roleProblem(web, WEB_INFRASTRUCTURE_TRUST, WEB_INFRASTRUCTURE_POLICY);
      if (problem) note(`role ${AWS_WEB_INFRASTRUCTURE_ROLE}`, problem, `${IAM_CONSOLE}/roles/details/${AWS_WEB_INFRASTRUCTURE_ROLE}`);
      else items.push(roleItem('web-infrastructure-role', AWS_WEB_INFRASTRUCTURE_ROLE, web.attached, `Role ${AWS_WEB_INFRASTRUCTURE_ROLE}, which Amazon ECS manages web services with`));
    }

    for (const [id, name, label] of [['deploy-policy', DEPLOY_POLICY, 'what the deploy role may do'], ['boundary-policy', BOUNDARY, 'the limit on app roles']] as const) {
      const arn = `arn:aws:iam::${accountId}:policy${AWS_PATH}${name}`;
      reading = `policy ${name}`;
      const found = await readPolicy(iam, arn);
      if (!found) continue;
      // A use by the deploy role ends when that role is deleted first.
      const others = found.users.filter((entity) => !(id === 'deploy-policy' && entity === `role ${ACCOUNT_DEPLOY_ROLE}` && planned('deploy-role')));
      // Setup tags nothing on its policies; the /hypervibe/ path (part of the ARN just read) and its description are what it recorded.
      const problem = typeof found.policy.Description !== 'string' || !found.policy.Description.startsWith('Hypervibe: ') ? 'its description is not the one Hypervibe wrote'
        : others.length ? `it is still used by ${few(others)}` : undefined;
      if (problem) { note(`policy ${name}`, problem, `${IAM_CONSOLE}/policies/details/${encodeURIComponent(arn)}`); continue; }
      items.push({ id, label: `Policy ${name}: ${label}`, steps: [
        ...found.older.map((version) => ({ what: `delete version ${version} of policy ${name}`, command: () => new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: version }) })),
        { what: `delete policy ${name}`, command: () => new DeletePolicyCommand({ PolicyArn: arn }) },
      ] });
    }

    reading = 'the GitHub sign-in for AWS';
    const oidcArn = `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}`;
    const providers = (await iam.send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList;
    if (!Array.isArray(providers)) throw new Unreadable();
    const listed = strings(providers, 'Arn');
    const provider = listed.includes(oidcArn) ? await orAbsent(() => iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: oidcArn }))) : undefined;
    if (provider) {
      const url = `${IAM_CONSOLE}/identity_providers/details/OPENID/${encodeURIComponent(oidcArn)}`;
      // Any role that names the provider in who may use it, other than a deploy role about to be deleted.
      const shared = roles.filter((role) => JSON.stringify(decoded(role.AssumeRolePolicyDocument)).includes(oidcArn)
        && !(role.RoleName === ACCOUNT_DEPLOY_ROLE && role.Path === AWS_PATH && planned('deploy-role'))).map((role) => role.RoleName);
      if (!tagged(provider.Tags)) note('GitHub sign-in for AWS', 'Hypervibe did not create it (it existed before setup, or lost Hypervibe\'s tag), so other tools may rely on it', url);
      else if (shared.length) note('GitHub sign-in for AWS', `these roles still sign in through it: ${few(shared)}`, url);
      else items.push({ id: 'github-oidc', label: 'GitHub sign-in for AWS (the keyless link GitHub Actions deployed through)',
        steps: [{ what: 'delete the GitHub sign-in for AWS', command: () => new DeleteOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: oidcArn }) }] });
    }

    for (const region of regions) {
      const rds = clients.rds(region);
      const ours = (identifier: string, tags: unknown) => identifier.startsWith('hv-') || tagged(tags);
      reading = `databases in ${region}`;
      const clusters = await pages(rds, (Marker) => new DescribeDBClustersCommand({ Marker }), (page) => page.DBClusters) as Array<{ TagList?: unknown }>;
      const databases = strings(clusters, 'DBClusterIdentifier').filter((identifier, index) => ours(identifier, clusters[index]!.TagList));
      if (databases.length) blockers.push(`databases in ${region}: ${few(databases)}`);
      reading = `database snapshots in ${region}`;
      const found = await pages(rds, (Marker) => new DescribeDBClusterSnapshotsCommand({ SnapshotType: 'manual', Marker }), (page) => page.DBClusterSnapshots) as Array<{ TagList?: unknown }>;
      for (const identifier of strings(found, 'DBClusterSnapshotIdentifier').filter((name, index) => ours(name, found[index]!.TagList))) {
        snapshots.push({ identifier, region, url: `https://${region}.console.aws.amazon.com/rds/home?region=${region}#snapshots-list:tab=manual` });
      }
    }
    return { state: 'known', items, blockers, leftAlone, snapshots, localUserGoes };
  } catch (error) {
    return { state: 'unknown', reason: `AWS did not give a complete answer about ${reading} (${errorName(error)}).` };
  }
}

/**
 * Deletes the items in order and stops at the first call AWS does not confirm.
 * "No such entity" on a delete is AWS confirming the thing is already gone.
 */
export async function removeAwsSetupItems(clients: AwsRemovalClients, items: AwsSetupItem[]): Promise<{ removed: string[]; failed?: { label: string; step: string; error: string } }> {
  const removed: string[] = [];
  for (const item of items) {
    for (const step of item.steps) {
      try { await clients.iam.send(step.command()); } catch (error) {
        if (!isMissing(error)) return { removed, failed: { label: item.label, step: step.what, error: errorName(error) } };
      }
    }
    removed.push(item.label);
  }
  return { removed };
}

/** Real clients for one signed-in administrator session, which stays in memory. */
export function awsRemovalClients(session: AwsSignInSession): AwsRemovalClients {
  const credentials = { accessKeyId: session.accessKeyId, secretAccessKey: session.secretAccessKey, sessionToken: session.sessionToken };
  return { iam: new IAMClient({ region: 'us-east-1', credentials }), rds: (region) => new RDSClient({ region, credentials }) };
}
