import { describe, expect, it } from 'vitest';
import { databaseMigrationStrategyStatus, overrideDatabaseName } from '../database-move.service.js';

describe('database-move.service', () => {
  describe('databaseMigrationStrategyStatus', () => {
    it('reports snapshot as available with a write freeze requirement', () => {
      expect(databaseMigrationStrategyStatus('snapshot')).toMatchObject({
        selected: 'snapshot',
        status: 'available',
        writeFreezeRequired: true,
        continuousReplication: false,
      });
    });

    it('reports non-snapshot strategies as planned only', () => {
      const status = databaseMigrationStrategyStatus('logical_replication');
      expect(status).toMatchObject({
        selected: 'logical_replication',
        status: 'planned',
        continuousReplication: true,
      });
      expect(String(status.detail)).toContain('Not implemented yet');
    });
  });

  describe('overrideDatabaseName', () => {
    it('switches the database path to target the default postgres database', () => {
      expect(overrideDatabaseName('postgresql://postgres:password@203.0.113.10:5432/app', 'postgres'))
        .toBe('postgresql://postgres:password@203.0.113.10:5432/postgres');
    });

    it('returns the original URL when no database name is provided', () => {
      const url = 'postgresql://postgres:password@203.0.113.10:5432/app';
      expect(overrideDatabaseName(url, undefined)).toBe(url);
      expect(overrideDatabaseName(url, '  ')).toBe(url);
    });
  });
});
