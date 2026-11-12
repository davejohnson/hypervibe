import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { createCommandContext } from '../context.js';
import * as commandsModule from '../commands.js';
import { migrateEnvironment } from '../migrate.js';
import { launchEnvironment } from '../launch.js';
import { CommandRegistry } from '../commands.js';
import { registerHvLaunchTools } from '../../tools/hv-launch.tools.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import * as infrastructure from '../infrastructure-engine.js';
import * as dnsHosting from '../dns-hosting.js';
import * as engineSecrets from '../engine-secrets.js';
import * as cloudPrepare from '../../domain/services/cloud-prepare.js';
import * as preparation from '../../domain/services/cloud-prepare.execute.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-launch-plan-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in saved-plan regression'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture(secrets: Record<string, unknown> = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'saved-launch', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, secrets, environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  const commands = new CommandRegistry(); registerHvLaunchTools(commands, ctx);
  vi.spyOn(infrastructure, 'engineGcpAdapter').mockResolvedValue(new CloudRunAdapter());
  vi.spyOn(cloudPrepare, 'isCloudPreparedForRegion').mockReturnValue(true);
  const apply = vi.spyOn(infrastructure, 'applyInfrastructureEngine').mockResolvedValue({ kind: 'blocked', reason: 'SAVED_APPLY_REACHED' });
  const plan = vi.spyOn(infrastructure, 'planInfrastructureEngine');
  const saved = (reason: string, revision = 1, envName = 'staging') => {
    const action: PlanAction = { id: 'secret:JWT_SECRET', type: 'create', resource: { kind: 'secret', name: 'JWT_SECRET', provider: 'gcp' }, verified: true, billable: true, reason,
      metadata: { operation: infrastructure.ENGINE_SECRET_OPERATION, gcpProjectId: 'demo-project' } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'infrastructure-engine', environmentName: envName, specRevision: revision, observedFingerprint: null, actions: [action], engine: { planId: `artifact-${reason}` },
    } });
    return { planRunId: run.id, environmentName: envName, specRevision: revision, actions: [action], confirmActions: [action.id], warnings: [] };
  };
  return { ctx, project, spec, commands, saved, plan, apply };
}

describe('launch exact saved-plan approval', () => {
  it('routes an approved saved DNS artifact to its own engine without replanning hosting', async () => {
    const f = fixture();
    const environment = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
    const segment = { id: 'dns-segment', engine: 'opentofu' as const, planDigest: 'reviewed', configurationDigest: 'reviewed-config', engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    const action: PlanAction = { id: 'dns:google_dns_record_set.fixture', type: 'create', verified: true, requiresConfirm: true,
      resource: { kind: 'domain', provider: 'dns-gcp', name: 'app.example.com' }, reason: 'Reviewed DNS change',
      metadata: { operation: 'dnsEngine', domain: 'app.example.com', engineSegment: { ...segment, addresses: ['google_dns_record_set.fixture'] } } };
    const saved = dnsHosting.persistDnsPlanRun(f.ctx, { project: f.project, environment, environmentName: 'staging', specRevision: 1,
      prepared: { actions: [action], ready: false, descriptor: { version: 1, planId: 'private-dns-artifact', segment,
        state: { provider: 'dns-gcp', projectId: f.project.id, environmentId: environment.id, partition: 'environment' },
        zone: { provider: 'gcp', zoneId: 'dns-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } },
        owner: 'gcp-domain', domain: 'app.example.com', connectionId: 'dns-connection', zoneFingerprint: 'reviewed-zone', payloadEncrypted: 'private-payload' } },
      source: { kind: 'gcp-domain' } });
    if ('blocked' in saved) throw new Error(saved.blocked.join(' '));
    const apply = vi.spyOn(dnsHosting, 'applyDnsPlan').mockResolvedValue({ kind: 'blocked', reason: 'SAVED_DNS_APPLY_REACHED' });
    const result = await launchEnvironment(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      environmentName: 'staging', planId: saved.planRunId, confirmActions: saved.confirmActions });
    expect(result).toMatchObject({ status: 'blocked', message: 'SAVED_DNS_APPLY_REACHED' });
    expect(apply).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ planId: saved.planRunId }));
    expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });
  it('reviews missing outside-key containers before asking the user for their values', async () => {
    const f = fixture({ ACME_API_KEY: { ownership: 'delegated', principal: 'owner@example.com', environments: ['staging'] } });
    const reviewed = f.saved('Create the owned container before collecting ACME_API_KEY');
    f.plan.mockResolvedValue(reviewed);
    const collect = vi.spyOn(engineSecrets, 'collectOutsideKeys').mockResolvedValue({ status: 'blocked', message: 'Container is not ready' });
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging' });
    expect(result).toMatchObject({ ok: true, data: { status: 'needs_confirmation', planId: reviewed.planRunId } });
    expect(collect.mock.calls.length).toBe(0);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('applies the reviewed container plan, collects missing keys, and then replans before proceeding', async () => {
    const f = fixture({ ACME_API_KEY: { ownership: 'delegated', principal: 'owner@example.com', environments: ['staging'] } });
    const reviewed = f.saved('Reviewed outside-key container');
    const next = f.saved('Wire the newly saved outside key');
    f.apply.mockResolvedValue({ kind: 'executed', envName: 'staging', result: { success: true, applyRunId: 'applied', receipts: [] } });
    f.plan.mockResolvedValueOnce({ blocked: ['ACME_API_KEY needs a value'], missingOutsideKeys: ['ACME_API_KEY'] }).mockResolvedValueOnce(next);
    const collect = vi.spyOn(engineSecrets, 'collectOutsideKeys').mockResolvedValue({ status: 'collected', keys: ['ACME_API_KEY'] });
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(result).toMatchObject({ ok: true, data: { status: 'needs_confirmation', planId: next.planRunId } });
    expect(collect.mock.calls.map(([, params]) => params.keys)).toEqual([['ACME_API_KEY']]);
    expect(f.apply.mock.invocationCallOrder[0]).toBeLessThan(f.plan.mock.invocationCallOrder[0]!);
    expect(f.plan.mock.invocationCallOrder[0]).toBeLessThan(collect.mock.invocationCallOrder[0]!);
    expect(collect.mock.invocationCallOrder[0]).toBeLessThan(f.plan.mock.invocationCallOrder[1]!);
    expect(f.apply).toHaveBeenCalledOnce();
  });

  it('keeps an unrelated infrastructure blocker from starting outside-key collection', async () => {
    const f = fixture({ ACME_API_KEY: { ownership: 'delegated', principal: 'owner@example.com', environments: ['staging'] } });
    f.plan.mockResolvedValue({ blocked: ['Ownership is unknown'] });
    const collect = vi.spyOn(engineSecrets, 'collectOutsideKeys').mockResolvedValue({ status: 'collected', keys: ['ACME_API_KEY'] });
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging' });
    expect(result).toMatchObject({ ok: false, error: { message: 'Ownership is unknown' } });
    expect(collect.mock.calls.length).toBe(0);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('keeps billing selection separate from storage permission approval', async () => {
    const f = fixture();
    const spec = projectSpecSchema.parse({ ...f.spec, environments: { staging: {
      ...f.spec.environments.staging,
      storage: { uploads: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: [] } },
    } } });
    vi.spyOn(CloudRunAdapter.prototype, 'engineConnection').mockReturnValue({ projectId: 'fixture-project', credentials: '{}' });
    vi.spyOn(cloudPrepare, 'isCloudPreparedForStorage').mockReturnValue(false);
    const prepare = vi.spyOn(preparation, 'runCloudPrepare').mockResolvedValue({ success: true, mode: 'preview', planId: 'saved-storage-permissions' });
    const result = await launchEnvironment(f.ctx, { project: f.project, spec, specRevision: 1,
      environmentName: 'staging', billingAccountName: 'billingAccounts/existing-account', stopAfter: 'prepare' });
    expect(result).toMatchObject({ status: 'needs_access', accessId: 'storage', grants: { planId: 'saved-storage-permissions' } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ gcsAccess: 'lifecycle', confirm: false }));
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('returns the reviewed persisted plan identity with confirmation', async () => {
    const f = fixture(); const reviewed = f.saved('reviewed changes'); f.plan.mockResolvedValue(reviewed);
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { status: 'needs_confirmation', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions } });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('applies the saved artifact before planning again even when a new plan has the same action id', async () => {
    const f = fixture(); const reviewed = f.saved('reviewed changes'); const different = f.saved('changed cost or dependencies'); f.plan.mockResolvedValue(different);
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ planId: reviewed.planRunId, confirmActions: reviewed.confirmActions }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { message: 'SAVED_APPLY_REACHED' } });
  });

  it('rejects reusable action tokens without their reviewed plan identity', async () => {
    const f = fixture(); f.plan.mockResolvedValue(f.saved('new unreviewed plan'));
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', confirmActions: ['secret:JWT_SECRET'] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { message: expect.stringContaining('planId') } });
    expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });

  it.each(['revision', 'environment'] as const)('rejects a saved plan with changed %s before planning or applying', async change => {
    const f = fixture(); const reviewed = f.saved('reviewed changes', change === 'revision' ? 0 : 1, change === 'environment' ? 'production' : 'staging'); f.plan.mockResolvedValue(f.saved('replacement'));
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(change === 'revision' ? 'spec changed' : 'different project, environment') } }); expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });

  it('requires fresh approval when the next round repeats an action id with changed work', async () => {
    const f = fixture(); const reviewed = f.saved('first reviewed changes'); const next = f.saved('different subsequent dependencies');
    f.apply.mockResolvedValue({ kind: 'executed', envName: 'staging', result: { success: true, applyRunId: 'applied', receipts: [] } });
    f.plan.mockResolvedValue(next);
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(result).toMatchObject({ ok: true, data: { status: 'needs_confirmation', planId: next.planRunId, confirmActions: next.confirmActions } });
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.apply.mock.calls[0]![1].planId).toBe(reviewed.planRunId);
    expect(f.apply.mock.invocationCallOrder[0]).toBeLessThan(f.plan.mock.invocationCallOrder[0]!);
  });

  it('retains exact approval identity for pending apply continuation', async () => {
    const f = fixture(); const reviewed = f.saved('reviewed changes');
    f.apply.mockResolvedValue({ kind: 'executed', envName: 'staging', result: { success: false, applyRunId: 'pending', receipts: [{ actionId: 'secret:JWT_SECRET', status: 'pending', message: 'Still settling' }] } });
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(result).toMatchObject({ ok: true, data: { status: 'pending', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions } });
    expect(f.plan).not.toHaveBeenCalled();
  });

  it('does not apply an infrastructure noop', async () => {
    const f = fixture(); const noop = f.saved('nothing changes'); noop.actions = noop.actions.map((action) => ({ ...action, type: 'noop' })); noop.confirmActions = [];
    f.plan.mockResolvedValue(noop);
    const result = await launchEnvironment(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging', stopAfter: 'infrastructure' });
    expect(result).toMatchObject({ status: 'ready', phase: 'infrastructure' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });


  it('stops when the saved artifact is rejected before execution', async () => {
    const f = fixture(); const reviewed = f.saved('reviewed changes'); f.plan.mockResolvedValue(f.saved('replacement'));
    f.apply.mockResolvedValue({ kind: 'executed', envName: 'staging', result: { success: false, error: 'The reviewed plan expired.', receipts: [] } });
    const result = await f.commands.execute('hv_launch', { project: f.project.name, env: 'staging', planId: reviewed.planRunId, confirmActions: reviewed.confirmActions });
    expect(result).toMatchObject({ ok: false, error: { message: 'The reviewed plan expired.' } });
    expect(f.plan).not.toHaveBeenCalled();
  });


  it('routes a source cutover approval to its saved source artifact before planning', async () => {
    const f = fixture();
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
    const target = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'gcp', platformBindings: { engine: {
      kind: 'opentofu', importedSecrets: [], migration: { from: 'staging', copiedAt: '2026-01-01T00:00:00Z' },
    } } });
    const spec = projectSpecSchema.parse({ version: 1, project: f.project.name, environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} }, domain: 'app.example.com',
        domainTarget: { environment: 'gcp', service: 'web' }, maintenance: { enabled: true, mode: 'application', page: 'off' } },
      gcp: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
    } });
    new ProjectSpecRepository().insert(f.project.id, 2, spec);
    const action: PlanAction = { id: 'maintenance:staging:route', type: 'update', resource: { kind: 'maintenance', name: 'staging', provider: 'railway' }, verified: true, requiresConfirm: true, reason: 'Reviewed traffic route' };
    const saved = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: source.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: 2, observedFingerprint: null, actions: [action],
    } });
    vi.spyOn(infrastructure, 'resolveEngineContext').mockResolvedValue({ environment: target, gcpProjectId: 'demo-project' } as infrastructure.EngineContext);
    const sourceApply = vi.fn().mockResolvedValue({ ok: true, data: { applied: true } });
    const sourcePlan = vi.fn().mockResolvedValue({ ok: true, data: { planId: 'subsequent-noop', actions: [] } });
    vi.spyOn(commandsModule, 'createCommandRegistry').mockReturnValue({ get: (name: string) => ({ execute: name === 'hv_apply' ? sourceApply : sourcePlan }) } as unknown as ReturnType<typeof commandsModule.createCommandRegistry>);
    const result = await migrateEnvironment(f.ctx, { project: f.project, from: 'staging', to: 'gcp', cutover: true, planId: saved.id, confirmActions: [action.id] });
    expect(result).toMatchObject({ status: 'cut_over' });
    expect(sourceApply).toHaveBeenCalledWith({ project: f.project.id, planId: saved.id, confirmActions: [action.id] });
    expect(sourceApply.mock.invocationCallOrder[0]).toBeLessThan(sourcePlan.mock.invocationCallOrder[0]!);
    expect(f.apply).not.toHaveBeenCalled();
  });

});
