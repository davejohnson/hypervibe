import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gcpObservedHoldingConfiguration } from '../../src/adapters/providers/gcp/gcp-prepared-hosting.js';

// Sanitized native field projection, observed 2026-10-27 after an approved create.
// Identity strings/labels/etag are replaced; configuration and protobuf omissions
// are retained. This is not a complete response or evidence for every provider.
// Google documents min(service maximum, revision maximum) for effective maximum:
// https://docs.cloud.google.com/run/docs/configuring/max-instances
const native = JSON.parse(readFileSync(new URL('./gcp/holding-service-observation.json', import.meta.url), 'utf8'));
const expected = { id: native.name, lifetimeId: native.uid, image: native.template.containers[0].image,
  serviceAccountEmail: native.template.serviceAccount, publicAccess: true };

describe('observed Google holding service scaling', () => {
  it.each([undefined, {}, { maxInstanceCount: 20 }, { maxInstanceCount: 1 }, { maxInstanceCount: 0 },
    { scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 20 }])('retains the reviewed revision cap with automatic service scaling %j', scaling => {
    const configuration = gcpObservedHoldingConfiguration({ ...native, scaling }, expected);
    expect(configuration.template.scaling).toEqual({ minInstanceCount: 0, maxInstanceCount: 1 });
  });
  it.each([null, [], { minInstanceCount: 1, maxInstanceCount: 20 }, { maxInstanceCount: -1 }, { maxInstanceCount: '20' },
    { maxInstanceCount: 0.5 }, { scalingMode: 'MANUAL', manualInstanceCount: 0 }, { manualInstanceCount: 1 },
    { scalingMode: 'UNKNOWN_MODE' }, { unknownField: 1 }])('rejects malformed, manual or nonzero-floor scaling %j', scaling => {
    expect(() => gcpObservedHoldingConfiguration({ ...native, scaling }, expected)).toThrow();
  });
  it.each([0, 2, undefined])('does not use a service cap to accept a changed revision maximum %j', maxInstanceCount => {
    const changed = structuredClone(native); changed.template.scaling = { maxInstanceCount };
    expect(() => gcpObservedHoldingConfiguration(changed, expected)).toThrow();
  });
});
