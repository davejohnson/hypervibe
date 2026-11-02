-- Historical additive migration from 6f536cf, independently matched to the
-- existing disposable-test login store with read-only schema metadata inspection.
-- No customer state or credentials are included in this fixture.
CREATE TABLE provider_login_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT,
  state_encrypted TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_provider_login_scope ON provider_login_sessions(provider, scope, created_at);
INSERT INTO schema_migrations (version, name) VALUES (12, 'provider_login_sessions');
