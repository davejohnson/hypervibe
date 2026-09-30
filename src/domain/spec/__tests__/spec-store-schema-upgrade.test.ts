import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ProjectSpecRepository } from '../../../adapters/db/repositories/spec.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConvergeExecutor } from '../../plan/converge.executor.js';
import { SpecStore } from '../spec.store.js';
import { projectSpecSchema } from '../spec.schema.js';
import { parseToolEnvelope } from '../../../tools/__tests__/tool-result.js';

// Independent contract: README "Team-Shared Desired State" and ARCHITECTURE
// "State Ownership" declare the repository spec authoritative, with SQLite
// retaining revision history. The old promotion shape reconstructs the
// reported schema-upgrade failure; no customer state or credentials are used.
let directory: string;
let originalCwd: string;
let originalRepoSetting: string | undefined;
let originalDataSetting: string | undefined;

const currentSpec = {
  version: 1, project: 'schema-upgrade-example',
  gitRemoteUrl: 'git@github.com:hypervibe-tests/schema-upgrade-example.git',
  environments: {
    staging: {
      hosting: { provider: 'railway' }, services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: true },
    },
    production: {
      hosting: { provider: 'railway' }, services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false, promoteFrom: 'staging' },
    },
  },
};

const previousSpec = {
  ...currentSpec,
  environments: {
    ...currentSpec.environments,
    production: {
      ...currentSpec.environments.production,
      deploy: { strategy: 'manual', promoteFrom: 'staging' },
    },
  },
};

beforeEach(() => {
  originalCwd = process.cwd();
  originalRepoSetting = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  originalDataSetting = process.env.HYPERVIBE_DATA_DIR;
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-schema-upgrade-')));
  SqliteAdapter.resetInstance();
  process.env.HYPERVIBE_DATA_DIR = directory;
  SqliteAdapter.getInstance(path.join(directory, 'isolated.db')).migrate();
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['remote', 'add', 'origin', currentSpec.gitRemoteUrl], { cwd: directory });
  process.chdir(directory);
  delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  mkdirSync(path.join(directory, '.hypervibe'));
  writeFileSync(path.join(directory, '.hypervibe/spec.json'), JSON.stringify(currentSpec));
  // Any unexpected provider observation must fail without contacting a network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Provider calls are forbidden in this regression.'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  process.chdir(originalCwd);
  if (originalRepoSetting === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  else process.env.HYPERVIBE_DISABLE_REPO_SPEC = originalRepoSetting;
  if (originalDataSetting === undefined) delete process.env.HYPERVIBE_DATA_DIR;
  else process.env.HYPERVIBE_DATA_DIR = originalDataSetting;
  rmSync(directory, { recursive: true, force: true });
});

function seedPreviousRevision() {
  const project = new ProjectRepository().create({
    name: currentSpec.project, gitRemoteUrl: currentSpec.gitRemoteUrl, defaultPlatform: 'railway',
  });
  const journal = new ProjectSpecRepository();
  journal.insert(project.id, 8, previousSpec);
  return { project, journal };
}

describe('schema-upgrade recovery from authoritative repository desired state', () => {
  it('adopts a validated repository spec without requiring the old cached revision to pass the new schema', () => {
    expect(projectSpecSchema.safeParse(previousSpec).success).toBe(false);
    expect(projectSpecSchema.safeParse(currentSpec).success).toBe(true);
    const { project, journal } = seedPreviousRevision();
    const store = new SpecStore();
    const adopted = store.get(project)!;
    expect(adopted.revision).toBe(9);
    expect(adopted.adopted).toBe(true);
    expect(adopted.source).toEqual({ kind: 'repo', path: path.join(directory, '.hypervibe/spec.json') });
    expect(adopted.spec.environments.production.deploy).toMatchObject(currentSpec.environments.production.deploy);
    expect(journal.findByRevision(project.id, 8)!.document).toEqual(previousSpec);
    expect(() => store.getRevision(project.id, 8)).toThrow(/persisted JSON has an invalid shape/);
    expect(store.get(project)).toMatchObject({ revision: 9 });
    expect(store.get(project)!.adopted).toBeUndefined();
    expect(journal.findLatest(project.id)!.revision).toBe(9);
  });

  it('allows the real public MCP replacement path to recover and read the corrected spec', async () => {
    const { project, journal } = seedPreviousRevision();
    const { createServer } = await import('../../../server.js');
    const server = createServer();
    const client = new Client({ name: 'schema-upgrade-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const replaced = parseToolEnvelope(await client.callTool({
        name: 'hv_spec', arguments: { project: project.name, replace: true, spec: currentSpec },
      }));
      expect(replaced.ok).toBe(true);
      expect(replaced.data).toMatchObject({
        revision: 10, spec: { environments: { production: { deploy: currentSpec.environments.production.deploy } } },
      });
      const read = parseToolEnvelope(await client.callTool({ name: 'hv_spec', arguments: { project: project.name } }));
      expect(read.ok).toBe(true);
      expect(read.data).toMatchObject({ revision: 10 });
      expect(journal.findByRevision(project.id, 8)!.document).toEqual(previousSpec);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects a prepared plan for the old revision before any action can run after recovery', async () => {
    const { project } = seedPreviousRevision();
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const runs = new RunRepository();
    const plan = runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: 'staging', specRevision: 8, observedFingerprint: null,
        actions: [{
          id: 'service:web', type: 'create',
          resource: { kind: 'service', name: 'web', provider: 'railway' },
          verified: true, reason: 'Prepared against the previous desired-state revision',
        }],
      },
    });
    const recovered = new SpecStore().get(project)!;
    expect(recovered.revision).toBe(9);
    const handler = vi.fn(async () => ({ success: true }));

    const result = await new ConvergeExecutor().execute({
      planRunId: plan.id, currentSpecRevision: recovered.revision, handler,
    });

    expect(result).toMatchObject({ success: false, receipts: [] });
    expect(result.error).toContain('plan revision 8, current 9');
    expect(handler).not.toHaveBeenCalled();
    expect(runs.findByProjectId(project.id)).toHaveLength(1);
    expect(runs.findById(plan.id)!.status).toBe('pending');
  });

  it('does not recover schema-invalid cached state from a repository spec naming another project', () => {
    const { project, journal } = seedPreviousRevision();
    const specPath = path.join(directory, '.hypervibe/spec.json');
    writeFileSync(specPath, JSON.stringify({ ...currentSpec, project: 'another-project' }));
    const before = readFileSync(specPath, 'utf8');

    expect(() => new SpecStore().get(project)).toThrow(/persisted JSON has an invalid shape/);

    expect(readFileSync(specPath, 'utf8')).toBe(before);
    expect(journal.findLatest(project.id)!.revision).toBe(8);
    expect(journal.findByRevision(project.id, 9)).toBeNull();
    expect(journal.findByRevision(project.id, 8)!.document).toEqual(previousSpec);
  });

  it('keeps cache-only schema-invalid state blocked without adding a revision', () => {
    const { project, journal } = seedPreviousRevision();
    rmSync(path.join(directory, '.hypervibe/spec.json'));
    expect(() => new SpecStore().get(project)).toThrow(/persisted JSON has an invalid shape/);
    expect(journal.findLatest(project.id)!.revision).toBe(8);
  });

  it('keeps invalid repository state blocked and does not overwrite either desired-state copy', () => {
    const { project, journal } = seedPreviousRevision();
    const specPath = path.join(directory, '.hypervibe/spec.json');
    writeFileSync(specPath, JSON.stringify(previousSpec));
    const before = readFileSync(specPath, 'utf8');
    expect(() => new SpecStore().get(project)).toThrow(/does not match the project spec schema/);
    expect(readFileSync(specPath, 'utf8')).toBe(before);
    expect(journal.findLatest(project.id)!.revision).toBe(8);
  });

  it('keeps corrupt journal JSON blocked even when the repository spec is valid', () => {
    const { project } = seedPreviousRevision();
    SqliteAdapter.getInstance().getDb().prepare('UPDATE project_specs SET document = ? WHERE project_id = ?')
      .run('{"secret":"must-not-leak",', project.id);
    expect(() => new SpecStore().get(project)).toThrow(/persisted JSON is corrupt/);
    expect(SqliteAdapter.getInstance().getDb().prepare('SELECT COUNT(*) AS count FROM project_specs').get())
      .toEqual({ count: 1 });
  });
});
