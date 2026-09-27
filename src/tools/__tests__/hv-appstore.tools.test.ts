import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { apiReleaseArtifactPrefix } from '../../domain/services/api-release-workflow.js';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createToolContext } from '../../application/context.js';
import { registerHvAppstoreTools } from '../hv-appstore.tools.js';
import '../../adapters/providers/railway/railway.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { resolveManagedWorkflowContract, workflowFiles } from '../../domain/services/ci-deploy.service.js';
import { iosBuildContractFingerprint } from '../../domain/services/ios-release-evidence.js';
import { environmentDeploymentContractHash } from '../../domain/services/deployment-contract.service.js';
import { MANAGED_CI_RELEASE_EVIDENCE_VERSION, managedCiReleaseArtifactPrefix } from '../../domain/services/managed-ci-evidence.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-appstore-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedConnection(options: { promotion?: boolean; api?: boolean; newerServer?: boolean } = {}) {
  const appStore = new ConnectionRepository().create({
    provider: 'appstoreconnect',
    credentialsEncrypted: getSecretStore().encryptObject({
      keyId: 'KEY1',
      issuerId: 'ISSUER1',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    }),
  });
  new ConnectionRepository().updateStatus(appStore.id, 'verified');
  const github = new ConnectionRepository().create({
    provider: 'github',
    scope: 'davejohnson/example',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'github-token' }),
  });
  new ConnectionRepository().updateStatus(github.id, 'verified');
  const project = new ProjectRepository().create({
    name: 'example',
    defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/davejohnson/example',
  });
  new SpecStore().replace(project, {
    version: 1,
    project: 'example',
    gitRemoteUrl: 'https://github.com/davejohnson/example',
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        deploy: { strategy: 'branch', trigger: 'ci' },
        ios: {
          bundleId: 'com.example.app',
          testflight: { groups: { beta: {} } },
          release: {
            services: ['web'],
            build: { command: 'make ipa', ipaPath: 'Example.ipa' },
            testflight: { groups: ['beta'] },
          },
        },
      },
    },
  } as never);
  const configured = new SpecStore().get(project)!.spec;
  if (options.api) {
    configured.runtime = { kind: 'node', version: '24' };
    configured.environments.production.api = {
      service: 'web', versions: { v1: { path: '/v1', contract: 'api/v1.json', status: 'supported' } }, consumers: {},
      compatibility: { command: 'npm run test:api-compatibility', workingDirectory: '.' },
    };
    configured.environments.production.ios!.release!.apiVersion = 'v1';
  }
  if (options.promotion) {
    configured.environments.staging = structuredClone(configured.environments.production);
    configured.environments.staging.ios!.release!.trigger = 'after-server-deploy';
    configured.environments.production.ios!.release!.promoteFrom = 'staging';
    configured.environments.production.ios!.release!.trigger = 'manual';
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId: 'rail-project', environmentId: 'rail-stage', services: { web: { serviceId: 'stage-web' } },
    } });
  }
  new SpecStore().replace(project, configured);
  new EnvironmentRepository().create({
    projectId: project.id, name: 'production',
    platformBindings: { provider: 'railway', projectId: 'rail-project', environmentId: 'rail-env', services: { web: { serviceId: 'rail-web' } } },
  });
  const spec = new SpecStore().get(project)!.spec;
  const contract = resolveManagedWorkflowContract({ project, environmentName: 'production', environmentSpec: spec.environments.production });
  if (!contract.ok) throw new Error(contract.error);
  const sourceEnvironment = options.promotion ? 'staging' : 'production';
  const sourceContract = resolveManagedWorkflowContract({ project, environmentName: sourceEnvironment, environmentSpec: spec.environments[sourceEnvironment] });
  if (!sourceContract.ok) throw new Error(sourceContract.error);
  const workflows = new Map([...workflowFiles(contract.workflow), ...workflowFiles(sourceContract.workflow)].map((file) => [file.path, file.content]));
  const releaseSha = 'a'.repeat(40);
  const run = (id: number) => ({
    id, name: 'release', status: 'completed', conclusion: 'success',
    path: id === 101 ? contract.workflow.path : id === 103 ? sourceContract.workflow.path : `.github/workflows/hypervibe-ios-release-${sourceEnvironment}.yml`,
    created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:10:00Z',
    // The dispatched program is newer than its deliberately selected release.
    head_sha: 'b'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', run_attempt: 1,
    repository: { full_name: 'davejohnson/example' }, head_repository: { full_name: 'davejohnson/example' },
    html_url: `https://github.com/davejohnson/example/actions/runs/${id}`,
  });
  const mobile = {
    version: 2, environment: sourceEnvironment,
    mobile: { repository: 'davejohnson/example', sha: releaseSha, buildContractFingerprint: iosBuildContractFingerprint(spec.environments.production.ios!, spec.runtime) },
    server: { repository: 'davejohnson/example', sha: releaseSha, workflowRunId: options.promotion ? '103' : '101', evidenceSha256: '' }, services: ['web'],
    app: { appId: 'app-1', bundleId: 'com.example.app', buildId: 'build-1', buildNumber: '42', marketingVersion: '1.2.0', ipaSha256: 'c'.repeat(64), testflightGroups: ['beta'], submittedForBetaReview: false },
    releasedAt: '2026-07-01T00:10:00Z',
  };
  const server = {
    version: MANAGED_CI_RELEASE_EVIDENCE_VERSION, provider: 'railway', environment: 'production', source: { repository: 'davejohnson/example', sha: options.newerServer ? 'e'.repeat(40) : releaseSha },
    programFingerprint: contract.target.programFingerprint,
    deploymentContractFingerprint: environmentDeploymentContractHash(spec, 'production'),
    target: { ...contract.target.releaseTarget!, resources: contract.target.releaseTarget!.resources.map((resource) => ({ ...resource, imageUri: 'ghcr.io/davejohnson/example@sha256:' + 'd'.repeat(64) })) },
    verifiedAt: '2026-07-01T00:05:00Z',
  };
  const sourceServer = options.promotion ? {
    ...server, environment: sourceEnvironment, source: { repository: 'davejohnson/example', sha: releaseSha },
    programFingerprint: sourceContract.target.programFingerprint,
    deploymentContractFingerprint: environmentDeploymentContractHash(spec, sourceEnvironment),
    target: { ...sourceContract.target.releaseTarget!, resources: sourceContract.target.releaseTarget!.resources.map((resource) => ({ ...resource, imageUri: 'ghcr.io/davejohnson/example@sha256:' + 'd'.repeat(64) })) },
  } : server;
  const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  mobile.server.evidenceSha256 = digest(encode(sourceServer));
  const snapshot = '{"openapi":"3.1.0"}\n';
  const apiProof = (environment: string, id: number, body: typeof server) => {
    const policy = spec.environments[environment].api!;
    return {
      version: 1, repository: 'davejohnson/example', environment, sha: body.source.sha, runId: id, workflow: run(id).path,
      service: 'web', versions: { v1: { ...policy.versions.v1, snapshot: 'contracts/v1.json', contractHash: digest(snapshot) } }, consumers: {},
      policyHash: canonicalJsonSha256(policy), baseline: null,
      compatibility: { status: 'passed', claim: 'project-command', commandHash: canonicalJsonSha256(policy.compatibility) },
      serverEvidenceSha256: digest(encode(body)),
    };
  };
  const targetApi = options.api ? apiProof('production', 101, server) : undefined;
  const sourceApi = options.api ? apiProof(sourceEnvironment, options.promotion ? 103 : 101, sourceServer) : undefined;
  const artifact = (id: number) => ({
    id: id + 100,
    name: id === 102 ? `hypervibe-ios-release-${sourceEnvironment}-` + releaseSha : managedCiReleaseArtifactPrefix(id === 101 ? 'production' : sourceEnvironment) + (id === 101 ? server.source.sha : releaseSha),
    expired: false, created_at: '2026-07-01T00:05:00Z', updated_at: '2026-07-01T00:05:00Z',
    workflow_run: { id, repository_id: 1, head_repository_id: 1, head_branch: 'main', head_sha: 'b'.repeat(40) },
  });
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockImplementation(async (_owner, _repo, workflow) => ({ total_count: 1, workflow_runs: [run(String(workflow).includes('ios-release') ? 102 : 101)] }));
  vi.spyOn(GitHubAdapter.prototype, 'getWorkflowRun').mockImplementation(async (_owner, _repo, id) => run(id));
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockImplementation(async (_owner, _repo, id) => {
    const artifacts = [artifact(Number(id))];
    if (options.api && Number(id) !== 102) artifacts.push({
      ...artifact(Number(id)), id: Number(id) + 200,
      name: apiReleaseArtifactPrefix(Number(id) === 101 ? 'production' : sourceEnvironment) + (Number(id) === 101 ? server.source.sha : releaseSha),
    });
    return { total_count: artifacts.length, artifacts };
  });
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => file === '.hypervibe/spec.json' ? JSON.stringify(spec) : file === 'api/v1.json' ? snapshot : workflows.get(file) ?? null);
  vi.spyOn(GitHubAdapter.prototype, 'readArtifactFiles').mockImplementation(async (_owner, _repo, id) => id >= 300 ? {
    'hypervibe-api-release.json': encode(id === 301 ? targetApi : sourceApi), 'contracts/v1.json': snapshot,
  } : { [id === 202 ? 'hypervibe-ios-release.json' : 'hypervibe-server-release.json']: encode(id === 202 ? mobile : id === 201 ? server : sourceServer) });
  return { project, spec, contract, mobile, server, sourceServer, sourceApi, targetApi, snapshot, run, artifact, workflows };

}

async function makeClient() {
  const server = new McpServer({ name: 'hv-appstore-test', version: '1.0.0' });
  registerHvAppstoreTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-appstore-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const APP = { id: 'app-1', bundleId: 'com.example.app', name: 'Example App' };
const BUILD = {
  id: 'build-1',
  version: '1.2.0',
  buildNumber: '42',
  processingState: 'VALID',
  usesNonExemptEncryption: false,
  uploadedDate: '2026-06-01T00:00:00Z',
  appId: 'app-1',
};
const GROUP = { id: 'group-1', name: 'External Testers', isInternal: false };

describe('hv_appstore_status', () => {
  it('aggregates builds and groups for an app (happy path)', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBuilds').mockResolvedValue([BUILD]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([GROUP]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['builds', 'groups'],
    });
    expect(status.ok).toBe(true);
    expect(status.data.app).toEqual(APP);
    expect(status.data.builds).toHaveLength(1);
    expect(status.data.builds[0]).toMatchObject({ id: 'build-1', buildNumber: '42', processingState: 'VALID' });
    expect(status.data.groups).toEqual([GROUP]);
    expect(status.data.testers).toBeUndefined();
    expect(status.data.readiness).toBeUndefined();
    await t.close();
  });

  it('hard-bounds build and tester sections when the adapter over-returns', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const listBuilds = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBuilds')
      .mockResolvedValue([
        BUILD,
        { ...BUILD, id: 'build-2', buildNumber: '43' },
      ]);
    const listBetaTesters = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters')
      .mockResolvedValue([
        { id: 'tester-1', email: 'one@example.com' },
        { id: 'tester-2', email: 'two@example.com' },
      ]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['builds', 'testers'],
      limit: 1,
    });

    expect(status.ok).toBe(true);
    expect(status.data.builds).toHaveLength(1);
    expect(status.data.testers).toHaveLength(1);
    expect(listBuilds).toHaveBeenCalledWith({ appId: APP.id, limit: 1 });
    expect(listBetaTesters).toHaveBeenCalledWith({ appId: APP.id, limit: 1 });
    await t.close();
  });

  it('warns when readiness and pagination options do not apply to selected sections', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([GROUP]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['groups'],
      locale: 'fr-CA',
      screenshotDisplayType: 'APP_IPHONE_67',
      limit: 5,
    });

    expect(status.ok).toBe(true);
    expect(status.warnings).toEqual([
      'Ignored options for hv_appstore_status include=["groups"]: locale, screenshotDisplayType, limit. The requested read still completed.',
    ]);
    await t.close();
  });

  it('uses iOS as the default readiness platform', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const getEditableVersion = vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion')
      .mockResolvedValue(null);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['readiness'],
    });

    expect(status.ok).toBe(true);
    expect(getEditableVersion).toHaveBeenCalledWith('app-1', 'IOS');
    await t.close();
  });

  it('returns MISSING_CONNECTION with setup guidance when no connection exists', async () => {
    const t = await makeClient();
    const status = await t.call('hv_appstore_status', { appIdentifier: 'com.example.app' });
    expect(status.ok).toBe(false);
    expect(status.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(status.error.details.connectionSetup, {
      provider: 'appstoreconnect',
      scope: 'com.example.app',
    });
    expect(status.hint).toContain('appstoreconnect.apple.com/access/integrations/api');
    await t.close();
  });
});

const VERSION = { id: 'ver-1', versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' };
const SUBMIT_INPUT = {
  project: 'example',
  environment: 'production',
  appIdentifier: 'com.example.app',
};

describe('hv_appstore_submit', () => {
  function stubSubmittableVersion() {
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const getEditableVersion = vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(VERSION);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getAppStoreVersionBuild').mockResolvedValue({ id: 'build-1', version: '42' });
    return getEditableVersion;
  }

  it('requires a reviewed exact-build confirmation before submitting', async () => {
    seedConnection();
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview').mockResolvedValue({
      reviewSubmission: { id: 'review-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }, reusedExistingSubmission: false,
    });
    const t = await makeClient();
    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(result.error?.code).toBe('CONFIRM_REQUIRED');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('does not use a matching artifact name as proof for a different attached Apple build', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.mocked(AppStoreConnectAdapter.prototype.getAppStoreVersionBuild).mockResolvedValue({ id: 'unproven-build', version: '99' });
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview').mockResolvedValue({
      reviewSubmission: { id: 'review-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }, reusedExistingSubmission: false,
    });
    const t = await makeClient();
    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('blocks an older pinned server release after a newer target run starts', async () => {
    const fixture = seedConnection();
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview').mockResolvedValue({
      reviewSubmission: { id: 'review-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }, reusedExistingSubmission: false,
    });
    const t = await makeClient();
    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code).toBe('CONFIRM_REQUIRED');
    vi.mocked(GitHubAdapter.prototype.listWorkflowRuns).mockImplementation(async (_owner, _repo, workflow) => ({
      total_count: 1, workflow_runs: [String(workflow).includes('ios-release') ? fixture.run(102) : {
        ...fixture.run(101), id: 103, status: 'in_progress', conclusion: null, created_at: '2026-07-02T00:00:00Z',
      }],
    }));
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('accepts an unchanged beta workflow when only the server workflow changed afterward', async () => {
    const fixture = seedConnection();
    stubSubmittableVersion();
    vi.mocked(GitHubAdapter.prototype.getWorkflowRun).mockImplementation(async (_owner, _repo, id) => ({
      ...fixture.run(id), head_sha: (id === 101 ? 'c' : 'b').repeat(40),
    }));
    vi.mocked(GitHubAdapter.prototype.getFileContent).mockImplementation(async (_owner, _repo, file, ref) => {
      if (file === '.hypervibe/spec.json') return JSON.stringify(fixture.spec);
      const content = fixture.workflows.get(file) ?? null;
      return file === fixture.contract.workflow.path && ref === 'b'.repeat(40) ? content + '\n# previous server program\n' : content;
    });
    const t = await makeClient();
    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(result.error?.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });

  it('promotes the same staging Apple build against a newer server with equal supported API snapshots', async () => {
    seedConnection({ promotion: true, api: true, newerServer: true });
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview').mockResolvedValue({
      reviewSubmission: { id: 'review-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }, reusedExistingSubmission: false,
    });
    const t = await makeClient();
    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code, JSON.stringify(preview)).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details).toMatchObject({ sourceEnvironment: 'staging', mobileSha: 'a'.repeat(40), serverSha: 'e'.repeat(40), buildId: 'build-1' });
    expect(preview.confirmation.message).toContain('retains staging build configuration');
    expect(submit).not.toHaveBeenCalled();
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.build.id).toBe('build-1');
    expect(submit).toHaveBeenCalledTimes(1);
    await t.close();
  });

  it.each([
    ['different API bytes', (fixture: ReturnType<typeof seedConnection>) => { fixture.targetApi!.versions.v1.contractHash = 'f'.repeat(64); }],
    ['API receipt for other raw server bytes', (fixture: ReturnType<typeof seedConnection>) => { fixture.targetApi!.serverEvidenceSha256 = 'f'.repeat(64); }],
    ['wrong API service despite a claimed policy hash', (fixture: ReturnType<typeof seedConnection>) => { fixture.targetApi!.service = 'unreviewed-api'; }],
    ['retired target API', (fixture: ReturnType<typeof seedConnection>) => { Object.assign(fixture.targetApi!.versions.v1, { status: 'retired', retirement: { id: 'retired-v1', reason: 'No remaining clients' } }); }],
    ['wrong source beta run', (fixture: ReturnType<typeof seedConnection>) => { fixture.mobile.server.workflowRunId = '104'; }],
  ] as const)('blocks cross-SHA promotion with %s', async (_label, corrupt) => {
    const fixture = seedConnection({ promotion: true, api: true, newerServer: true });
    corrupt(fixture);
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview');
    const t = await makeClient();
    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('requires a new preview if an artifact is replaced after confirmation was prepared', async () => {
    const fixture = seedConnection();
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview');
    const t = await makeClient();
    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    fixture.mobile.releasedAt = '2026-07-02T00:00:00Z';
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(result.error?.message).toContain('selection changed');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('rechecks the attached build immediately before mutation', async () => {
    seedConnection();
    stubSubmittableVersion();
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview');
    const t = await makeClient();
    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    vi.mocked(AppStoreConnectAdapter.prototype.getAppStoreVersionBuild)
      .mockResolvedValueOnce({ id: 'build-1', version: '42' })
      .mockResolvedValueOnce({ id: 'different-build', version: '43' });
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(result.error?.message).toContain('changed before submission');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('does not return artifact body or download credential errors', async () => {
    seedConnection();
    vi.mocked(GitHubAdapter.prototype.readArtifactFiles).mockRejectedValue(new Error('private-github-value signed-download-secret'));
    const t = await makeClient();
    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(result.error?.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(result)).not.toMatch(/private-github-value|signed-download-secret/);
    await t.close();
  });

  it('does not return upstream credential echoes from submission failures', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'submitForReview').mockRejectedValue(new Error('provider-echo-private-material'));
    const t = await makeClient();
    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('provider-echo-private-material');
    await t.close();
  });

  it('blocks a retry of an older run that deployed after the selected server release', async () => {
    const fixture = seedConnection();
    stubSubmittableVersion();
    const t = await makeClient();
    vi.mocked(GitHubAdapter.prototype.listWorkflowRuns).mockImplementation(async (_owner, _repo, workflow) => ({
      total_count: 2, workflow_runs: String(workflow).includes('ios-release') ? [fixture.run(102)] : [fixture.run(101), {
        ...fixture.run(101), id: 99, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
      }],
    }));
    const result = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, iosRunId: '102', serverRunId: '101' });
    expect(result.error?.message).toContain('newer');
    await t.close();
  });

  it('returns project-scoped GitHub setup when release evidence cannot be read', async () => {
    seedConnection();
    const connections = new ConnectionRepository();
    connections.delete(connections.findByProviderAndScope('github', 'davejohnson/example')!.id);
    const t = await makeClient();

    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'github',
      project: 'example',
      scope: 'davejohnson/example',
    });
    await t.close();
  });

  it('returns project-scoped App Store setup after release evidence succeeds', async () => {
    seedConnection();
    const connections = new ConnectionRepository();
    connections.delete(connections.findByProvider('appstoreconnect')!.id);
    const t = await makeClient();

    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'appstoreconnect',
      project: 'example',
      scope: 'com.example.app',
    });
    await t.close();
  });

  it('creates a review submission, adds the version as an item, and submits it', async () => {
    seedConnection();
    const getEditableVersion = stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions').mockResolvedValue([]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'READY_FOR_REVIEW', platform: 'IOS' });
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code).toBe('CONFIRM_REQUIRED');
    const res = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(res.ok).toBe(true);
    expect(getEditableVersion).toHaveBeenCalledWith('app-1', 'IOS');
    expect(create).toHaveBeenCalledWith('app-1', 'IOS');
    expect(addItem).toHaveBeenCalledWith('rs-1', 'ver-1');
    expect(submit).toHaveBeenCalledWith('rs-1');
    expect(res.data.version).toMatchObject({ id: 'ver-1', versionString: '1.2.0' });
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: false });

    const audit = new AuditRepository().findByAction('appstore.submit');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ reviewSubmissionId: 'rs-1' });
    await t.close();
  });

  it('reuses an existing READY_FOR_REVIEW submission instead of creating one', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission');
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code).toBe('CONFIRM_REQUIRED');
    const res = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(res.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith('rs-9', 'ver-1');
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: true });
    await t.close();
  });

  it('fails clearly when a review submission is already in flight', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }]);
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem');
    const t = await makeClient();

    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code).toBe('CONFIRM_REQUIRED');
    const res = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('submission could not be verified');
    expect(addItem).not.toHaveBeenCalled();
    await t.close();
  });

  it('reports an unverified submission without upstream prose when adding the version item fails', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem')
      .mockRejectedValue(new Error('App Store Connect API: This version is already added to another submission.'));
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission');
    const t = await makeClient();

    const preview = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(preview.error?.code).toBe('CONFIRM_REQUIRED');
    const res = await t.call('hv_appstore_submit', { ...SUBMIT_INPUT, ...preview.confirmation.retryInput });
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('submission could not be verified');
    expect(res.error.message).not.toContain('already added to another submission');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('returns VALIDATION when no version is ready for submission', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(null);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listAppStoreVersions')
      .mockResolvedValue([{ id: 'ver-0', versionString: '1.1.0', appStoreState: 'READY_FOR_SALE', platform: 'IOS' }]);
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    expect(res.error.message).toContain('No version ready for submission');
    expect(res.error.message).toContain('attach the tested build');
    await t.close();
  });
});
