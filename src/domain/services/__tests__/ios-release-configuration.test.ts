import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildIosReleaseWorkflow } from '../ios-release-workflow.service.js';
import { iosBuildContractFingerprint } from '../ios-release-evidence.js';
import type { IosSpec } from '../../spec/spec.schema.js';

// Synthetic IPA contents, from the requested Invoice Perfect environment split.
// Apple's Info.plist contract permits app-defined keys alongside bundle identity:
// https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AboutInformationPropertyListFiles.html
// These test the emitted validators, not signing, effective localized values or live Apple APIs.
const stagingInfo = {
  CFBundleIdentifier: 'com.example.invoiceperfect.staging',
  CFBundleShortVersionString: '1.0', CFBundleVersion: '10',
  CFBundleDisplayName: 'IP Staging', AppEnvironment: 'staging',
  APIBaseURL: 'https://staging.invoiceperfect.com',
};
const productionInfo = {
  CFBundleIdentifier: 'com.example.invoiceperfect',
  CFBundleShortVersionString: '1.0', CFBundleVersion: '10',
  CFBundleDisplayName: 'Invoice Perfect', AppEnvironment: 'production',
  APIBaseURL: 'https://invoiceperfect.com',
};

function ios(environment: 'staging' | 'production', validate = true): IosSpec {
  return {
    bundleId: 'com.example.invoiceperfect' + (environment === 'staging' ? '.staging' : ''),
    platform: 'IOS', capabilities: [],
    release: {
      services: ['web'], trigger: 'after-server-deploy',
      build: {
        workingDirectory: '.', command: 'bundle exec fastlane ios release', ipaPath: 'app.ipa', requiredSecrets: [],
        ...(validate ? { expectedInfoPlist: {
          AppEnvironment: environment,
          APIBaseURL: environment === 'staging' ? 'https://staging.invoiceperfect.com' : 'https://invoiceperfect.com',
          CFBundleDisplayName: environment === 'staging' ? 'IP Staging' : 'Invoice Perfect',
        } } : {}),
      },
      signing: { provider: 'project' },
      testflight: { groups: [environment], usesNonExemptEncryption: false, submitForBetaReview: false },
    },
  };
}

function workflow(environment: 'staging' | 'production', validate = true, expectedInfoPlist?: Record<string, string>) {
  const app = ios(environment, validate);
  if (expectedInfoPlist) app.release!.build.expectedInfoPlist = expectedInfoPlist;
  return parse(buildIosReleaseWorkflow({
    provider: 'railway', providerName: 'Railway',
    serverWorkflowPath: `.github/workflows/hypervibe-deploy-${environment}.yml`,
    target: {
      environmentName: environment, kind: environment, branch: 'main', autoDeployOnPush: false,
      serviceNames: ['web'], providerServiceIds: ['web-' + environment], programFingerprint: 'd'.repeat(64),
      releaseTarget: {
        scope: { providerProjectId: 'project-1', providerEnvironmentId: environment }, bindingsFingerprint: 'e'.repeat(64),
        resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-' + environment }],
      },
    },
    ios: app,
  })!.files[0].content);
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function validateIpa(jobName: 'build' | 'release', info: Record<string, unknown>, options: {
  environment?: 'staging' | 'production'; format?: 'xml' | 'binary'; validate?: boolean;
  expectedInfoPlist?: Record<string, string>;
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ios-configuration-'));
  directories.push(directory);
  const artifactDirectory = path.join(directory, 'hypervibe-ios-build');
  mkdirSync(artifactDirectory);
  const ipa = path.join(jobName === 'build' ? directory : artifactDirectory, 'app.ipa');
  const created = spawnSync('python3', ['-c', `
import json, plistlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('Payload/App.app/Info.plist', plistlib.dumps(json.loads(sys.argv[2]), fmt=plistlib.FMT_BINARY if sys.argv[3] == 'binary' else plistlib.FMT_XML))
`, ipa, JSON.stringify(info), options.format ?? 'xml'], { encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  const generated = workflow(options.environment ?? 'staging', options.validate, options.expectedInfoPlist);
  const job = generated.jobs[jobName];
  const step = job.steps.find((entry: any) => entry.name === (jobName === 'build' ? 'Validate IPA identity' : 'Verify release IPA identity'));
  const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [
    key, value === '${{ needs.prepare.outputs.build_number }}' ? '10' : String(value),
  ]));
  const output = path.join(directory, 'outputs');
  const result = spawnSync('bash', ['-eu', '-c', step.run], {
    encoding: 'utf8', cwd: directory, env: {
      PATH: process.env.PATH, ...job.env, GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory, GITHUB_OUTPUT: output,
      HYPERVIBE_BUILD_NUMBER: '10', HYPERVIBE_MARKETING_VERSION: '1.0',
      HYPERVIBE_EXPECTED_IPA_SHA256: createHash('sha256').update(readFileSync(ipa)).digest('hex'),
      // Project commands can write GITHUB_ENV; the validator must pin its own expectations.
      HYPERVIBE_EXPECTED_INFO_PLIST: '{}',
      HYPERVIBE_BUNDLE_ID: String(info.CFBundleIdentifier),
      ...stepEnv,
    },
  });
  return { ...result, output };
}

describe.each(['build', 'release'] as const)('emitted %s IPA environment validation', job => {
  it.each(['xml', 'binary'] as const)('accepts both environment-specific %s IPAs', format => {
    for (const [environment, info] of [['staging', stagingInfo], ['production', productionInfo]] as const) {
      const result = validateIpa(job, info, { environment, format });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(result.output, 'utf8')).toContain('path=');
    }
  });

  it.each([
    ['production backend', { ...stagingInfo, APIBaseURL: 'https://invoiceperfect.com' }],
    ['production environment', { ...stagingInfo, AppEnvironment: 'production' }],
    ['production display name', { ...stagingInfo, CFBundleDisplayName: 'Invoice Perfect' }],
    ['missing backend', { ...stagingInfo, APIBaseURL: undefined }],
    ['unexpanded setting', { ...stagingInfo, APIBaseURL: '$(API_BASE_URL)' }],
    ['array backend', { ...stagingInfo, APIBaseURL: ['https://staging.invoiceperfect.com'] }],
    ['number environment', { ...stagingInfo, AppEnvironment: 1 }],
    ['boolean environment', { ...stagingInfo, AppEnvironment: false }],
    ['nested backend', { ...stagingInfo, APIBaseURL: { value: 'https://staging.invoiceperfect.com' } }],
  ])('rejects %s despite matching bundle, build number and artifact digest', (_, info) => {
    const result = validateIpa(job, info);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('Info.plist');
    expect(existsSync(result.output)).toBe(false);
  });

  it('keeps mismatching embedded values out of diagnostics', () => {
    const secret = 'do-not-print-this-embedded-value';
    const result = validateIpa(job, { ...stagingInfo, APIBaseURL: 'https://user:' + secret + '@example.com' });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).not.toContain(secret);
    expect(result.stderr + result.stdout).not.toContain('https://user:');
  });

  it('rejects the production bundle even when the build environment claims it is expected', () => {
    const result = validateIpa(job, { ...stagingInfo, CFBundleIdentifier: productionInfo.CFBundleIdentifier });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundle identifier');
    expect(existsSync(result.output)).toBe(false);
  });

  it.each([['1', 1], ['False', false]] as const)('requires a string for literal expectation %s', (literal, coerced) => {
    const options = { expectedInfoPlist: { BuildChannel: literal } };
    const valid = validateIpa(job, { ...stagingInfo, BuildChannel: literal }, options);
    expect(valid.status, valid.stderr).toBe(0);
    const invalid = validateIpa(job, { ...stagingInfo, BuildChannel: coerced }, options);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('Info.plist');
    expect(existsSync(invalid.output)).toBe(false);
  });

  it('preserves literal metadata that resembles a workflow template marker', () => {
    const result = validateIpa(job, { ...stagingInfo, BuildChannel: '@@BUILD_COMMAND@@' }, {
      expectedInfoPlist: { BuildChannel: '@@BUILD_COMMAND@@' },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('preserves identity-only validation when checks are undeclared', () => {
    const { APIBaseURL: _url, AppEnvironment: _environment, CFBundleDisplayName: _name, ...info } = stagingInfo;
    const result = validateIpa(job, info, { validate: false });
    expect(result.status, result.stderr).toBe(0);
  });
});

it('fingerprints declared IPA configuration for source, relevance and submission checks', () => {
  const original = ios('staging');
  const changed = structuredClone(original);
  changed.release!.build.expectedInfoPlist!.APIBaseURL = 'https://invoiceperfect.com';
  expect(iosBuildContractFingerprint(changed)).not.toBe(iosBuildContractFingerprint(original));
  expect(iosBuildContractFingerprint(ios('staging', false))).not.toBe(iosBuildContractFingerprint(original));
  changed.release!.build.expectedInfoPlist = Object.fromEntries(Object.entries(original.release!.build.expectedInfoPlist!).reverse());
  expect(iosBuildContractFingerprint(changed)).toBe(iosBuildContractFingerprint(original));
});

it('preserves the historical build fingerprint when metadata checks are undeclared', () => {
  expect(iosBuildContractFingerprint(ios('staging', false)))
    .toBe('faa027465df898fac946c1904bca2af4b2cc36e5ed4e3c506802eeb084456123');
});

it('fingerprints case-sensitive plist keys identically across operator and runner locales', () => {
  const app = ios('staging');
  app.release!.build.expectedInfoPlist = { Icon: 'A', icon: 'B' };
  const fingerprints = ['en_US.UTF-8', 'tr_TR.UTF-8'].map(locale => {
    const result = spawnSync(process.execPath, ['-e',
      'process.stdout.write(require(process.argv[1]).iosBuildContractFingerprint(JSON.parse(process.argv[2])))',
      fileURLToPath(new URL('../../../../templates/ios/build-contract.cjs', import.meta.url)), JSON.stringify(app),
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: locale, LC_ALL: locale } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  });
  expect(fingerprints[0]).toBe(fingerprints[1]);
});
