import { describe, expect, it } from 'vitest';
import { parseJsonColumn } from '../json.codec.js';
import {
  buildConfigColumnSchema,
  componentBindingsColumnSchema,
  runReceiptsColumnSchema,
} from '../column.schemas.js';

describe('parseJsonColumn', () => {
  it('parses valid JSON through the schema', () => {
    const result = parseJsonColumn(
      buildConfigColumnSchema,
      JSON.stringify({ startCommand: 'npm start', public: true }),
      'test'
    );
    expect(result).toEqual({ startCommand: 'npm start', public: true });
  });

  it('preserves unknown keys (passthrough)', () => {
    const result = parseJsonColumn(
      componentBindingsColumnSchema,
      JSON.stringify({ host: 'db.example.com', customKey: 'kept' }),
      'test'
    );
    expect(result).toEqual({ host: 'db.example.com', customKey: 'kept' });
  });

  it('falls back to default on corrupt JSON', () => {
    expect(parseJsonColumn(buildConfigColumnSchema, '{not json', 'test')).toEqual({});
    expect(parseJsonColumn(runReceiptsColumnSchema, '{not json', 'test')).toEqual([]);
  });

  it('falls back to default on schema mismatch', () => {
    // build_config must be an object, not an array
    expect(parseJsonColumn(buildConfigColumnSchema, '[1,2,3]', 'test')).toEqual({});
  });

  it('falls back to default on null/empty input', () => {
    expect(parseJsonColumn(buildConfigColumnSchema, null, 'test')).toEqual({});
    expect(parseJsonColumn(buildConfigColumnSchema, '', 'test')).toEqual({});
    expect(parseJsonColumn(runReceiptsColumnSchema, undefined, 'test')).toEqual([]);
  });

  it('rejects wrong field types inside known keys', () => {
    // public must be boolean — whole row degrades to default rather than throwing
    expect(parseJsonColumn(buildConfigColumnSchema, JSON.stringify({ public: 'yes' }), 'test')).toEqual({});
  });
});
