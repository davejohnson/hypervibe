import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { createCommandContext } from '../context.js';
import { ENGINE_PLAN_SCOPE, planEngineSecrets, recordEnginePlan } from '../engine-shared.js';
import { runPlanReportPath } from '../../adapters/storage/plan-report-files.js';
import { buildCloudRunConfiguration, storageEngineKey } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { parseEnginePlan, translateEnginePlan } from '../../adapters/engine/opentofu/plan-mapping.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-shared-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

const action = (key: string, stored: boolean): PlanAction => ({
  id: `secret:${key}`, type: stored ? 'noop' : 'create', verified: true, resource: { kind: 'secret', name: key, provider: 'aws' }, reason: stored ? 'stored' : 'generate',
});

// Contract (ARCHITECTURE.md, Reconciliation Safety Invariants): present, absent and
// unknown stay distinct; only confirmed absence plans a create; Hypervibe never
// invents a key an outside service issues.
describe('shared engine secret planning', () => {
  const plan = (store: Record<string, 'present' | 'absent' | { unknown: string }>) => planEngineSecrets({
    environmentName: 'testing', generated: ['JWT_SECRET', 'SESSION_SECRET'], outside: ['STRIPE_KEY'],
    observe: async (key) => store[key] ?? 'absent', action,
  });

  it('creates only generated keys confirmed absent', async () => {
    expect(await plan({ STRIPE_KEY: 'present', JWT_SECRET: 'present' })).toEqual({ actions: [action('JWT_SECRET', true), action('SESSION_SECRET', false)] });
  });

  it('stops on a missing outside key and names it, planning nothing', async () => {
    expect(await plan({ JWT_SECRET: 'present' })).toEqual({ blocked: [expect.stringContaining('STRIPE_KEY')], missingOutsideKeys: ['STRIPE_KEY'] });
  });

  it('plans without a value for an outside key declared optional, and reports it so workloads leave it out', async () => {
    const result = await planEngineSecrets({
      environmentName: 'testing', generated: ['JWT_SECRET'], outside: ['STRIPE_KEY', 'SENTRY_DSN'], optional: ['STRIPE_KEY'],
      observe: async (key) => (({ JWT_SECRET: 'present', SENTRY_DSN: 'present' } as Record<string, 'present'>)[key] ?? 'absent'), action,
    });
    expect(result).toEqual({ actions: [action('JWT_SECRET', true)], unset: ['STRIPE_KEY'] });
  });

  it('still stops on a required key when an optional one is also missing', async () => {
    const result = await planEngineSecrets({
      environmentName: 'testing', generated: [], outside: ['STRIPE_KEY', 'SENTRY_DSN'], optional: ['STRIPE_KEY'], observe: async () => 'absent', action,
    });
    expect(result).toEqual({ blocked: [expect.stringContaining('SENTRY_DSN')], missingOutsideKeys: ['SENTRY_DSN'] });
  });

  it.each(['STRIPE_KEY', 'SESSION_SECRET'])('blocks instead of creating when %s cannot be read', async (key) => {
    const result = await plan({ STRIPE_KEY: 'present', JWT_SECRET: 'present', [key]: { unknown: 'The secret store could not be read.' } });
    expect(result).toEqual({ blocked: ['The secret store could not be read.'] });
  });
});

describe('shared engine plan recording', () => {
  const actions: PlanAction[] = [
    { id: 'secret:A', type: 'noop', verified: true, resource: { kind: 'secret', name: 'A', provider: 'aws' }, reason: 'stored' },
    { id: 'service:web', type: 'create', verified: true, resource: { kind: 'service', name: 'web', provider: 'aws' }, reason: 'create', metadata: { operation: 'engineImageRelease' } },
    { id: 'service:worker', type: 'update', verified: true, requiresConfirm: true, resource: { kind: 'service', name: 'worker', provider: 'aws' }, reason: 'replace', metadata: { operation: 'engineImageRelease' } },
  ];
  function record(confirm?: 'all') {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'engine-shared', defaultPlatform: 'aws' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'testing' });
    return recordEnginePlan({ projectId: project.id, environmentId: environment.id, environmentName: 'testing', specRevision: 3, actions,
      warnings: ['one warning'], engine: { planId: 'plan-1', aws: { accountId: '1' } }, ...(confirm ? { confirm } : {}) });
  }

  it('saves a loadable plan and asks to confirm only consequential actions', () => {
    const result = record();
    expect(result).toMatchObject({ environmentName: 'testing', specRevision: 3, warnings: ['one warning'], confirmActions: ['service:worker'] });
    const loaded = new ConvergeExecutor().loadPlan(result.planRunId);
    if ('error' in loaded) throw new Error(loaded.error);
    expect(loaded.document).toMatchObject({ scope: ENGINE_PLAN_SCOPE, environmentName: 'testing', specRevision: 3, engine: { planId: 'plan-1', aws: { accountId: '1' } } });
    expect(loaded.document.actions.map((item) => item.id)).toEqual(actions.map((item) => item.id));
  });

  it('confirms every action of a teardown', () => {
    const result = record('all');
    expect(result.confirmActions).toEqual(['secret:A', 'service:web', 'service:worker']);
    const saved = createCommandContext().repos.runs.findById(result.planRunId)!;
    expect(saved.plan).toMatchObject({ reviewConfirmActions: result.confirmActions });
    expect(readFileSync(runPlanReportPath(saved.id), 'utf8')).toContain('Need your OK <b>3</b>');
  });

  it.each([
    { gcpProjectId: 'demo-project', aws: { accountId: '111122223333', region: 'us-east-1' } },
    { state: { provider: 'gcp' }, aws: { accountId: '111122223333', region: 'us-east-1' } },
    { accountId: '111122223333', region: 'us-east-1' },
    { aws: { accountId: '111122223333', region: 'us-east-1' }, accountId: '222233334444' },
  ])('keeps a bare or conflicting saved target readable without choosing a console', (engine) => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'legacy-target' });
    const env = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
    const result = recordEnginePlan({ projectId: project.id, environmentId: env.id, environmentName: env.name,
      specRevision: 1, actions: [], warnings: [], engine });
    const html = readFileSync(runPlanReportPath(result.planRunId), 'utf8');
    expect(html).toContain('<dt>Target</dt><dd>');
    expect(html).not.toContain('href="https:');
  });

  it.each([
    { provider: 'gcp', target: 'reports-demo-project' },
    { provider: 'aws', target: '111122223333' },
    { provider: 'azure', target: '51b1a746-9a7d-4558-8b83-6d76d21775c5' },
  ])('reports the exact $provider target and action confirmations shown by its saved plan', ({ provider, target }) => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'report-test' });
    const env = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
    let planActions = actions;
    const engine = provider === 'gcp' ? { gcpProjectId: target }
      : provider === 'azure' ? { azure: { subscriptionId: target, resourceGroup: 'test-group' } }
      : { aws: { accountId: target, region: 'us-east-1' }, teardown: true };
    if (provider === 'gcp') {
      const bucket = 'uploads';
      const configuration = buildCloudRunConfiguration({ projectId: target, region: 'us-central1', services: [],
        runtimeServiceAccountEmail: `runtime@${target}.iam.gserviceaccount.com`,
        storage: [{ name: bucket, bucketName: 'reports-demo-uploads', location: 'us-central1', injectInto: [] }] });
      const parsed = parseEnginePlan(JSON.stringify({ resource_changes: [{ type: 'google_storage_bucket',
        address: `google_storage_bucket.${storageEngineKey(bucket)}`, change: { actions: ['create'], after: { name: 'reports-demo-uploads' } } }] }));
      const translated = translateEnginePlan({ provider, configuration, parsed, segment: { id: 'fixture', engine: 'opentofu',
        planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.12', providerVersions: {} } });
      expect(translated.blockers).toEqual([]);
      planActions = translated.actions;
    } else {
      planActions = actions.map(action => ({ ...action, resource: { ...action.resource, provider } }));
    }
    const result = recordEnginePlan({ projectId: project.id, environmentId: env.id, environmentName: env.name,
      specRevision: 1, actions: planActions, warnings: [], engine, ...(provider === 'aws' ? { confirm: 'all' } : {}) });
    const expected = provider === 'gcp' ? ['storage:uploads']
      : provider === 'aws' ? ['secret:A', 'service:web', 'service:worker'] : ['service:worker'];
    expect(result.confirmActions).toEqual(expected);
    function expectReview() {
      const html = readFileSync(runPlanReportPath(result.planRunId), 'utf8');
      const links = [...html.matchAll(/href="(https:[^"]+)"/g)].map(match => match[1]!);
      expect(links.some(link => link.includes(target))).toBe(true);
      if (provider === 'azure') expect(links.some(link => link.includes(target) && link.includes('test-group'))).toBe(true);
      const confirmed = [...html.matchAll(/<li id="action-\d+"[\s\S]*?<\/details><\/li>/g)]
        .map(([row]) => row).filter(row => row.includes('Needs your OK'))
        .map(row => /<dt>Action ID<\/dt><dd><code>([^<]+)<\/code>/.exec(row)?.[1]);
      expect(confirmed).toEqual(expected);
    }
    expectReview();
    // Also export the previous version's stored document without a frozen report confirmation list.
    const saved = ctx.repos.runs.findById(result.planRunId)!;
    const { reviewConfirmActions: _newField, ...legacy } = saved.plan as Record<string, unknown>;
    SqliteAdapter.getInstance().getDb().prepare('UPDATE runs SET plan = ? WHERE id = ?').run(JSON.stringify(legacy), saved.id);
    ctx.repos.runs.planReport(saved.id, true);
    expectReview();
  });
});
