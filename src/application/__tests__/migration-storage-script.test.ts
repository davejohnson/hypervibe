import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTransferResult, storageCheckScript, storageTransferScript } from '../migration-transfer-gcp.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-rclone-check-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe.each([['verify', storageCheckScript], ['copy', storageTransferScript]] as const)('%s file evidence', (_operation, script) => {
  function run(check: string) {
    writeFileSync(path.join(directory, 'rclone'), [
      '#!/bin/sh', 'case "$1" in',
      'sync) exit 0 ;;',
      `check) printf '%s\\n' "$@" > check-arguments; ${check} ;;`,
      'size) printf \'{"count":1,"bytes":3}\\n\' ;;',
      '*) exit 2 ;;', 'esac',
    ].join('\n'), { mode: 0o700 });
    const result = spawnSync('/bin/sh', ['-c', script().replaceAll('/tmp/', `"${directory}"/`)], {
      cwd: directory, encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`, SOURCE_BUCKET: 'source', TARGET_BUCKET: 'target' },
    });
    return parseTransferResult(result.stdout);
  }

  it('cannot return a match after the verifier exits without any diagnostic', () => {
    expect(run('kill -TERM $$')).not.toMatchObject({ ok: true, differences: 0 });
  });

  it('uses the two-sided downloaded byte comparison even with no common object hash', () => {
    // rclone check --download streams both sides; --one-way would miss additional target keys.
    // https://rclone.org/commands/rclone_check/
    const checked = run([
      'case " $* " in *" --one-way "*) exit 2 ;; esac',
      'case " $* " in *" --download "*) exit 0 ;; *) exit 2 ;; esac',
    ].join('\n'));
    expect(checked).toMatchObject({ ok: true, differences: 0 });
    const args = readFileSync(path.join(directory, 'check-arguments'), 'utf8').split('\n');
    expect(args).toContain('--download');
    expect(args).not.toContain('--one-way');
  });
});
