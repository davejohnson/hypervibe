import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { resolveBackupStrategy, withBackupStorageDefaults } from '../backup-strategy.service.js';

const raw = { hosting: { provider: 'railway' }, services: {}, storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] } } };
describe('shared backup defaults', () => {
  it('derives a separately reviewed vault without changing source intent or injecting app credentials', () => {
    const original = environmentSpecSchema.parse(raw), before = JSON.stringify(original);
    const effective = withBackupStorageDefaults(original);
    expect(effective.storage?.['hypervibe-backups']).toEqual({ provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [], purpose: 'backup' });
    expect(JSON.stringify(original)).toBe(before);
    expect(withBackupStorageDefaults(effective)).toEqual(effective);
    expect(resolveBackupStrategy(effective)).toMatchObject({ mode: 'daily', destination: 'hypervibe-backups', retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 });
  });
  it('never repurposes an application bucket with the reserved name', () => {
    const spec = environmentSpecSchema.parse({ ...raw, storage: { ...raw.storage, 'hypervibe-backups': raw.storage.documents } });
    expect(withBackupStorageDefaults(spec)).toEqual(spec);
    expect(resolveBackupStrategy(spec).issues).toContain('The default backup destination name is already used by application storage. Declare a separate backup destination.');
  });
  it('requires a separate vault and an immutable helper image', () => {
    expect(environmentSpecSchema.safeParse({ ...raw, backups: { mode: 'daily', destination: 'documents', runnerImage: 'example/helper:latest' } }).success).toBe(false);
    expect(environmentSpecSchema.safeParse({ ...raw, storage: { vault: { ...raw.storage.documents, purpose: 'backup', injectInto: ['web'] } } }).success).toBe(false);
  });
  it('preserves explicit exclusions and never removes existing protection', () => {
    const spec = environmentSpecSchema.parse({ ...raw, backups: { mode: 'disabled', reason: 'Ephemeral fixture' } });
    expect(withBackupStorageDefaults(spec)).toEqual(spec);
    expect(resolveBackupStrategy(spec)).toMatchObject({ mode: 'disabled', issues: [] });
  });
});
