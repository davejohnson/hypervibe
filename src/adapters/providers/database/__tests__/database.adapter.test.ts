import { describe, expect, it } from 'vitest';
import { DatabaseAdapter, stripSqlLiteralsAndComments } from '../database.adapter.js';

const adapter = new DatabaseAdapter();

describe('stripSqlLiteralsAndComments', () => {
  it('strips line and block comments', () => {
    expect(stripSqlLiteralsAndComments('SELECT 1 -- DROP TABLE x')).not.toMatch(/DROP/);
    expect(stripSqlLiteralsAndComments('/* DROP */ SELECT 1')).not.toMatch(/DROP/);
  });

  it('strips string literals including escapes and dollar quotes', () => {
    expect(stripSqlLiteralsAndComments("SELECT 'a;b''c'")).toBe("SELECT ''");
    expect(stripSqlLiteralsAndComments('SELECT $tag$ ; DROP $tag$')).toBe("SELECT ''");
  });
});

describe('isMutationQuery', () => {
  it('detects plain mutations', () => {
    expect(adapter.isMutationQuery('DELETE FROM users')).toBe(true);
    expect(adapter.isMutationQuery('  update users set x = 1')).toBe(true);
  });

  it('is not evaded by a leading comment', () => {
    expect(adapter.isMutationQuery('/* hi */ DROP TABLE users')).toBe(true);
    expect(adapter.isMutationQuery('-- note\nTRUNCATE users')).toBe(true);
  });

  it('detects data-modifying CTEs', () => {
    expect(adapter.isMutationQuery('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone')).toBe(true);
  });

  it('detects SELECT INTO', () => {
    expect(adapter.isMutationQuery('SELECT * INTO backup FROM users')).toBe(true);
  });

  it('does not flag reads with keywords in strings', () => {
    expect(adapter.isMutationQuery("SELECT * FROM logs WHERE message = 'DROP TABLE'")).toBe(false);
    expect(adapter.isMutationQuery('SELECT * FROM users')).toBe(false);
  });
});

describe('isMultiStatement', () => {
  it('detects piggybacked statements', () => {
    expect(adapter.isMultiStatement('SELECT 1; DROP TABLE users')).toBe(true);
    expect(adapter.isMultiStatement('SELECT 1;\n-- x\nDELETE FROM users')).toBe(true);
  });

  it('allows a single statement with trailing semicolon', () => {
    expect(adapter.isMultiStatement('SELECT 1;')).toBe(false);
    expect(adapter.isMultiStatement('SELECT 1; \n')).toBe(false);
  });

  it('ignores semicolons inside strings and comments', () => {
    expect(adapter.isMultiStatement("SELECT * FROM t WHERE x = 'a;b'")).toBe(false);
    expect(adapter.isMultiStatement('SELECT 1 /* ; */')).toBe(false);
  });
});

describe('analyzeQuery', () => {
  it('returns multiStatement flag and warnings', () => {
    const analysis = adapter.analyzeQuery('DELETE FROM users');
    expect(analysis.isMutation).toBe(true);
    expect(analysis.multiStatement).toBe(false);
    expect(analysis.warnings).toContain('DELETE without WHERE clause will affect all rows');
  });
});
