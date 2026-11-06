import { describe, expect, it } from 'vitest';
import { pointsAtSourceData, proposeTargetEnvironment } from '../migrate.js';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';

describe('proposed migration target', () => {
  it('maps a Railway environment onto OpenTofu-managed Google Cloud equivalents', () => {
    const source = {
      hosting: { provider: 'railway', region: 'us-west1' },
      services: {
        'staging-web': { workloadKind: 'web', startCommand: 'npm start', healthCheckPath: '/', public: true },
        'staging-worker': { workloadKind: 'worker', startCommand: 'npm run worker', public: false },
      },
      database: { provider: 'railway', engine: 'postgres' },
      domain: 'staging.example.com',
      envVars: { APP_URL: 'https://staging.example.com', NODE_ENV: 'production' },
      migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
      storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['staging-web', 'staging-worker'] } },
      email: { enabled: true },
    } as unknown as EnvironmentSpec;
    const target = proposeTargetEnvironment(source, { domain: 'gcp.example.com' }) as unknown as Record<string, any>;
    expect(target.hosting).toEqual({ provider: 'cloudrun', region: 'us-central1', engine: 'opentofu' });
    expect(target.database).toEqual({ provider: 'cloudsql' });
    expect(target.storage.documents).toEqual({ provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: ['staging-web', 'staging-worker'], access: 's3' });
    expect(target.envVars.APP_URL).toBe('https://gcp.example.com');
    expect(target.migrations).toEqual({ mode: 'releaseCommand', command: 'npm run migrate' });
    expect(target.domain).toBe('gcp.example.com');
    // Features the engine cannot manage yet are not silently carried over.
    expect(target.email).toBeUndefined();
    expect(Object.keys(target.services)).toEqual(['staging-web', 'staging-worker']);
  });
});

describe('migrated settings', () => {
  it('never copies a setting that points at the source database or cache, whatever its name', () => {
    expect(pointsAtSourceData('postgresql://user:pw@roundhouse.proxy.rlwy.net:5432/railway')).toBe(true);
    expect(pointsAtSourceData('rediss://default:pw@host:6379')).toBe(true);
    expect(pointsAtSourceData('https://api.anthropic.com')).toBe(false);
    expect(pointsAtSourceData('sk-ant-abc')).toBe(false);
  });
});
