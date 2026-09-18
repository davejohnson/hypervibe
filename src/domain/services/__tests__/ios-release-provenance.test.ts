import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANAGED_CI_RELEASE_EVIDENCE_VERSION } from '../managed-ci-evidence.js';
import { buildIosReleaseWorkflow } from '../ios-release-workflow.service.js';

const runtimeUrl = new URL('../../../../templates/ios/hypervibe-ios-release.mjs', import.meta.url);
const workflow = buildIosReleaseWorkflow({
  provider: 'railway', providerName: 'Railway',
  serverWorkflowPath: '.github/workflows/hypervibe-deploy-production.yml',
  target: {
    environmentName: 'production', kind: 'production', branch: 'main',
    autoDeployOnPush: false, serviceNames: ['web'], providerServiceIds: ['web-1'],
    programFingerprint: 'd'.repeat(64),
    releaseTarget: {
      scope: { providerProjectId: 'project-1', providerEnvironmentId: 'environment-1' },
      bindingsFingerprint: 'e'.repeat(64),
      resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-1' }],
    },
  },
  ios: {
    bundleId: 'com.example.app', platform: 'IOS', capabilities: [],
    release: {
      services: ['web'], trigger: 'manual',
      build: { workingDirectory: '.', command: 'build-ios', ipaPath: 'app.ipa', requiredSecrets: [] },
      signing: { provider: 'project' },
      testflight: { groups: ['Pilot'], usesNonExemptEncryption: false, submitForBetaReview: false },
    },
  },
});
const encodedRuntime = parse(workflow!.files[0].content).jobs.release.steps.find(
  (step: { name?: string }) => step.name === 'Materialize Hypervibe release runtime'
)?.env?.HYPERVIBE_MANAGED_RUNTIME_BASE64;
if (!encodedRuntime) throw new Error('Generated workflow did not embed its release runtime');
const runtimes = await Promise.all([
  ['source template', runtimeUrl.href],
  ['generated workflow runtime', `data:text/javascript;base64,${encodedRuntime}`],
].map(async ([name, url]) => ({ name, runtime: await import(url) as {
  main: () => Promise<void>;
  allocateBuildNumber: (env: Record<string, string>) => Promise<string>;
} })));
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupRelease() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ios-release-provenance-'));
  directories.push(directory);
  const ipaPath = path.join(directory, 'NewBuild.ipa');
  const evidencePath = path.join(directory, 'server.json');
  const outputPath = path.join(directory, 'release.json');
  const releaseSha = 'b'.repeat(40);
  writeFileSync(ipaPath, 'different IPA from a newly gated source commit');
  const evidence = {
    version: MANAGED_CI_RELEASE_EVIDENCE_VERSION,
    environment: 'production',
    deploymentContractFingerprint: 'c'.repeat(64),
    programFingerprint: 'd'.repeat(64),
    source: { repository: 'owner/repo', sha: releaseSha },
    target: { resources: [{ logicalName: 'web' }] },
  };
  writeFileSync(evidencePath, JSON.stringify(evidence));
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const env = {
    APP_STORE_CONNECT_KEY_ID: 'TESTKEY',
    APP_STORE_CONNECT_ISSUER_ID: 'test-issuer',
    APP_STORE_CONNECT_PRIVATE_KEY: privateKey,
    HYPERVIBE_BUNDLE_ID: 'com.example.app',
    HYPERVIBE_IPA_PATH: ipaPath,
    HYPERVIBE_BUILD_NUMBER: '9',
    HYPERVIBE_MARKETING_VERSION: '1.0',
    HYPERVIBE_TESTFLIGHT_GROUPS: '["Pilot"]',
    HYPERVIBE_USES_NON_EXEMPT_ENCRYPTION: 'false',
    HYPERVIBE_SUBMIT_BETA_REVIEW: 'true',
    HYPERVIBE_ENVIRONMENT: 'production',
    HYPERVIBE_RELEASE_SHA: releaseSha,
    HYPERVIBE_SERVER_EVIDENCE_VERSION: String(MANAGED_CI_RELEASE_EVIDENCE_VERSION),
    HYPERVIBE_SERVER_EVIDENCE_PATH: evidencePath,
    HYPERVIBE_IOS_RELEASE_OUTPUT: outputPath,
    GITHUB_REPOSITORY: 'owner/repo',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  return { evidencePath, outputPath, evidence, env };
}

// Synthetic HTTP responses, not a recording of Apple's API. Apple identifies
// builds by version/build string, not our Git SHA or freshly produced IPA:
// https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
// Counterexample: build 9 predates the requested commit, as observed in the
// Invoice Perfect Sep 2 release log, which reused the Aug 20 upload.
function stubAppStore(options: { buildStatus?: number; duplicate?: boolean; marketingVersion?: string; processingState?: string } = {}) {
  const requests: Array<{ pathname: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://api.appstoreconnect.apple.com');
    expect(init.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
    requests.push({ pathname: url.pathname, method: init.method ?? 'GET' });
    if (url.pathname === '/v1/apps') return Response.json({ data: [{ type: 'apps', id: 'app-1' }] });
    if (url.pathname === '/v1/builds') {
      expect(url.searchParams.get('filter[app]')).toBe('app-1');
      expect(url.searchParams.get('filter[version]')).toBe('9');
      if (options.buildStatus) return Response.json({ errors: [{ title: 'Unavailable' }] }, { status: options.buildStatus });
      const build = { type: 'builds', id: 'old-build', attributes: {
        version: '9', processingState: options.processingState ?? 'VALID', uploadedDate: '2026-08-20T00:00:00Z',
        usesNonExemptEncryption: null,
      } };
      return Response.json({ data: options.duplicate ? [build, { ...build, id: 'other-build' }] : [build] });
    }
    if (url.pathname === '/v1/builds/old-build/preReleaseVersion') {
      return Response.json({ data: { type: 'preReleaseVersions', id: 'version-1', attributes: { version: options.marketingVersion ?? '1.0' } } });
    }
    if (url.pathname === '/v1/builds/old-build' && init.method === 'PATCH') return new Response(null, { status: 204 });
    if (url.pathname === '/v1/betaGroups') {
      return Response.json({ data: [{ type: 'betaGroups', id: 'pilot', attributes: {
        name: 'Pilot', hasAccessToAllBuilds: false,
      } }] });
    }
    if (url.pathname === '/v1/betaGroups/pilot/relationships/builds') {
      return init.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({ data: [] });
    }
    if (url.pathname === '/v1/builds/old-build/betaAppReviewSubmission') return new Response(null, { status: 404 });
    if (url.pathname === '/v1/betaAppReviewSubmissions' && init.method === 'POST') {
      return Response.json({ data: { type: 'betaAppReviewSubmissions', id: 'review-1' } }, { status: 201 });
    }
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  }));
  return requests;
}

describe.each(runtimes)('managed iOS release provenance: $name', ({ runtime }) => {
  it('does not attribute an older uploaded build to the newly gated commit, including retries', async () => {
    const { outputPath } = setupRelease();
    const requests = stubAppStore();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(runtime.main()).rejects.toThrow(/already exists|provenance|cannot verify/i);
    }
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(requests.some(({ pathname }) => pathname.includes('betaGroups'))).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects a previously uploaded processing build without waiting or distributing it', async () => {
    const { outputPath } = setupRelease();
    const requests = stubAppStore({ processingState: 'PROCESSING' });
    await expect(runtime.main()).rejects.toThrow(/already exists|provenance|cannot verify/i);
    expect(requests).toHaveLength(3);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([401, 429, 503])('does not treat an unknown build read (%i) as permission to upload', async (buildStatus) => {
    const { outputPath } = setupRelease();
    const requests = stubAppStore({ buildStatus });
    await expect(runtime.main()).rejects.toThrow(`App Store Connect returned ${buildStatus}`);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects ambiguous existing build identities', async () => {
    const { outputPath } = setupRelease();
    const requests = stubAppStore({ duplicate: true });
    await expect(runtime.main()).rejects.toThrow(/multiple.*builds/);
    expect(requests).toHaveLength(2);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects an existing build belonging to a different marketing version', async () => {
    const { outputPath } = setupRelease();
    const requests = stubAppStore({ marketingVersion: '0.9' });
    await expect(runtime.main()).rejects.toThrow(/marketing version/);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each(['sha', 'version', 'invalid JSON'] as const)('validates server evidence (%s) before any App Store effects', async (invalid) => {
    const { evidencePath, outputPath, evidence } = setupRelease();
    if (invalid === 'sha') evidence.source.sha = 'a'.repeat(40);
    if (invalid === 'version') evidence.version = 1;
    writeFileSync(evidencePath, invalid === 'invalid JSON' ? '{' : JSON.stringify(evidence));
    const requests = stubAppStore();
    await expect(runtime.main()).rejects.toThrow();
    expect(requests).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });
});

// Apple's list-builds API exposes numeric/dotted CFBundleVersion values and
// cursor pagination. Fixtures below are synthetic boundary examples, not live
// compatibility evidence. Hypervibe intentionally emits simple integers 1..9999.
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
// https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion
function stubBuildPages(pages: unknown[], status = 200) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://api.appstoreconnect.apple.com');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
    requests.push(url);
    if (url.pathname === '/v1/apps') return Response.json({ data: [{ type: 'apps', id: 'app-1' }] });
    expect(url.pathname).toBe('/v1/builds');
    expect(url.searchParams.get('filter[app]')).toBe('app-1');
    expect(url.searchParams.has('filter[version]')).toBe(false);
    expect(url.searchParams.has('filter[expired]')).toBe(false);
    return Response.json(pages.shift() ?? { errors: [{ title: 'Unexpected extra request' }] }, { status });
  }));
  return requests;
}

const buildPage = (versions: unknown[], next: unknown = null) => ({
  data: versions.map((version, index) => ({ type: 'builds', id: String(index), attributes: { version } })),
  links: { next },
});
const nextPage = 'https://api.appstoreconnect.apple.com/v1/builds?filter[app]=app-1&limit=200&cursor=page-2';

describe.each(runtimes)('managed build-number allocation: $name', ({ runtime }) => {
  it('reads every page and chooses above the numeric maximum, not the newest or lexical maximum', async () => {
    const { env } = setupRelease();
    const requests = stubBuildPages([buildPage(['9', '2.9'], nextPage), buildPage(['10.2.1', '3'])]);
    await expect(runtime.allocateBuildNumber(env)).resolves.toBe('11');
    expect(requests).toHaveLength(3);
  });

  it('starts at 1 only after a successful empty listing', async () => {
    const { env } = setupRelease();
    stubBuildPages([buildPage([])]);
    await expect(runtime.allocateBuildNumber(env)).resolves.toBe('1');
  });

  it.each([
    [['0', '0.0.0'], '1'],
    [['9.100.500'], '10'],
  ])('accepts documented numeric CFBundleVersion components (%j)', async (versions, expected) => {
    const { env } = setupRelease();
    stubBuildPages([buildPage(versions as string[])]);
    await expect(runtime.allocateBuildNumber(env)).resolves.toBe(expected);
  });

  it.each([401, 429, 503])('never treats an unknown listing (%i) as an empty app', async status => {
    const { env } = setupRelease();
    stubBuildPages([{ errors: [{ title: 'Unavailable' }] }], status);
    await expect(runtime.allocateBuildNumber(env)).rejects.toThrow(`App Store Connect returned ${status}`);
  });

  it.each([undefined, '', '1.2.3.4', 'not-a-number', '9999', '999999999999999999999', 9])('rejects an unsupported or exhausted build number (%s)', async version => {
    const { env } = setupRelease();
    stubBuildPages([buildPage([version])]);
    await expect(runtime.allocateBuildNumber(env)).rejects.toThrow(/build number|version/i);
  });

  it.each([
    'https://example.invalid/v1/builds?filter[app]=app-1',
    'https://api.appstoreconnect.apple.com/v1/builds?filter[app]=other-app',
    'https://api.appstoreconnect.apple.com/v1/apps?filter[app]=app-1',
    123,
  ])('rejects unsafe pagination without following it (%s)', async next => {
    const { env } = setupRelease();
    const requests = stubBuildPages([buildPage(['9'], next)]);
    await expect(runtime.allocateBuildNumber(env)).rejects.toThrow(/pagination|next/i);
    expect(requests).toHaveLength(2);
  });

  it('rejects a repeated cursor rather than accepting an incomplete maximum', async () => {
    const { env } = setupRelease();
    const requests = stubBuildPages([buildPage(['9'], nextPage), buildPage(['10'], nextPage)]);
    await expect(runtime.allocateBuildNumber(env)).rejects.toThrow(/pagination|repeated|loop/i);
    expect(requests).toHaveLength(3);
  });

  it.each([{ data: null }, { data: [] }, { data: [], links: { next: false } }])('rejects malformed/incomplete listing evidence (%j)', async page => {
    const { env } = setupRelease();
    stubBuildPages([page]);
    await expect(runtime.allocateBuildNumber(env)).rejects.toThrow(/build|listing|pagination/i);
  });
});

describe('generated managed-number workflow contract', () => {
  const jobs = parse(workflow!.files[0].content).jobs;

  // GitHub's workflow syntax contract limits each jobs.<job_id>.steps.run to
  // 21,000 characters; growing the embedded runtime must not exceed this.
  // https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsrun
  it('keeps every emitted run script within the GitHub Actions size limit', () => {
    for (const job of Object.values(jobs) as Array<{ steps: Array<{ name?: string; run?: string }> }>) {
      for (const step of job.steps) {
        if (step.run) expect(step.run.length, step.name).toBeLessThanOrEqual(21000);
      }
    }
  });

  it('allocates after the server gate in an isolated job and passes the number to a credential-free project build', () => {
    expect(jobs.prepare).toBeDefined();
    const preparation = JSON.stringify(jobs.prepare);
    expect(preparation).not.toContain('actions/checkout');
    expect(preparation).toContain('APP_STORE_CONNECT_PRIVATE_KEY');
    expect(preparation.indexOf('Verify server release gate')).toBeLessThan(preparation.indexOf('--allocate-build-number'));
    expect(jobs.prepare.outputs.build_number).toBe('${{ steps.number.outputs.build_number }}');
    expect(jobs.build.needs).toBe('prepare');
    expect(jobs.build.env.HYPERVIBE_BUILD_NUMBER).toBe('${{ needs.prepare.outputs.build_number }}');
    expect(jobs.build.outputs.build_number).toBe('${{ needs.prepare.outputs.build_number }}');
    expect(jobs.build.steps.find((step: any) => step.name === 'Validate IPA identity').env.HYPERVIBE_BUILD_NUMBER)
      .toBe('${{ needs.prepare.outputs.build_number }}');
    expect(jobs.build.steps.find((step: any) => step.uses?.startsWith('actions/checkout')).with.ref).toBe('${{ needs.prepare.outputs.sha }}');
    expect(JSON.stringify(jobs.build)).not.toContain('APP_STORE_CONNECT_PRIVATE_KEY');
    expect(JSON.stringify(jobs.release)).not.toContain('actions/checkout');
    // A whole-run retry can replace its own short-lived IPA; a release-only
    // retry still sees the same identity and must pass the collision guard.
    expect(jobs.build.steps.find((step: any) => step.name === 'Upload validated iOS build').with.overwrite).toBe(true);
    expect(jobs.release.steps.find((step: any) => step.name === 'Upload iOS release manifest').with.overwrite).toBe(true);
  });

  it('executes the emitted materializer and number-selection command without an IPA or project checkout', () => {
    const { env } = setupRelease();
    const directory = mkdtempSync(path.join(tmpdir(), 'ios-number-command-'));
    directories.push(directory);
    const preload = path.join(directory, 'app-store-fixture.mjs');
    writeFileSync(preload, `
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.origin !== 'https://api.appstoreconnect.apple.com') throw Error('Unexpected host');
  if (url.pathname === '/v1/apps') return Response.json({data:[{type:'apps',id:'app-1'}]});
  if (url.pathname === '/v1/builds') return Response.json({data:[{type:'builds',id:'build-9',attributes:{version:'9'}}],links:{next:null}});
  throw Error('Unexpected request');
};
`);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, RUNNER_TEMP: directory,
      GITHUB_ENV: path.join(directory, 'env'), GITHUB_OUTPUT: path.join(directory, 'output'),
      NODE_OPTIONS: '--import=' + preload,
      APP_STORE_CONNECT_KEY_ID: env.APP_STORE_CONNECT_KEY_ID,
      APP_STORE_CONNECT_ISSUER_ID: env.APP_STORE_CONNECT_ISSUER_ID,
      APP_STORE_CONNECT_PRIVATE_KEY: env.APP_STORE_CONNECT_PRIVATE_KEY,
      HYPERVIBE_BUNDLE_ID: env.HYPERVIBE_BUNDLE_ID,
    };
    const steps = jobs.prepare.steps;
    const materializer = steps.find((step: any) => step.name === 'Materialize Hypervibe release runtime');
    const materialized = spawnSync('bash', ['-eu', '-c', materializer.run], {
      encoding: 'utf8', cwd: directory, env: { ...environment, ...materializer.env },
    });
    expect(materialized.status, materialized.stderr).toBe(0);
    const line = readFileSync(environment.GITHUB_ENV!, 'utf8').trim();
    const separator = line.indexOf('=');
    environment[line.slice(0, separator)] = line.slice(separator + 1);
    expect(readFileSync(environment.HYPERVIBE_MANAGED_RELEASE_RUNTIME!, 'utf8')).toBe(readFileSync(runtimeUrl, 'utf8'));
    const allocation = steps.find((step: any) => step.id === 'number');
    const result = spawnSync('bash', ['-eu', '-c', allocation.run], { encoding: 'utf8', cwd: directory, env: environment });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(environment.GITHUB_OUTPUT!, 'utf8')).toBe('build_number=10\n');
  });

  it.each([['9', '10'], ['10', '10'], ['9', '9']])('executes the emitted IPA validator: plist %s, build-job environment %s, allocated 10', (build, buildJobNumber) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ios-allocated-ipa-'));
    directories.push(directory);
    const create = spawnSync('python3', ['-c', `
import pathlib, plistlib, sys, zipfile
with zipfile.ZipFile(pathlib.Path(sys.argv[1]) / 'app.ipa', 'w') as archive:
    archive.writestr('Payload/App.app/Info.plist', plistlib.dumps({
        'CFBundleIdentifier': 'com.example.app', 'CFBundleShortVersionString': '1.0', 'CFBundleVersion': sys.argv[2]
    }))
`, directory, build], { encoding: 'utf8' });
    expect(create.status, create.stderr).toBe(0);
    const outputPath = path.join(directory, 'output');
    const step = jobs.build.steps.find((entry: any) => entry.name === 'Validate IPA identity');
    const stepEnvironment = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [
      key, value === '${{ needs.prepare.outputs.build_number }}' ? '10' : String(value),
    ]));
    const result = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8', env: {
      PATH: process.env.PATH, GITHUB_WORKSPACE: directory, GITHUB_OUTPUT: outputPath,
      HYPERVIBE_WORKING_DIRECTORY: '.', HYPERVIBE_IPA_PATH: 'app.ipa',
      HYPERVIBE_BUNDLE_ID: 'com.example.app', HYPERVIBE_BUILD_NUMBER: buildJobNumber,
      ...stepEnvironment,
    } });
    if (build === '10') {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, 'utf8')).toContain('build=10\n');
    } else {
      expect(result.status).not.toBe(0);
      expect(existsSync(outputPath)).toBe(false);
    }
  });
});
