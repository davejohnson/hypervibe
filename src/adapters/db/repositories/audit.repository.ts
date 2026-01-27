import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { AuditEvent, CreateAuditEventInput } from '../../../domain/entities/audit.entity.js';

export class AuditRepository {
  create(input: CreateAuditEventInput): AuditEvent {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO audit_events (id, timestamp, actor, action, resource_type, resource_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      now,
      input.actor ?? 'system',
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.details ?? {}),
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): AuditEvent | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByResource(resourceType: string, resourceId: string, limit = 100): AuditEvent[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM audit_events
      WHERE resource_type = ? AND resource_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(resourceType, resourceId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findRecent(limit = 100): AuditEvent[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByAction(action: string, limit = 100): AuditEvent[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY timestamp DESC LIMIT ?').all(action, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): AuditEvent {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as string),
      actor: row.actor as string,
      action: row.action as string,
      resourceType: row.resource_type as string,
      resourceId: row.resource_id as string,
      details: JSON.parse(row.details as string),
      createdAt: new Date(row.created_at as string),
    };
  }
}
