import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { createCommandContext } from '../context.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { planDelegatedSecrets } from '../../domain/services/delegated-secret.service.js';
import { eligibleCredentialRequirements, resolveCredentialPlanHandoff } from '../credential-plan-handoff.js';

// Synthetic input policy with real Git/source and SQLite plan boundaries. These
// tests do not claim that a provider's live credentials are absent or valid.
const remote = 'https://github.com/studio/sequence.git';
const missing = { key: 'GOOGLE_CLIENT_ID', principal: 'email:owner@example.test', reason: 'No accepted value has been recorded; live state is unverified.' };
const required = (environments = ['staging']) => ({ ownership: 'delegated', principal: missing.principal, environments });
let root: string;
let context: ReturnType<typeof createCommandContext>;
let spec: ProjectSpec;
let projectId: string;
let environmentId: string;
let revision: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-credential-plan-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  context = createCommandContext();
  git('init', '-b', 'review/credentials');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('remote', 'add', 'origin', remote);
  spec = projectSpecSchema.parse({ version: 1, project: 'Sequence', gitRemoteUrl: remote,
    github: { enabled: true },
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} } },
      production: { hosting: { provider: 'railway' }, services: { web: {} } } },
    secrets: {
      GOOGLE_CLIENT_ID: required(), GOOGLE_CLIENT_SECRET: required(), ACCEPTED: required(),
      GENERATED: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['staging'] },
      PROD_ONLY: required(['production']), OPTIONAL: { ...required(), required: false },
      CI_ONLY: { ...required([]), githubActions: { repository: true } },
    },
  });
  mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(spec));
  git('add', '.hypervibe/spec.json');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'reviewed source');
  revision = git('rev-parse', 'HEAD');
  const project = context.repos.projects.create({ name: spec.project, gitRemoteUrl: remote });
  projectId = project.id;
  environmentId = context.repos.environments.create({ projectId, name: 'staging' }).id;
  new ProjectSpecRepository().insert(projectId, 1, spec);
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

function plan(document = {}, runInput = {}) {
  const run = context.repos.runs.create({ projectId, environmentId, type: 'plan',
    plan: { kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: 1,
      sourceCommitSha: revision, observedFingerprint: null, actions: [], inputRequired: [missing], ...document },
    ...runInput });
  context.repos.runs.updateStatus(run.id, 'succeeded');
  return run.id;
}

function resolve(planId: string, overrides = {}) {
  return resolveCredentialPlanHandoff(context, { planId, root, repository: 'studio/sequence', env: 'staging', spec, ...overrides });
}

describe('credential requirements from a persisted plan', () => {
  it('returns only required runtime inputs from the plan, preserving uncertainty and excluding supplied inputs', () => {
    const requirements = [missing, ...['GOOGLE_CLIENT_SECRET', 'GENERATED', 'PROD_ONLY', 'OPTIONAL', 'CI_ONLY', 'UNDECLARED'].map(key => ({ ...missing, key }))];
    expect(eligibleCredentialRequirements(spec, 'staging', requirements, ['GOOGLE_CLIENT_SECRET'])).toEqual([missing]);
    const planId = plan({ inputRequired: requirements, overrides: { delegatedSecretKeys: ['GOOGLE_CLIENT_SECRET'], delegatedSecretVarsEncrypted: 'encrypted-not-readable-here' } });
    const decrypt = vi.spyOn(context.secretStore, 'decryptObject');
    expect(resolve(planId)).toEqual({ planId, environment: 'staging', requirements: [missing], keys: ['GOOGLE_CLIENT_ID'], sourceCommitPinned: true });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('never expands an empty prerequisite plan into all spec declarations', () => {
    expect(resolve(plan({ inputRequired: [] })).keys).toEqual([]);
  });

  it('does not request accepted inputs again merely because provider observation is unknown', () => {
    const acceptedSpec = { ...spec, secrets: { ACCEPTED: spec.secrets.ACCEPTED } };
    const delegated = planDelegatedSecrets({ spec: acceptedSpec, environmentName: 'staging', hostingProvider: 'railway', observed: null,
      environment: { platformBindings: { delegatedEnvBindings: [{
        name: 'ACCEPTED', principal: missing.principal, valueHash: 'a'.repeat(64),
        source: 'delegated-plan-input', syncedAt: new Date().toISOString(), applyRunId: 'earlier-apply', actionId: 'secret:ACCEPTED',
      }] } } });
    expect(delegated.inputRequired).toEqual([]);
    expect(delegated.actions).toMatchObject([{ type: 'noop', verified: false }]);
    expect(eligibleCredentialRequirements(acceptedSpec, 'staging', delegated.inputRequired)).toEqual([]);
  });

  it('deduplicates exact matching inputs without dropping the original reason', () => {
    expect(eligibleCredentialRequirements(spec, 'staging', [missing, missing])).toEqual([missing]);
    expect(eligibleCredentialRequirements(spec, 'staging', [{ ...missing, principal: 'another-owner' }])).toEqual([]);
  });

  it('does not claim an unpinned manual plan pinned the commit', () => {
    expect(resolve(plan({ sourceCommitSha: undefined })).sourceCommitPinned).toBe(false);
  });

  it.each(['pending', 'running', 'failed', 'blocked', 'cancelled'] as const)('rejects a %s plan', status => {
    const id = plan(); context.repos.runs.updateStatus(id, status);
    expect(() => resolve(id)).toThrow(/completed|successful|succeeded/i);
  });

  it('rejects unknown and non-plan run ids', () => {
    expect(() => resolve('not-a-plan')).toThrow(/plan/i);
    expect(() => resolve(plan({}, { type: 'deploy' }))).toThrow(/plan/i);
  });

  it.each([-(24 * 60 * 60 * 1000 + 1), 60 * 1000, Number.NaN])('rejects stale, future or invalid timestamps (%s)', offset => {
    const id = plan();
    getDb().prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(Number.isNaN(offset) ? 'invalid' : new Date(Date.now() + offset).toISOString(), id);
    expect(() => resolve(id)).toThrow(/fresh|age|expired|time/i);
  });

  it('rejects another project even if its environment has the same name', () => {
    const other = context.repos.projects.create({ name: 'Other', gitRemoteUrl: 'https://github.com/studio/other.git' });
    const otherEnv = context.repos.environments.create({ projectId: other.id, name: 'staging' });
    expect(() => resolve(plan({}, { projectId: other.id, environmentId: otherEnv.id }))).toThrow(/project|repository/i);
  });

  it('rejects environment mismatch in the selected name or persisted row', () => {
    expect(() => resolve(plan(), { env: 'production' })).toThrow(/environment/i);
    const otherEnv = context.repos.environments.create({ projectId, name: 'production' });
    expect(() => resolve(plan({}, { environmentId: otherEnv.id }))).toThrow(/environment/i);
  });

  it('rejects a changed or unavailable repository identity', () => {
    const id = plan();
    git('remote', 'set-url', 'origin', 'https://github.com/studio/other.git');
    expect(() => resolve(id)).toThrow(/repository/i);
    git('remote', 'remove', 'origin');
    expect(() => resolve(id)).toThrow(/repository/i);
  });

  it('rejects outdated revisions and an unjournaled changed spec without adopting it', () => {
    const id = plan();
    new ProjectSpecRepository().insert(projectId, 2, spec);
    expect(() => resolve(id)).toThrow(/spec|revision/i);
    const current = plan({ specRevision: 2 });
    const changed = { ...spec, secrets: { ...spec.secrets, GOOGLE_CLIENT_ID: { ...required(), principal: 'email:someone-else@example.test' } } };
    writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(changed));
    git('add', '.hypervibe/spec.json'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'change owner');
    expect(() => resolve(current, { spec: projectSpecSchema.parse(changed) })).toThrow(/spec|revision/i);
    expect(new ProjectSpecRepository().findLatest(projectId)?.revision).toBe(2);
  });

  it('rejects dirty specs and changed commit-pinned source without reading dotenv values', () => {
    const id = plan();
    const specPath = path.join(root, '.hypervibe/spec.json');
    const original = readFileSync(specPath, 'utf8');
    writeFileSync(specPath, original + '\n');
    writeFileSync(path.join(root, '.env.staging'), 'GOOGLE_CLIENT_ID=must-not-leak\n', { mode: 0o600 });
    expect(() => resolve(id)).toThrow(/commit|source/i);
    writeFileSync(specPath, original);
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'new source');
    expect(() => resolve(id)).toThrow(/commit|source/i);
  });
});
