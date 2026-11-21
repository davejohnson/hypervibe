import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function setupDataDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** All inputs come from the original native record, including material omitted from its public report. */
export function reviewDigest(kind: 'run' | 'setup' | 'probe', projectId: string, targetId: string, planId: string, plan: unknown): string {
  return setupDataDigest(['hypervibe-review-v1', kind, projectId, targetId, planId, plan]);
}

/** SQLite may access companion files even on a read-only connection. */
export function regularReviewDatabase(file: string): boolean {
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const stat = fs.lstatSync(file + suffix, { throwIfNoEntry: false });
    if (!stat && !suffix) return false;
    if (stat && !stat.isFile()) throw new Error('The local review database must use regular files.');
  }
  return true;
}

type SetupStatus = 'running' | 'applied' | 'failed';
interface SetupExecution {
  projectId: string;
  targetId: string;
  planId: string;
  digest: string;
  status: SetupStatus;
  updatedAt: string;
}

function journal(dataDir: string, write: boolean): Database.Database | undefined {
  const root = fs.lstatSync(dataDir, { throwIfNoEntry: false });
  if (!root && !write) return;
  if (!root?.isDirectory()) throw new Error('The local review directory is unavailable.');
  const file = path.join(dataDir, 'local-reviews.sqlite');
  if (!regularReviewDatabase(file)) {
    if (!write) return;
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!regularReviewDatabase(file)) throw new Error('The local review database is unavailable.');
  }
  const db = new Database(file, { readonly: !write, fileMustExist: true });
  if (write) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS approvals (
        planId TEXT NOT NULL, digest TEXT NOT NULL, displayDigest TEXT NOT NULL, approvedAt TEXT NOT NULL, PRIMARY KEY (planId, digest)
      );
      CREATE TABLE IF NOT EXISTS setup_history (
        projectId TEXT NOT NULL, targetId TEXT NOT NULL, planId TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (projectId, targetId, planId, digest)
      );`);
    } catch (error) { db.close(); throw error; }
  }
  return db;
}

export function readReviewApproval(dataDir: string, planId: string, digest: string): {approvedAt: string} | undefined {
  const db = journal(dataDir, false);
  try {
    return db?.prepare('SELECT approvedAt FROM approvals WHERE planId=? AND digest=?').get(planId, digest) as {approvedAt:string} | undefined;
  } finally { db?.close(); }
}

export function readReviewHistory(dataDir: string) {
  const db = journal(dataDir, false);
  try {
    const approvals = (db?.prepare('SELECT planId,digest,displayDigest,approvedAt FROM approvals').all() ?? []) as {planId:string; digest:string; displayDigest:string; approvedAt:string}[];
    const setups = (db?.prepare('SELECT * FROM setup_history').all() ?? []) as SetupExecution[];
    return { approvals, setups };
  } finally { db?.close(); }
}

/** The only browser write. Re-read eligibility while serializing duplicate submissions. */
export function recordReviewApproval(dataDir: string, planId: string, digest: string, displayDigest: string, verify: () => boolean): void {
  const db = journal(dataDir, true)!;
  try {
    db.transaction(() => {
      if (!verify()) throw new Error('This plan changed or is no longer awaiting approval. Open its current review.');
      db.prepare('INSERT OR IGNORE INTO approvals (planId,digest,displayDigest,approvedAt) VALUES (?,?,?,?)')
        .run(planId, digest, displayDigest, new Date().toISOString());
    }).immediate();
  } finally { db.close(); }
}

/** Written only by the setup executor after validating the exact saved setup plan. */
export function recordSetupReviewExecution(dataDir: string, projectId: string, targetId: string, planId: string, digest: string, status: SetupStatus): void {
  const db = journal(dataDir, true)!;
  try {
    db.prepare(`INSERT INTO setup_history (projectId,targetId,planId,digest,status,updatedAt) VALUES (?,?,?,?,?,?)
      ON CONFLICT (projectId,targetId,planId,digest) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt`)
      .run(projectId, targetId, planId, digest, status, new Date().toISOString());
  } finally { db.close(); }
}
