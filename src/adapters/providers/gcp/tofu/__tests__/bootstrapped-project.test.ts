import { describe, expect, it } from 'vitest';
import { bootstrappedProjectNumber } from '../project-state-recovery.js';

// The shape `tofu show -json` gives for the project the bootstrap created.
const row = (changes: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({
  address: 'google_project.hypervibe', mode: 'managed', type: 'google_project', name: 'hypervibe', provider_name: 'registry.opentofu.org/hashicorp/google',
  values: { project_id: 'hv-demo-12345678', number: '4242', ...values }, ...changes,
});
const state = (...resources: unknown[]) => ({ values: { root_module: { resources } } });

describe('which Google project a setup created', () => {
  it('reads the number of the project in its own state', () => {
    expect(bootstrappedProjectNumber(state(row()), 'hv-demo-12345678')).toBe('4242');
  });
  it.each([
    ['no project in the state', state({ address: 'google_service_account.deploy', values: {} })],
    ['a different project id', state(row({}, { project_id: 'someone-elses' }))],
    ['no number', state(row({}, { number: null }))],
    ['a half-created project', state(row({ tainted: true }))],
    ['a replaced instance left behind', state(row({ deposed_key: 'abc' }))],
    ['a data source, not a created resource', state(row({ mode: 'data' }))],
    ['an empty document', {}],
  ])('reports none for %s', (_what, document) => {
    expect(bootstrappedProjectNumber(document, 'hv-demo-12345678')).toBeUndefined();
  });
});
