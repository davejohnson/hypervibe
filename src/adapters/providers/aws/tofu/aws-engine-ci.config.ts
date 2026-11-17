import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { assertEngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import type { AwsEngineInput } from './aws-engine.config.js';

/** A separate role per environment; the setup boundary caps it, its own policy grants only releases. */
export function addAwsCiConfiguration(input: AwsEngineInput, files: EngineConfiguration['files'], resources: Record<string, EngineResourceMapping>): void {
  if (!input.ci) return;
  assertEngineCiIntent(input.ci);
  const scope = `${input.region}:${input.accountId}`;
  const statement = (Sid: string, Action: string[], Resource: string | string[], extra = {}) => ({ Sid, Effect: 'Allow', Action, Resource, ...extra });
  const tasks = [...(input.workers ?? []), ...(input.jobs ?? [])];
  const statements = [
    statement('BuildImage', ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], [`arn:aws:codebuild:${scope}:project/${input.prefix}-images`, `arn:aws:codebuild:${scope}:build/${input.prefix}-images:*`]),
    statement('UploadSource', ['s3:PutObject'], `arn:aws:s3:::${input.prefix}-build-${input.accountId}/sources/*`),
    statement('ReadImages', ['ecr:DescribeImages'], `arn:aws:ecr:${scope}:repository/${input.prefix}`),
    ...((input.services ?? []).length ? [statement('ReleaseWeb', ['lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:GetFunctionUrlConfig', 'lambda:ListTags', 'lambda:UpdateFunctionCode'],
      input.services!.map((service) => `arn:aws:lambda:${scope}:function:${service.resourceName}`))] : []),
    ...(tasks.length ? [
      statement('ReadTasks', ['ecs:DescribeTaskDefinition'], tasks.map((task) => `arn:aws:ecs:${scope}:task-definition/${task.resourceName}:*`)),
      // RegisterTaskDefinition does not support resource-level authorization; PassRole remains exact.
      statement('RegisterTaskRevision', ['ecs:RegisterTaskDefinition'], '*'),
      statement('PassRuntimeRole', ['iam:PassRole'], `arn:aws:iam::${input.accountId}:role/hypervibe/app/${input.prefix}-runtime`, { Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } }),
      statement('ReleaseWorkers', ['ecs:DescribeServices', 'ecs:UpdateService'], (input.workers ?? []).map((worker) => `arn:aws:ecs:${scope}:service/${input.prefix}/${worker.resourceName}`)),
    ] : []),
  ].filter((s) => !Array.isArray(s.Resource) || s.Resource.length);
  files['ci.tf.json'] = { resource: {
    aws_iam_role: { ci: {
      name: `${input.prefix}-ci`, path: '/hypervibe/app/', permissions_boundary: `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`,
      assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
        Principal: { Federated: `arn:aws:iam::${input.accountId}:oidc-provider/token.actions.githubusercontent.com` },
        Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': `repo:${input.ci.repository}:ref:refs/heads/${input.ci.branch}` } },
      }] }),
    } },
    aws_iam_role_policy: { ci: { name: 'release', role: '${aws_iam_role.ci.id}', policy: JSON.stringify({ Version: '2012-10-17', Statement: statements }) } },
  }, output: { ci_role_arn: { value: '${aws_iam_role.ci.arn}' } } };
  for (const address of ['aws_iam_role.ci', 'aws_iam_role_policy.ci']) resources[address] = { actionId: 'identity:ci-release', kind: 'service', name: 'ci-release', requiresConfirm: true };
}
