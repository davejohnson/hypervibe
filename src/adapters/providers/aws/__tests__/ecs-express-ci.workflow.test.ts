import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ecr from '@aws-sdk/client-ecr';
import { brokerTarget } from '../../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';
import '../ecs-express.adapter.js';
import {
  buildEcsExpressGitHubActionsSteps,
  ECS_EXPRESS_CI_REQUIRED_SECRETS,
} from '../ecs-express-ci.workflow.js';

describe('ECS Express managed CI workflow', () => {
  it('renders release-only broker callbacks without copied AWS keys and makes portable unsupported explicit', async () => {
    const target = brokerTarget(), result = buildEcsExpressGitHubActionsSteps(target);
    expect(result.requiredSecrets).toEqual([]); expect(result.permissions).toContain('id-token: write');
    expect(result.steps).not.toMatch(/secrets\.AWS_|configure-aws-credentials/);
    const steps = parse('steps:\n' + result.steps).steps;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const step of steps) if (step.with?.script) expect(() => new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', step.with.script)).not.toThrow();
    const login = steps.find((step: any) => step.name === 'Authenticate to Hypervibe-managed ECR');
    expect(login.with.script).toContain('hvDeploymentSession');
    // Execute the generated consumer through the real ECR SDK and a reconstructed
    // AWS JSON transport. Docker is intercepted at stdin, never written to disk.
    const nativeRequests: any[] = [], dockerCalls: any[] = [], outputs: any[] = [], runner = mkdtempSync(join(tmpdir(), 'hv-ci-'));
    const env: Record<string, string> = { RUNNER_TEMP: runner, AWS_ECS_CLUSTER_ARN: target.providerProjectId! };
    const require = createRequire(import.meta.url);
    const dependencies = (name: string) => name === '@aws-sdk/client-ecr' ? { ...ecr, ECRClient: class extends ecr.ECRClient {
      constructor(config: any) { super({ ...config, requestHandler: { handle: async (request: any) => { nativeRequests.push(request); return { response: { statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify({ authorizationData: [{ authorizationToken: Buffer.from('AWS:synthetic-registry-password').toString('base64'),
          expiresAt: Date.now() / 1000 + 3600, proxyEndpoint: 'https://123456789012.dkr.ecr.us-west-2.amazonaws.com' }] })) } }; } } }); }
    } } : name === 'node:child_process' ? { execFileSync: (...args: unknown[]) => { dockerCalls.push(args); } } : require(name);
    const core = { getIDToken: async () => 'synthetic-jwt', setSecret: () => {}, setOutput: (...args: unknown[]) => outputs.push(args), exportVariable: (key: string, value: string) => { env[key] = value; } };
    const source = '{}';
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64'), size: 2 } }) } } };
    const context = { repo: { owner: 'example', repo: 'app' }, sha: 'c'.repeat(40), ref: 'refs/heads/main' };
    const fetch = async () => Response.json({ kind: 'aws-sts', principal: target.deploymentAccess!.connection.principals.release,
      accessKeyId: 'ASIA' + '2'.repeat(17), secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900000).toISOString() });
    try {
      await new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', login.with.script)(dependencies, core, github, context, fetch, { env });
      expect(nativeRequests).toHaveLength(1); expect(nativeRequests[0].headers['x-amz-security-token']).toBe('synthetic-session');
      expect(dockerCalls[0][2]).toMatchObject({ input: 'synthetic-registry-password', stdio: ['pipe', 'ignore', 'ignore'] }); expect(outputs).toEqual([]);
      const cleanup = steps.find((step: any) => step.name === 'Remove temporary registry access');
      await new AsyncFunction('require', 'process', cleanup.with.script)(require, { env });
    } finally { rmSync(runner, { recursive: true, force: true }); }
    const { buildEcsExpressPortableRecipe } = await import('../ecs-express-ci.recipe.js');
    expect(() => buildEcsExpressPortableRecipe(target)).toThrow(/GitHub/);
  });
  it('uses only the connection credentials and already-bound resource ARNs', () => {
    const result = buildEcsExpressGitHubActionsSteps({
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/hv-app-production-a1b2c3d4e5',
      providerServiceIds: [
        'arn:aws:ecs:us-west-2:123456789012:service/hv-app-production-a1b2c3d4e5/hv-web-a1b2c3d4e5',
      ],
      containerStartCommand: 'node server.mjs',
    });

    expect(result.requiredSecrets).toEqual(ECS_EXPRESS_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.steps).toContain("'hypervibe/' + cluster.toLowerCase()");
    expect(result.steps).toContain('UpdateExpressGatewayServiceCommand');
    expect(result.steps).toContain('networkConfiguration: config.networkConfiguration');
    expect(result.steps).toContain('workload-network configuration is missing or malformed');
    expect(result.steps).toContain('IMAGE_DIGEST');
    expect(result.steps).not.toMatch(/CreateExpressGatewayServiceCommand|CreateClusterCommand|CreateRepositoryCommand|CreateRoleCommand/);
    expect(result.steps).not.toContain('aws ecs');
  });

  it('requires explicit variables when no applied binding is compiled', () => {
    const result = buildEcsExpressGitHubActionsSteps({
      environmentName: 'staging',
      kind: 'staging',
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerServiceIds: [],
    });
    expect(result.requiredVariables).toEqual([
      'AWS_ECS_CLUSTER_ARN',
      'AWS_ECS_EXPRESS_SERVICE_ARNS_JSON',
    ]);
  });
});
