import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, storageSpecSchema } from '../spec.schema.js';

describe('storage spec', () => {
  it('accepts opt-in daily backups only for application buckets on their hosting cloud', () => {
    function environment(hosting: string, provider: string, extra: Record<string, unknown> = {}) {
      return environmentSpecSchema.safeParse({ hosting: { provider: hosting }, storage: {
        documents: { provider, type: 'bucket', region: provider === 'railway' ? 'sjc' : 'us-central1', injectInto: [], ...extra },
      } });
    }
    for (const [hosting, provider] of [['cloudrun', 'gcs'], ['aws', 's3'], ['azure', 'azureblob']] as const) {
      const requested = environment(hosting, provider, { automatedBackups: true });
      expect(requested.success && requested.data.storage?.documents?.automatedBackups).toBe(true);
      const legacy = environment(hosting, provider);
      expect(legacy.success && legacy.data.storage?.documents).not.toHaveProperty('automatedBackups');
      expect(environment(hosting, provider, { automatedBackups: true, purpose: 'backup' }).success).toBe(false);
      expect(environment(hosting, provider, { automatedBackups: false }).success).toBe(false);
    }
    expect(environment('cloudrun', 's3', { automatedBackups: true }).success).toBe(false);
    expect(environment('railway', 'railway', { automatedBackups: true }).success).toBe(false);
  });

  it('accepts Railway storage targeting declared services across hosting providers', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'cloudrun' },
      services: { api: {}, worker: { workloadKind: 'worker' } },
      storage: { uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api', 'worker'] } },
    }).success).toBe(true);
  });

  it('requires a supported region and permits a standalone bucket with no runtime injection', () => {
    expect(storageSpecSchema.safeParse({ provider: 'railway', type: 'bucket', region: 'xyz', injectInto: ['api'] }).success).toBe(false);
    expect(storageSpecSchema.safeParse({ provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] }).success).toBe(true);
  });

  it('keeps non-Railway provider ids and regions portable for registered adapters', () => {
    expect(storageSpecSchema.safeParse({
      provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['api'],
    }).success).toBe(true);
    expect(storageSpecSchema.safeParse({
      provider: 'gcs', type: 'bucket', region: 'northamerica-northeast1', injectInto: [],
    }).success).toBe(true);
    expect(storageSpecSchema.safeParse({
      provider: 'azureblob', type: 'bucket', region: 'westus2', injectInto: ['api'],
    }).success).toBe(true);
  });

  it('rejects storage targets that are not declared services', () => {
    const result = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' }, services: { api: {} },
      storage: { uploads: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['missing'] } },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('not declared');
  });

  it('rejects two buckets targeting one service because AWS variable names would collide', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' }, services: { api: {} },
      storage: {
        uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api'] },
        documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['api'] },
      },
    }).success).toBe(false);
  });
  // Auto-tiering is off unless asked for, and is never accepted where it would be silently ignored.
  describe('autoTiering', () => {
    const environment = (hosting: string, provider: string, extra: Record<string, unknown> = {}) => environmentSpecSchema.safeParse({
      hosting: { provider: hosting }, services: { api: {} },
      storage: { files: { provider, type: 'bucket', region: provider === 'railway' ? 'sjc' : 'us-west1', injectInto: ['api'], ...extra } },
    });
    const message = (result: ReturnType<typeof environment>) => result.success ? '' : result.error.issues.map(issue => issue.message).join('\n');

    it('is accepted for a Google Cloud bucket on Google Cloud and an S3 bucket on AWS', () => {
      expect(environment('cloudrun', 'gcs', { autoTiering: true }).success).toBe(true);
      expect(environment('aws', 's3', { autoTiering: true, versioning: true }).success).toBe(true);
    });

    it('is off by default and may be written as false for any provider', () => {
      for (const [hosting, provider] of [['cloudrun', 'gcs'], ['aws', 's3'], ['azure', 'azureblob'], ['railway', 'railway']] as const) {
        expect(environment(hosting, provider).success).toBe(true);
        expect(environment(hosting, provider, { autoTiering: false }).success).toBe(true);
      }
      const parsed = storageSpecSchema.parse({ provider: 'gcs', type: 'bucket', region: 'us-west1', injectInto: [] });
      expect(parsed).not.toHaveProperty('autoTiering');
      expect(storageSpecSchema.safeParse({ provider: 'gcs', type: 'bucket', region: 'us-west1', injectInto: [], autoTiering: 'yes' }).success).toBe(false);
    });

    it('is refused on Azure, where last-read tracking belongs to the whole storage account and reading cooled files costs extra', () => {
      const result = environment('azure', 'azureblob', { autoTiering: true });
      expect(result.success).toBe(false);
      expect(message(result)).toMatch(/Storage files: autoTiering is not available on Azure/);
      expect(message(result)).toMatch(/Remove autoTiering/);
    });

    it('is refused for a provider with no storage tiers, instead of being ignored', () => {
      const result = environment('railway', 'railway', { autoTiering: true });
      expect(result.success).toBe(false);
      expect(message(result)).toMatch(/Storage files: autoTiering is available only for Google Cloud Storage \("gcs"\) and Amazon S3 \("s3"\) buckets/);
    });

    it.each([['railway', 'gcs'], ['railway', 's3'], ['aws', 'gcs'], ['cloudrun', 's3']])('is refused when %s hosting would leave a %s bucket outside the engine that applies it', (hosting, provider) => {
      const result = environment(hosting, provider, { autoTiering: true });
      expect(result.success).toBe(false);
      expect(message(result)).toMatch(/Storage files: autoTiering needs/);
    });
  });
});
