import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as ecs from '@aws-sdk/client-ecs';
import { buildEcsExpressGitHubActionsSteps } from '../ecs-express-ci.workflow.js';
import { brokerTarget } from '../../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../../../../domain/services/managed-runtime.js';
import '../ecs-express.adapter.js';

// Reconstructed AWS ECS JSON transport. The real emitted program and SDK run;
// first runtime values must be attached with the exact image, never its bootstrap.
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RegisterTaskDefinition.html
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html
function fixture(options: { replacement?: boolean; missingSecret?: boolean; unsafeBootstrap?: boolean; wrongCommand?: boolean; wrongEnvironment?: boolean; wrongExecutionRole?: boolean; unexpectedMount?: boolean; unexpectedVolume?: boolean; extraContainer?: boolean; environmentValue?: string } = {}) {
  const target = brokerTarget(), connection = target.deploymentAccess!.connection;
  const secretArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:api-AbCdEf', version = 'd'.repeat(32);
  connection.deployment.workloads[0].runtimeSecrets = [{ key: 'API_KEY', reference: {
    destination: { provider: 'aws-secrets', accountId: '123456789012', region: 'us-west-2', secretArn }, version,
  } }];
  const serviceArn = target.providerServiceIds[0], createdAt = 1_700_000_000;
  target.runtimeResources = [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: serviceArn,
    providerResourceUid: new Date(createdAt * 1000).toISOString(), startCommand: 'node app.js', healthCheckPath: '/health' }];
  const taskPrefix = 'arn:aws:ecs:us-west-2:123456789012:task-definition/web:';
  const bootstrap: any = { taskDefinitionArn: taskPrefix + '1', family: 'web', revision: 1, status: 'ACTIVE', networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', executionRoleArn: 'arn:aws:iam::123456789012:role/' + (options.wrongExecutionRole ? 'foreign' : 'execution'),
    containerDefinitions: [{ name: 'Main', image: `public.ecr.aws/docker/library/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`,
      command: ['node', '-e', "require('http').createServer((_,res)=>{res.writeHead(200);res.end('hypervibe bootstrap')}).listen(8080)"],
      portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }], environment: [],
      secrets: options.unsafeBootstrap ? [{ name: 'API_KEY', valueFrom: secretArn + ':::' + version }] : [] }] };
  if (options.unexpectedMount) bootstrap.containerDefinitions[0].mountPoints = [{ sourceVolume: 'unexpected', containerPath: '/data' }];
  if (options.unexpectedVolume) bootstrap.volumes = [{ name: 'unexpected', efsVolumeConfiguration: { fileSystemId: 'fs-12345678' } }];
  if (options.extraContainer) bootstrap.containerDefinitions.push({ name: 'sidecar', image: 'example/sidecar:latest' });
  const image = '123456789012.dkr.ecr.us-west-2.amazonaws.com/hypervibe/cluster@sha256:' + 'b'.repeat(64), sha = 'c'.repeat(40);
  let selected = bootstrap, registered: any;
  const calls: Array<{ operation: string; body: any }> = [];
  const handler = { handle: async (request: any) => {
    const operation = request.headers['x-amz-target'].split('.').at(-1), body = JSON.parse(request.body);
    calls.push({ operation, body });
    let result;
    if (operation === 'DescribeExpressGatewayService') result = { service: { serviceArn, cluster: target.providerProjectId,
      createdAt: createdAt + (options.replacement ? 1 : 0), currentDeployment: 'current', status: { statusCode: 'ACTIVE' },
      tags: [{ key: 'hypervibe-owner', value: 'b'.repeat(64) }, { key: 'hypervibe-installation', value: connection.installationId }],
      activeConfigurations: [{ serviceRevisionArn: 'current', taskDefinitionArn: selected.taskDefinitionArn,
        networkConfiguration: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'] },
        ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }] }] } };
    else if (operation === 'DescribeTaskDefinition') result = { taskDefinition: body.taskDefinition === bootstrap.taskDefinitionArn ? bootstrap : registered };
    else if (operation === 'RegisterTaskDefinition') {
      registered = { ...body, taskDefinitionArn: taskPrefix + '2', revision: 2, status: 'ACTIVE' };
      result = { taskDefinition: registered };
    } else if (operation === 'UpdateExpressGatewayService') {
      selected = structuredClone(registered);
      if (options.missingSecret) selected.containerDefinitions[0].secrets = [];
      if (options.wrongCommand) selected.containerDefinitions[0].command = ['node', 'unexpected.js'];
      if (options.wrongEnvironment) selected.containerDefinitions[0].environment = (selected.containerDefinitions[0].environment as any[]).filter(item => item.name !== 'NODE_ENV') as never[];
      result = { service: { serviceArn } };
    } else throw new Error('Unexpected native request');
    // Once selected, native reads independently expose the observed configuration.
    if (operation === 'DescribeTaskDefinition' && selected !== bootstrap && body.taskDefinition === selected.taskDefinitionArn) result = { taskDefinition: selected };
    return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(result)) } };
  } };
  const nativeRequire = createRequire(import.meta.url);
  const require = (name: string) => name === '@aws-sdk/client-ecs' ? { ...ecs, ECSClient: class extends ecs.ECSClient {
    constructor(config: any) { super({ ...config, requestHandler: handler }); }
  } } : nativeRequire(name);
  const env = { AWS_ECS_CLUSTER_ARN: target.providerProjectId, AWS_ECS_EXPRESS_SERVICE_ARNS_JSON: JSON.stringify([serviceArn]), IMAGE_URI: image, DEPLOY_SHA: sha };
  const outputs: unknown[] = [], core = { getIDToken: async () => 'synthetic-oidc', setSecret() {}, setOutput: (...args: unknown[]) => outputs.push(args) };
  const source = JSON.stringify({ environments: { production: { hosting: { provider: 'ecs' }, envVars: { NODE_ENV: options.environmentValue ?? 'production' } } } });
  const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64'), size: Buffer.byteLength(source) } }) } } };
  const context = { repo: { owner: 'example', repo: 'app' }, sha, ref: 'refs/heads/main' };
  const fetch = async (url: string) => url === 'https://app.example.test/health' ? new Response('ok') : Response.json({ kind: 'aws-sts',
    principal: connection.principals.release, accessKeyId: 'ASIA' + '2'.repeat(17), secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900_000).toISOString() });
  const script = extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + buildEcsExpressGitHubActionsSteps(target).steps, 'Release exact digest to bound ECS Express services');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return { calls, outputs, image, secretArn, version, script, run: () => new AsyncFunction('require', 'process', 'fetch', 'core', 'github', 'context', script)(require, { env }, fetch, core, github, context) };
}
describe('installed ECS first exact-image release', () => {
  it('attaches reviewed references, final task role, environment and command atomically with the application digest', async () => {
    const f = fixture(); await f.run();
    const registration = f.calls.find(call => call.operation === 'RegisterTaskDefinition')!.body;
    expect.soft(registration.taskRoleArn).toBe('arn:aws:iam::123456789012:role/task');
    expect.soft(registration.executionRoleArn).toBe('arn:aws:iam::123456789012:role/execution');
    expect.soft(registration.containerDefinitions[0]).toMatchObject({ image: f.image, command: ['sh', '-lc', 'node app.js'],
      secrets: [{ name: 'API_KEY', valueFrom: f.secretArn + ':::' + f.version }] });
    expect.soft(registration.containerDefinitions[0].environment).toContainEqual({ name: 'NODE_ENV', value: 'production' });
    expect(f.calls.filter(call => call.operation === 'UpdateExpressGatewayService')).toHaveLength(1);
  });
  it('reads updated nonsecret source settings without changing the generated workflow', async () => {
    const original = fixture(), changed = fixture({ environmentValue: 'reviewed-next-value' });
    expect(changed.script).toBe(original.script);
    expect(changed.script).not.toContain('reviewed-next-value');
    await changed.run();
    const registration = changed.calls.find(call => call.operation === 'RegisterTaskDefinition')!.body;
    expect(registration.containerDefinitions[0].environment).toContainEqual({ name: 'NODE_ENV', value: 'reviewed-next-value' });
  });
  it.each([{ replacement: true }, { unsafeBootstrap: true }, { wrongExecutionRole: true }, { unexpectedMount: true }, { unexpectedVolume: true }, { extraContainer: true }])('blocks changed or unsafe bootstrap before release: %j', async options => {
    const f = fixture(options); await expect(f.run()).rejects.toThrow();
    expect(f.calls.some(call => ['RegisterTaskDefinition', 'UpdateExpressGatewayService'].includes(call.operation))).toBe(false);
  });
  it.each([{ missingSecret: true }, { wrongCommand: true }, { wrongEnvironment: true }])('cannot report success when native final configuration drifts: %j', async options => {
    const f = fixture(options); await expect(f.run()).rejects.toThrow();
    expect(f.outputs).toEqual([]);
  });
});
