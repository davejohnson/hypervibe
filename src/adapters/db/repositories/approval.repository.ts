import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Approval, ApprovalStatus, CreateApprovalInput } from '../../../domain/entities/approval.entity.js';

export class ApprovalRepository {
  create(input: CreateApprovalInput): Approval {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO approvals (
        id,
        project_id,
        environment_name,
        action,
        status,
        requested_by,
        approved_by,
        rejected_by,
        reason,
        payload,
        expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.environmentName,
      input.action,
      'pending',
      input.requestedBy ?? 'system',
      null,
      null,
      input.reason ?? null,
      JSON.stringify(input.payload ?? {}),
      input.expiresAt ? input.expiresAt.toISOString() : null,
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Approval | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProject(projectId: string, limit = 50): Approval[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM approvals
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  findPending(projectId?: string, limit = 50): Approval[] {
    const db = getDb();
    const rows = projectId
      ? (db.prepare(`
          SELECT * FROM approvals WHERE project_id = ? AND status = 'pending'
          ORDER BY created_at DESC LIMIT ?
        `).all(projectId, limit) as Record<string, unknown>[])
      : (db.prepare(`
          SELECT * FROM approvals WHERE status = 'pending'
          ORDER BY created_at DESC LIMIT ?
        `).all(limit) as Record<string, unknown>[]);
    return rows.map((r) => this.mapRow(r));
  }

  approve(id: string, approvedBy: string): Approval | null {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE approvals
      SET status = 'approved', approved_by = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(approvedBy, now, id);
    return this.findById(id);
  }

  reject(id: string, rejectedBy: string, reason?: string): Approval | null {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE approvals
      SET status = 'rejected', rejected_by = ?, reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(rejectedBy, reason ?? null, now, id);
    return this.findById(id);
  }

  cancel(id: string, cancelledBy: string, reason?: string): Approval | null {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE approvals
      SET status = 'cancelled', reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'approved')
    `).run(reason ?? `Cancelled by ${cancelledBy}`, now, id);
    return this.findById(id);
  }

  consume(id: string): Approval | null {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE approvals
      SET status = 'consumed', updated_at = ?
      WHERE id = ? AND status = 'approved'
    `).run(now, id);
    return this.findById(id);
  }

  validateForAction(id: string, projectId: string, environmentName: string, action: string): { ok: true; approval: Approval } | { ok: false; error: string } {
    const approval = this.findById(id);
    if (!approval) return { ok: false, error: `Approval not found: ${id}` };

    if (approval.projectId !== projectId) return { ok: false, error: 'Approval does not match project' };
    if (approval.environmentName.toLowerCase() !== environmentName.toLowerCase()) return { ok: false, error: 'Approval does not match environment' };
    if (approval.action !== action) return { ok: false, error: `Approval action mismatch (expected ${action}, got ${approval.action})` };

    if (approval.status !== 'approved') return { ok: false, error: `Approval is not approved (status: ${approval.status})` };

    if (approval.expiresAt && new Date() > approval.expiresAt) return { ok: false, error: 'Approval is expired' };

    return { ok: true, approval };
  }

  private mapRow(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      environmentName: row.environment_name as string,
      action: row.action as string,
      status: row.status as ApprovalStatus,
      requestedBy: row.requested_by as string,
      approvedBy: (row.approved_by as string) ?? null,
      rejectedBy: (row.rejected_by as string) ?? null,
      reason: (row.reason as string) ?? null,
      payload: JSON.parse((row.payload as string) ?? '{}'),
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

