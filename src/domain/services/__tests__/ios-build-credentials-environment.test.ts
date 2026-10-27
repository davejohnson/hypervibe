import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { iosSpecSchema, type IosSpec } from '../../spec/spec.schema.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { iosBuildContractFingerprint } from '../ios-release-evidence.js';
import * as renderer from '../ios-release-workflow.service.js';
import { githubActionsWorkflowInputHash } from '../github-ops.service.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';

// GitHub's documented environment.deployment:false retains environment secrets
// and protection rules without creating a deployment. No live GitHub run here.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idenvironment
const localRequire = createRequire(import.meta.url);
const SHA = 'a'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: any[]) => Promise<unknown>;
function ios(credentialsEnvironment?: string, signing: 'project' | 'match' = 'project'): IosSpec {
  const parsed = iosSpecSchema.parse({
    bundleId: 'com.example.app.staging', testflight: { groups: { Internal: {} } },
    release: { services: ['web'],
      build: { command: 'make ios', ipaPath: 'build/App.ipa', requiredSecrets: ['SIGNING_PASSWORD'] },
      signing: { provider: signing }, testflight: { groups: ['Internal'] } },
  });
  return credentialsEnvironment === undefined ? parsed : {
    ...parsed, release: { ...parsed.release!, build: { ...parsed.release!.build, credentialsEnvironment } },
  };
}
function workflow(config = ios()) {
  return parse(renderer.buildIosReleaseWorkflow({
    provider: 'railway', providerName: 'Railway', serverWorkflowPath: '.github/workflows/deploy-railway-staging.yml',
    target: { environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerServiceIds: ['web-id'],
      programFingerprint: 'd'.repeat(64), releaseTarget: {
        scope: { providerProjectId: 'project', providerEnvironmentId: 'staging' }, bindingsFingerprint: 'e'.repeat(64),
        resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-id' }],
      } }, ios: config,
  })!.files[0].content);
}

describe('build-only credential environment rendering', () => {
  it('resolves an explicit source and otherwise keeps the logical environment', () => {
    const resolve = renderer.iosBuildCredentialsEnvironment;
    expect(resolve).toBeTypeOf('function');
    expect(resolve(ios('Apple signing'), 'staging')).toBe('Apple signing');
    expect(resolve(ios(), 'staging')).toBe('staging');
    expect(resolve(undefined, 'staging')).toBe('staging');
  });
  it.each([undefined, 'staging', 'STAGING'])('retains the existing logical job environments for %s', source => {
    const generated = workflow(ios(source));
    for (const job of ['prepare', 'build', 'release']) expect(generated.jobs[job].environment).toBe('staging');
  });
  it.each(['project', 'match'] as const)('uses a non-deployment environment only for the %s build job', signing => {
    const generated = workflow(ios('production', signing));
    expect(generated.jobs.build.environment).toEqual({ name: 'production', deployment: false });
    expect(generated.jobs.prepare.environment).toBe('staging');
    expect(generated.jobs.release.environment).toBe('staging');
    expect(generated.jobs.eligibility.environment).toBeUndefined();
    expect(generated.jobs.build.env.HYPERVIBE_ENVIRONMENT).toBe('staging');
    expect(generated.jobs.build.env.HYPERVIBE_BUNDLE_ID).toBe('com.example.app.staging');
    expect(generated.jobs.eligibility.env.HYPERVIBE_ENVIRONMENT).toBe('staging');
    expect(generated.jobs.release.env.HYPERVIBE_ENVIRONMENT).toBe('staging');
    const build = generated.jobs.build.steps.find((step: any) => step.name === 'Build signed IPA');
    expect(build.env).toEqual({ SIGNING_PASSWORD: '${{ secrets.SIGNING_PASSWORD }}' });
    for (const name of renderer.IOS_RELEASE_REQUIRED_SECRETS) expect(JSON.stringify(generated.jobs.build)).not.toContain(name);
    const match = generated.jobs.build.steps.filter((step: any) => JSON.stringify(step.env ?? {}).includes('MATCH_PASSWORD'));
    expect(match).toHaveLength(signing === 'match' ? 1 : 0);
    if (signing === 'match') expect(match[0].env.MATCH_PASSWORD).toBe('${{ secrets.MATCH_PASSWORD }}');
  });
  it('quotes literal environment names without interpreting template-like contents', () => {
    const name = 'Shared "Apple" / @@ENVIRONMENT_JSON@@';
    expect(workflow(ios(name)).jobs.build.environment).toEqual({ name, deployment: false });
  });
  it('requires a reviewed iOS workflow update without migrating server-only workflows', () => {
    const target = { environmentName: 'staging', kind: 'staging' as const, branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerServiceIds: ['web-id'] };
    const input = { provider: 'railway', target, migration: { includeStep: false } };
    // Shared dispatch revision 8 changes every server workflow independently of
    // iOS. Its emitted-byte migration is pinned in shared-workflow-dispatch-migration.test.ts.
    const serverContract = { version: 1, rendererRevision: 8, ...input };
    const config = ios();
    expect(githubActionsWorkflowInputHash(input)).toBe(canonicalJsonSha256(serverContract));
    expect(githubActionsWorkflowInputHash({ ...input, ios: config })).toBe(canonicalJsonSha256({
      ...serverContract,
      ios: { rendererRevision: 6, buildContractFingerprint: iosBuildContractFingerprint(config), bundleId: config.bundleId, release: config.release },
    }));
    for (const rendererRevision of [4, 5]) {
      expect(githubActionsWorkflowInputHash({ ...input, ios: config })).not.toBe(canonicalJsonSha256({
        ...serverContract,
        ios: { rendererRevision, buildContractFingerprint: iosBuildContractFingerprint(config), bundleId: config.bundleId, release: config.release },
      }));
    }
  });
});

describe('credential source is part of the mobile source contract', () => {
  it('preserves the historical omitted-field fingerprint and binds explicit sources', () => {
    // Captured from the parent revision before this new optional field existed.
    expect(iosBuildContractFingerprint(ios())).toBe('d037f13e4cdde37a8bb3f1d4e8554beb3587adc2555f05ab917a01d6d513e9a3');
    expect(iosBuildContractFingerprint(ios('production'))).not.toBe(iosBuildContractFingerprint(ios()));
    expect(iosBuildContractFingerprint(ios('production'))).not.toBe(iosBuildContractFingerprint(ios('another')));
  });
  it.each(['production', 'another', undefined])('executes the source gate for source environment %s', async source => {
    const generated = workflow(ios('production'));
    const gate = generated.jobs.eligibility.steps.find((step: any) => step.name === 'Verify mobile source contract');
    const historicalSpec = { environments: { staging: { ios: ios(source) } } };
    const getContent = vi.fn(async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(historicalSpec)).toString('base64') } }));
    const readFileSync = vi.fn(() => JSON.stringify({ deploymentContractFingerprint: environmentDeploymentContractHash(historicalSpec, 'staging') }));
    const run = new AsyncFunction('github', 'context', 'process', 'require', gate.with.script)(
      { rest: { repos: { getContent } } }, { repo: { owner: 'owner', repo: 'app' } },
      { env: { ...generated.jobs.eligibility.env, ...gate.env, HYPERVIBE_CANDIDATE_SHA: SHA } },
      (name: string) => name === 'fs' ? { readFileSync } : localRequire(name),
    );
    if (source === 'production') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toThrow('source mobile configuration');
    expect(getContent).toHaveBeenCalledWith({ owner: 'owner', repo: 'app', path: '.hypervibe/spec.json', ref: SHA });
  });
});
