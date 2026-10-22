import { describe, expect, it, vi } from 'vitest';
import { projectSpecSchema, type ProjectSpec } from '../../spec/spec.schema.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { buildProjectRotationAssessment } from '../project-rotation.service.js';

// Expected process boundaries come from the user's requested project-wide
// incident workflow, AWS IAM's overlapping-key rotation procedure, and OWASP's
// exposed-secret containment and encryption-key lifecycle guidance:
// https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html
// https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
// These are local assessment tests, not issuer or live rotation conformance.
const project = { id: 'project-one', name: 'rotation-app' };
function spec(patch: Record<string, unknown> = {}): ProjectSpec {
  return projectSpecSchema.parse({
    version: 1,
    project: project.name,
    gitRemoteUrl: 'https://github.com/example/rotation-app.git',
    github: { enabled: true, repository: 'example/rotation-app' },
    secrets: {
      EXTERNAL_KEY: { principal: 'github:owner', environments: ['staging', 'production'],
        githubActions: { repository: true, environments: ['production'] } },
      SESSION_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1',
        generation: 2, environments: ['staging', 'production'] },
      ENCRYPTION_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1',
        replacementPolicy: 'immutable', environments: ['production'] },
    },
    environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {}, worker: { workloadKind: 'worker' } } },
      production: { hosting: { provider: 'ecs' }, services: { web: {} } },
    },
    ...patch,
  });
}
function assess(document = spec(), mode: 'incident' | 'routine' = 'incident') {
  return buildProjectRotationAssessment({ project, spec: document, specRevision: 7, mode,
    recordedEnvironments: [{ name: 'staging' }, { name: 'production' }], connections: [] });
}

describe('project rotation assessment', () => {
  it('keeps declared environment and CI destinations separate without inferring credential sharing', () => {
    const report = assess();
    const entries = report.inventory.filter(entry => entry.keys.includes('EXTERNAL_KEY'));
    expect(entries).toHaveLength(4);
    expect(entries.flatMap(entry => entry.destinations)).toEqual(expect.arrayContaining([
      { kind: 'runtime', environment: 'staging', service: 'web', workloadKind: 'web' },
      { kind: 'runtime', environment: 'staging', service: 'worker', workloadKind: 'worker' },
      { kind: 'runtime', environment: 'production', service: 'web', workloadKind: 'web' },
      { kind: 'github-repository', repository: 'example/rotation-app' },
      { kind: 'github-environment', repository: 'example/rotation-app', environment: 'production' },
    ]));
    for (const entry of entries) {
      expect(entry.ownership).toBe('delegated');
      expect(entry.blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining([
        'issuer_unknown', 'outside_consumers_unchecked', 'issuer_rotation_unsupported',
      ]));
    }
    expect(report).toMatchObject({ version: 1, project, specRevision: 7,
      status: 'review_required', rotationPerformed: false, executable: false,
      coverage: { basis: 'recorded_desired_state', live: 'unchecked', unmanaged: 'unchecked',
        outsideConsumers: 'unchecked', complete: false } });
    expect(report).not.toHaveProperty('planId');
  });

  it('uses different dependency order for routine overlap and immediate incident containment', () => {
    const routine = assess(spec(), 'routine').inventory.find(entry => entry.category === 'delegated-secret')!;
    const incident = assess(spec(), 'incident').inventory.find(entry => entry.id === routine.id)!;
    expect(routine.stages.find(stage => stage.id === 'revoke')?.dependsOn).toEqual(['verify-consumers']);
    expect(routine.stages.find(stage => stage.id === 'distribute')?.dependsOn).toEqual(['issue', 'trust-destinations']);
    expect(incident.stages.find(stage => stage.id === 'revoke')?.dependsOn).toEqual(['review']);
    expect(incident.stages.find(stage => stage.id === 'issue')?.dependsOn).toEqual(['verify-revocation']);
    expect(incident.stages.find(stage => stage.id === 'review')?.message).toContain('outage');
    expect(incident.stages.find(stage => stage.id === 'revoke')?.message).toContain('exact');
    expect(incident.stages.every(stage => stage.status !== ('complete' as string))).toBe(true);
  });

  it('blocks immutable keys for an explicit rewrap and separates generated environment generations', () => {
    const report = assess();
    const immutable = report.inventory.find(entry => entry.keys.includes('ENCRYPTION_KEY'))!;
    expect(immutable).toMatchObject({ category: 'generated-secret', ownership: 'hypervibe',
      replacementPolicy: 'immutable', generation: 1 });
    expect(immutable.blockers.map(blocker => blocker.code)).toContain('rewrap_required');
    expect(immutable.stages.map(stage => stage.id)).toEqual(['review', 'trust-destinations', 'rewrap', 'verify-recovery', 'closure']);
    expect(immutable.stages).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'issue' })]));
    const sessions = report.inventory.filter(entry => entry.keys.includes('SESSION_KEY'));
    expect(sessions).toHaveLength(2);
    for (const entry of sessions) {
      expect(entry.generation).toBe(2);
      expect(entry.blockers.map(blocker => blocker.code)).toContain('application_effect_unknown');
      expect(entry.stages.map(stage => stage.id)).toContain('verify-invalidation');
    }
  });

  it('lists unclassified names without reading values or treating all configuration as credentials', () => {
    const document = spec();
    document.environments.staging.envVars = Object.defineProperties({}, {
      DEBUG_LABEL: { enumerable: true, get: () => { throw new Error('must not read configuration values'); } },
    });
    document.environments.staging.envFile = { mode: 'runtime', include: ['LOCAL_INPUT', 'EXCLUDED'], exclude: ['EXCLUDED'] };
    const report = assess(document);
    expect(report.inventory.filter(entry => entry.category === 'configuration').map(entry => entry.keys))
      .toEqual([['DEBUG_LABEL'], ['LOCAL_INPUT']]);
    expect(report.blockers.map(blocker => blocker.code)).toContain('dotenv_inventory_unchecked');
    expect(JSON.stringify(report)).not.toContain('EXCLUDED');
  });

  it('includes datastore, integration, CI, registry, signing and retained-resource obligations', () => {
    const document = spec();
    const staging = document.environments.staging;
    staging.database = { provider: 'railway', engine: 'postgres' };
    staging.cache = { provider: 'railway', engine: 'redis' };
    staging.storage = { documents: { provider: 's3', type: 'bucket', region: 'us-east-1', injectInto: ['web'] },
      backups: { provider: 's3', type: 'bucket', region: 'us-east-1', injectInto: [], purpose: 'backup' } };
    staging.email = { enabled: true };
    staging.deploy = { strategy: 'branch', trigger: 'ci' };
    staging.ios = { bundleId: 'example.rotation', platform: 'IOS', capabilities: [],
      release: { services: ['web'], trigger: 'manual',
        build: { workingDirectory: '.', command: 'bundle exec fastlane build', ipaPath: 'app.ipa',
          requiredSecrets: ['BUILD_SIGNING_INPUT'] }, signing: { provider: 'project' },
        testflight: { groups: ['internal'], usesNonExemptEncryption: false, submitForBetaReview: false } } };
    const report = assess(document);
    for (const category of ['database', 'cache', 'storage', 'integration', 'ci', 'registry', 'signing', 'retained-resources']) {
      expect(report.inventory.some(entry => entry.category === category), category).toBe(true);
    }
    expect(report.inventory.some(entry => entry.keys.includes('BUILD_SIGNING_INPUT'))).toBe(true);
    const documents = report.inventory.find(entry => entry.id === 'storage:staging:documents')!;
    expect(documents.destinations.filter(destination => destination.kind === 'runtime'))
      .toEqual([{ kind: 'runtime', environment: 'staging', service: 'web', workloadKind: 'web' }]);
    expect(report.inventory.find(entry => entry.id === 'storage:staging:backups')?.destinations)
      .toEqual([{ kind: 'resource', environment: 'staging', resource: 'backups' }]);
    expect(report.inventory.find(entry => entry.category === 'retained-resources')?.blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'retained_resources_unchecked' })]));
  });

  it('does not turn recorded environments omitted from desired state into empty coverage', () => {
    const report = buildProjectRotationAssessment({ project, spec: spec(), specRevision: 1, mode: 'incident',
      recordedEnvironments: [{ name: 'production' }, { name: 'abandoned' }], connections: [] });
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'environment_unrecorded', environment: 'staging' }),
      expect.objectContaining({ code: 'retained_environment_unchecked', environment: 'abandoned' }),
    ]));
    expect(report.inventory.some(entry => entry.destinations.some(destination => destination.environment === 'abandoned'))).toBe(true);
  });

  it('limits connection candidates by applicable provider aliases and scope without asserting ownership', () => {
    const alias = vi.spyOn(providerRegistry, 'connectionProviders').mockImplementation(provider =>
      provider === 's3' ? ['s3', 'ecs'] : [provider]);
    try {
      const document = spec();
      document.environments.staging.storage = { documents: { provider: 's3', type: 'bucket', region: 'us-east-1', injectInto: ['web'] } };
      const report = buildProjectRotationAssessment({ project, spec: document, specRevision: 1, mode: 'routine',
        recordedEnvironments: [], connections: [
          { id: 'exact', provider: 'railway', scope: 'example/rotation-app', status: 'verified' },
          { id: 'wildcard', provider: 'ecs', scope: 'example/*', status: 'verified' },
          { id: 'global', provider: 's3', scope: null, status: 'verified' },
          { id: 'unrelated-scope', provider: 'railway', scope: 'elsewhere/other', status: 'verified' },
          { id: 'unrelated-provider', provider: 'unrelated', scope: null, status: 'verified' },
        ] });
      const candidates = report.inventory.filter(entry => entry.category === 'connection');
      expect(candidates.map(entry => entry.connection?.id).sort()).toEqual(['exact', 'global', 'wildcard']);
      for (const entry of candidates) {
        expect(entry.ownership).toBe('unknown');
        expect(entry.blockers.map(blocker => blocker.code)).toContain('connection_usage_unverified');
        expect(entry.blockers.map(blocker => blocker.code)).toContain('outside_consumers_unchecked');
      }
      expect(candidates.find(entry => entry.connection?.id === 'global')?.blockers.map(blocker => blocker.code))
        .toContain('shared_scope_review_required');
    } finally { alias.mockRestore(); }
  });

  it('leaves empty declarations incomplete and does not claim a safe project', () => {
    const report = assess(spec({ secrets: {}, environments: {} }));
    expect(report).toMatchObject({ status: 'review_required', executable: false, rotationPerformed: false,
      coverage: { complete: false } });
    expect(report.blockers.map(blocker => blocker.code)).toContain('live_inventory_unchecked');
  });

  it('does not reuse an integration scope as proof that another provider connection belongs to this project', () => {
    const document = spec();
    document.environments.production.payments = { stripe: { environment: 'stripe-sandbox',
      credentials: { secretKeyEnvVar: 'PAYMENTS_KEY' }, webhooks: {} } };
    const report = buildProjectRotationAssessment({ project, spec: document, specRevision: 1, mode: 'incident',
      recordedEnvironments: [], connections: [
        { id: 'stripe', provider: 'stripe', scope: 'stripe-sandbox', status: 'verified' },
        { id: 'other-host', provider: 'railway', scope: 'stripe-sandbox', status: 'verified' },
      ] });
    expect(report.inventory.filter(entry => entry.category === 'connection').map(entry => entry.connection?.id)).toEqual(['stripe']);
  });

  it('gates replacement distribution on destination trust and closure on all evidence and remaining scope', () => {
    const report = assess();
    const external = report.inventory.find(entry => entry.category === 'delegated-secret')!;
    expect(external.stages.find(stage => stage.id === 'trust-destinations')).toMatchObject({
      status: 'blocked', dependsOn: ['review'], message: expect.stringContaining('trust'),
    });
    expect(external.stages.find(stage => stage.id === 'distribute')?.dependsOn).toContain('trust-destinations');
    expect(external.stages.find(stage => stage.id === 'closure')).toMatchObject({
      status: 'blocked', dependsOn: ['verify-consumers', 'verify-revocation'],
      message: expect.stringContaining('unchecked'),
    });
    const generated = report.inventory.find(entry => entry.keys.includes('SESSION_KEY'))!;
    expect(generated.stages.find(stage => stage.id === 'generation')?.dependsOn).toContain('trust-destinations');
    expect(generated.stages.find(stage => stage.id === 'closure')?.dependsOn).toContain('verify-invalidation');
  });

  it('includes only declared App Store bundle and existing domain-scope policy candidates', () => {
    const document = spec();
    document.environments.staging.domain = 'staging.example.com';
    document.environments.staging.ios = { bundleId: 'com.example.rotation.staging', platform: 'IOS', capabilities: [] };
    const report = buildProjectRotationAssessment({ project, spec: document, specRevision: 1, mode: 'routine',
      recordedEnvironments: [], connections: [
        { id: 'apple', provider: 'appstoreconnect', scope: 'com.example.rotation.staging', status: 'verified' },
        { id: 'other-apple', provider: 'appstoreconnect', scope: 'com.example.other', status: 'verified' },
        { id: 'zone', provider: 'cloudflare', scope: 'example.com', status: 'verified' },
        { id: 'host', provider: 'cloudflare', scope: 'staging.example.com', status: 'verified' },
        { id: 'other-domain', provider: 'cloudflare', scope: 'unrelated.com', status: 'verified' },
      ] });
    expect(report.inventory.filter(entry => entry.category === 'connection').map(entry => entry.connection?.id))
      .toEqual(['apple', 'host', 'zone']);
  });

  it('includes every declared AI automation consumer and scoped OpenAI credential candidates', () => {
    const document = spec({ github: { enabled: true, repository: 'example/rotation-app', actions: {
      review: { kind: 'pull-request-review' },
      'disabled-review': { kind: 'pull-request-review', enabled: false },
    } } });
    const report = buildProjectRotationAssessment({ project, spec: document, specRevision: 1, mode: 'incident',
      recordedEnvironments: [], connections: [
        { id: 'ai-project', provider: 'openai', scope: 'example/rotation-app', status: 'verified' },
        { id: 'ai-other', provider: 'openai', scope: 'elsewhere/other', status: 'verified' },
      ] });
    const ai = report.inventory.filter(entry => entry.provider === 'openai' && entry.category !== 'connection');
    expect(ai).toHaveLength(2);
    expect(ai.map(entry => entry.destinations)).toEqual([
      [{ kind: 'github-repository', repository: 'example/rotation-app', resource: 'github-action:disabled-review' }],
      [{ kind: 'github-repository', repository: 'example/rotation-app', resource: 'github-action:review' }],
    ]);
    for (const entry of ai) {
      expect(entry.keys).toEqual(['OPENAI_API_KEY']);
      expect(entry.blockers.map(blocker => blocker.code)).toContain('issuer_rotation_unsupported');
    }
    expect(report.inventory.filter(entry => entry.category === 'connection').map(entry => entry.connection?.id))
      .toEqual(['ai-project']);
  });

  it('leaves credential-source credentials and their scope explicitly unchecked without reading references', () => {
    const report = assess(spec({ secrets: {}, environments: {} }));
    expect(report.blockers).toContainEqual(expect.objectContaining({
      code: 'secret_source_credentials_unchecked', message: expect.stringContaining('source'),
    }));
    expect(report.coverage.complete).toBe(false);
  });

  it('includes managed App Store and Match inputs in the exact build environment only', () => {
    const document = spec();
    const ios = { bundleId: 'com.example.rotation', platform: 'IOS' as const, capabilities: [],
      release: { services: ['web'], trigger: 'manual' as const,
        build: { workingDirectory: '.', command: 'make ios', ipaPath: 'app.ipa', requiredSecrets: ['BUILD_INPUT'] },
        signing: { provider: 'match' as const, gitBranch: 'main' },
        testflight: { groups: ['internal'], usesNonExemptEncryption: false, submitForBetaReview: false } } };
    document.environments.staging.ios = ios;
    document.environments.production.ios = { ...ios, release: { ...ios.release, promoteFrom: 'staging' } };
    const report = assess(document);
    const entries = report.inventory.filter(entry => entry.category === 'signing');
    const keys = entries.flatMap(entry => entry.keys);
    expect(keys).toEqual(expect.arrayContaining(['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY', 'MATCH_GIT_URL', 'MATCH_PASSWORD', 'MATCH_GIT_BASIC_AUTHORIZATION', 'BUILD_INPUT']));
    for (const entry of entries.filter(entry => entry.keys.length > 0)) {
      expect(entry.destinations).toEqual([{ kind: 'github-environment', repository: 'example/rotation-app', environment: 'staging' }]);
    }
    expect(entries.some(entry => entry.destinations.some(destination => destination.environment === 'production'))).toBe(true);
  });

  it('keeps stable ids and order across declaration order and never mutates inputs', () => {
    const document = spec();
    const before = JSON.stringify(document);
    const first = assess(document);
    const reordered = structuredClone(document);
    reordered.secrets = Object.fromEntries(Object.entries(reordered.secrets).reverse());
    reordered.environments = Object.fromEntries(Object.entries(reordered.environments).reverse());
    reordered.environments.staging.services = Object.fromEntries(Object.entries(reordered.environments.staging.services).reverse());
    expect(assess(reordered)).toEqual(first);
    expect(JSON.stringify(document)).toBe(before);
    expect(new Set(first.inventory.map(entry => entry.id)).size).toBe(first.inventory.length);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
