import { isDeepStrictEqual } from 'node:util';
import { getDb } from '../sqlite.adapter.js';
import type { CloudInstallationEvidence } from '../../../domain/ports/cloud-installation.port.js';

interface JournalRecord {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  intent: { appId: string; environment: string };
  plan: unknown;
  status: string;
  attempts: Array<{ id: string; actionId?: string; status?: string; evidence?: CloudInstallationEvidence }>;
  completed?: Record<string, unknown>;
}
interface Scope { projectId: string; environmentId: string; environmentName: string }
interface Row { id: string; plan: string }
const TYPE = 'cloud-scope-preparation';
const HISTORY_LIMIT = 100;
const invalid = () => new Error('Cloud scope preparation journal is invalid; preserve the retained state.');
const historyFull = () => new Error('Cloud scope preparation history exceeds the safe inspection limit; preserve it for explicit review.');

function retainsAttempt(previous: JournalRecord['attempts'][number], next: JournalRecord['attempts'][number] | undefined): boolean {
  if (!next || next.id !== previous.id || next.actionId !== previous.actionId) return false;
  if (previous.status === 'succeeded') return next.status === 'succeeded' && isDeepStrictEqual(previous.evidence, next.evidence);
  if (previous.status !== 'attempted' && next.status === 'attempted') return false;
  if (!previous.evidence) return true;
  // Acknowledgment may gain terminal proof, but its operation identity and
  // already observed native resources cannot be forgotten or substituted.
  return !!next.evidence && previous.evidence.resources.every((resource, index) => isDeepStrictEqual(resource, next.evidence!.resources[index]))
    && Object.entries(previous.evidence.native).every(([key, value]) => isDeepStrictEqual(value, next.evidence!.native[key]));
}

/** Nonsecret operation history in existing runs; no new schema or credential store. */
export class CloudScopePreparationRepository<T extends JournalRecord> {
  private readonly scope: Scope;
  constructor(scope: Scope, private readonly parseRecord: (value: unknown) => T) { this.scope = { ...scope }; }

  private assertScope(): void {
    const row = getDb().prepare('SELECT project_id, name FROM environments WHERE id = ?').get(this.scope.environmentId) as
      { project_id: string; name: string } | undefined;
    if (!row || row.project_id !== this.scope.projectId || row.name !== this.scope.environmentName)
      throw new Error('Cloud scope preparation requires the exact local project and environment scope.');
  }

  private parse(value: unknown, id: string): T {
    try {
      const record = this.parseRecord(value);
      if (record.schemaVersion !== 1 || record.installationId !== id
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || record.intent.appId !== this.scope.projectId || record.intent.environment !== this.scope.environmentName
        || !Array.isArray(record.attempts) || JSON.stringify(record).length > 1_000_000) throw invalid();
      return record;
    } catch { throw invalid(); }
  }

  private fromRow(row: Row): T {
    try { if (row.plan.length > 1_000_000) throw invalid(); return this.parse(JSON.parse(row.plan), row.id); }
    catch { throw invalid(); }
  }

  private history(): T[] {
    const rows = getDb().prepare(`SELECT id, plan FROM runs WHERE project_id = ? AND environment_id = ? AND type = ?
      ORDER BY created_at, id LIMIT ?`).all(this.scope.projectId, this.scope.environmentId, TYPE, HISTORY_LIMIT + 1) as Row[];
    if (rows.length > HISTORY_LIMIT) throw historyFull();
    return rows.map(row => this.fromRow(row));
  }

  async read(installationId: string): Promise<T | null> {
    this.assertScope();
    const row = getDb().prepare('SELECT id, plan FROM runs WHERE id = ? AND project_id = ? AND environment_id = ? AND type = ?')
      .get(installationId, this.scope.projectId, this.scope.environmentId, TYPE) as Row | undefined;
    return row ? this.fromRow(row) : null;
  }

  async findByScope(): Promise<T[]> { this.assertScope(); return this.history(); }

  async compareAndSwap(installationId: string, expectedRevision: number | null, value: T): Promise<boolean> {
    const next = this.parse(value, installationId);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      || next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw invalid();
    if (expectedRevision === null && (next.attempts.length || Object.keys(next.completed ?? {}).length
      || !['review-required', 'blocked'].includes(next.status))) throw invalid();
    const db = getDb();
    return db.transaction(() => {
      this.assertScope();
      const history = this.history();
      const anyRow = db.prepare('SELECT id, project_id, environment_id, type, plan FROM runs WHERE id = ?').get(installationId) as
        (Row & { project_id: string; environment_id: string; type: string }) | undefined;
      if (expectedRevision === null ? !!anyRow : !anyRow) return false;
      if (anyRow && (anyRow.project_id !== this.scope.projectId || anyRow.environment_id !== this.scope.environmentId || anyRow.type !== TYPE)) return false;
      if (!anyRow && history.length >= HISTORY_LIMIT) throw historyFull();
      const current = anyRow ? this.fromRow(anyRow) : undefined;
      if (current && current.revision !== expectedRevision) return false;
      if (current && (!isDeepStrictEqual(current.intent, next.intent) || !isDeepStrictEqual(current.plan, next.plan)
        || next.attempts.length < current.attempts.length
        || current.attempts.some((attempt, index) => !retainsAttempt(attempt, next.attempts[index]))
        || Object.entries(current.completed ?? {}).some(([key, proof]) => !isDeepStrictEqual(next.completed?.[key], proof)
          // Current readiness may be invalidated; historical ownership proof
          // must remain on the same immutable succeeded native attempt.
          && (Object.hasOwn(next.completed ?? {}, key) || !next.attempts.some(attempt => attempt.actionId === key
            && attempt.status === 'succeeded' && isDeepStrictEqual(attempt.evidence, proof)))))) throw invalid();
      // A stale sibling proposal cannot allocate another project or erase an
      // accepted allocation. Source edits and terminal status do not reset it.
      if (history.some(record => record.installationId !== installationId && record.attempts.length > 0)) return false;
      const status = next.status === 'scope-ready' ? 'succeeded' : next.status === 'blocked' ? 'blocked' : 'pending';
      const serialized = JSON.stringify(next);
      if (!current) {
        db.prepare('INSERT INTO runs (id, project_id, environment_id, type, status, plan, receipts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(installationId, this.scope.projectId, this.scope.environmentId, TYPE, status, serialized, '[]', new Date().toISOString());
      } else {
        const update = db.prepare('UPDATE runs SET plan = ?, status = ? WHERE id = ? AND project_id = ? AND environment_id = ? AND type = ? AND plan = ?')
          .run(serialized, status, installationId, this.scope.projectId, this.scope.environmentId, TYPE, anyRow!.plan);
        if (update.changes !== 1) return false;
      }
      return true;
    }).immediate();
  }
}
