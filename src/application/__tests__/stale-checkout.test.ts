/**
 * A checkout that does not reflect the app's real state must never be acted on
 * (issue 879). Real temporary git repositories with a local bare "remote"; no
 * network. Two guards: a command that plans or changes things refuses a
 * checkout that is behind its upstream, and an older copy of the app's setup
 * or bindings file never replaces what Hypervibe has saved since.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { checkoutFreshness } from '../../lib/checkout-freshness.js';
import { CommandRegistry } from '../commands.js';
import { createCommandContext } from '../context.js';

let base: string;
const cwd = process.cwd();
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
const specOf = (project: string, services: string[]) => ({ version: 1, project, environments: { staging: { hosting: { provider: 'railway' },
  services: Object.fromEntries(services.map((name) => [name, { startCommand: 'npm start' }])) } } });

/** A bare remote, a checkout that is up to date (`app`), and one that is `behind` commits behind (`old/app`). */
function repositories(behind: number): { current: string; stale: string } {
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  const current = path.join(base, 'app');
  git(base, 'clone', '--quiet', remote, current);
  mkdirSync(path.join(current, '.hypervibe'));
  writeFileSync(path.join(current, '.hypervibe/spec.json'), `${JSON.stringify(specOf('app', ['api']), null, 2)}\n`);
  git(current, 'checkout', '--quiet', '-b', 'main');
  git(current, 'add', '.');
  git(current, 'commit', '--quiet', '-m', 'first');
  git(current, 'push', '--quiet', '-u', 'origin', 'main');
  mkdirSync(path.join(base, 'old'));
  const stale = path.join(base, 'old/app');
  git(base, 'clone', '--quiet', remote, stale);
  for (let n = 1; n <= behind; n++) {
    writeFileSync(path.join(current, `file-${n}.txt`), 'x');
    git(current, 'add', '.');
    git(current, 'commit', '--quiet', '-m', `later ${n}`);
  }
  git(current, 'push', '--quiet');
  return { current, stale };
}

/** The shared command core with one command that records being run. */
function commands() {
  const registry = new CommandRegistry();
  const ran: string[] = [];
  for (const name of ['hv_plan', 'hv_apply', 'hv_deploy', 'hv_migrate', 'hv_launch', 'hv_destroy', 'hv_rollback', 'hv_import', 'hv_spec', 'hv_status']) {
    registry.register(name, name, {}, () => { ran.push(name); return { ok: true, data: {} }; });
  }
  return { ran, run: (name: string, input: Record<string, unknown> = {}) => registry.get(name)!.execute(input) };
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'hv-stale-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  vi.stubEnv('HYPERVIBE_DATA_DIR', path.join(base, 'data'));
  // The suite itself may run in CI, where this guard stands aside; each case says whether it is in CI.
  vi.stubEnv('CI', '');
  vi.stubEnv('GITHUB_ACTIONS', '');
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(base, 'test.db')).migrate();
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(base, { recursive: true, force: true });
});

describe('a command that plans or changes things, in a checkout that is behind', () => {
  it('is refused before it runs, with the count and what to do; the same command runs in an up-to-date checkout', async () => {
    const { current, stale } = repositories(14);
    process.chdir(stale);
    for (const name of ['hv_plan', 'hv_apply', 'hv_deploy', 'hv_migrate', 'hv_launch', 'hv_destroy', 'hv_rollback', 'hv_import']) {
      const { ran, run } = commands();
      const result = await run(name);
      expect(result).toMatchObject({ ok: false, error: { message: 'This checkout is 14 commits behind origin/main. Run git pull, then run this again.' } });
      expect(ran).toEqual([]);
    }
    // Saving a setup is refused too; reading it, and commands that do not depend on the checkout, are not.
    const { ran, run } = commands();
    expect((await run('hv_spec', { spec: {} })).ok).toBe(false);
    expect((await run('hv_spec')).ok).toBe(true);
    expect((await run('hv_status')).ok).toBe(true);
    expect(ran).toEqual(['hv_spec', 'hv_status']);

    process.chdir(current);
    // Uncommitted changes are not a reason to refuse.
    writeFileSync(path.join(current, 'scratch.txt'), 'not committed');
    const upToDate = await commands().run('hv_plan');
    expect(upToDate).toMatchObject({ ok: true });
    expect(upToDate.warnings).toBeUndefined();
    // After pulling, the stale checkout is accepted.
    git(stale, 'pull', '--quiet');
    process.chdir(stale);
    expect((await commands().run('hv_plan')).ok).toBe(true);
  }, 60_000);

  it('judges a feature branch by its own upstream, and a worktree like any checkout', async () => {
    const { current, stale } = repositories(1);
    // A feature branch that is up to date with its own upstream is fine although main has moved on.
    git(stale, 'checkout', '--quiet', '-b', 'feature');
    git(stale, 'push', '--quiet', '-u', 'origin', 'feature');
    process.chdir(stale);
    expect((await commands().run('hv_plan')).ok).toBe(true);
    // Someone else pushes to that branch: now this checkout is behind it.
    git(current, 'fetch', '--quiet');
    git(current, 'checkout', '--quiet', 'feature');
    writeFileSync(path.join(current, 'more.txt'), 'x');
    git(current, 'add', '.');
    git(current, 'commit', '--quiet', '-m', 'on the feature branch');
    git(current, 'push', '--quiet');
    expect((await commands().run('hv_plan')).error?.message).toBe('This checkout is 1 commit behind origin/feature. Run git pull, then run this again.');

    const tree = path.join(base, 'tree');
    git(stale, 'fetch', '--quiet', 'origin', 'main');
    git(stale, 'worktree', 'add', '-b', 'side', tree, 'origin/main~1');
    git(tree, 'branch', '--quiet', '--set-upstream-to=origin/main');
    process.chdir(tree);
    expect((await commands().run('hv_apply')).error?.message).toBe('This checkout is 1 commit behind origin/main. Run git pull, then run this again.');
  }, 60_000);

  it('says so when it could not check, and never calls that up to date', async () => {
    const { stale } = repositories(2);
    git(stale, 'pull', '--quiet');
    process.chdir(stale);
    // The remote cannot be reached: the command runs, and its result says the checkout could not be confirmed.
    git(stale, 'remote', 'set-url', 'origin', path.join(base, 'gone.git'));
    const unreachable = await commands().run('hv_plan');
    expect(unreachable.ok).toBe(true);
    expect(unreachable.warnings).toEqual([expect.stringMatching(/could not confirm this checkout is up to date: origin could not be reached/)]);
    expect(checkoutFreshness()).toMatchObject({ state: 'unchecked' });
    // No upstream, and no branch at all.
    git(stale, 'checkout', '--quiet', '-b', 'local-only');
    expect((await commands().run('hv_plan')).warnings).toEqual([expect.stringContaining('branch local-only has no upstream branch')]);
    git(stale, 'checkout', '--quiet', '--detach');
    expect((await commands().run('hv_plan')).warnings).toEqual([expect.stringContaining('not on a branch')]);
  }, 60_000);

  it('stands aside in CI, which deploys the commit it was given, and for a directory that holds no app setup', async () => {
    const { stale } = repositories(3);
    process.chdir(stale);
    expect(checkoutFreshness()).toEqual({ state: 'behind', count: 3, upstream: 'origin/main' });
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect(checkoutFreshness()).toEqual({ state: 'not-applicable' });
    const inCi = await commands().run('hv_deploy');
    expect(inCi.ok).toBe(true);
    expect(inCi.warnings).toBeUndefined();
    vi.stubEnv('GITHUB_ACTIONS', '');
    rmSync(path.join(stale, '.hypervibe'), { recursive: true });
    expect(checkoutFreshness()).toEqual({ state: 'not-applicable' });
  }, 60_000);
});

describe('an older copy of a file never replaces what Hypervibe has saved since', () => {
  it('refuses a setup file that matches an earlier saved revision, changing neither the saved setup nor the file; a file with new content is still taken in', () => {
    const { current } = repositories(0);
    process.chdir(current);
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'app', defaultPlatform: 'railway' });
    const store = new SpecStore();
    const file = path.join(current, '.hypervibe/spec.json');
    const first = store.replace(project, specOf('app', ['api']));
    const older = readFileSync(file, 'utf8');
    const second = store.replace(project, specOf('app', ['api', 'worker']));
    expect(second.revision).toBe(first.revision + 1);
    // As a checkout that was never updated has it: the file Hypervibe wrote one revision ago.
    writeFileSync(file, older);
    expect(() => store.get(project)).toThrow(/older copy of this project's setup.*revision 1.*now revision 2/s);
    expect(() => store.merge(project, { environments: {} })).toThrow(/older copy of this project's setup/);
    expect(new ProjectSpecRepository().findLatest(project.id)!.revision).toBe(second.revision);
    expect(Object.keys((new ProjectSpecRepository().findLatest(project.id)!.document as ReturnType<typeof specOf>).environments.staging.services)).toEqual(['api', 'worker']);
    expect(readFileSync(file, 'utf8')).toBe(older);

    // Content Hypervibe has never saved (pulled from elsewhere, or edited by hand) is new, and is taken in as before.
    writeFileSync(file, `${JSON.stringify(specOf('app', ['api', 'worker', 'cron']), null, 2)}\n`);
    const adopted = store.get(project)!;
    expect(adopted).toMatchObject({ adopted: true, revision: second.revision + 1 });
    expect(Object.keys(adopted.spec.environments.staging!.services)).toEqual(['api', 'worker', 'cron']);
  }, 60_000);

  it('refuses a bindings file last written before the saved bindings changed, changing neither; a file written after is still taken in', () => {
    const { current } = repositories(0);
    process.chdir(current);
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'app', defaultPlatform: 'railway' });
    new SpecStore().replace(project, specOf('app', ['api']));
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { projectId: 'railway-old', services: { api: { serviceId: 'svc-1' } } } });
    const file = path.join(current, '.hypervibe/bindings.json');
    const older = readFileSync(file, 'utf8');
    ctx.repos.environments.updatePlatformBindings(environment.id, { projectId: 'railway-new' });
    const saved = ctx.repos.environments.findById(environment.id)!;
    // As a checkout that was never updated has it: the older file, last written before the saved bindings changed.
    writeFileSync(file, older);
    const before = new Date(saved.updatedAt.getTime() - 60_000);
    utimesSync(file, before, before);
    expect(() => ctx.resolveProject({ project: 'app' })).toThrow(/bindings\.json is older than the bindings Hypervibe has saved for staging/);
    expect(ctx.repos.environments.findById(environment.id)!.platformBindings).toEqual(saved.platformBindings);
    expect(readFileSync(file, 'utf8')).toBe(older);

    // The same content in a file written after the saved bindings changed (a pull, an edit) is taken in as before.
    const after = new Date(saved.updatedAt.getTime() + 60_000);
    utimesSync(file, after, after);
    expect(ctx.resolveProject({ project: 'app' })?.name).toBe('app');
    expect(ctx.repos.environments.findById(environment.id)!.platformBindings).toMatchObject({ projectId: 'railway-old' });
  }, 60_000);
});
