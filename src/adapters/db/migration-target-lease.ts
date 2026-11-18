import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePrivateDirectory, hardenPrivateFile } from '../storage/paths.js';
import { getDb } from './sqlite.adapter.js';
import type { TransferResources } from '../providers/gcp/gcp-data.client.js';

/**
 * One controller in this Hypervibe installation may operate a migration target at a
 * time. A dedicated SQLite file lets unrelated environments and ordinary state writes
 * proceed. EXCLUSIVE locking_mode retains the OS lock across committed checkpoints
 * and releases it when the process exits, including on a crash.
 */
export function acquireMigrationTargetLease(projectId: string, target: string) {
  const directory = path.join(path.dirname(getDb().name), 'migration-targets');
  ensurePrivateDirectory(directory);
  const scope = createHash('sha256').update(JSON.stringify([projectId, target])).digest('hex');
  const file = path.join(directory, scope + '.db');
  hardenPrivateFile(file);
  const db = new Database(file, { timeout: 0 });
  try {
    hardenPrivateFile(file);
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK (id = 1), resources TEXT NOT NULL)');
    db.exec('COMMIT');
    const pending = (): TransferResources | undefined => {
      const row = db.prepare('SELECT resources FROM pending WHERE id = 1').get() as { resources: string } | undefined;
      return row ? JSON.parse(row.resources) as TransferResources : undefined;
    };
    return {
      pending,
      record(resources: TransferResources | null) {
        if (resources === null) {
          db.prepare('DELETE FROM pending WHERE id = 1').run();
          return;
        }
        // Under the exclusive lock, the only allowed refinement is learning the
        // immutable UID of the job this attempt created.
        const previous = pending();
        if (previous && !isDeepStrictEqual(
          { ...previous, jobUid: previous.jobUid ?? resources.jobUid }, { ...resources, jobUid: resources.jobUid },
        )) {
          throw new Error('An earlier transfer still has outstanding cleanup.');
        }
        db.prepare('INSERT OR REPLACE INTO pending (id, resources) VALUES (1, ?)').run(JSON.stringify(resources));
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    if (error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY') return undefined;
    throw error;
  }
}

export type MigrationTargetLease = NonNullable<ReturnType<typeof acquireMigrationTargetLease>>;
