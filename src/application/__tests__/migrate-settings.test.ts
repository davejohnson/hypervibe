import { describe, expect, it } from 'vitest';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { mergeServiceSettings, proposeTargetEnvironment } from '../migrate.js';
import { failedTaskIsOver } from '../../adapters/providers/railway/railway.adapter.js';

// #547: a declared setting that points at the source's own database must not follow the app to the target.
describe('declared settings carried to the target', () => {
  const source = {
    hosting: { provider: 'railway', region: 'us-west1' }, services: { web: { workloadKind: 'web' } }, domain: 'staging.example.com',
    envVars: {
      APP_URL: 'https://staging.example.com', NODE_ENV: 'production',
      DIRECT_URL: 'postgresql://app:pw@roundhouse.proxy.rlwy.net:5432/railway', READ_REPLICA: 'postgres://ro:pw@replica.internal/app',
      CACHE: 'rediss://default:pw@cache.internal:6379', DATABASE_URL: 'placeholder', RAILWAY_ENVIRONMENT: 'staging',
    },
  } as unknown as EnvironmentSpec;
  it('leaves out source data addresses and provider-managed names, and keeps ordinary settings', () => {
    const target = proposeTargetEnvironment(source, { domain: 'gcp.example.com' });
    expect(target.envVars).toEqual({ APP_URL: 'https://gcp.example.com', NODE_ENV: 'production' });
  });
});

// #553: settings are read per service. The same name with different values, or a value
// the provider could not resolve, cannot be copied as one environment-wide value.
describe('settings read from each source service', () => {
  it('copies a name every service agrees on', () => {
    expect(mergeServiceSettings([{ service: 'web', variables: { API_KEY: 'k', A: '1' } }, { service: 'worker', variables: { API_KEY: 'k' } }]))
      .toEqual({ values: { API_KEY: 'k', A: '1' }, conflicting: [], unresolved: [] });
  });
  it('does not pick a winner when services disagree', () => {
    const merged = mergeServiceSettings([{ service: 'web', variables: { API_KEY: 'web-key', SHARED: 's' } }, { service: 'worker', variables: { API_KEY: 'worker-key', SHARED: 's' } }]);
    expect(merged.values).toEqual({ SHARED: 's' });
    expect(merged.conflicting).toEqual(['API_KEY']);
  });
  it('does not copy a value the provider could not resolve, even when another service has one', () => {
    const merged = mergeServiceSettings([{ service: 'web', variables: { TOKEN: '${{shared.TOKEN}}', OK: '1' }, unresolvedKeys: ['TOKEN'] }, { service: 'worker', variables: { TOKEN: 'real' } }]);
    expect(merged.values).toEqual({ OK: '1' });
    expect(merged.unresolved).toEqual(['TOKEN']);
  });
});

// #558: a failed Railway task with no exit marker in its logs will never produce one.
describe('a failed Railway task', () => {
  const log = (message: string) => ({ message });
  it('is over when its latest logs carry no exit marker, however many lines were seen before', () => {
    expect(failedTaskIsOver('FAILED', [log('starting'), log('pg_dump: error')])).toBe(true);
    expect(failedTaskIsOver('CRASHED', [])).toBe(true);
  });
  it('is not over while the exit marker can still be read, or the task has not failed', () => {
    expect(failedTaskIsOver('FAILED', [log('__HYPERVIBE_TASK_EXIT:3__')])).toBe(false);
    expect(failedTaskIsOver('DEPLOYING', [log('starting')])).toBe(false);
    expect(failedTaskIsOver('SUCCESS', [])).toBe(false);
  });
});
