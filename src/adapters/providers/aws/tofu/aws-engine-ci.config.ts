import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { assertEngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import type { AwsEngineInput } from './aws-engine.config.js';

/** A separate role per environment; the setup boundary caps it, its own policy grants only releases. */
export function addAwsCiConfiguration(input: AwsEngineInput, files: EngineConfiguration['files'], resources: Record<string, EngineResourceMapping>): void {
  if (!input.ci) return;
  assertEngineCiIntent(input.ci);
  const scope = `${input.region}:${input.accountId}`;
  const statement = (Sid: string, Action: string[], Resource: string | string[], extra = {}) => ({ Sid, Effect: 'Allow', Action, Resource, ...extra });
  // A public web service is an Express Mode service; a private one is released like a worker.
  const express = (input.services ?? []).filter((service) => service.public);
  const services = [...(input.workers ?? []), ...(input.services ?? []).filter((service) => !service.public)];
  const tasks = [...services, ...(input.jobs ?? [])];
  const taskFamilies = tasks.map((task) => `arn:aws:ecs:${scope}:task-definition/${task.resourceName}:*`);
  const statements = [
    statement('BuildImage', ['codebuild:BatchGetProjects', 'codebuild:StartBuild', 'codebuild:BatchGetBuilds'], [`arn:aws:codebuild:${scope}:project/${input.prefix}-images`]),
    statement('UploadSource', ['s3:PutObject'], `arn:aws:s3:::${input.prefix}-build-${input.accountId}/sources/*`),
    statement('ReadImages', ['ecr:DescribeImages'], `arn:aws:ecr:${scope}:repository/${input.prefix}`),
    ...(express.length ? [
      statement('ReleaseWeb', ['ecs:DescribeExpressGatewayService', 'ecs:UpdateExpressGatewayService'], express.map((service) => `arn:aws:ecs:${scope}:service/${input.prefix}/${service.resourceName}`)),
      statement('ReadWebRollout', ['ecs:DescribeServiceDeployments'], express.map((service) => `arn:aws:ecs:${scope}:service-deployment/${input.prefix}/${service.resourceName}/*`)),
    ] : []),
    ...(express.length || tasks.length ? [
      statement('PassRuntimeRole', ['iam:PassRole'], `arn:aws:iam::${input.accountId}:role/hypervibe/app/${input.prefix}-runtime`, { Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } }),
    ] : []),
    ...(tasks.length ? [
      // DescribeTaskDefinition has no resource-level scope; writes remain family-scoped.
      statement('ReadTasks', ['ecs:DescribeTaskDefinition'], '*'),
      statement('RegisterTaskRevision', ['ecs:RegisterTaskDefinition'], taskFamilies),
      statement('TagTaskRevision', ['ecs:TagResource'], taskFamilies, { Condition: { StringEquals: { 'ecs:CreateAction': 'RegisterTaskDefinition' } } }),
      statement('ReleaseWorkers', ['ecs:DescribeServices', 'ecs:UpdateService'], services.map((worker) => `arn:aws:ecs:${scope}:service/${input.prefix}/${worker.resourceName}`)),
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
