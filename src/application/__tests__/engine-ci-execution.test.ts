import { awsImageBuildspec } from '../../adapters/providers/aws/aws-buildspec.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { executeEngineCiRelease } from '../engine-ci-execution.js';
import { runEngineCiReleaseFromProcess } from '../../ci/engine-release.js';
import { environmentDeploymentContractHash } from '../../domain/services/deployment-contract.service.js';
import type { GitHubOidcContext } from '../../domain/ports/engine-ci.port.js';
import { githubOidcToken } from '../../adapters/providers/github/github-oidc.js';
import { AzureCiTokens } from '../../adapters/providers/azure/azure-ci-auth.js';
import type { EngineCiBinding } from '../../domain/spec/engine-ci-binding.js';

const account = '111122223333'; const region = 'eu-west-1'; const prefix = 'hv-app-preview'; const repository = 'example/app';
const webArn = `arn:aws:ecs:${region}:${account}:service/${prefix}/${prefix}-web`; const deploymentArn = `arn:aws:ecs:${region}:${account}:service-deployment/${prefix}/${prefix}-web/release1`; const digest = `sha256:${'a'.repeat(64)}`;
const webDigest = `sha256:${'b'.repeat(64)}`;
let directory: string;
beforeEach(() => { directory = mkdtempSync(`${tmpdir()}/hv-ci-execution-`); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); process.exitCode = 0; });
function fixture(options: { marker?: boolean; path?: string; migrations?: unknown; serviceCommand?: string; startCommand?: string; dockerfile?: boolean; public?: boolean } = {}) {
  const rawSpec = { version: 1, project: 'app', gitRemoteUrl: `https://github.com/${repository}`, runtime: { kind: 'node', version: '22', installCommand: 'npm ci', buildCommand: 'npm run build' },
    environments: { preview: { hosting: { provider: 'aws', region }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      services: { web: { workloadKind: 'web', public: options.public ?? true, healthCheckPath: options.path ?? '/health', ...(options.serviceCommand ? { releaseCommand: options.serviceCommand } : {}), ...(options.startCommand ? { startCommand: options.startCommand } : {}) } }, ...(options.migrations ? { migrations: options.migrations } : {}) } } };
  const binding = { version: 1, provider: 'aws', repository, branch: 'main', environmentName: 'preview', environmentId: 'env1', appliedContractHash: environmentDeploymentContractHash(rawSpec, 'preview'), region, prefix,
    services: { web: { serviceId: webArn, resourceType: 'ecs-express', workloadKind: 'web', region } },
    aws: { accountId: account, roleArn: `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-ci`, buildProjectArn: `arn:aws:codebuild:${region}:${account}:project/${prefix}-images`, sourceBucket: `${prefix}-build-${account}`, repositoryUrl: `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}` } };
  const bindings = { version: 1, project: 'app', environments: { preview: { platformBindings: options.marker === false ? {} : { engineCi: binding } } } };
  mkdirSync(`${directory}/.hypervibe`); writeFileSync(`${directory}/.hypervibe/spec.json`, JSON.stringify(rawSpec)); writeFileSync(`${directory}/.hypervibe/bindings.json`, JSON.stringify(bindings));
  if (options.dockerfile !== false) writeFileSync(`${directory}/Dockerfile`, 'FROM node:22\nENTRYPOINT ["node", "a.js"]\nCMD ["serve"]\n'); writeFileSync(`${directory}/app.js`, 'console.log("fixture")');
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Synthetic Test'); git('remote', 'add', 'origin', `https://github.com/${repository}`); git('add', '.'); git('commit', '-m', 'fixture');
  const github: GitHubOidcContext = { repository, ref: 'refs/heads/main', sha: git('rev-parse', 'HEAD'), eventName: 'push', runId: '123', runAttempt: '1', requestUrl: 'https://pipelines.actions.githubusercontent.com/oidctoken?api-version=2.0', requestToken: 'github-private-request-token' };
  return { rawSpec, bindings, binding, github, environmentName: 'preview', sourceDirectory: directory };
}
function assertion(github: GitHubOidcContext, audience: string, patch: Record<string, unknown> = {}) {
  return `header.${Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', aud: audience, sub: `repo:${repository}:ref:refs/heads/main`, repository, ref: github.ref, sha: github.sha, event_name: github.eventName, run_id: github.runId, run_attempt: github.runAttempt, exp: Math.floor(Date.now() / 1000) + 300, ...patch })).toString('base64url')}.signature`;
}
function transport(github: GitHubOidcContext, options: { wrongIdentity?: boolean; buildFailed?: boolean; alreadyRunning?: boolean; projectStatus?: 403 | 404; legacyBuildProject?: boolean; extraWebArn?: string; previousCommand?: string[]; rolledBack?: boolean; privateHealth?: boolean } = {}) {
  const calls: Array<{ method: string; host: string; path: string; target: string; body: any }> = []; const active = new Map<string, { image: string; command: string[] }>(); let built = false; const originalImage = options.alreadyRunning ? `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@${digest}` : 'old';
  vi.stubGlobal('fetch', vi.fn(async (raw: string | URL) => {
    const url = new URL(String(raw));
    if (url.hostname.endsWith('actions.githubusercontent.com')) return Response.json({ value: assertion(github, url.searchParams.get('audience')!) });
    if (url.hostname === 'app.example') return new Response('ok', { status: options.privateHealth ? 403 : 200 });
    throw new Error('Unexpected HTTP request');
  }));
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (r: any) => {
    const text = String(r.body ?? ''); const body = text.startsWith('{') ? JSON.parse(text) : text;
    const target = r.headers['x-amz-target'] ?? ''; calls.push({ method: r.method, host: r.hostname, path: r.path, target, body });
    let data: unknown = {}; let statusCode = 200;
    const observedWebArn = options.extraWebArn && body?.serviceArn === options.extraWebArn ? options.extraWebArn : webArn;
    if (r.hostname.startsWith('sts.')) data = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><AssumedRoleUser><Arn>arn:aws:sts::${account}:assumed-role/${prefix}-ci/hv-ci-123-1</Arn><AssumedRoleId>ID:hv-ci-123-1</AssumedRoleId></AssumedRoleUser><Credentials><AccessKeyId>AKIACI000000000000</AccessKeyId><SecretAccessKey>private-cloud-secret</SecretAccessKey><SessionToken>private-cloud-session</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
    else if (target.endsWith('BatchGetProjects')) {
      data = options.projectStatus ? { __type: options.projectStatus === 403 ? 'AccessDeniedException' : 'ResourceNotFoundException', message: 'private-cloud-secret' } : { projects: [{ arn: `arn:aws:codebuild:${region}:${account}:project/${prefix}-images`, source: { type: 'S3', location: `${prefix}-build-${account}/source.zip`, buildspec: JSON.stringify(awsImageBuildspec(!options.legacyBuildProject)) },
        serviceRole: `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-build`,
        environment: { type: 'LINUX_CONTAINER', privilegedMode: true, environmentVariables: [{ name: 'REGISTRY', value: `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}` }] },
        tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hv-environment', value: 'env1' }] }] };
      statusCode = options.projectStatus ?? 200;
    }
    else if (target.endsWith('DescribeImages')) {
      if (!built) { data = { __type: 'ImageNotFoundException', message: 'No image' }; statusCode = 400; }
      else data = { imageDetails: [{ imageDigest: body.imageIds[0].imageTag.endsWith('-hv-web1') ? webDigest : digest, imageTags: [body.imageIds[0].imageTag] }] };
    } else if (target.endsWith('StartBuild')) { built = true; data = { build: { id: `${prefix}-images:run`, buildStatus: options.buildFailed ? 'FAILED' : 'SUCCEEDED' } }; }
    else if (target.endsWith('UpdateExpressGatewayService')) { active.set(body.serviceArn, { image: options.rolledBack ? originalImage : body.primaryContainer.image, command: body.primaryContainer.command ?? [] }); data = { service: { serviceArn: body.serviceArn } }; }
    else if (target.endsWith('DescribeExpressGatewayService')) data = { service: { serviceArn: options.wrongIdentity ? webArn.replace('-web', '-other') : observedWebArn, status: { statusCode: 'ACTIVE' }, ...(active.has(observedWebArn) ? { currentDeployment: deploymentArn } : {}),
      activeConfigurations: [{ primaryContainer: { image: active.get(observedWebArn)?.image ?? originalImage, command: active.get(observedWebArn)?.command ?? options.previousCommand ?? [], containerPort: 8080, environment: [{ name: 'UNCHANGED', value: 'retained' }] }, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'app.example' }] }] } };
    else if (target.endsWith('DescribeServiceDeployments')) data = { serviceDeployments: [{ serviceDeploymentArn: deploymentArn, status: options.rolledBack ? 'ROLLBACK_SUCCESSFUL' : 'SUCCESSFUL', ...(options.rolledBack ? { statusReason: 'health checks failed' } : {}) }] };
    return { response: { statusCode, headers: { 'content-type': typeof data === 'string' ? 'text/xml' : 'application/json' }, body: Readable.from([typeof data === 'string' ? data : JSON.stringify(data)]) } };
  });
  return calls;
}
it('skips a missing applied marker with zero authentication and provider requests', async () => {
  const f = fixture({ marker: false }); const calls = transport(f.github);
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'skipped' }); expect(calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it.each(['repository', 'ref', 'sha'] as const)('blocks mismatched %s before any authentication or cloud work', async (key) => {
  const f = fixture(); const calls = transport(f.github); f.github[key] = key === 'sha' ? 'b'.repeat(40) : 'untrusted';
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'blocked' }); expect(calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it.each([{ path: '//untrusted.example/' }, { serviceCommand: 'npm run migrate' }, { migrations: { mode: 'releaseCommand', command: 'npm run migrate' } }])('rejects unsupported release/health inputs before OIDC %o', async (options) => {
  const f = fixture(options); const calls = transport(f.github);
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'blocked' }); expect(calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it('authenticates with the exact OIDC role, verifies native identity before build, then releases only the digest image', async () => {
  const f = fixture(); const calls = transport(f.github); const result = await executeEngineCiRelease(f);
  expect(result).toMatchObject({ status: 'released', revision: f.github.sha, results: [{ service: 'web', serviceId: webArn, status: 'released', imageUri: expect.stringContaining(`@${digest}`) }] });
  const build = calls.findIndex((r) => r.target.endsWith('StartBuild')); expect(build).toBeGreaterThan(calls.findIndex((r) => r.target.endsWith('DescribeExpressGatewayService')));
  expect(calls[build]!.body.projectName).toBe(f.binding.aws.buildProjectArn);
  const roleRequest = new URLSearchParams(calls.find((r) => r.host.startsWith('sts.'))!.body);
  expect(roleRequest.get('Action')).toBe('AssumeRoleWithWebIdentity'); expect(roleRequest.get('RoleArn')).toBe(f.binding.aws.roleArn);
  const exchangedClaims = JSON.parse(Buffer.from(roleRequest.get('WebIdentityToken')!.split('.')[1]!, 'base64url').toString('utf8'));
  expect(exchangedClaims).toMatchObject({ aud: 'sts.amazonaws.com', repository, ref: f.github.ref, sha: f.github.sha, run_id: f.github.runId, run_attempt: f.github.runAttempt });
  expect(exchangedClaims.exp).toBeGreaterThan(Date.now() / 1000);
  const update = calls.find((r) => r.target.endsWith('UpdateExpressGatewayService'))!;
  expect(update.body.serviceArn).toBe(webArn); expect(update.body.primaryContainer.image).toContain(`@${digest}`);
  // The rest of the running container's settings carry over; a release changes only the image.
  expect(update.body.primaryContainer).toMatchObject({ containerPort: 8080, environment: [{ name: 'UNCHANGED', value: 'retained' }] });
  expect(JSON.stringify(result)).not.toMatch(/private-cloud|github-private|signature|client_secret|WebIdentityToken/);
  expect(execFileSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
});
it('blocks mismatched native identity before source upload or build', async () => {
  const f = fixture(); const calls = transport(f.github, { wrongIdentity: true });
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'blocked' }); expect(calls.some((r) => r.target.endsWith('StartBuild') || r.host.includes('.s3.'))).toBe(false);
});
it.each([403, 404] as const)('blocks unreadable applied AWS build projects (%s) before source upload', async (projectStatus) => {
  const f = fixture(); const calls = transport(f.github, { projectStatus }); const result = await executeEngineCiRelease(f);
  expect(result.status).toBe('blocked'); expect(calls.some((r) => r.target.endsWith('StartBuild') || r.host.includes('.s3.'))).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private-cloud');
});
it('rejects a public AWS web command bound to an ordinary private ECS service before authentication', async () => {
  const base = fixture({ startCommand: 'node web.js' });
  const binding = { ...base.binding, services: { web: { ...base.binding.services.web, resourceType: 'ecs-service',
    clusterArn: `arn:aws:ecs:${region}:${account}:cluster/${prefix}`, taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/${prefix}-web:1` } } };
  const f = replaceCommitted(base, base.rawSpec, binding);
  const calls = transport(f.github);
  expect((await executeEngineCiRelease(f)).status).toBe('blocked');
  expect(calls).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it('blocks web commands on a legacy CI build project before uploading source or starting CodeBuild', async () => {
  const f = fixture({ startCommand: 'npm start' });
  const calls = transport(f.github, { legacyBuildProject: true });
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'blocked', message: expect.stringMatching(/build project/) });
  expect(calls.some(call => call.method === 'PUT' || /StartBuild|UpdateExpress/.test(call.target))).toBe(false);
});
it('stops a failed build before any workload update and emits a safe process receipt', async () => {
  const f = fixture(); const calls = transport(f.github, { buildFailed: true }); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const receiptPath = `${directory}/receipt.json`;
  const result = await runEngineCiReleaseFromProcess({ GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: directory, GITHUB_SHA: f.github.sha, GITHUB_REPOSITORY: repository, GITHUB_REF: f.github.ref,
    GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ACTIONS_ID_TOKEN_REQUEST_URL: f.github.requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: f.github.requestToken,
    HYPERVIBE_CI_ENVIRONMENT: 'preview', HYPERVIBE_CI_RECEIPT_PATH: receiptPath });
  expect(result.status).toBe('failed'); expect(calls.some((r) => r.target.endsWith('UpdateExpressGatewayService'))).toBe(false);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(result); expect(JSON.stringify(log.mock.calls)).not.toContain('private-cloud'); expect(process.exitCode).toBe(1);
});
it('correlates GitHub signed claims before sending an assertion to a cloud', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ value: assertion(f.github, 'sts.amazonaws.com', { ref: 'refs/heads/other' }) })));
  await expect(githubOidcToken(f.github, 'sts.amazonaws.com')).rejects.toThrow(/does not match/);
});
it('exchanges an Azure assertion with client_assertion only, scoped to Resource Manager, without using a client secret', async () => {
  const f = fixture(); const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = vi.fn(async (raw: string | URL, init: RequestInit = {}) => {
    const url = String(raw); calls.push({ url, body: String(init.body ?? '') });
    return Response.json(url.includes('actions.githubusercontent.com') ? { value: assertion(f.github, 'api://AzureADTokenExchange') } : { access_token: 'private-azure-token', expires_in: 3600 });
  });
  const b = { ...f.binding, provider: 'azure', azure: { tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222' } } as unknown as EngineCiBinding;
  const tokens = new AzureCiTokens(b, f.github, fetchImpl as typeof fetch); expect(await tokens.get('https://management.azure.com/.default')).toBe('private-azure-token');
  const body = new URLSearchParams(calls[1]!.body); expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer'); expect(body.has('client_secret')).toBe(false);
  expect(body.get('scope')).toBe('https://management.azure.com/.default'); expect(tokens.redact).toContain('private-azure-token');
});

function replaceCommitted(f: ReturnType<typeof fixture>, rawSpec: any, binding: any) {
  binding.appliedContractHash = environmentDeploymentContractHash(rawSpec, 'preview');
  const bindings = { version: 1, project: 'app', environments: { preview: { platformBindings: { engineCi: binding } } } };
  writeFileSync(`${directory}/.hypervibe/spec.json`, JSON.stringify(rawSpec)); writeFileSync(`${directory}/.hypervibe/bindings.json`, JSON.stringify(bindings));
  execFileSync('git', ['-C', directory, 'add', '.']); execFileSync('git', ['-C', directory, 'commit', '-m', 'scope fixture'], { stdio: 'pipe' });
  const sha = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { ...f, rawSpec, bindings, binding, github: { ...f.github, sha } };
}
it.each(['ready', 'web-ready', 'web-private', 'worker-ready', 'registry-403', 'registry-404', 'registry-owner', 'registry-abac', 'registry-unknown-mode', 'task-404'])('requires exact Azure dedicated registry/task/workload IDs before a federated build: %s', async (condition) => {
  const { azureCiRegistry } = await import('../../adapters/providers/azure/azure-ci-registry.js');
  const base = fixture(); const subscriptionId = '11111111-1111-4111-8111-111111111111'; const resourceGroup = 'hv-app';
  const registry = azureCiRegistry({ subscriptionId, resourceGroup, environmentId: 'env1' });
  const group = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const kind = condition === 'web-ready' || condition === 'web-private' ? 'web' : condition === 'worker-ready' ? 'worker' : 'cron';
  const serviceId = `${group}/providers/Microsoft.App/${kind === 'cron' ? 'jobs' : 'containerApps'}/${prefix}-nightly`; const managedEnvironmentId = `${group}/providers/Microsoft.App/managedEnvironments/${prefix}-apps`;
  const binding = { ...base.binding, provider: 'azure', region: 'northeurope', aws: undefined,
    azure: { subscriptionId, resourceGroup, tenantId: subscriptionId, clientId: '22222222-2222-4222-8222-222222222222', registryId: registry.id, registryLoginServer: registry.loginServer, buildTaskId: `${registry.id}/tasks/${prefix}-images` },
    services: { nightly: { serviceId, workloadKind: kind, resourceType: kind === 'cron' ? 'container-job' : 'container-app', region: 'northeurope', managedEnvironmentId } } };
  const rawSpec = { ...base.rawSpec, environments: { preview: { hosting: { provider: 'azure', region: 'northeurope' }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' }, services: { nightly: { workloadKind: kind, ...(kind === 'cron' ? { cronSchedule: '0 1 * * *' } : kind === 'web' ? { public: condition !== 'web-private', healthCheckPath: '/health' } : {}), startCommand: 'npm run nightly' } } } } };
  const f = replaceCommitted(base, rawSpec, binding); const calls: Array<{ method: string; url: string; body: any }> = []; let image = 'old';
  vi.stubGlobal('fetch', vi.fn(async (raw: string | URL, init: RequestInit = {}) => {
    const url = String(raw); const method = init.method ?? 'GET'; const text = String(init.body ?? ''); const body = text.startsWith('{') ? JSON.parse(text) : text; calls.push({ method, url, body });
    if (url.includes('actions.githubusercontent.com')) return Response.json({ value: assertion(f.github, 'api://AzureADTokenExchange') });
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'private-azure-access', expires_in: 3600 });
    if (url.includes('/tasks/')) return condition === 'task-404' ? Response.json({}, { status: 404 }) : Response.json({ id: binding.azure.buildTaskId, properties: { status: 'Enabled' } });
    if (url.includes(registry.id) && url.includes('?api-version=2025-11-01')) return condition === 'registry-403' || condition === 'registry-404' ? Response.json({ error: { message: 'private-azure-access' } }, { status: condition === 'registry-403' ? 403 : 404 }) : Response.json({ id: registry.id, tags: { 'managed-by': 'hypervibe', 'hv-environment': condition === 'registry-owner' ? 'other' : 'env1' }, properties: { loginServer: registry.loginServer, provisioningState: 'Succeeded', roleAssignmentMode: condition === 'registry-unknown-mode' ? undefined : condition === 'registry-abac' ? 'AbacRepositoryPermissions' : 'LegacyRegistryPermissions' } });
    if (url.includes('/listBuildSourceUploadUrl?')) return Response.json({ uploadUrl: 'https://source.blob.core.windows.net/build/source?sig=private-upload-signature', relativePath: 'build/source' });
    if (url.includes('source.blob.core.windows.net')) return new Response(null, { status: 201 });
    if (url.includes('/scheduleRun?')) return Response.json({ name: 'run1', properties: { runId: 'run1' } });
    if (url.includes('/runs/run1?')) return Response.json({ id: `${registry.id}/runs/run1`, properties: { status: 'Succeeded', outputImages: [{ repository: 'app', tag: f.github.sha, digest }] } });
    if (url === 'https://app.example/health') return new Response('ok', { status: condition === 'web-private' ? 403 : 200 });
    if (url.includes('/revisions/')) return Response.json({ id: `${serviceId}/revisions/current-2`, properties: { healthState: 'Healthy', provisioningState: 'Provisioned' } });
    if (url.includes(serviceId)) {
      if (method === 'PATCH') { image = body.properties.template.containers[0].image; return Response.json({ id: serviceId }, { status: 202 }); }
      const revision = image === 'old' ? 'current-1' : 'current-2';
      return Response.json({ id: serviceId, location: 'northeurope', properties: { environmentId: managedEnvironmentId, provisioningState: 'Succeeded', latestRevisionName: revision, latestReadyRevisionName: revision, configuration: { ingress: { fqdn: 'app.example' } }, template: { containers: [{ name: 'app', image, env: [{ name: 'UNCHANGED', secretRef: 'private-ref' }] }] } } });
    }
    throw new Error('Unexpected Azure operation');
  }));
  const result = await executeEngineCiRelease(f);
  if (!['ready', 'web-ready', 'worker-ready'].includes(condition)) {
    if (condition === 'web-private') expect(calls).toEqual([]);
    expect(result.status).toBe('blocked'); expect(calls.some((r) => r.url.includes('listBuildSourceUploadUrl') || r.url.includes('scheduleRun') || r.method === 'PATCH')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private-azure|private-upload|private-ref|client_assertion/);
    return;
  }
  expect(result).toMatchObject({ status: 'released', results: [{ service: 'nightly', serviceId, imageUri: `${registry.loginServer}/app@${digest}` }] });
  const schedule = calls.find((r) => r.url.includes('/scheduleRun?'))!;
  expect(schedule.url).toContain(registry.id); expect(schedule.body).toMatchObject({ type: 'TaskRunRequest', taskId: binding.azure.buildTaskId });
  expect(calls.findIndex((r) => r.url.includes(serviceId))).toBeLessThan(calls.findIndex((r) => r.url.includes('/listBuildSourceUploadUrl?')));
  expect(calls.find((r) => r.method === 'PATCH')?.body.properties.template.containers[0].env).toEqual([{ name: 'UNCHANGED', secretRef: 'private-ref' }]);
  expect(JSON.stringify(result)).not.toMatch(/private-azure|private-upload|private-ref|client_assertion/);
});
it('releases an exact ECS worker from its current native revision and waits for the acknowledged rollout', async () => {
  const base = fixture(); const ecs = `arn:aws:ecs:${region}:${account}`; const clusterArn = `${ecs}:cluster/${prefix}`; const serviceId = `${ecs}:service/${prefix}/${prefix}-worker`;
  const family = `${prefix}-worker`; const old = `${ecs}:task-definition/${family}:5`; const next = `${ecs}:task-definition/${family}:6`;
  const binding = { ...base.binding, services: { worker: { serviceId, clusterArn, taskDefinitionArn: `${ecs}:task-definition/${family}:4`, workloadKind: 'worker', resourceType: 'ecs-service', region } } };
  const rawSpec = { ...base.rawSpec, environments: { preview: { ...base.rawSpec.environments.preview, services: { worker: { workloadKind: 'worker', startCommand: 'npm run worker' } } } } };
  const f = replaceCommitted(base, rawSpec, binding); const calls = transport(f.github); const original = vi.mocked(NodeHttpHandler.prototype.handle).getMockImplementation()!; let active = old;
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (r: any, opts: any) => {
    const target = r.headers['x-amz-target'] ?? ''; const text = String(r.body ?? ''); const body = text.startsWith('{') ? JSON.parse(text) : text; let data: unknown;
    if (target.endsWith('DescribeServices')) data = { services: [{ serviceArn: serviceId, clusterArn, taskDefinition: active, status: 'ACTIVE', desiredCount: 0, runningCount: 0, pendingCount: 0, deployments: [{ status: 'PRIMARY', taskDefinition: active, rolloutState: 'COMPLETED' }] }] };
    else if (target.endsWith('DescribeTaskDefinition')) data = { taskDefinition: { taskDefinitionArn: active, family, status: 'ACTIVE', taskRoleArn: `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-runtime`, executionRoleArn: `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-runtime`, containerDefinitions: [{ name: 'app', image: 'old', environment: [{ name: 'UNCHANGED', value: 'retained' }] }] } };
    else if (target.endsWith('RegisterTaskDefinition')) data = { taskDefinition: { taskDefinitionArn: next } };
    else if (target.endsWith('UpdateService')) { active = next; data = { service: { serviceArn: serviceId } }; }
    else return original(r, opts);
    calls.push({ method: r.method, host: r.hostname, path: r.path, target, body });
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Readable.from([JSON.stringify(data)]) } };
  });
  const result = await executeEngineCiRelease(f);
  expect(result).toMatchObject({ status: 'released', results: [{ service: 'worker', serviceId, taskDefinitionArn: next }] });
  expect(calls.find((r) => r.target.endsWith('UpdateService'))?.body).toMatchObject({ cluster: clusterArn, service: serviceId, taskDefinition: next });
  expect(calls.find((r) => r.target.endsWith('RegisterTaskDefinition'))?.body.containerDefinitions[0].environment).toEqual([{ name: 'UNCHANGED', value: 'retained' }]);
  expect(calls.filter((r) => r.target.endsWith('DescribeTaskDefinition')).every((r) => r.body.taskDefinition === old)).toBe(true);
});
it('reports a release AWS rolled back as failed, never as released', async () => {
  const { releaseWebService } = await import('../../adapters/providers/aws/aws-release.client.js');
  const f = fixture(); transport(f.github, { rolledBack: true });
  const result = await releaseWebService({ region, accountId: account, prefix, credentials: { accessKeyId: 'AKIACI000000000000', secretAccessKey: 'private-cloud-secret', sessionToken: 'private-cloud-session' } }, 'web', webArn, `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@${digest}`, '/health');
  expect(result).toMatchObject({ status: 'failed', message: expect.stringContaining('AWS kept the previous one running') });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['node b.js', undefined])('reconciles a same-image AWS command change or removal (%s)', async startCommand => {
  const { releaseWebService } = await import('../../adapters/providers/aws/aws-release.client.js');
  const f = fixture(); const calls = transport(f.github, { alreadyRunning: true, previousCommand: ['sh', '-c', 'node a.js'] });
  const result = await releaseWebService({ region, accountId: account, prefix, credentials: { accessKeyId: 'AKIAFIXTURE', secretAccessKey: 'synthetic', sessionToken: 'synthetic' } },
    'web', webArn, `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@${digest}`, '/health', false, 0, startCommand);
  expect(result.status).toBe('released');
  expect(calls.find(call => call.target.endsWith('UpdateExpressGatewayService'))?.body.primaryContainer.command).toEqual(startCommand ? ['sh', '-c', startCommand] : []);
});

it('releasing an already-running web service digest performs no workload mutation', async () => {
  const { releaseWebService: releaseFunction } = await import('../../adapters/providers/aws/aws-release.client.js');
  const f = fixture(); const calls = transport(f.github, { alreadyRunning: true });
  const result = await releaseFunction({ region, accountId: account, prefix, credentials: { accessKeyId: 'AKIACI000000000000', secretAccessKey: 'private-cloud-secret', sessionToken: 'private-cloud-session' } }, 'web', webArn, `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@${digest}`, '/health');
  expect(result).toMatchObject({ status: 'released', url: 'https://app.example' }); expect(calls.filter((r) => /Update|Create|Delete|Register/.test(r.target))).toEqual([]);
});

// #557: a declared health check that answers 4xx fails the release; the "/" fallback keeps the lenient rule.
it.each([[true, 'failed'], [false, 'released']] as const)('treats HTTP 403 from an AWS health check by whether the path was declared (strict: %s)', async (strict, expected) => {
  const { releaseWebService: releaseFunction } = await import('../../adapters/providers/aws/aws-release.client.js');
  const f = fixture(); transport(f.github, { alreadyRunning: true, privateHealth: true });
  const result = await releaseFunction({ region, accountId: account, prefix, credentials: { accessKeyId: 'AKIACI000000000000', secretAccessKey: 'private-cloud-secret', sessionToken: 'private-cloud-session' } }, 'web', webArn, `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@${digest}`, '/health', strict);
  expect(result).toMatchObject({ status: expected, health: { status: 403, path: '/health' } });
});

it.each([true, false])('releases the per-service AWS command alongside the image (repository Dockerfile: %s)', async (dockerfile) => {
  const f = fixture({ startCommand: 'npm start', dockerfile }); const calls = transport(f.github);
  const result = await executeEngineCiRelease(f);
  expect(result.status).toBe('released');
  expect(calls.find(call => call.target.endsWith('UpdateExpressGatewayService'))?.body.primaryContainer.command).toEqual(['sh', '-c', 'npm start']);
});

it.each([true, false])('requires a Dockerfile default for a commandless web peer before building (override first %s)', async overrideFirst => {
  const base = fixture({ dockerfile: false });
  const plain = base.rawSpec.environments.preview.services.web;
  const override = { ...plain, startCommand: 'node admin.js' };
  const services = overrideFirst ? { admin: override, web: plain } : { web: plain, admin: override };
  const extraWebArn = webArn.replace(/-web$/, '-admin');
  const binding = { ...base.binding, services: { ...base.binding.services, admin: { ...base.binding.services.web, serviceId: extraWebArn } } };
  const rawSpec = { ...base.rawSpec, environments: { preview: { ...base.rawSpec.environments.preview, services } } };
  const f = replaceCommitted(base, rawSpec, binding);
  const calls = transport(f.github, { extraWebArn });
  expect(await executeEngineCiRelease(f)).toMatchObject({ status: 'blocked', message: expect.stringMatching(/startCommand.*Dockerfile/) });
  expect(calls.some(call => call.method === 'PUT' || /StartBuild|UpdateExpress/.test(call.target))).toBe(false);
});

it.each([
  ['npm run public', 'npm run admin', 'released'],
  ['npm start', undefined, 'released'],
  [undefined, 'npm start', 'released'],
  ['npm start', 'npm start', 'released'],
] as const)('runs two workloads from one repository image with their own commands (%s / %s)', async (first, second, status) => {
  const base = fixture({ dockerfile: true, startCommand: first });
  const extraWebArn = `arn:aws:ecs:${region}:${account}:service/${prefix}/${prefix}-admin`;
  const rawSpec = { ...base.rawSpec, environments: { preview: { ...base.rawSpec.environments.preview, services: {
    ...base.rawSpec.environments.preview.services, admin: { workloadKind: 'web', public: true, healthCheckPath: '/health', ...(second === undefined ? {} : { startCommand: second }) },
  } } } };
  const binding = { ...base.binding, services: { ...base.binding.services, admin: { ...base.binding.services.web, serviceId: extraWebArn } } };
  const f = replaceCommitted(base, rawSpec, binding); const calls = transport(f.github, { extraWebArn });
  const result = await executeEngineCiRelease(f);
  expect(result.status).toBe(status);
  for (const [arn, command] of [[webArn, first], [extraWebArn, second]] as const) {
    const container = calls.find(call => call.target.endsWith('UpdateExpressGatewayService') && call.body.serviceArn === arn)?.body.primaryContainer;
    expect(container.command).toEqual(command ? ['sh', '-c', command] : []);
    expect(container.image).toContain(`@${command ? webDigest : digest}`);
  }
  expect(result.results).toMatchObject([{ service: 'web', status: 'released' }, { service: 'admin', status: 'released' }]);
});

it('refuses a private AWS web target before OIDC because CI cannot sign its HTTP health check', async () => {
  const f = fixture({ public: false }); const calls = transport(f.github, { privateHealth: true });
  const result = await executeEngineCiRelease(f);
  expect(result.status).toBe('blocked'); expect(calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
