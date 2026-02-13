import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDataDir } from '../storage/paths.js';

const DATA_DIR = getDataDir();

export interface Migration {
  version: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      -- Projects table
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        default_platform TEXT DEFAULT 'railway',
        policies TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Environments table
      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform_bindings TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, name)
      );

      -- Services table
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        build_config TEXT DEFAULT '{}',
        env_var_spec TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, name)
      );

      -- Components table (postgres, redis, etc.)
      CREATE TABLE IF NOT EXISTS components (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        bindings TEXT DEFAULT '{}',
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(environment_id, type)
      );

      -- Connections table (provider credentials)
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        credentials_encrypted TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider)
      );

      -- Runs table (deploy, migrate, rollback)
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        plan TEXT DEFAULT '{}',
        receipts TEXT DEFAULT '[]',
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Audit events table (append-only log)
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Migrations tracking table
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id);
      CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);
      CREATE INDEX IF NOT EXISTS idx_components_environment ON components(environment_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
      CREATE INDEX IF NOT EXISTS idx_runs_environment ON runs(environment_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_audit_events_resource ON audit_events(resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
    `,
  },
  {
    version: 2,
    name: 'integration_keys',
    up: `
      -- Integration keys table (stored encrypted, grouped by provider and mode)
      CREATE TABLE IF NOT EXISTS integration_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        keys_encrypted TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, mode)
      );

      CREATE INDEX IF NOT EXISTS idx_integration_keys_provider ON integration_keys(provider);
    `,
  },
  {
    version: 3,
    name: 'scoped_connections',
    up: `
      -- Add scope column to connections table for scoped tokens
      -- Scope allows fine-grained tokens for specific repos/domains with global fallback
      -- Examples: "davejohnson/hypervibe", "clientorg/*", "hypervibe.dev"

      -- Create new table with scope column and updated unique constraint
      CREATE TABLE IF NOT EXISTS connections_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        scope TEXT DEFAULT NULL,
        credentials_encrypted TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, scope)
      );

      -- Copy existing data (all existing connections become global with scope = NULL)
      INSERT INTO connections_new (id, provider, scope, credentials_encrypted, status, last_verified_at, created_at, updated_at)
      SELECT id, provider, NULL, credentials_encrypted, status, last_verified_at, created_at, updated_at
      FROM connections;

      -- Drop old table and rename new one
      DROP TABLE connections;
      ALTER TABLE connections_new RENAME TO connections;

      -- Create index for efficient scope lookups
      CREATE INDEX IF NOT EXISTS idx_connections_provider_scope ON connections(provider, scope);
    `,
  },
  {
    version: 4,
    name: 'project_git_remote',
    up: `
      ALTER TABLE projects ADD COLUMN git_remote_url TEXT;
    `,
  },
  {
    version: 5,
    name: 'secret_mappings',
    up: `
      -- Secret mappings: map env vars to secret manager references
      CREATE TABLE IF NOT EXISTS secret_mappings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        env_var TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        environments TEXT DEFAULT '[]',
        service_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, env_var, service_name)
      );

      CREATE INDEX IF NOT EXISTS idx_secret_mappings_project ON secret_mappings(project_id);
      CREATE INDEX IF NOT EXISTS idx_secret_mappings_secret_ref ON secret_mappings(secret_ref);

      -- Secret access audit log
      CREATE TABLE IF NOT EXISTS secret_access_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        action TEXT NOT NULL,
        provider TEXT NOT NULL,
        secret_path TEXT NOT NULL,
        project_id TEXT,
        environment_name TEXT,
        success INTEGER NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_secret_access_log_timestamp ON secret_access_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_secret_access_log_project ON secret_access_log(project_id);
      CREATE INDEX IF NOT EXISTS idx_secret_access_log_path ON secret_access_log(secret_path);
    `,
  },
  {
    version: 6,
    name: 'approvals',
    up: `
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled | consumed
        requested_by TEXT NOT NULL DEFAULT 'system',
        approved_by TEXT,
        rejected_by TEXT,
        reason TEXT,
        payload TEXT DEFAULT '{}',
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_env ON approvals(environment_name);
    `,
  },
];

export class SqliteAdapter {
  private db: Database.Database;
  private static instance: SqliteAdapter | null = null;

  private constructor(dbPath?: string) {
    const finalPath = dbPath ?? path.join(DATA_DIR, 'hypervibe.db');
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  static getInstance(dbPath?: string): SqliteAdapter {
    if (!SqliteAdapter.instance) {
      SqliteAdapter.instance = new SqliteAdapter(dbPath);
    }
    return SqliteAdapter.instance;
  }

  static resetInstance(): void {
    if (SqliteAdapter.instance) {
      SqliteAdapter.instance.close();
      SqliteAdapter.instance = null;
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  migrate(): void {
    // Ensure schema_migrations exists first
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const appliedVersions = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row: unknown) => (row as { version: number }).version)
    );

    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        this.db.transaction(() => {
          this.db.exec(migration.up);
          this.db
            .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
            .run(migration.version, migration.name);
        })();
        console.error(`Applied migration ${migration.version}: ${migration.name}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

export function getDb(): Database.Database {
  return SqliteAdapter.getInstance().getDb();
}

export function initializeDatabase(dbPath?: string): SqliteAdapter {
  const adapter = SqliteAdapter.getInstance(dbPath);
  adapter.migrate();
  return adapter;
}
