import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseExportScript, databaseRestoreScript, databaseTransferScript, parseTransferResult } from '../migration-transfer-gcp.js';

// Cluster identifiers must stay strings: these adjacent valid uint64 values
// become indistinguishable if a JavaScript Number is used to compare them.
const sourceIdentity = '18446744073709551615:617070';
const otherClusterIdentity = '18446744073709551614:617070';
const otherDatabaseIdentity = '18446744073709551615:6f74686572';
const sourceUrl = 'postgresql://reader:source-fixture@database.internal/app?sslmode=require';
const targetUrl = 'postgresql://writer:target-fixture@proxy.internal/app';

interface ScriptOptions {
  sourceIdentity?: string;
  targetIdentity?: string;
  sourceIdentityExit?: number;
  targetIdentityExit?: number;
  dumpExit?: number;
  exportedSourceIdentity?: string;
}

/** Execute the emitted program. Only PostgreSQL/HTTP command transport and
 * host temporary paths are replaced; shell branching and ordering stay real. */
function execute(script: string, options: ScriptOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-self-copy-script-'));
  const tools = {
    psql: `
      if [ "$1" = "$SOURCE_DATABASE_URL" ]; then SIDE=source; else SIDE=target; fi
      SQL="$*"
      HAS_SQL_ARG=false
      for ARG in "$@"; do
        case "$ARG" in -c|--command|--command=*) HAS_SQL_ARG=true ;; esac
      done
      if [ "$HAS_SQL_ARG" = false ]; then SQL="$SQL $(cat)"; fi
      case "$SQL" in
        *'ALTER SCHEMA'*|*'DROP OWNED'*|*'CREATE SCHEMA'*)
          printf 'write:%s\\n' "$SIDE" >> "$TEST_TRACE" ;;
        *pg_control_system*)
          printf 'identity:%s\\n' "$SIDE" >> "$TEST_TRACE"
          if [ "$SIDE" = source ]; then
            printf '%s\\n' "$TEST_SOURCE_IDENTITY"
            exit "$TEST_SOURCE_IDENTITY_EXIT"
          fi
          printf '%s\\n' "$TEST_TARGET_IDENTITY"
          exit "$TEST_TARGET_IDENTITY_EXIT" ;;
        *information_schema.tables*)
          printf 'manifest:%s\\n' "$SIDE" >> "$TEST_TRACE"
          printf 'public.invoices|1:42\\n' ;;
        *server_version_num*) printf '160000\\n' ;;
        *current_user*) printf 'app_owner\\n' ;;
        *) printf 'Unexpected SQL transport call\\n' >&2; exit 91 ;;
      esac`,
    pg_dump: `
      printf 'dump\\n' >> "$TEST_TRACE"
      printf 'synthetic custom archive\\n'
      exit "$TEST_DUMP_EXIT"`,
    pg_restore: 'printf "restore\\n" >> "$TEST_TRACE"',
    curl: `
      case "$*" in
        *--upload-file*) printf 'upload\\n' >> "$TEST_TRACE" ;;
        *)
          printf 'download\\n' >> "$TEST_TRACE"
          while [ "$#" -gt 0 ]; do
            if [ "$1" = -o ]; then shift; printf 'synthetic custom archive\\n' > "$1"; break; fi
            shift
          done ;;
      esac`,
    apk: ':',
  };
  try {
    for (const [name, body] of Object.entries(tools)) writeFileSync(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    const trace = path.join(directory, 'trace');
    writeFileSync(trace, '');
    const execution = spawnSync('bash', ['-c', script.replaceAll('/tmp/', '"${TEST_DIRECTORY}"/')], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        SOURCE_DATABASE_URL: sourceUrl, DATABASE_URL: targetUrl,
        DUMP_URL: 'https://fixture.invalid/dump', UPLOAD_URL: 'https://fixture.invalid/upload',
        TEST_DIRECTORY: directory, TEST_TRACE: trace,
        TEST_SOURCE_IDENTITY: options.sourceIdentity ?? sourceIdentity,
        TEST_TARGET_IDENTITY: options.targetIdentity ?? otherClusterIdentity,
        TEST_SOURCE_IDENTITY_EXIT: String(options.sourceIdentityExit ?? 0),
        TEST_TARGET_IDENTITY_EXIT: String(options.targetIdentityExit ?? 0),
        TEST_DUMP_EXIT: String(options.dumpExit ?? 0),
        ...(options.exportedSourceIdentity === undefined ? {} : { SOURCE_DATABASE_IDENTITY: options.exportedSourceIdentity }),
      },
    });
    if (execution.error) throw execution.error;
    return { ...execution, result: parseTransferResult(execution.stdout), trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectBlockedBeforeTargetWrites(execution: ReturnType<typeof execute>) {
  expect(execution.status).not.toBe(0);
  expect(execution.result?.ok).not.toBe(true);
  expect(execution.trace.filter((entry) => entry.startsWith('write:') || entry === 'restore')).toEqual([]);
}

const unknownIdentities = [
  { label: 'empty identity', identity: '', exit: 0 },
  { label: 'malformed identity', identity: 'unknown:database', exit: 0 },
  { label: 'invalid database-name encoding', identity: '123456789:xyz', exit: 0 },
  { label: 'multiple identity rows', identity: `${sourceIdentity}\n${otherClusterIdentity}`, exit: 0 },
  { label: 'failed identity query', identity: sourceIdentity, exit: 3 },
];

describe('direct copy database identity boundary', () => {
  it('rejects the same actual database despite different URL, endpoint and login strings', () => {
    const execution = execute(databaseTransferScript(), { targetIdentity: sourceIdentity });
    expectBlockedBeforeTargetWrites(execution);
    expect(execution.trace).toContain('identity:source');
    expect(execution.trace).toContain('identity:target');
  });

  describe.each(['source', 'target'] as const)('%s identity', (side) => {
    it.each(unknownIdentities)('rejects $label before target writes', ({ identity, exit }) => {
      const execution = execute(databaseTransferScript(), side === 'source'
        ? { sourceIdentity: identity, sourceIdentityExit: exit }
        : { targetIdentity: identity, targetIdentityExit: exit });
      expectBlockedBeforeTargetWrites(execution);
    });
  });

  it.each([
    { label: 'another cluster with the same database name', targetIdentity: otherClusterIdentity },
    { label: 'another database on the same cluster', targetIdentity: otherDatabaseIdentity },
  ])('copies to $label', ({ targetIdentity }) => {
    const execution = execute(databaseTransferScript(), { targetIdentity });
    expect(execution.status).toBe(0);
    expect(execution.result).toMatchObject({ ok: true, source: { totalRows: '1' }, target: { totalRows: '1' } });
    expect(execution.trace).toContain('write:target');
    expect(execution.trace).toContain('restore');
    expect(execution.trace).not.toContain('write:source');
  });

  it('completes identity checks and the dump before starting target writes', () => {
    const execution = execute(databaseTransferScript());
    expect(execution.status).toBe(0);
    expect(execution.trace).toContain('identity:source');
    expect(execution.trace).toContain('identity:target');
    expect(execution.trace.indexOf('identity:source')).toBeLessThan(execution.trace.indexOf('write:target'));
    expect(execution.trace.indexOf('identity:target')).toBeLessThan(execution.trace.indexOf('write:target'));
    expect(execution.trace.indexOf('dump')).toBeLessThan(execution.trace.indexOf('write:target'));
    expect(execution.trace.indexOf('write:target')).toBeLessThan(execution.trace.indexOf('restore'));
  });

  it('does not drop target objects or restore a partial archive when pg_dump fails', () => {
    const execution = execute(databaseTransferScript(), { dumpExit: 7 });
    expectBlockedBeforeTargetWrites(execution);
    expect(execution.trace).toContain('dump');
    expect(execution.result).toMatchObject({ ok: false, error: expect.stringContaining('pg_dump exit 7') });
  });
});

describe('private-network export source identity', () => {
  it('carries the observed source identity with the successfully uploaded archive', () => {
    const execution = execute(databaseExportScript());
    expect(execution.status).toBe(0);
    expect(execution.result).toMatchObject({ ok: true, sourceIdentity, source: { totalRows: '1' } });
    expect(execution.trace).toContain('identity:source');
    expect(execution.trace.indexOf('identity:source')).toBeLessThan(execution.trace.indexOf('dump'));
    expect(execution.trace.indexOf('dump')).toBeLessThan(execution.trace.indexOf('upload'));
  });

  it.each(unknownIdentities)('does not export with $label', ({ identity, exit }) => {
    const execution = execute(databaseExportScript(), { sourceIdentity: identity, sourceIdentityExit: exit });
    expect(execution.status).not.toBe(0);
    expect(execution.result?.ok).not.toBe(true);
    expect(execution.trace).not.toContain('dump');
    expect(execution.trace).not.toContain('upload');
  });
});

describe('private-network restore database identity boundary', () => {
  it('rejects the exported source identity when it is the actual target identity', () => {
    const execution = execute(databaseRestoreScript(), { exportedSourceIdentity: sourceIdentity, targetIdentity: sourceIdentity });
    expectBlockedBeforeTargetWrites(execution);
    expect(execution.trace).toContain('identity:target');
  });

  it.each([
    { label: 'missing', identity: undefined },
    { label: 'empty', identity: '' },
    { label: 'malformed', identity: 'not-a-database-identity' },
  ])('rejects a $label exported source identity before ALTER, DROP or restore', ({ identity }) => {
    expectBlockedBeforeTargetWrites(execute(databaseRestoreScript(), { exportedSourceIdentity: identity }));
  });

  it.each(unknownIdentities)('rejects target $label before ALTER, DROP or restore', ({ identity, exit }) => {
    expectBlockedBeforeTargetWrites(execute(databaseRestoreScript(), {
      exportedSourceIdentity: sourceIdentity, targetIdentity: identity, targetIdentityExit: exit,
    }));
  });

  it('restores the archive only after establishing a different target identity', () => {
    const execution = execute(databaseRestoreScript(), { exportedSourceIdentity: sourceIdentity });
    expect(execution.status).toBe(0);
    expect(execution.result).toMatchObject({ ok: true, target: { totalRows: '1' } });
    expect(execution.trace).toContain('write:target');
    expect(execution.trace).toContain('restore');
    expect(execution.trace.indexOf('write:target')).toBeLessThan(execution.trace.indexOf('restore'));
  });
});
