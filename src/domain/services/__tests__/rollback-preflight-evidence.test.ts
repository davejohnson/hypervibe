import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectRollbackEvidence } from '../rollback-preflight-evidence.js';
import { releaseEvidenceValidationRuntime } from '../github-ops.service.js';

const SHA = 'a'.repeat(40);
const IMAGE = `ghcr.io/owner/app@sha256:${'b'.repeat(64)}`;
const producer = parse(readFileSync('test/fixtures/legacy-release-v2/producer.yml', 'utf8')).jobs.deploy.steps[0];
const consumer = parse(readFileSync('test/fixtures/legacy-release-v2/consumer.yml', 'utf8')).jobs.deploy.steps[0];
const sourceSpec = { version: 1, project: 'app', runtime: { kind: 'node', version: '24' }, environments: { production: {
  hosting: { provider: 'railway' }, services: {
    web: { workloadKind: 'web', startCommand: 'npm start' },
    worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
    cron: { workloadKind: 'cron', startCommand: 'npm run cron' },
  }, migrations: { mode: 'releaseCommand', command: 'npm run db:migrate' },
} } };
const resources = Object.entries(sourceSpec.environments.production.services).map(([logicalName, service]) => ({
  logicalName, workloadKind: service.workloadKind as 'web' | 'worker' | 'cron', providerResourceType: 'service' as const, providerResourceId: `old-${logicalName}`,
})).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
const sourceBindings = { version: 1, environments: { production: { platformBindings: {
  provider: 'railway', projectId: 'old-project', environmentId: 'old-environment',
  services: Object.fromEntries(resources.map(r => [r.logicalName, { serviceId: r.providerResourceId, workloadKind: r.workloadKind }])),
} } } };
function originalEvidence() {
  let text = '';
  new Function('require', 'process', producer.with.script)(
    () => ({ writeFileSync: (_name: string, value: string) => { text = value; } }),
    { env: { GITHUB_REPOSITORY: 'owner/app', HYPERVIBE_RELEASE_SHA: SHA, HYPERVIBE_RELEASE_IMAGE_URI: IMAGE } },
  );
  return text;
}
function input() {
  return {
    repository: 'owner/app', sha: SHA, environment: 'production', provider: 'railway',
    evidenceText: originalEvidence(), sourceSpecText: JSON.stringify(sourceSpec),
    sourceBindingsText: JSON.stringify(sourceBindings),
    currentSpec: { ...sourceSpec, runtime: { ...sourceSpec.runtime, installCommand: 'npm ci --omit=dev' } },
    target: { scope: { providerProjectId: 'old-project', providerEnvironmentId: 'old-environment' }, resources, bindingsFingerprint: 'd'.repeat(64) },
    programFingerprint: 'e'.repeat(64),
  };
}
describe('historical rollback evidence preflight', () => {
  it('executes the original August producer and consumer, and proves v4 rejects its v2 evidence', () => {
    const evidenceText = originalEvidence();
    const outputs: Record<string, unknown> = {};
    new Function('require', 'process', 'core', consumer.with.script)(
      () => ({ readFileSync: () => evidenceText }),
      { env: { HYPERVIBE_SERVICES: '["web","worker","cron"]', HYPERVIBE_ENVIRONMENT: 'production', GITHUB_REPOSITORY: 'owner/app', HYPERVIBE_ROLLBACK_SHA: SHA } },
      { setOutput: (key: string, value: unknown) => { outputs[key] = value; }, info: () => {} },
    );
    expect(outputs.image_uri).toBe(IMAGE);
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
    expect(() => module.exports.validateReleaseEvidence(JSON.parse(evidenceText), { label: 'Rollback' })).toThrow('release evidence');
  });
  it('preserves original v2 provenance and reports program drift and unsupported consumer instead of manufacturing v4 evidence', () => {
    const params = input();
    const result = inspectRollbackEvidence(params);
    expect(result).toMatchObject({ evidenceVersion: 2, imageUri: IMAGE, sourceEvidenceSha256: createHash('sha256').update(params.evidenceText).digest('hex'), historicalBindingsMatch: true });
    expect(result.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['legacy_consumer_unsupported', 'program_contract_changed']));
    expect(result).not.toHaveProperty('programFingerprint');
    expect(result).not.toHaveProperty('deploymentContractFingerprint');
    expect(JSON.parse(params.evidenceText).version).toBe(2);
  });
  it('does not replace historical resource identities with the current bindings', () => {
    const params = input();
    params.target.resources = params.target.resources.map(r => ({ ...r, providerResourceId: `new-${r.logicalName}` }));
    const result = inspectRollbackEvidence(params);
    expect(result.historicalResources).toEqual(resources);
    expect(result.historicalBindingsMatch).toBe(false);
    expect(result.blockers.map(b => b.code)).toContain('resource_bindings_changed');
  });
  it.each([
    ['repository', { server: { repository: 'another/app', sha: SHA, imageUri: IMAGE } }],
    ['sha', { server: { repository: 'owner/app', sha: 'c'.repeat(40), imageUri: IMAGE } }],
    ['mutable image', { server: { repository: 'owner/app', sha: SHA, imageUri: 'ghcr.io/owner/app:latest' } }],
    ['duplicate service', { services: ['web', 'web', 'cron'] }],
    ['missing timestamp', { verifiedAt: undefined }],
  ])('rejects mismatched %s without claiming compatible evidence', (_name, change) => {
    const params = input();
    params.evidenceText = JSON.stringify({ ...JSON.parse(params.evidenceText), ...change });
    expect(() => inspectRollbackEvidence(params)).toThrow('Legacy release evidence');
  });
});
