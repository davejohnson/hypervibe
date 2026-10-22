import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../sqlite.adapter.js';

/** Preparation metadata only. Credential values and assessments never belong here. */
export const rotationWorkflowSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  projectGitRemoteUrl: z.string().min(1).optional(),
  mode: z.enum(['incident', 'routine']),
  specRevision: z.number().int().nonnegative(),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  recordedEnvironments: z.array(z.object({ name: z.string().min(1) }).strict()),
  connections: z.array(z.object({
    id: z.string().min(1),
    provider: z.string().min(1),
    scope: z.string().min(1).nullable(),
    status: z.enum(['pending', 'verified', 'failed']),
  }).strict()),
  createdAt: z.string().datetime(),
}).strict();

const prepareRotationSchema = rotationWorkflowSchema.omit({ id: true, createdAt: true });
export type RotationWorkflow = z.infer<typeof rotationWorkflowSchema>;
export type PrepareRotationInput = z.infer<typeof prepareRotationSchema>;

export class RotationRepository {
  /** Same reviewed snapshot returns its original ID, including across process retries. */
  prepare(input: PrepareRotationInput): { workflow: RotationWorkflow; created: boolean } {
    const parsed = prepareRotationSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid rotation workflow snapshot.');
    const snapshot = parsed.data;
    const db = getDb();
    return db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM rotation_workflows
        WHERE project_id = ? AND mode = ? AND spec_revision = ? AND scope_fingerprint = ?
      `).get(snapshot.projectId, snapshot.mode, snapshot.specRevision, snapshot.scopeFingerprint);
      if (existing) return { workflow: this.read(existing), created: false };

      const workflow: RotationWorkflow = { ...snapshot, id: randomUUID(), createdAt: new Date().toISOString() };
      db.prepare(`
        INSERT INTO rotation_workflows
          (id, project_id, mode, spec_revision, scope_fingerprint, recorded_environments, connections, created_at, project_git_remote_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(workflow.id, workflow.projectId, workflow.mode, workflow.specRevision, workflow.scopeFingerprint,
        JSON.stringify(workflow.recordedEnvironments), JSON.stringify(workflow.connections), workflow.createdAt,
        workflow.projectGitRemoteUrl ?? null);
      return { workflow, created: true };
    }).immediate();
  }

  getById(projectId: string, id: string): RotationWorkflow | null {
    const row = getDb().prepare('SELECT * FROM rotation_workflows WHERE project_id = ? AND id = ?').get(projectId, id);
    return row ? this.read(row) : null;
  }

  latest(projectId: string): RotationWorkflow | null {
    const row = getDb().prepare(`
      SELECT * FROM rotation_workflows WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(projectId);
    return row ? this.read(row) : null;
  }

  private read(raw: unknown): RotationWorkflow {
    try {
      const row = raw as Record<string, unknown>;
      return rotationWorkflowSchema.parse({
        id: row.id, projectId: row.project_id, mode: row.mode, specRevision: row.spec_revision,
        ...(row.project_git_remote_url != null ? { projectGitRemoteUrl: row.project_git_remote_url } : {}),
        scopeFingerprint: row.scope_fingerprint,
        recordedEnvironments: JSON.parse(String(row.recorded_environments)),
        connections: JSON.parse(String(row.connections)), createdAt: row.created_at,
      });
    } catch {
      // JSON and Zod errors can echo invalid stored fields; retain no rejected content.
      throw new Error('Cannot read rotation workflow: persisted snapshot is invalid.');
    }
  }
}
