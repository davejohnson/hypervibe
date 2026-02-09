import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type {
  SecretMapping,
  CreateSecretMappingInput,
  SecretAccessLog,
  CreateSecretAccessLogInput,
} from '../../../domain/entities/secret-mapping.entity.js';
import type { SecretManagerProvider } from '../../../domain/ports/secretmanager.port.js';

export class SecretMappingRepository {
  create(input: CreateSecretMappingInput): SecretMapping {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const environments = JSON.stringify(input.environments ?? []);
    const serviceName = input.serviceName ?? null;

    db.prepare(`
      INSERT INTO secret_mappings (id, project_id, env_var, secret_ref, environments, service_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.envVar,
      input.secretRef,
      environments,
      serviceName,
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): SecretMapping | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM secret_mappings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProjectId(projectId: string): SecretMapping[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM secret_mappings WHERE project_id = ? ORDER BY env_var').all(projectId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find mappings for a specific environment.
   * Returns mappings where environments array is empty (applies to all) or contains the specified environment.
   */
  findByProjectAndEnvironment(projectId: string, environmentName: string): SecretMapping[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_mappings
      WHERE project_id = ?
      AND (environments = '[]' OR environments LIKE ?)
      ORDER BY env_var
    `).all(projectId, `%"${environmentName}"%`) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find mappings for a specific service and environment.
   */
  findByProjectEnvironmentAndService(
    projectId: string,
    environmentName: string,
    serviceName: string | null
  ): SecretMapping[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_mappings
      WHERE project_id = ?
      AND (environments = '[]' OR environments LIKE ?)
      AND (service_name IS NULL OR service_name = ?)
      ORDER BY env_var
    `).all(projectId, `%"${environmentName}"%`, serviceName) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find all mappings that reference a specific secret path.
   * Used for rotation to find all affected mappings.
   */
  findBySecretRef(secretRef: string): SecretMapping[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM secret_mappings WHERE secret_ref = ? ORDER BY project_id, env_var').all(secretRef) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find mappings by secret path prefix.
   * Useful for finding all mappings for a secret path regardless of key/version.
   */
  findBySecretPathPrefix(pathPrefix: string): SecretMapping[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM secret_mappings WHERE secret_ref LIKE ? ORDER BY project_id, env_var').all(`%://${pathPrefix}%`) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  update(id: string, updates: Partial<Pick<SecretMapping, 'secretRef' | 'environments' | 'serviceName'>>): SecretMapping | null {
    const db = getDb();
    const now = new Date().toISOString();
    const existing = this.findById(id);
    if (!existing) return null;

    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.secretRef !== undefined) {
      fields.push('secret_ref = ?');
      values.push(updates.secretRef);
    }
    if (updates.environments !== undefined) {
      fields.push('environments = ?');
      values.push(JSON.stringify(updates.environments));
    }
    if (updates.serviceName !== undefined) {
      fields.push('service_name = ?');
      values.push(updates.serviceName);
    }

    values.push(id);
    db.prepare(`UPDATE secret_mappings SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return this.findById(id);
  }

  /**
   * Upsert a mapping by project, envVar, and serviceName.
   */
  upsert(input: CreateSecretMappingInput): SecretMapping {
    const db = getDb();
    const serviceName = input.serviceName ?? null;

    let existing: Record<string, unknown> | undefined;
    if (serviceName === null) {
      existing = db.prepare(`
        SELECT * FROM secret_mappings
        WHERE project_id = ? AND env_var = ? AND service_name IS NULL
      `).get(input.projectId, input.envVar) as Record<string, unknown> | undefined;
    } else {
      existing = db.prepare(`
        SELECT * FROM secret_mappings
        WHERE project_id = ? AND env_var = ? AND service_name = ?
      `).get(input.projectId, input.envVar, serviceName) as Record<string, unknown> | undefined;
    }

    if (existing) {
      return this.update(existing.id as string, {
        secretRef: input.secretRef,
        environments: input.environments,
      })!;
    }

    return this.create(input);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM secret_mappings WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteByProjectAndEnvVar(projectId: string, envVar: string, serviceName?: string | null): boolean {
    const db = getDb();
    let result;

    if (serviceName === undefined) {
      result = db.prepare('DELETE FROM secret_mappings WHERE project_id = ? AND env_var = ?').run(projectId, envVar);
    } else if (serviceName === null) {
      result = db.prepare('DELETE FROM secret_mappings WHERE project_id = ? AND env_var = ? AND service_name IS NULL').run(projectId, envVar);
    } else {
      result = db.prepare('DELETE FROM secret_mappings WHERE project_id = ? AND env_var = ? AND service_name = ?').run(projectId, envVar, serviceName);
    }

    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): SecretMapping {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      envVar: row.env_var as string,
      secretRef: row.secret_ref as string,
      environments: JSON.parse(row.environments as string) as string[],
      serviceName: row.service_name as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

export class SecretAccessLogRepository {
  create(input: CreateSecretAccessLogInput): SecretAccessLog {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO secret_access_log (id, timestamp, action, provider, secret_path, project_id, environment_name, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      now,
      input.action,
      input.provider,
      input.secretPath,
      input.projectId ?? null,
      input.environmentName ?? null,
      input.success ? 1 : 0,
      input.error ?? null
    );

    return this.findById(id)!;
  }

  findById(id: string): SecretAccessLog | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM secret_access_log WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find recent access logs for a project.
   */
  findByProjectId(projectId: string, limit = 50): SecretAccessLog[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_access_log
      WHERE project_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(projectId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find access logs for a specific secret path.
   */
  findBySecretPath(secretPath: string, limit = 50): SecretAccessLog[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_access_log
      WHERE secret_path = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(secretPath, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find recent access logs across all secrets.
   */
  findRecent(limit = 50): SecretAccessLog[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_access_log
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find access logs by action type.
   */
  findByAction(action: SecretAccessLog['action'], limit = 50): SecretAccessLog[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_access_log
      WHERE action = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(action, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): SecretAccessLog {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as string),
      action: row.action as SecretAccessLog['action'],
      provider: row.provider as SecretManagerProvider,
      secretPath: row.secret_path as string,
      projectId: row.project_id as string | null,
      environmentName: row.environment_name as string | null,
      success: Boolean(row.success),
      error: row.error as string | null,
    };
  }
}
