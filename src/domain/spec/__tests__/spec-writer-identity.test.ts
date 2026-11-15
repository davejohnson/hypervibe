import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { SqliteAdapter, getDb } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ProjectSpecRepository } from '../../../adapters/db/repositories/spec.repository.js';
import { commandErrorFromUnknown, HvError } from '../../../application/results.js';
import { HYPERVIBE_VERSION } from '../../../version.js';
import { SpecStore } from '../spec.store.js';
import { compareReleaseVersions, currentSpecWriter, specSchemaFingerprint } from '../spec-writer.js';
import type { Project } from '../../entities/project.entity.js';

// Regression for hypervibe#566: a newer build stored maintenance.mode/page and
// an older reader reported the valid revision as an INTERNAL invalid shape.
let directory: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-spec-writer-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function makeProject(): Project {
  return new ProjectRepository().create({
    name: `writer-${Math.random().toString(36).slice(2, 8)}`,
    defaultPlatform: 'railway',
    policies: {},
  });
}

function spec(project: Project, maintenance: Record<string, unknown>) {
  return {
    version: 1,
    project: project.name,
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} }, maintenance } },
  };
}

function rawInsert(projectId: string, revision: number, document: unknown, writer: { version: string; schema: string } | null) {
  getDb().prepare(`
    INSERT INTO project_specs (id, project_id, revision, document, created_at, writer_version, writer_schema)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`row-${revision}`, projectId, revision, JSON.stringify(document), new Date().toISOString(),
    writer?.version ?? null, writer?.schema ?? null);
}

function storedRows(projectId: string) {
  return getDb().prepare('SELECT revision, document, writer_version, writer_schema FROM project_specs WHERE project_id = ? ORDER BY revision')
    .all(projectId);
}

function readError(projectId: string, revision: number): unknown {
  try {
    new SpecStore().getRevision(projectId, revision);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the stored revision to be rejected.');
}

describe('spec writer identity', () => {
  it('records the writing build with every new revision', () => {
    const project = makeProject();
    const result = new SpecStore().replace(project, spec(project, { enabled: true, mode: 'application', page: 'active' }));
    const row = new ProjectSpecRepository().findLatest(project.id)!;
    expect(row.revision).toBe(result.revision);
    expect(row.writer).toEqual({ version: HYPERVIBE_VERSION, schema: specSchemaFingerprint() });
  });

  it('reads the Billforge maintenance shape with mode and page', () => {
    const project = makeProject();
    rawInsert(project.id, 41, spec(project, { enabled: true, mode: 'application', page: 'active' }), currentSpecWriter());
    expect(new SpecStore().getRevision(project.id, 41)?.environments.staging.maintenance)
      .toEqual({ enabled: true, mode: 'application', page: 'active' });
  });

  it('reports a newer writer as an actionable upgrade without modifying stored state', () => {
    const project = makeProject();
    const writer = { version: '99.0.0', schema: 'f'.repeat(16) };
    rawInsert(project.id, 41, spec(project, { enabled: true, futureField: 'x' }), writer);
    const before = storedRows(project.id);

    const error = readError(project.id, 41);
    expect(error).toBeInstanceOf(HvError);
    const envelope = commandErrorFromUnknown(error);
    expect(envelope.error?.code).toBe('UNSUPPORTED');
    expect(envelope.error?.message).toContain('written by a newer Hypervibe (99.0.0');
    expect(envelope.error?.message).toContain('Upgrade Hypervibe to 99.0.0 or later');
    expect(envelope.error?.message).toContain('environments.staging.maintenance');
    expect(envelope.error?.details).toMatchObject({ reason: 'spec-writer-mismatch', revision: 41, writer, reader: currentSpecWriter() });
    expect(envelope.agentInstruction?.action).toBe('ask_user');
    expect(storedRows(project.id)).toEqual(before);
  });

  it('distinguishes a same-version build with a different spec schema', () => {
    const project = makeProject();
    rawInsert(project.id, 3, spec(project, { enabled: true, futureField: 'x' }),
      { version: HYPERVIBE_VERSION, schema: '0'.repeat(16) });
    const envelope = commandErrorFromUnknown(readError(project.id, 3));
    expect(envelope.error?.code).toBe('UNSUPPORTED');
    expect(envelope.error?.message).toContain('written by a different Hypervibe build');
    expect(envelope.error?.message).toContain('Upgrade or rebuild this Hypervibe runtime');
  });

  it('keeps failing closed as invalid state when the writer is unknown or matches this build', () => {
    const project = makeProject();
    rawInsert(project.id, 1, spec(project, { enabled: true, futureField: 'x' }), null);
    rawInsert(project.id, 2, spec(project, { enabled: 'yes' }), currentSpecWriter());
    for (const revision of [1, 2]) {
      const error = readError(project.id, revision);
      expect(error).not.toBeInstanceOf(HvError);
      expect(commandErrorFromUnknown(error).error?.message)
        .toMatch(/invalid shape.*refuses to treat unreadable desired state as empty/);
    }
  });

  it('adds nullable writer columns to an existing schema-13 journal', () => {
    SqliteAdapter.resetInstance();
    const dbPath = path.join(directory, 'legacy.db');
    SqliteAdapter.getInstance(dbPath).migrate();
    SqliteAdapter.resetInstance();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE project_specs_old AS SELECT id, project_id, revision, document, created_at FROM project_specs;
      DROP TABLE project_specs;
      ALTER TABLE project_specs_old RENAME TO project_specs;
      DELETE FROM schema_migrations WHERE version = 14;
      INSERT INTO projects (id, name, default_platform, policies, created_at, updated_at)
        VALUES ('legacy-project', 'legacy', 'railway', '{}', datetime('now'), datetime('now'));
      INSERT INTO project_specs VALUES ('legacy-row', 'legacy-project', 1, '{}', datetime('now'));
    `);
    legacy.close();

    const applied = SqliteAdapter.getInstance(dbPath).migrate();
    expect(applied.map((migration) => migration.version)).toEqual([14]);
    expect(new ProjectSpecRepository().findLatest('legacy-project')?.writer).toBeNull();
  });
});

describe('spec schema fingerprint', () => {
  it('changes when the accepted spec shape gains a field', () => {
    const base = z.object({ enabled: z.boolean() }).strict();
    const extended = z.object({ enabled: z.boolean(), mode: z.enum(['application', 'data']).optional() }).strict();
    expect(specSchemaFingerprint(base)).toBe(specSchemaFingerprint(base));
    expect(specSchemaFingerprint(extended)).not.toBe(specSchemaFingerprint(base));
  });

  it('orders release versions and ignores non-release identities', () => {
    expect(compareReleaseVersions('0.1.48', '0.1.47')).toBeGreaterThan(0);
    expect(compareReleaseVersions('0.1.47', '0.1.47')).toBe(0);
    expect(compareReleaseVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareReleaseVersions('dev', '0.1.47')).toBeNull();
  });
});
