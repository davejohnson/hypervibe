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
