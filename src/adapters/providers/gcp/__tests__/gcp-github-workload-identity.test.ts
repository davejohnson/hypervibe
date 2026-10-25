import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudRunCredentialsSchema } from '../cloudrun.adapter.js';
import { CloudSqlCredentialsSchema } from '../cloudsql.adapter.js';
import { GcsStorageCredentialsSchema } from '../gcs.adapter.js';
import { buildGcpGithubTokenRuntime, createGcpGithubTokenProvider, parseGcpGithubWorkloadIdentity, GcpGithubWorkloadAuthentication } from '../gcp-github-workload-identity.js';
import { buildCloudRunGitHubActionsSteps } from '../cloudrun-ci.workflow.js';
import { buildCloudRunPortableRecipe } from '../cloudrun-ci.recipe.js';

export const githubWorkloadIdentityFixture = {
  schemaVersion: 1 as const, projectId: 'synthetic-project', projectNumber: '123456789012',
  workloadIdentityProvider: 'projects/123456789012/locations/global/workloadIdentityPools/hv-ci-synthetic/providers/github',
  serviceAccountEmail: 'ci-synthetic@synthetic-project.iam.gserviceaccount.com', serviceAccountUniqueId: '123456789012345678901',
  repository: 'synthetic-owner/synthetic-app', repositoryId: '123456789', repositoryOwnerId: '987654321',
  branch: 'main', environment: 'staging', workflow: '.github/workflows/deploy-cloudrun-staging.yml',
};

describe('keyless GitHub Google authentication at actual adapter input boundaries', () => {
  // Independent contract: Google deployment-pipeline federation exchanges the
  // workflow OIDC token for short-lived access; it does not require user ADC or
  // a service-account private key. These descriptors contain identifiers only.
  // https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
  it.each([['Cloud Run', CloudRunCredentialsSchema], ['Cloud SQL', CloudSqlCredentialsSchema], ['GCS', GcsStorageCredentialsSchema]])(
    '%s accepts the same nonsecret federated credential descriptor', (_name, schema) => {
      expect(schema.parse({ projectId: githubWorkloadIdentityFixture.projectId,
        authMode: 'github-workload-identity', workloadIdentity: githubWorkloadIdentityFixture }))
        .toMatchObject({ authMode: 'github-workload-identity', workloadIdentity: githubWorkloadIdentityFixture });
    });
});

function fixture(claimChanges: Record<string, unknown> = {}) {
  let clock = Date.parse('2026-10-25T12:00:00Z');
  const config = githubWorkloadIdentityFixture;
  const getSubjectToken = vi.fn(async (audience: string) => [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', aud: audience,
      sub: `repo:${config.repository}:environment:${config.environment}`, repository: config.repository,
      repository_id: config.repositoryId, repository_owner_id: config.repositoryOwnerId,
      ref: `refs/heads/${config.branch}`, workflow_ref: `${config.repository}/${config.workflow}@refs/heads/${config.branch}`,
      event_name: 'workflow_dispatch', iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 300, ...claimChanges,
    })).toString('base64url'), 'synthetic-signature',
  ].join('.'));
  const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    if (String(url) === 'https://sts.googleapis.com/v1/token') {
      // STS explicitly prohibits an Authorization header. This is a serialized
      // token-exchange contract, not a caller-supplied synthetic SDK result.
      expect(new Headers(options?.headers).has('authorization')).toBe(false);
      const body = new URLSearchParams(String(options?.body));
      expect(body.get('audience')).toBe(`//iam.googleapis.com/${config.workloadIdentityProvider}`);
      expect(body.get('subject_token')).toBe(await getSubjectToken(`https://iam.googleapis.com/${config.workloadIdentityProvider}`));
      expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
      return Response.json({ access_token: 'synthetic-sts-access-token', expires_in: 3600, token_type: 'Bearer',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
    }
    expect(String(url)).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccountUniqueId}:generateAccessToken`);
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-sts-access-token');
    expect(JSON.parse(String(options?.body))).toEqual({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '900s' });
    return Response.json({ accessToken: 'synthetic-impersonated-token', expireTime: new Date(clock + 900_000).toISOString() });
  });
  return { getSubjectToken, request, now: () => clock, advance: () => { clock += 850_000; } };
}

describe('Google GitHub OIDC exchange contract', () => {
  it('uses STS and exact unique service-account impersonation without ADC, keys or tokens in the descriptor', async () => {
    const f = fixture(); const issue = createGcpGithubTokenProvider(githubWorkloadIdentityFixture, { fetch: f.request, ...f });
    await expect(issue()).resolves.toMatchObject({ token: 'synthetic-impersonated-token' });
    await issue(); expect(f.request).toHaveBeenCalledTimes(2);
    f.advance(); await issue(); expect(f.request).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(githubWorkloadIdentityFixture)).not.toMatch(/private_key|refresh_token|synthetic-.*token/);
  });
  it.each([
    { repository_id: '555555555' }, { repository_owner_id: '555555555' }, { repository: 'another-owner/synthetic-app' },
    { ref: 'refs/heads/other' }, { sub: 'repo:synthetic-owner/synthetic-app:environment:production' },
    { workflow_ref: 'synthetic-owner/synthetic-app/.github/workflows/other.yml@refs/heads/main' },
    { event_name: 'pull_request' }, { aud: 'https://attacker.invalid' }, { iss: 'https://attacker.invalid' }, { exp: 0 },
  ])('rejects a mismatched workflow claim before exchanging credentials: %j', async changes => {
    const f = fixture(changes); const issue = createGcpGithubTokenProvider(githubWorkloadIdentityFixture, { fetch: f.request, ...f });
    await expect(issue()).rejects.toThrow('could not authorize'); expect(f.request).not.toHaveBeenCalled();
  });
  it('executes the emitted workflow exchange with the same transport and claim boundaries', async () => {
    const f = fixture();
    // Use a current synthetic assertion because emitted code uses the runner clock.
    const clock = vi.spyOn(Date, 'now').mockImplementation(f.now);
    try {
      const run = new Function('core', 'fetch', `return (async()=>{${buildGcpGithubTokenRuntime(githubWorkloadIdentityFixture)}return await getAccessToken();})()`);
      await expect(run({ getIDToken: f.getSubjectToken }, f.request)).resolves.toBe('synthetic-impersonated-token');
      expect(f.request).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
  it.each(['success', 'provider-error', 'echo'] as const)('runs the actual GoogleAuth/OAuth client for SQL Connector and guards %s', async outcome => {
    const f = fixture(); const clock = vi.spyOn(Date, 'now').mockImplementation(f.now);
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sqladmin.googleapis.com/sql/v1beta4/projects/synthetic-project/instances/database');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-impersonated-token');
      return outcome === 'success' ? Response.json({ name: 'database', state: 'RUNNABLE' })
        : Response.json({ message: 'synthetic-impersonated-token' }, { status: outcome === 'provider-error' ? 403 : 200 });
    });
    vi.stubGlobal('fetch', transport);
    try {
      const auth = new GcpGithubWorkloadAuthentication(githubWorkloadIdentityFixture, { fetch: f.request, ...f });
      const client = await auth.auth.getClient();
      const result = client.request({ url: 'https://sqladmin.googleapis.com/sql/v1beta4/projects/synthetic-project/instances/database' });
      if (outcome === 'success') await expect(result).resolves.toMatchObject({ data: { name: 'database', state: 'RUNNABLE' } });
      else {
        const error = await result.catch(error => error);
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain('synthetic-impersonated-token');
        expect(String(error)).not.toContain('synthetic-impersonated-token');
      }
      expect(f.request).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); clock.mockRestore(); }
  });
  it('rejects extra credential fields and a cross-project native descriptor', () => {
    expect(() => parseGcpGithubWorkloadIdentity({ ...githubWorkloadIdentityFixture, private_key: 'synthetic-private-key' })).toThrow();
    expect(() => parseGcpGithubWorkloadIdentity({ ...githubWorkloadIdentityFixture, projectNumber: '999999999999' })).toThrow();
  });
  it.each(['valid', 'registry-replaced', 'image-replaced', 'source-changed', 'wrong-digest'] as const)(
    'executes a long build then fresh registry access with exact candidate guards: %s', async scenario => {
    const f = fixture(), clock = vi.spyOn(Date, 'now').mockImplementation(f.now), config = githubWorkloadIdentityFixture;
    const runner = mkdtempSync(join(tmpdir(), 'hv-gcp-long-build-')), require = createRequire(import.meta.url);
    const sha = 'a'.repeat(40), imageId = 'sha256:' + 'b'.repeat(64), imageDigest = 'sha256:' + 'c'.repeat(64);
    const image = `us-central1-docker.pkg.dev/${config.projectId}/hypervibe/${config.repository}:${sha}`;
    const repository = image.slice(0, image.lastIndexOf(':'));
    const target = { environmentName: 'staging', kind: 'staging' as const, branch: 'main', autoDeployOnPush: true,
      serviceNames: ['web'], providerProjectId: config.projectId, providerServiceIds: ['web'], providerRegion: 'us-central1',
      providerScope: { projectId: config.projectId, region: 'us-central1', artifactRepository: 'hypervibe', artifactRepositoryCreateTime: '2026-10-25T00:00:00Z' },
      runtimeResources: [{ logicalName: 'web', workloadKind: 'web' as const, providerResourceType: 'service' as const,
        providerResourceId: 'web', providerResourceUid: 'synthetic-native-uid', startCommand: null, healthCheckPath: null }], nativeAuthentication: config };
    const env: Record<string,string> = { RUNNER_TEMP: runner, GCP_PROJECT_ID: config.projectId, GCP_BOUND_PROJECT_ID: config.projectId,
      GCP_REGION: 'us-central1', GCP_ARTIFACT_REPOSITORY: 'hypervibe', GITHUB_REPOSITORY: config.repository, DEPLOY_SHA: sha,
      IMAGE_TAG: image, BUILT_IMAGE_ID: imageId };
    let loginAt = 0, pushed = false, built = false; const logins: string[] = [], outputs: unknown[][] = [];
    const execute = (_command: string, args: string[], options: any) => {
      expect(JSON.stringify(args)).not.toContain('synthetic-impersonated-token');
      if (args.includes('login')) { expect(options.input).toBe('synthetic-impersonated-token'); expect(options.stdio).toEqual(['pipe','ignore','ignore']);
        loginAt = f.now(); logins.push(args[1]); return ''; }
      if (args.includes('push')) {
        if (f.now() - loginAt >= 900000) throw new Error('Synthetic registry rejected the expired pre-build token.');
        expect(args.at(-1)).toBe(image); expect(options.stdio).toEqual(['ignore','ignore','ignore']); pushed = true; return '';
      }
      if (args.includes('inspect')) return JSON.stringify([{ Id: scenario === 'image-replaced' ? 'sha256:' + 'd'.repeat(64) : imageId, RepoTags: [image],
        RepoDigests: pushed ? [(scenario === 'wrong-digest' ? 'unrelated-registry.invalid/other/image' : repository) + '@' + imageDigest] : [] }]);
      throw new Error('Unexpected generated Docker command');
    };
    const core = { getIDToken: f.getSubjectToken, setSecret: () => {}, setOutput: (...values: unknown[]) => outputs.push(values),
      exportVariable: (key: string,value: string) => { env[key] = value; } };
    const request: typeof fetch = async (url, options) => String(url).startsWith('https://artifactregistry.googleapis.com/')
      ? Response.json({ name: `projects/${config.projectId}/locations/us-central1/repositories/hypervibe`, format: 'DOCKER',
        createTime: built && scenario === 'registry-replaced' ? '2026-10-25T01:00:00Z' : '2026-10-25T00:00:00Z' })
      : f.request(url, options);
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const run = (script: string) => new AsyncFunction('require','core','fetch','process',script)(
      (name: string) => name === 'node:child_process' ? { execFileSync: execute } : require(name), core, request, { env });
    try {
      const steps = parseYaml('steps:\n' + buildCloudRunGitHubActionsSteps(target).steps).steps;
      await run(steps.find((step: any) => step.name === 'Verify GCP Artifact Registry').with.script);
      const build = steps.find((step: any) => step.uses === 'docker/build-push-action@v6');
      expect(build.with.secrets).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
      // Execute the declared action's push behavior after independent synthetic
      // elapsed time. The external Docker build is the only substituted work.
      f.advance(); f.advance(); built = true;
      if (scenario === 'source-changed') env.GITHUB_REPOSITORY = 'unrelated-owner/other-app';
      if (build.with.push) execute('docker', ['--config',env.DOCKER_CONFIG,'push',image], { stdio: ['ignore','ignore','ignore'] });
      else { expect(build.with.load).toBe(true);
        const pushing = run(steps.find((step: any) => step.id === 'build').with.script);
        if (scenario === 'valid') await pushing; else await expect(pushing).rejects.toThrow('could not be published');
      }
      if (scenario === 'valid') {
        expect(pushed).toBe(true); expect(f.request).toHaveBeenCalledTimes(4); expect(logins).toHaveLength(2);
        expect(existsSync(logins[0])).toBe(false); expect(outputs).toEqual([['digest',imageDigest]]);
      } else { expect(pushed).toBe(scenario === 'wrong-digest'); expect(outputs).toEqual([]); }
      await run(steps.find((step: any) => step.name === 'Remove temporary registry access').with.script);
      expect(logins.some(config => existsSync(config))).toBe(false);
    } finally { clock.mockRestore(); rmSync(runner,{ recursive:true,force:true }); }
  });
  it.each([false, true])('executes actual generated WIF registry authentication and blocks lifetime replacement=%s', async replaced => {
    const f = fixture(); const clock = vi.spyOn(Date, 'now').mockImplementation(f.now);
    const runner = mkdtempSync(join(tmpdir(), 'hv-gcp-wif-runner-'));
    const require = createRequire(import.meta.url); const docker: unknown[][] = []; const outputs: unknown[][] = [];
    const config = githubWorkloadIdentityFixture;
    const target = { environmentName: 'staging', kind: 'staging' as const, branch: 'main', autoDeployOnPush: true,
      serviceNames: ['web'], providerProjectId: config.projectId, providerServiceIds: ['web'], providerRegion: 'us-central1',
      providerScope: { projectId: config.projectId, region: 'us-central1', artifactRepository: 'hypervibe', artifactRepositoryCreateTime: '2026-10-25T00:00:00Z' },
      runtimeResources: [{ logicalName: 'web', workloadKind: 'web' as const, providerResourceType: 'service' as const,
        providerResourceId: 'web', providerResourceUid: 'synthetic-native-uid', startCommand: null, healthCheckPath: null }], nativeAuthentication: config };
    try {
      const program = buildCloudRunGitHubActionsSteps(target);
      expect(program.requiredSecrets).toEqual([]); expect(program.permissions).toContain('id-token: write');
      expect(program.steps).not.toMatch(/GCP_SERVICE_ACCOUNT_JSON|secrets\.GCP_PROJECT_ID|outputs\.access_token/);
      expect(() => buildCloudRunPortableRecipe(target)).toThrow(/GitHub/);
      const steps = parseYaml('steps:\n' + program.steps).steps;
      const script = steps.find((step: any) => step.name === 'Verify GCP Artifact Registry').with.script;
      const env: Record<string, string> = { RUNNER_TEMP: runner, GCP_PROJECT_ID: config.projectId, GCP_BOUND_PROJECT_ID: config.projectId,
        GCP_REGION: 'us-central1', GCP_ARTIFACT_REPOSITORY: 'hypervibe' };
      const dependencies = (name: string) => name === 'node:child_process' ? { execFileSync: (...args: unknown[]) => docker.push(args) } : require(name);
      const core = { getIDToken: f.getSubjectToken, setSecret: () => {}, setOutput: (...args: unknown[]) => outputs.push(args),
        exportVariable: (key: string, value: string) => { env[key] = value; } };
      const request: typeof fetch = async (url, options) => {
        if (!String(url).startsWith('https://artifactregistry.googleapis.com/')) return f.request(url, options);
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-impersonated-token');
        return Response.json({ name: `projects/${config.projectId}/locations/us-central1/repositories/hypervibe`, format: 'DOCKER',
          createTime: replaced ? '2026-10-25T01:00:00Z' : '2026-10-25T00:00:00Z' });
      };
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const running = new AsyncFunction('require', 'core', 'fetch', 'process', script)(dependencies, core, request, { env });
      if (replaced) { await expect(running).rejects.toThrow('could not be verified'); expect(docker).toEqual([]); }
      else { await running; expect(docker[0][2]).toMatchObject({ input: 'synthetic-impersonated-token', stdio: ['pipe', 'ignore', 'ignore'] }); }
      expect(outputs).toEqual([]);
    } finally { clock.mockRestore(); rmSync(runner, { recursive: true, force: true }); }
  });
});
