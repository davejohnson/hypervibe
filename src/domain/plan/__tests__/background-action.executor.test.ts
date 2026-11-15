import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConvergeExecutor, type PlanRunDocument } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import type { ActionResult } from '../converge.executor.js';
import type { EngineActionSegment, EngineSegmentResult } from '../../ports/infrastructure-engine.port.js';

let projectId: string;
let environmentId: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-background-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  projectId = new ProjectRepository().create({ name: 'background' }).id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'demo' }).id;
});

const segment = (planId: string, address: string): EngineActionSegment => ({
  id: `opentofu:${planId}`, engine: 'opentofu', planDigest: 'p', configurationDigest: 'c', engineVersion: '1.13.9', providerVersions: {}, addresses: [address],
});

const action = (id: string, extra: Partial<PlanAction> = {}): PlanAction => ({
  id, type: 'create', resource: { kind: 'service', name: id.split(':')[1]!, provider: 'aws' }, verified: true, reason: id, ...extra,
});

// The shared cluster (background engine plan), the environment (engine plan), the image build and the login that needs the cluster.
const plan = (): PlanAction[] => [
  action('shared:database', { background: true, metadata: { engineSegment: segment('shared', 'aws_rds_cluster.postgres') } }),
  action('build:image', { metadata: { operation: 'awsImageBuild' } }),
  action('service:web', { metadata: { engineSegment: segment('main', 'aws_lambda_function.web') } }),
  action('database-login:postgres', { dependsOn: ['shared:database'], metadata: { operation: 'awsDatabaseLoginEnsure' } }),
];

function storePlan(actions: PlanAction[]): string {
  const document = { kind: 'hv_plan', scope: 'infrastructure-engine', engine: { planId: 'main' }, environmentName: 'demo', specRevision: 1, observedFingerprint: null, actions } as PlanRunDocument;
  return new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(cluster: EngineSegmentResult) {
  const events: string[] = [];
  const clusterDone = deferred<EngineSegmentResult>();
  const executor = new ConvergeExecutor();
  const run = executor.execute({
    planRunId: storePlan(plan()), currentSpecRevision: 1,
    handler: async (planned): Promise<ActionResult> => { events.push(planned.id); return { success: true, message: 'ok' }; },
    segmentHandler: async (seg) => {
      if (seg.id === 'opentofu:shared') { events.push('cluster:start'); const result = await clusterDone.promise; events.push('cluster:end'); return result; }
      events.push('service:web');
      return { outcomes: { 'aws_lambda_function.web': 'succeeded' }, diagnostics: [] };
    },
  });
  return { events, run, finishCluster: () => clusterDone.resolve(cluster) };
}

describe('background plan actions', () => {
  it('runs independent work while the background action runs, and holds its dependents', async () => {
    const { events, run, finishCluster } = harness({ outcomes: { 'aws_rds_cluster.postgres': 'succeeded' }, diagnostics: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['cluster:start', 'build:image', 'service:web']);
    finishCluster();
    const result = await run;
    expect(events).toEqual(['cluster:start', 'build:image', 'service:web', 'cluster:end', 'database-login:postgres']);
    expect(result.success).toBe(true);
    expect(Object.fromEntries(result.receipts.map((r) => [r.actionId, r.status]))).toEqual({
      'shared:database': 'succeeded', 'build:image': 'succeeded', 'service:web': 'succeeded', 'database-login:postgres': 'succeeded',
    });
  });

  it('skips its dependents when the background action fails, and apply fails', async () => {
    const { events, run, finishCluster } = harness({ outcomes: { 'aws_rds_cluster.postgres': 'failed' }, diagnostics: ['quota'] });
    await new Promise((r) => setTimeout(r, 20));
    finishCluster();
    const result = await run;
    expect(events).not.toContain('database-login:postgres');
    expect(result.success).toBe(false);
    expect(Object.fromEntries(result.receipts.map((r) => [r.actionId, r.status]))).toMatchObject({
      'shared:database': 'failed', 'database-login:postgres': 'aborted',
    });
  });
});
