import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// Responses below were read from a real repository whose owner had moved
// classic branch protection to rulesets (GET .../rules/branches/main and
// GET .../rulesets/{id}, 2026-11-17), with timestamps and links removed.
// Other cases are variations of those bodies; none is live evidence of writes.
const STATUS_RULESET = {
  id: 27467308,
  name: 'main-2',
  target: 'branch',
  source_type: 'Repository',
  source: 'acme/app',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['refs/heads/main'] } },
  rules: [{
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: 'Hypervibe / acceptance', integration_id: 15368 }],
    },
  }],
  bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
};
const SAFETY_RULESET = {
  id: 27467307,
  name: 'main-1',
  target: 'branch',
  source_type: 'Repository',
  source: 'acme/app',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['refs/heads/main'] } },
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  bypass_actors: [],
};

type Ruleset = typeof STATUS_RULESET | typeof SAFETY_RULESET | Record<string, any>;

function github(options: { rulesets?: Ruleset[]; classic?: Record<string, unknown> | null } = {}) {
  const rulesets = structuredClone(options.rulesets ?? []) as Array<Record<string, any>>;
  const classic = options.classic ?? null;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    if (method !== 'GET') {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      writes.push({ method, path, body });
      return Response.json({ id: 99, ...body }, { status: method === 'POST' ? 201 : 200 });
    }
    if (path === '/repos/acme/app/branches/main/protection') {
      return classic
        ? Response.json(classic)
        : Response.json({ message: 'Branch not protected', status: '404' }, { status: 404 });
    }
    if (path === '/repos/acme/app/rules/branches/main') {
      if (url.searchParams.get('page') !== '1') return Response.json([]);
      return Response.json(rulesets.filter((ruleset) => ruleset.enforcement === 'active').flatMap((ruleset) =>
        ruleset.rules.map((rule: Record<string, unknown>) => ({
          ...rule,
          ruleset_source_type: ruleset.source_type,
          ruleset_source: ruleset.source,
          ruleset_id: ruleset.id,
        }))));
    }
    const detail = /^\/repos\/acme\/app\/rulesets\/(\d+)$/.exec(path);
    const found = detail && rulesets.find((ruleset) => ruleset.id === Number(detail[1]) && ruleset.source_type === 'Repository');
    if (found) return Response.json(found);
    return Response.json({ message: 'Not Found', status: '404' }, { status: 404 });
  });
  const adapter = new GitHubAdapter();
  adapter.connect({ apiToken: 'synthetic_provider_token' });
  return { adapter, writes };
}

const desired = {
  requireReviews: false,
  requireStatusChecks: true,
  statusChecks: ['Hypervibe / acceptance'],
  strictStatusChecks: false,
  enforceAdmins: false,
  allowForcePushes: false,
  allowDeletions: false,
};

afterEach(() => vi.restoreAllMocks());

describe('GitHub branch rules kept in rulesets', () => {
  it('reads rules from rulesets when the branch has no classic protection', async () => {
    const { adapter } = github({ rulesets: [SAFETY_RULESET, STATUS_RULESET] });

    const protection = await adapter.getBranchProtection('acme', 'app', 'main');

    expect(protection?.required_status_checks).toMatchObject({ strict: true, contexts: ['Hypervibe / acceptance'] });
    expect(protection?.required_pull_request_reviews).toBeNull();
    expect(protection?.enforce_admins).toEqual({ enabled: false });
    expect(protection?.allow_force_pushes).toEqual({ enabled: false });
    expect(protection?.allow_deletions).toEqual({ enabled: false });
  });

  it('still reports an unprotected branch as unprotected', async () => {
    const { adapter } = github();
    await expect(adapter.getBranchProtection('acme', 'app', 'main')).resolves.toBeNull();
  });

  it('changes the rule in its ruleset instead of adding classic protection', async () => {
    const { adapter, writes } = github({ rulesets: [SAFETY_RULESET, STATUS_RULESET] });

    await adapter.updateBranchProtection('acme', 'app', 'main', desired);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/repos/acme/app/rulesets/27467308' });
    expect(writes[0].body.rules).toEqual([{
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: 'Hypervibe / acceptance', integration_id: 15368 }],
      },
    }]);
    expect(writes[0].body.bypass_actors).toEqual(STATUS_RULESET.bypass_actors);
    expect(writes[0].body.conditions).toEqual(STATUS_RULESET.conditions);
  });

  it('writes nothing when the rulesets already match', async () => {
    const { adapter, writes } = github({ rulesets: [SAFETY_RULESET, STATUS_RULESET] });
    await adapter.updateBranchProtection('acme', 'app', 'main', { ...desired, strictStatusChecks: true });
    expect(writes).toEqual([]);
  });

  it('refuses, with no writes, when a ruleset covering other branches is stricter', async () => {
    const broad = { ...STATUS_RULESET, name: 'all-branches', conditions: { ref_name: { exclude: [], include: ['~ALL'] } } };
    const { adapter, writes } = github({ rulesets: [SAFETY_RULESET, broad] });

    await expect(adapter.updateBranchProtection('acme', 'app', 'main', desired)).rejects.toThrow(/all-branches/);
    expect(writes).toEqual([]);
  });

  it('adds missing rules in a new ruleset and leaves existing ones alone', async () => {
    const { adapter, writes } = github({ rulesets: [SAFETY_RULESET] });

    await adapter.updateBranchProtection('acme', 'app', 'main', {
      ...desired, requireReviews: true, requiredReviewers: 2, enforceAdmins: true,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', path: '/repos/acme/app/rulesets' });
    expect(writes[0].body).toMatchObject({
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      bypass_actors: [],
    });
    expect(writes[0].body.rules.map((rule: { type: string }) => rule.type).sort()).toEqual(['pull_request', 'required_status_checks']);
    const review = writes[0].body.rules.find((rule: { type: string }) => rule.type === 'pull_request');
    expect(review.parameters).toMatchObject({ required_approving_review_count: 2, require_code_owner_review: false });
  });

  it('lets admins bypass or not, to match the requested setting', async () => {
    const { adapter, writes } = github({ rulesets: [SAFETY_RULESET, STATUS_RULESET] });

    await adapter.updateBranchProtection('acme', 'app', 'main', { ...desired, strictStatusChecks: true, enforceAdmins: true });

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/repos/acme/app/rulesets/27467308');
    expect(writes[0].body.bypass_actors).toEqual([]);
  });

  it('keeps using classic protection when no ruleset applies', async () => {
    const { adapter, writes } = github();
    await adapter.updateBranchProtection('acme', 'app', 'main', desired);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/repos/acme/app/branches/main/protection' });
    expect(writes[0].body.required_status_checks).toEqual({ strict: false, contexts: ['Hypervibe / acceptance'] });
  });
});
