import { describe, expect, it } from 'vitest';
import { databaseSpecSchema } from '../spec.schema.js';

describe('one-use database checkpoint intent', () => {
  it('allows a named snapshot without a PITR policy or restore schedule', () => {
    expect(databaseSpecSchema.parse({ provider: 'railway', resilience: { checkpoint: { id: 'pre-beta-20260930' } } }).resilience)
      .toEqual({ checkpoint: { id: 'pre-beta-20260930' } });
  });
  it.each(['', 'UPPER', ' spaces ', '../db', 'double--dash', 'x'.repeat(64)])('rejects unsafe intent id %j', (id) => {
    expect(databaseSpecSchema.safeParse({ provider: 'railway', resilience: { checkpoint: { id } } }).success).toBe(false);
  });
  it('rejects hidden restore, delete, and PITR options in the snapshot contract', () => {
    for (const key of ['restore', 'delete', 'enablePitr']) {
      expect(databaseSpecSchema.safeParse({ provider: 'railway', resilience: { checkpoint: { id: 'pre-beta', [key]: true } } }).success).toBe(false);
    }
  });
});
