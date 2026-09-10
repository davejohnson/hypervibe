-- Schema-6 boundary from v0.1.18 migration definitions, commit 63bd0fe4c676709e8bd32d0da1a2316f157199bb.
-- Frozen before generic Railway bindings (7), spec journal (8), encryption (10), and apply locks (11).
-- No customer data or credentials. Do not regenerate from current migrations.
BEGIN TRANSACTION;
CREATE TABLE approvals (
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
CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE components (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        bindings TEXT DEFAULT '{}',
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(environment_id, type)
      );
CREATE TABLE "connections" (
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
CREATE TABLE environments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform_bindings TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, name)
      );
CREATE TABLE integration_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        keys_encrypted TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, mode)
      );
CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        default_platform TEXT NOT NULL DEFAULT 'unconfigured',
        policies TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      , git_remote_url TEXT);
CREATE TABLE runs (
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
CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
INSERT INTO "schema_migrations" VALUES(1,'initial_schema','2026-09-10 05:13:46');
INSERT INTO "schema_migrations" VALUES(2,'integration_keys','2026-09-10 05:13:46');
INSERT INTO "schema_migrations" VALUES(3,'scoped_connections','2026-09-10 05:13:46');
INSERT INTO "schema_migrations" VALUES(4,'project_git_remote','2026-09-10 05:13:46');
INSERT INTO "schema_migrations" VALUES(5,'secret_mappings','2026-09-10 05:13:46');
INSERT INTO "schema_migrations" VALUES(6,'approvals','2026-09-10 05:13:46');
CREATE TABLE secret_access_log (
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
CREATE TABLE secret_mappings (
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
CREATE TABLE services (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        build_config TEXT DEFAULT '{}',
        env_var_spec TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, name)
      );
CREATE INDEX idx_environments_project ON environments(project_id);
CREATE INDEX idx_services_project ON services(project_id);
CREATE INDEX idx_components_environment ON components(environment_id);
CREATE INDEX idx_runs_project ON runs(project_id);
CREATE INDEX idx_runs_environment ON runs(environment_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id);
CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX idx_integration_keys_provider ON integration_keys(provider);
CREATE INDEX idx_connections_provider_scope ON connections(provider, scope);
CREATE INDEX idx_secret_mappings_project ON secret_mappings(project_id);
CREATE INDEX idx_secret_mappings_secret_ref ON secret_mappings(secret_ref);
CREATE INDEX idx_secret_access_log_timestamp ON secret_access_log(timestamp);
CREATE INDEX idx_secret_access_log_project ON secret_access_log(project_id);
CREATE INDEX idx_secret_access_log_path ON secret_access_log(secret_path);
CREATE INDEX idx_approvals_project ON approvals(project_id);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_approvals_env ON approvals(environment_name);
COMMIT;
