import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { acquireMigrationTargetLease } from '../migration-target-lease.js';
import { SqliteAdapter } from '../sqlite.adapter.js';

it('retains the native identity across controller exit and excludes another process during its transaction', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-target-lease-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  const saved = { gcpProjectId: 'fixture-project', region: 'us-central1', jobId: 'hv-migrate-database-fixture', secretIds: [], ownershipToken: 'fixture-owner' };
  const lease = acquireMigrationTargetLease('project', 'preview')!;
  try {
    lease.record(saved);
    lease.record({ ...saved, jobUid: 'native-uid' });
    expect(() => lease.record({ ...saved, jobId: 'another-job' })).toThrow();
    expect(() => lease.record({ ...saved, jobUid: 'replacement-uid' })).toThrow();
  } finally { lease.close(); }

  // A separate native SQLite connection in another OS process can hold the
  // same destination file across commits. Its exit releases the lock.
  const journalDirectory = path.join(directory, 'migration-targets');
  const file = readdirSync(journalDirectory).find(name => name.endsWith('.db'))!;
  const child = spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT');
    process.send('locked');
    process.on('message', () => process.exit(0));
  `, createRequire(import.meta.url).resolve('better-sqlite3'), path.join(journalDirectory, file)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before locking'); })]);
    expect(acquireMigrationTargetLease('project', 'preview')).toBeUndefined();
    const other = acquireMigrationTargetLease('project', 'other');
    expect(other).toBeDefined();
    other!.close();
    child.send('exit');
    await exited;
    const resumed = acquireMigrationTargetLease('project', 'preview')!;
    try {
      expect(resumed.pending()).toEqual({ ...saved, jobUid: 'native-uid' });
      resumed.record(null);
      expect(resumed.pending()).toBeUndefined();
    } finally { resumed.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  }
});
