import { getDb } from '../adapters/db/sqlite.adapter.js';
import type { CommandContext } from './context.js';
import type { MigrateResult } from './migrate.js';

type Verification = Extract<MigrateResult, { status: 'verified' | 'differs' } | { status: 'blocked' }>;

/** Store the outcome of this read-only comparison without retaining provider payloads or object names. */
export function saveMigrationVerification(ctx: CommandContext, projectId: string, from: string, to: string, result: Verification) {
  const environment = ctx.repos.environments.findByProjectAndName(projectId, to);
  if (!environment) return;
  const database = result.status !== 'blocked' && result.database;
  return getDb().transaction(() => {
    const run = ctx.repos.runs.create({ projectId, environmentId: environment.id, type: 'migration-verification',
      plan: { kind: 'migration-verification', sourceEnvironment: from, targetEnvironment: to, outcome: result.status,
        ...(database && { tables: database.tables, rows: database.rows, databaseMatched: database.match }),
        ...(result.status !== 'blocked' && { checkedBuckets: result.storage.length, matchedBuckets: result.storage.filter(bucket => bucket.match).length }) } });
    ctx.repos.runs.updateStatus(run.id, result.status === 'verified' ? 'succeeded' : result.status === 'differs' ? 'failed' : 'blocked');
    return run.id;
  })();
}
