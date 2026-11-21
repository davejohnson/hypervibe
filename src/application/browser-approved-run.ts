import path from 'node:path';
import type { Run } from '../domain/entities/run.entity.js';
import { SqliteAdapter } from '../adapters/db/sqlite.adapter.js';
import { getDataDir } from '../adapters/storage/paths.js';
import { LocalReviewCatalog } from '../adapters/storage/local-review-catalog.js';
import { readReviewApproval, reviewDigest } from '../adapters/storage/review-authorization.js';

/** Only records that belong to the same on-disk profile as the browser can carry its approval. */
export function localReviewProfile(): string | undefined {
  const db = SqliteAdapter.currentDatabase();
  const dataDir = path.resolve(getDataDir());
  if (db && !db.memory && path.resolve(db.name) === path.join(dataDir, 'hypervibe.db')) return dataDir;
}

export function browserApprovedRunActions(run: Run, projectId: string): string[] | undefined {
  if (run.projectId !== projectId || run.type !== 'plan') return;
  const dataDir = localReviewProfile();
  if (!dataDir) return;
  const digest = reviewDigest('run', projectId, run.environmentId, run.id, run.plan);
  if (!readReviewApproval(dataDir, run.id, digest)) return;
  const artifact = new LocalReviewCatalog(dataDir).get(run.id);
  if (artifact?.approval?.digest !== digest || !artifact.approval.approvedAt) return;
  return artifact.report?.actions.filter(action => action.requiresConfirm).map(action => action.id);
}
