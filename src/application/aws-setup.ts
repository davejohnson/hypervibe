import {
  AttachRolePolicyCommand, CreateAccessKeyCommand, CreateOpenIDConnectProviderCommand, CreatePolicyCommand, CreatePolicyVersionCommand,
  CreateRoleCommand, CreateUserCommand, DeletePolicyVersionCommand, GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, GetUserCommand, IAMClient,
  ListAccessKeysCommand, ListOpenIDConnectProvidersCommand, ListPolicyVersionsCommand, NoSuchEntityException, PutUserPolicyCommand, UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import type { AwsSignInSession } from './aws-sign-in.js';

/**
 * One-time AWS setup, mirroring GCP: the person signs in once (any admin,
 * including root), approves this exact list, and Hypervibe creates its own
 * limited access. Afterwards the sign-in is not used again.
 *
 * - hypervibe-local (IAM user): this computer's credential; it can only
 *   assume Hypervibe deploy roles. Stored encrypted locally, rotated by Hypervibe.
 * - hypervibe-deploy-<project> (role): what OpenTofu deploys with, from this
 *   computer and from the repository's GitHub Actions (keyless OIDC).
 * - hypervibe-app-boundary (policy): the most any role Hypervibe creates for
 *   the app can do. The deploy role can create app roles only under
 *   /hypervibe/app/ and only with this boundary, so it cannot escalate.
 */
export const AWS_SETUP_VERSION = 'aws-v1';
export const AWS_PATH = '/hypervibe/';
export const AWS_APP_ROLE_PATH = '/hypervibe/app/';
const LOCAL_USER = 'hypervibe-local';
const BOUNDARY = 'hypervibe-app-boundary';
const DEPLOY_POLICY = 'hypervibe-deploy';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export const deployRoleName = (project: string) => `hypervibe-deploy-${project.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}`;

/** Services the app's own runtime roles may use (the permissions boundary). */
export function appBoundaryDocument(): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'AppServices', Effect: 'Allow', Resource: '*', Action: [
        's3:*', 'rds-data:*', 'rds-db:connect', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'sqs:*', 'sns:Publish',
        'ses:SendEmail', 'ses:SendRawEmail', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'lambda:InvokeFunction',
        'ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability',
        // Image builds (CodeBuild's role) push to the environment's registry.
        'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        // The on-demand worker waker reads pending work and sets the worker's task count.
        'ecs:DescribeServices', 'ecs:UpdateService', 'ecs:RunTask', 'scheduler:*', 'events:PutEvents', 'states:StartExecution', 'states:StartSyncExecution',
      ] },
      // The worker waker reads pending work with its own read-only database login.
      { Sid: 'WakerLogin', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: 'arn:aws:secretsmanager:*:*:secret:hypervibe/*' },
      { Sid: 'AppSecrets', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'kms:Decrypt'], Resource: '*' },
      { Sid: 'PassOnlyAppRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::*:role${AWS_APP_ROLE_PATH}*` },
    ],
  };
}

/** What OpenTofu needs to manage the app: compute, database, storage, schedules and capped app roles. */
export function deployPolicyDocument(accountId: string): Record<string, unknown> {
  const boundaryArn = `arn:aws:iam::${accountId}:policy${AWS_PATH}${BOUNDARY}`;
  const appRoles = `arn:aws:iam::${accountId}:role${AWS_APP_ROLE_PATH}*`;
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'Workloads', Effect: 'Allow', Resource: '*', Action: [
        'lambda:*', 'ecs:*', 'ecr:*', 'rds:*', 'rds-data:*', 's3:*', 'scheduler:*', 'events:*', 'logs:*', 'cloudwatch:*',
        'application-autoscaling:*', 'elasticloadbalancing:*', 'sqs:*', 'acm:*',
        'ec2:Describe*', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress', 'ec2:CreateTags', 'ec2:DeleteTags',
        'ssm:DescribeParameters', 'sts:GetCallerIdentity', 'ce:GetCostAndUsage', 'budgets:ViewBudget', 'codebuild:*', 'states:*', 'kms:DescribeKey',
      ] },
      // RDS keeps each database's master password in Secrets Manager (rds!... secrets); Hypervibe reads it
      // only to create the app's own login through the Data API.
      { Sid: 'DatabaseMasterSecrets', Effect: 'Allow', Resource: `arn:aws:secretsmanager:*:${accountId}:secret:rds!*`, Action: [
        'secretsmanager:CreateSecret', 'secretsmanager:TagResource', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue',
        'secretsmanager:RotateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret',
      ] },
      { Sid: 'AppSecrets', Effect: 'Allow', Action: 'ssm:*', Resource: `arn:aws:ssm:*:${accountId}:parameter/hypervibe/*` },
      { Sid: 'HypervibeSecrets', Effect: 'Allow', Resource: `arn:aws:secretsmanager:*:${accountId}:secret:hypervibe/*`, Action: [
        'secretsmanager:CreateSecret', 'secretsmanager:TagResource', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:GetResourcePolicy',
      ] },
      { Sid: 'CreateCappedAppRoles', Effect: 'Allow', Resource: appRoles,
        Action: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary'],
        Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } } },
      { Sid: 'ManageAppRoles', Effect: 'Allow', Resource: appRoles, Action: [
        'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:ListInstanceProfilesForRole', 'iam:DeleteRole',
        'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:PassRole',
      ] },
      { Sid: 'ServiceLinkedRoles', Effect: 'Allow', Action: 'iam:CreateServiceLinkedRole', Resource: '*',
        Condition: { StringLike: { 'iam:AWSServiceName': ['ecs.amazonaws.com', 'rds.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'application-autoscaling.amazonaws.com', 'ecs.application-autoscaling.amazonaws.com'] } } },
      { Sid: 'ReadIam', Effect: 'Allow', Action: ['iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyVersions', 'iam:GetOpenIDConnectProvider', 'iam:ListOpenIDConnectProviders'], Resource: '*' },
      // The boundary and Hypervibe's own access are set up by the person, never changed by the deploy role.
      { Sid: 'KeepBoundaryFixed', Effect: 'Deny', Resource: [boundaryArn, `arn:aws:iam::${accountId}:policy${AWS_PATH}${DEPLOY_POLICY}`],
        Action: ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'] },
      { Sid: 'NoBoundaryRemoval', Effect: 'Deny', Action: 'iam:DeleteRolePermissionsBoundary', Resource: '*' },
    ],
  };
}

function deployTrustDocument(accountId: string, repository?: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      // The account principal limited to the exact user: a just-created user is not yet a valid
      // principal ("Invalid principal in policy"), while the account always is.
      { Sid: 'ThisComputer', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: 'sts:AssumeRole',
        Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${accountId}:user${AWS_PATH}${LOCAL_USER}` } } },
      ...(repository ? [{ Sid: 'GitHubActions', Effect: 'Allow', Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com' }, StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: `repo:${repository}:*` } } }] : []),
    ],
  };
}

export interface AwsSetupChange { id: string; change: string; state: 'create' | 'update' | 'ok' }
export interface AwsSetupPlan {
  accountId: string;
  region: string;
  signedInAs: string;
  deployRole: string;
  repository?: string;
  changes: AwsSetupChange[];
  /** True when every change is already in place. */
  ready: boolean;
}

function iamClient(session: AwsSignInSession): IAMClient {
  const { accessKeyId, secretAccessKey, sessionToken } = session;
  return new IAMClient({ region: 'us-east-1', credentials: { accessKeyId, secretAccessKey, sessionToken } });
}

async function exists(read: () => Promise<unknown>): Promise<boolean> {
  try { await read(); return true; } catch (error) {
    if (error instanceof NoSuchEntityException) return false;
    throw error;
  }
}

async function policyMatches(iam: IAMClient, arn: string, document: Record<string, unknown>): Promise<boolean | undefined> {
  try {
    const policy = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
    const version = await iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: policy.Policy!.DefaultVersionId! }));
    return JSON.stringify(JSON.parse(decodeURIComponent(version.PolicyVersion!.Document!))) === JSON.stringify(document);
  } catch (error) {
    if (error instanceof NoSuchEntityException) return undefined;
    throw error;
  }
}

/** Read-only: what setup would create or update in this account. */
export async function planAwsSetup(session: AwsSignInSession, params: { project: string; region: string; repository?: string }): Promise<AwsSetupPlan> {
  const iam = iamClient(session);
  const account = session.accountId;
  const role = deployRoleName(params.project);
  const changes: AwsSetupChange[] = [];
  const boundary = await policyMatches(iam, `arn:aws:iam::${account}:policy${AWS_PATH}${BOUNDARY}`, appBoundaryDocument());
  changes.push({ id: 'boundary', state: boundary === undefined ? 'create' : boundary ? 'ok' : 'update', change: `Policy ${BOUNDARY}: the most any role Hypervibe creates for your app can do (no admin or IAM access)` });
  const deploy = await policyMatches(iam, `arn:aws:iam::${account}:policy${AWS_PATH}${DEPLOY_POLICY}`, deployPolicyDocument(account));
  changes.push({ id: 'deploy-policy', state: deploy === undefined ? 'create' : deploy ? 'ok' : 'update', change: `Policy ${DEPLOY_POLICY}: run your app on Lambda, Fargate, Aurora/RDS, S3 and schedules, and build its images on CodeBuild; create app roles only within ${BOUNDARY}` });
  if (params.repository) {
    const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
    const hasGithub = (providers.OpenIDConnectProviderList ?? []).some((entry) => entry.Arn?.endsWith(`oidc-provider/${GITHUB_OIDC_HOST}`));
    changes.push({ id: 'github-oidc', state: hasGithub ? 'ok' : 'create', change: 'GitHub sign-in for AWS, so CI deploys without stored keys' });
  }
  const hasRole = await exists(() => iam.send(new GetRoleCommand({ RoleName: role })));
  changes.push({ id: 'deploy-role', state: hasRole ? 'update' : 'create', change: `Role ${role}: what Hypervibe deploys with, from this computer${params.repository ? ` and ${params.repository}'s GitHub Actions` : ''}` });
  const hasUser = await exists(() => iam.send(new GetUserCommand({ UserName: LOCAL_USER })));
  changes.push({ id: 'local-user', state: hasUser ? 'update' : 'create', change: `User ${LOCAL_USER} with one access key: lets this computer use the deploy role and nothing else; stored encrypted here and rotated by Hypervibe` });
  return {
    accountId: account, region: params.region, signedInAs: session.identityArn, deployRole: role, ...(params.repository ? { repository: params.repository } : {}),
    changes, ready: changes.every((change) => change.state === 'ok'),
  };
}

async function putPolicy(iam: IAMClient, account: string, name: string, document: Record<string, unknown>, description: string): Promise<string> {
  const arn = `arn:aws:iam::${account}:policy${AWS_PATH}${name}`;
  const current = await policyMatches(iam, arn, document);
  if (current === undefined) {
    await iam.send(new CreatePolicyCommand({ PolicyName: name, Path: AWS_PATH, Description: description, PolicyDocument: JSON.stringify(document) }));
  } else if (!current) {
    // IAM keeps at most five versions; drop the oldest non-default one first.
    const versions = (await iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }))).Versions ?? [];
    if (versions.length >= 5) {
      const oldest = versions.filter((version) => !version.IsDefaultVersion).sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
      if (oldest?.VersionId) await iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId }));
    }
    await iam.send(new CreatePolicyVersionCommand({ PolicyArn: arn, PolicyDocument: JSON.stringify(document), SetAsDefault: true }));
  }
  return arn;
}

/**
 * Applies an approved plan. Returns the new local access key only when one
 * was created (the caller stores it encrypted and never prints it); an
 * existing key is kept and must already be stored locally.
 */
export async function applyAwsSetup(session: AwsSignInSession, plan: AwsSetupPlan, options: { hasStoredKey: boolean }): Promise<{ roleArn: string; key?: { accessKeyId: string; secretAccessKey: string } }> {
  const iam = iamClient(session);
  const account = plan.accountId;
  const tags = [{ Key: 'managed-by', Value: 'hypervibe' }];
  await putPolicy(iam, account, BOUNDARY, appBoundaryDocument(), 'Hypervibe: the most any app role may do');
  const deployArn = await putPolicy(iam, account, DEPLOY_POLICY, deployPolicyDocument(account), 'Hypervibe: deploy and run apps');
  if (plan.repository && plan.changes.some((change) => change.id === 'github-oidc' && change.state === 'create')) {
    // IAM no longer checks the thumbprint for GitHub's issuer; one value is still required.
    await iam.send(new CreateOpenIDConnectProviderCommand({ Url: `https://${GITHUB_OIDC_HOST}`, ClientIDList: ['sts.amazonaws.com'], ThumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'], Tags: tags }));
  }
  if (!(await exists(() => iam.send(new GetUserCommand({ UserName: LOCAL_USER }))))) {
    await iam.send(new CreateUserCommand({ UserName: LOCAL_USER, Path: AWS_PATH, Tags: tags }));
  }
  await iam.send(new PutUserPolicyCommand({ UserName: LOCAL_USER, PolicyName: 'assume-hypervibe-deploy-roles', PolicyDocument: JSON.stringify({
    Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: `arn:aws:iam::${account}:role${AWS_PATH}hypervibe-deploy-*` }],
  }) }));
  const trust = JSON.stringify(deployTrustDocument(account, plan.repository));
  if (await exists(() => iam.send(new GetRoleCommand({ RoleName: plan.deployRole })))) {
    await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: plan.deployRole, PolicyDocument: trust }));
  } else {
    await iam.send(new CreateRoleCommand({ RoleName: plan.deployRole, Path: AWS_PATH, AssumeRolePolicyDocument: trust, MaxSessionDuration: 3600, Tags: tags,
      Description: 'Hypervibe deploys this project with this role' }));
  }
  await iam.send(new AttachRolePolicyCommand({ RoleName: plan.deployRole, PolicyArn: deployArn }));
  const roleArn = `arn:aws:iam::${account}:role${AWS_PATH}${plan.deployRole}`;
  if (options.hasStoredKey) return { roleArn };
  const keys = (await iam.send(new ListAccessKeysCommand({ UserName: LOCAL_USER }))).AccessKeyMetadata ?? [];
  if (keys.length >= 2) throw new Error(`${LOCAL_USER} already has two access keys and none is stored on this computer. Delete one in IAM → Users → ${LOCAL_USER}, then run setup again.`);
  const created = await iam.send(new CreateAccessKeyCommand({ UserName: LOCAL_USER }));
  return { roleArn, key: { accessKeyId: created.AccessKey!.AccessKeyId!, secretAccessKey: created.AccessKey!.SecretAccessKey! } };
}

