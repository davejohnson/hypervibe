import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { stateAddresses } from '../engine.js';
import { runTofu } from '../runner.js';

// #559: state that was cut off or cannot be parsed is no evidence. A missing
// address in it must never read as "the resource was deleted".
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-state-evidence-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function fakeBinary(bytes: number): string {
  const file = path.join(directory, `tofu-${bytes}`);
  fs.writeFileSync(file, `#!/bin/sh\nhead -c ${bytes} /dev/zero | tr '\\0' 'a'\n`, { mode: 0o755 });
  return file;
}

describe('engine output capture', () => {
  it('says when output was cut off at the capture limit', async () => {
    const result = await runTofu({ kind: 'show-state' }, { binary: fakeBinary(9 * 1024 * 1024), workingDirectory: directory, env: {}, redact: [] });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
  });
  it('does not flag output that fits', async () => {
    const result = await runTofu({ kind: 'show-state' }, { binary: fakeBinary(1024), workingDirectory: directory, env: {}, redact: [] });
    expect(result.stdout).toHaveLength(1024);
    expect(result.truncated).toBeUndefined();
  });
});

describe('state addresses', () => {
  const state = JSON.stringify({ values: { root_module: { resources: [{ address: 'google_sql_database_instance.db', mode: 'managed' }], child_modules: [{ resources: [{ address: 'module.x.google_storage_bucket.b', mode: 'managed', tainted: true }] }] } } });
  it('reads every managed address from complete state', () => {
    expect([...stateAddresses(state)!.entries()]).toEqual([['google_sql_database_instance.db', { tainted: false }], ['module.x.google_storage_bucket.b', { tainted: true }]]);
  });
  it('treats an empty state as no resources', () => {
    expect(stateAddresses('{"format_version":"1.0"}')!.size).toBe(0);
  });
  it.each([state.slice(0, 60), '', 'not json'])('gives no evidence for unreadable state %j', (json) => {
    expect(stateAddresses(json)).toBeUndefined();
  });
});
