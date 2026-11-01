import { describe, expect, it } from 'vitest';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { planDelegatedSecrets } from '../delegated-secret.service.js';
import type { ProjectSpec } from '../../spec/spec.schema.js';
import type { ObservedState } from '../../ports/observe.port.js';

const destination = { provider: 'gcp-secret-manager', projectId: 'synthetic-project',
  projectNumber: '123456789012', secretId: 'staging-flow-key' };
function setup(version?: string, observedVersion?: string) {
  const spec = { version: 1, project: 'synthetic-app', secrets: { FLOW_KEY: {
    ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'],
    required: true, driftPolicy: 'preserve',
  } }, environments: { staging: { hosting: { provider: 'cloudrun' },
    services: { web: {} }, secretDestinations: { FLOW_KEY: { destination, ...(version ? { version } : {}) } },
  } } } as unknown as ProjectSpec;
  const observed = { provider: 'cloudrun', projectExists: true, partial: false, warnings: [],
    services: [{ name: 'web', externalId: 'web-id', envVarKeys: observedVersion ? ['FLOW_KEY'] : [],
      envVarHashes: {}, envVarSecretRefs: observedVersion ? { FLOW_KEY: {
        provider: 'gcp-secret-manager', resource: 'projects/123456789012/secrets/staging-flow-key',
        version: observedVersion,
      } } : {}, config: {} }],
  } as unknown as ObservedState;
  return { spec, observed, environmentName: 'staging', hostingProvider: 'cloudrun', environment: null };
}

describe('reference-only secret planning', () => {
  // Reconstructed from the 2026-11-01 live backup-plan observation: both
  // workloads and their native references were complete; only storage was
  // unknown. This tests the shared metadata boundary, not provider transport.
  it.each(['matching', 'replacement', 'immutable', 'activation', 'creation'] as const)(
    'uses complete service evidence despite unrelated storage uncertainty: %s', kind => {
      const input = setup('7', kind === 'replacement' ? '6' : '7');
      input.observed.partial = true;
      input.observed.completeness = { services: 'complete', storage: 'unknown' };
      if (kind === 'immutable') input.spec.secrets.FLOW_KEY = {
        ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1,
        environments: ['staging'], replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'],
      };
      if (kind === 'activation') input.observed.services[0].runtimeSecretReferenceActivation = 'application-release';
      if (kind === 'creation') input.observed.services = [];
      const result = planDelegatedSecrets({ ...input, environment: { platformBindings: {
        provider: 'cloudrun', projectId: 'synthetic-project',
        services: kind === 'creation' ? {} : { web: { serviceId: 'web-id' } },
      } } });
      expect(result.blockers).toEqual([]);
      expect(result.desiredEnvVars).toEqual({});
      expect(result.actions[0]).toMatchObject({ verified: true,
        type: ['replacement', 'activation', 'creation'].includes(kind) ? 'update' : 'noop' });
      if (kind === 'replacement') expect(result.actions[0].requiresConfirm).toBe(true);
      if (kind === 'activation') expect(result.actions[0].metadata?.activation).toBe('application-release');
      if (kind === 'creation') expect(result.actions[0].metadata?.creationOnlyServices).toEqual(['web']);
    });

  it.each(['unknown', 'legacy-partial', 'identity-only', 'duplicate', 'missing-keys', 'conflict'] as const)(
    'keeps incomplete or contradictory service evidence blocked: %s', kind => {
      const input = setup('7', '7');
      input.observed.partial = kind !== 'unknown';
      input.observed.completeness = { services: 'complete', storage: 'unknown' };
      if (kind === 'unknown') input.observed.completeness.services = 'unknown';
      if (kind === 'legacy-partial') delete input.observed.completeness;
      if (kind === 'identity-only') input.observed.completeness = { services: 'unknown', serviceIdentities: 'complete' };
      if (kind === 'duplicate') input.observed.services.push({ ...input.observed.services[0] });
      if (kind === 'missing-keys') delete (input.observed.services[0] as Partial<typeof input.observed.services[0]>).envVarKeys;
      if (kind === 'conflict') {
        input.spec.secrets.FLOW_KEY = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1,
          environments: ['staging'], replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'] };
        input.observed.services[0].envVarKeys.push('OLD_KEY');
      }
      expect(planDelegatedSecrets(input).blockers).toEqual([expect.objectContaining({ key: 'FLOW_KEY' })]);
    });

  it('blocks a credential role instead of installing its native reference in unreviewed services', () => {
    const input = setup('7');
    input.spec.environments.staging.services.worker = { ...input.spec.environments.staging.services.web };
    input.spec.secrets.FLOW_KEY.credential = { role: 'external-api', label: 'External API', purpose: 'Web requests', kind: 'opaque',
      source: 'env:PRIVATE_INPUT', runtimeConsumers: [{ environment: 'staging', service: 'web', variable: 'FLOW_KEY' }] };
    input.observed!.services.push({ ...input.observed!.services[0], name: 'worker', externalId: 'worker-id' });
    const result = planDelegatedSecrets(input);
    expect(result.blockers).toEqual([expect.objectContaining({ key: 'FLOW_KEY', reason: expect.stringMatching(/credential.*native|native.*credential/i) })]);
    expect(result.actions.every(action => action.type === 'noop' && !action.verified)).toBe(true);
    expect(result.desiredEnvVars).toEqual({});
  });

  it('accepts an exact observed reference without requesting, hashing or materializing a value', () => {
    const result = planDelegatedSecrets(setup('7', '7'));
    expect(result.inputRequired).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.desiredEnvVars).toEqual({});
    expect(result.actions).toEqual([expect.objectContaining({ type: 'noop',
      metadata: expect.objectContaining({ operation: 'secretReferenceSync' }) })]);
  });

  it('requests direct delivery when the committed destination has no version', () => {
    const result = planDelegatedSecrets(setup());
    expect(result.inputRequired).toEqual([expect.objectContaining({ key: 'FLOW_KEY',
      reason: expect.stringContaining('secret manager') })]);
    expect(result.desiredEnvVars).toEqual({});
    expect(JSON.stringify(result)).not.toContain('dotenv:');
  });

  it('requires exact rotation confirmation when replacing an existing native reference', () => {
    const result = planDelegatedSecrets(setup('8', '7'));
    expect(result.inputRequired).toEqual([]);
    expect(result.actions[0]).toMatchObject({ type: 'update', requiresConfirm: true,
      metadata: { operation: 'secretReferenceSync', reference: { destination, version: '8' } } });
    expect(result.desiredEnvVars).toEqual({});
  });

  it('rejects literal secret input for a manager-owned destination', () => {
    const result = planDelegatedSecrets({ ...setup('7'), suppliedValues: { FLOW_KEY: 'synthetic-transient-value' } });
    expect(result.blockers).toEqual([expect.objectContaining({ key: 'FLOW_KEY' })]);
    expect(result.desiredEnvVars).toEqual({});
    expect(JSON.stringify(result)).not.toContain('synthetic-transient-value');
  });

  it('keeps unknown observation blocked rather than assuming destination absence', () => {
    const result = planDelegatedSecrets({ ...setup('7'), observed: null });
    expect(result.blockers).toEqual([expect.objectContaining({ key: 'FLOW_KEY' })]);
    expect(result.actions.every(action => action.type === 'noop')).toBe(true);
  });
  it.each(['FLOW_KEY', 'OLD_KEY'])('does not reinitialize an immutable slot over retained legacy acceptance for %s', (legacyName) => {
    const input = setup('7');
    input.spec.secrets.FLOW_KEY = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1,
      environments: ['staging'], replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'] };
    const result = planDelegatedSecrets({ ...input, environment: { platformBindings: {
      delegatedEnvBindings: [{ name: legacyName, principal: 'hypervibe', valueHash: 'synthetic-offline-verifier', source: 'hypervibe-generated', generator: 'random-base64url-32-v1', generation: 1, syncedAt: '2026-10-24T00:00:00.000Z', applyRunId: 'prior-run', actionId: 'secret:' + legacyName }],
    } } });
    expect(result.blockers).toEqual([expect.objectContaining({ key: 'FLOW_KEY' })]);
    expect(JSON.stringify(result)).not.toContain('synthetic-offline-verifier');
  });
});
