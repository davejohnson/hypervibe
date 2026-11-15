import { describe, expect, it, vi } from 'vitest';
import { assertRailwayFixturePlan, loadRailwayFixturePreview, type RailwayFixtureScope } from './railway-fixture-authorization.js';
import { assertFixtureContinuation, assertFixtureLifecycleConsent, fixturePreview } from './fixture-authorization.js';

const scope: RailwayFixtureScope = { repository: 'owner/disposable', environment: 'production', service: 'web', storage: ['files'], queues: ['jobs'] };
const action = (kind: string, name: string, type = 'create', provider = 'railway', metadata?: Record<string, unknown>) =>
  ({ id: `${kind}:${name}`, type, verified: true, resource: { kind, name, provider }, metadata });
const plan = (...actions: ReturnType<typeof action>[]) => ({ data: { planId: 'saved-plan', actions, blocked: [], inputRequired: [] } });

describe('Railway disposable lifecycle authorization', () => {
  it('allows only the declared fixture resources and exact managed workflow target', () => {
    expect(() => assertRailwayFixturePlan(plan(action('service', 'web'), action('database', 'postgres'), action('cache', 'redis'),
      action('storage', 'files'), action('queue', 'jobs'),
      action('ci', 'deploy-branch:production', 'update', 'github', { operation: 'githubActionsDeployBranch', repository: scope.repository,
        workflow: { path: '.github/workflows/deploy-railway-production.yml', branch: 'main' } })), scope, 'create')).not.toThrow();
  });
  it.each([action('service', 'customer-app'), action('storage', 'customer-data'), action('project', 'fixture'),
    action('service', 'web', 'create', 'cloudrun'), action('repo', 'owner/production', 'update', 'github'),
    action('ci', 'deploy-branch:staging', 'update', 'github')])('rejects scope expansion before apply: %j', (extra) => {
    expect(() => assertRailwayFixturePlan(plan(extra), scope, 'create')).toThrow(/fixture/);
  });
  it.each(['create', 'replace', 'destroy'])('does not allow %s during the in-place update', (type) => {
    expect(() => assertRailwayFixturePlan(plan(action('service', 'web', type)), scope, 'update')).toThrow(/fixture/);
  });
  it('does not allow creation during teardown or unrelated GitHub account settings', () => {
    expect(() => assertRailwayFixturePlan(plan(action('database', 'postgres')), scope, 'absent')).toThrow(/fixture/);
    expect(() => assertRailwayFixturePlan(plan(action('repo', scope.repository, 'update', 'github', { operation: 'githubSecuritySettings', repository: scope.repository })), scope, 'create')).toThrow(/fixture/);
  });
  it('requires the original saved plan and explicit lifecycle consent', () => {
    const target = { profile: 'railway', project: 'fixture', environment: scope.environment };
    const preview = fixturePreview(plan(action('service', 'web')), target);
    expect(() => assertFixtureContinuation(preview, target, undefined)).toThrow();
    expect(() => assertFixtureContinuation(preview, target, 'replacement-plan')).toThrow();
    expect(() => assertFixtureContinuation(preview, target, preview.planId)).not.toThrow();
    expect(() => assertFixtureLifecycleConsent(undefined)).toThrow();
    expect(() => assertFixtureLifecycleConsent('1')).not.toThrow();
  });
  it('loads only the exact persisted initial plan and blocks missing or cross-environment records', () => {
    const target = { profile: 'railway', project: 'fixture', environment: scope.environment };
    const original = action('service', 'web');
    const preview = fixturePreview(plan(original), target);
    const load = vi.fn(() => ({ kind: 'hv_plan', environmentName: scope.environment, actions: [original] }));
    expect(loadRailwayFixturePreview({ preview, target, approvedPlanId: 'saved-plan', load }))
      .toMatchObject({ data: { planId: 'saved-plan', actions: [original] } });
    expect(load).toHaveBeenCalledExactlyOnceWith('saved-plan');
    for (const invalid of [undefined, { kind: 'hv_plan', environmentName: 'other', actions: [original] }]) {
      expect(() => loadRailwayFixturePreview({ preview, target, approvedPlanId: 'saved-plan', load: () => invalid })).toThrow(/exact saved/);
    }
    load.mockClear();
    expect(() => loadRailwayFixturePreview({ preview, target, approvedPlanId: 'replacement-plan', load })).toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});
