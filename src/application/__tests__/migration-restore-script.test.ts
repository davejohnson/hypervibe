import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseRestoreScript, databaseTransferScript, manifestsMatch, parseTransferResult } from '../migration-transfer-gcp.js';

const manifest = { tables: { 'public.invoices': '1:42' }, totalRows: '1', version: '160000' };
const privateDiagnostic = 'private-customer-row-value';

/**
 * Execute the emitted shell, replacing only command transport and temporary
 * paths. pg_restore's nonzero exit is the PostgreSQL failure contract; the
 * independent table fixture deliberately cannot reveal a missing schema object.
 */
function executeRestore(script: string, restoreExit: number, diagnostic: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-restore-script-'));
  const tools: Record<string, string> = {
    psql: `
      case "$*" in
        *pg_control_system*)
          if [ "$1" = source ]; then printf '101:736f75726365\\n'; else printf '202:746172676574\\n'; fi ;;
        *information_schema.tables*)
          printf 'manifest:%s\\n' "$1" >> "$TEST_TRACE"
          printf 'public.invoices|1:42\\n' ;;
        *server_version_num*) printf '160000\\n' ;;
        *current_user*) printf 'app_owner\\n' ;;
        *) : ;;
      esac`,
    pg_dump: 'printf "synthetic custom archive\\n"',
    pg_restore: `
      printf 'restore\\n' >> "$TEST_TRACE"
      if [ -n "$TEST_DIAGNOSTIC" ]; then printf '%s\\n' "$TEST_DIAGNOSTIC" >&2; fi
      exit "$TEST_RESTORE_EXIT"`,
    curl: ':',
    apk: ':',
  };
  try {
    for (const [name, body] of Object.entries(tools)) writeFileSync(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    const trace = path.join(directory, 'trace');
    writeFileSync(trace, '');
    // The production container owns /tmp. Keep tests isolated from that shared
    // host directory without changing the generated program's control flow.
    const isolated = script.replaceAll('/tmp/', '"${TEST_DIRECTORY}"/');
    const execution = spawnSync('bash', ['-c', isolated], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        SOURCE_DATABASE_URL: 'source', DATABASE_URL: 'target', DUMP_URL: 'https://fixture.invalid/dump',
        SOURCE_DATABASE_IDENTITY: '101:736f75726365',
        TEST_DIRECTORY: directory, TEST_TRACE: trace, TEST_RESTORE_EXIT: String(restoreExit), TEST_DIAGNOSTIC: diagnostic,
      },
      timeout: 10_000,
    });
    if (execution.error) throw execution.error;
    return { ...execution, result: parseTransferResult(execution.stdout), trace: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.each([
  { name: 'direct database transfer', script: databaseTransferScript },
  { name: 'private-network database restore', script: databaseRestoreScript },
])('$name schema-restore outcome', ({ script }) => {
  it.each([
    { diagnostic: `pg_restore: error: could not execute query: ERROR: permission denied; ${privateDiagnostic}`, label: 'schema error' },
    { diagnostic: `pg_restore: fatal restore failure; ${privateDiagnostic}`, label: 'failure without an error-count marker' },
    { diagnostic: '', label: 'failure without diagnostics' },
  ])('rejects $label even when source and target table manifests match', ({ diagnostic }) => {
    // Table equality alone cannot prove schema restoration: both fixtures have
    // the same row but the restore process failed to recreate a schema object.
    expect(manifestsMatch(manifest, { ...manifest })).toEqual({ match: true, differences: [] });
    const execution = executeRestore(script(), 1, diagnostic);
    expect(execution.status).not.toBe(0);
    expect(execution.result).toMatchObject({ ok: false, error: expect.stringContaining('pg_restore exit 1') });
    expect(execution.result).not.toHaveProperty('target');
    expect(execution.trace).toContain('restore\n');
    expect(execution.trace).not.toContain('manifest:target');
    expect(execution.stdout + execution.stderr).not.toContain(privateDiagnostic);
  });

  it('preserves successful restoration and matching table evidence', () => {
    const execution = executeRestore(script(), 0, '');
    expect(execution.status).toBe(0);
    expect(execution.result).toMatchObject({ ok: true, target: manifest, restoreWarnings: 0 });
    expect(execution.trace).toContain('manifest:target');
  });
});
