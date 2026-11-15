import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { canonicalizeLegacyGitHubSpec } from '../../spec/spec.store.js';
import {
  applyGitHubNativeSetting,
  canonicalPullRequestTemplateContent,
  compileManagedGitHubFiles,
  GITHUB_COLLABORATION_SETTINGS_ACTION_ID,
  planGitHubInfrastructure,
} from '../github-infrastructure.service.js';
import { applyGitHubCollaboration, planGitHubCollaboration } from '../repo-collaboration.service.js';

const repository = 'owner/solo';
const root = `/repos/${repository}`;
type SetupPath = 'github' | 'legacy' | 'canonicalized legacy';

// Reconstructed from the live before/after observations on davejohnson/hypervibe,
// 2026-10-18. GitHub omits required_pull_request_reviews after disabling reviews.
// The explicit-null variant exercises the adapter's nullable response contract.
// PUT semantics: https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection
function protection(reviewCount?: number | null) {
  return {
    required_status_checks: { strict: true, contexts: ['acceptance'], checks: [] },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    ...(reviewCount === undefined ? {} : {
      required_pull_request_reviews: reviewCount === null ? null : {
        required_approving_review_count: reviewCount,
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
      },
    }),
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo' },
  });
}

describe.each<SetupPath>(['github', 'legacy', 'canonicalized legacy'])('%s review policy', (setupPath) => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-review-policy-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'github', scope: repository,
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'test-token' }),
    });
    connections.updateStatus(connection.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(
    reviewPolicy: { requireReview?: boolean; requiredReviewers?: number },
    initial: ReturnType<typeof protection> | null,
    observedAfterWrite = protection(),
  ) {
    const project = new ProjectRepository().create({
      name: 'solo', defaultPlatform: 'railway', gitRemoteUrl: `https://github.com/${repository}.git`,
    });
    const collaboration = {
      issues: { enabled: false },
      pullRequests: { requireStatusChecks: true, statusChecks: ['acceptance'], ...reviewPolicy },
    };
    const raw = {
      version: 1, project: 'solo',
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
      ...(setupPath === 'github' ? { github: { collaboration } } : { collaboration }),
    };
    const spec = projectSpecSchema.parse(setupPath === 'canonicalized legacy'
      ? canonicalizeLegacyGitHubSpec(raw) : raw);
    // Existing managed files are only setup for reaching native settings planning.
    const files = new Map(spec.github
      ? compileManagedGitHubFiles(spec.github).map(file => [file.path, file.content])
      : [['.github/pull_request_template.md', canonicalPullRequestTemplateContent()]]);
    let observed = initial;
    const writes: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.pathname === `${root}/branches/main/protection`) {
        writes.push(JSON.parse(String(init?.body)));
        // Independent, preselected provider response; never echo the submitted body.
        observed = observedAfterWrite;
        return response(observed);
      }
      if (method !== 'GET') throw new Error(`Unexpected mutation: ${method} ${url.pathname}`);
      if (url.pathname === '/user') return response({ login: 'owner', id: 1 });
      if (url.pathname === root) return response({ full_name: repository, private: false, default_branch: 'main' });
      if (url.pathname === `${root}/labels`) return response([]);
      if (url.pathname === `${root}/branches/main/protection`) {
        return observed ? response(observed) : response({ message: 'Branch not protected' }, 404);
      }
      const prefix = `${root}/contents/`;
      if (url.pathname.startsWith(prefix)) {
        const content = files.get(url.pathname.slice(prefix.length));
        if (content !== undefined) return response({ content: Buffer.from(content).toString('base64'), encoding: 'base64' });
      }
      throw new Error(`Unexpected read: ${url.pathname}`);
    });
    const params = { project, spec, environmentName: 'production' };
    async function plan() {
      if (!spec.github) {
        const result = await planGitHubCollaboration(params);
        expect(result.warnings).toEqual([]);
        return result.action!;
      }
      const result = await planGitHubInfrastructure(params);
      expect(result.blocked).toEqual([]);
      expect(result.warnings).toEqual([]);
      return result.actions.find(action => action.id === GITHUB_COLLABORATION_SETTINGS_ACTION_ID)!;
    }
    async function apply() {
      const action = await plan();
      expect(action).toMatchObject({ type: 'update', verified: true });
      const result = spec.github
        ? await applyGitHubNativeSetting({ action })
        : await applyGitHubCollaboration(params);
      expect(result.success).toBe(true);
    }
    return { plan, apply, writes };
  }

  it('does not require another reviewer when the owner never requested one', async () => {
    const scenario = setup({}, null);
    await scenario.apply();
    expect(scenario.writes).toEqual([expect.objectContaining({
      required_pull_request_reviews: null,
      required_status_checks: { strict: true, contexts: ['acceptance'] },
      allow_force_pushes: false,
      allow_deletions: false,
    })]);
    await expect(scenario.plan()).resolves.toMatchObject({ type: 'noop', verified: true });
    expect(scenario.writes).toHaveLength(1);
  });

  it.each([undefined, null])('removes an unwanted review requirement and accepts %s review observation', async (absent) => {
    const scenario = setup({ requireReview: false }, protection(1), protection(absent));
    await scenario.apply();
    expect(scenario.writes).toEqual([expect.objectContaining({
      required_pull_request_reviews: null,
      required_status_checks: { strict: true, contexts: ['acceptance'] },
      allow_force_pushes: false,
      allow_deletions: false,
    })]);
    await expect(scenario.plan()).resolves.toMatchObject({ type: 'noop', verified: true });
    expect(scenario.writes).toHaveLength(1);
  });

  it('honors a review requirement explicitly chosen by the owner', async () => {
    const scenario = setup({ requireReview: true, requiredReviewers: 2 }, null, protection(2));
    await scenario.apply();
    expect(scenario.writes).toEqual([expect.objectContaining({
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
      },
    })]);
    await expect(scenario.plan()).resolves.toMatchObject({ type: 'noop', verified: true });
    expect(scenario.writes).toHaveLength(1);
  });
});
