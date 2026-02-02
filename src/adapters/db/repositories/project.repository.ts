import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Project, CreateProjectInput } from '../../../domain/entities/project.entity.js';

export class ProjectRepository {
  create(input: CreateProjectInput): Project {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projects (id, name, default_platform, git_remote_url, policies, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.defaultPlatform ?? 'railway',
      input.gitRemoteUrl ?? null,
      JSON.stringify(input.policies ?? {}),
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Project | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByName(name: string): Project | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findAll(): Project[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByGitRemoteUrl(url: string): Project | null {
    const normalized = normalizeGitUrl(url);
    const all = this.findAll();
    return all.find((p) => p.gitRemoteUrl && normalizeGitUrl(p.gitRemoteUrl) === normalized) ?? null;
  }

  update(id: string, updates: Partial<CreateProjectInput>): Project | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects
      SET name = ?, default_platform = ?, git_remote_url = ?, policies = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? existing.name,
      updates.defaultPlatform ?? existing.defaultPlatform,
      updates.gitRemoteUrl !== undefined ? updates.gitRemoteUrl : (existing.gitRemoteUrl ?? null),
      JSON.stringify(updates.policies ?? existing.policies),
      now,
      id
    );

    return this.findById(id);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      defaultPlatform: row.default_platform as string,
      gitRemoteUrl: (row.git_remote_url as string) ?? undefined,
      policies: JSON.parse(row.policies as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

/**
 * Normalize a git URL to a canonical form for comparison.
 * Handles git@, https://, trailing .git, trailing slashes, case.
 */
function normalizeGitUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  // Convert git@host:org/repo to host/org/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // Strip protocol
    normalized = normalized.replace(/^https?:\/\//, '');
  }
  // Strip .git suffix and trailing slashes
  normalized = normalized.replace(/\.git$/, '').replace(/\/+$/, '');
  return normalized;
}
