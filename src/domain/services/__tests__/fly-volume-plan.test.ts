import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlyAdapter } from '../../../adapters/providers/fly/fly.adapter.js';
import { formatFlyEnvironmentBinding, parseFlyServiceBinding } from '../../../adapters/providers/fly/fly.binding.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../../plan/plan.service.js';
import { adapterFactory } from '../adapter.factory.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';

beforeEach(() => { vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(':memory:').migrate(); });
afterEach(() => { SqliteAdapter.resetInstance(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Stateful synthetic HTTP shapes from Fly Machines docs. This tests the real
// serialized adapter composed with SQLite/plan/apply, not live compatibility.
it.each([false, true])('stages namespace, disk, then Machine; stripped confirmation=%s', async (stripConfirmation) => {
  let app: any;
  let disk: any;
  let machine: any;
  const mutations: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST') {
      mutations.push(path);
      const body = JSON.parse(String(init.body));
      if (path === '/v1/apps') {
        app = { id: 'app-ack', name: body.app_name, organization: { slug: 'example' } };
        return Response.json({ id: app.id });
      }
      if (path.endsWith('/volumes')) {
        expect(machine).toBeUndefined();
        disk = { id: 'vol_ack', name: 'data', region: 'ord', size_gb: 1, encrypted: true, state: 'created', attached_machine_id: null };
        return Response.json(disk);
      }
      if (path.endsWith('/machines')) {
        expect(disk?.id).toBe('vol_ack');
        expect(body.config.mounts).toEqual([{ volume: 'vol_ack', path: '/data' }]);
        machine = { id: 'machine-ack', instance_id: 'machine-version', state: 'created', config: body.config };
        disk.attached_machine_id = machine.id;
        return Response.json(machine);
      }
      throw new Error(`Unexpected mutation ${path}`);
    }
    if (path === '/v1/apps') return Response.json({ apps: app ? [app] : [] });
    if (path.endsWith('/machines')) return Response.json(machine ? [machine] : []);
    if (path.endsWith('/machines/machine-ack')) return Response.json(machine);
    if (path.endsWith('/volumes')) return Response.json(disk ? [disk] : []);
    if (path.endsWith('/volumes/vol_ack')) return Response.json(disk);
    if (path.endsWith('/secrets')) return Response.json({ secrets: [] });
    if (path.endsWith('/certificates')) return Response.json({ certificates: [] });
    if (path.endsWith('/ip_assignments')) return Response.json({ ips: [] });
    if (app && path === `/v1/apps/${app.name}`) return Response.json(app);
    if (path.startsWith('/v1/apps/')) return new Response('', { status: 404 });
    throw new Error(`Unexpected read ${path}`);
  }));
  const project = new ProjectRepository().create({ name: 'planner', defaultPlatform: 'fly' });
  new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: { builder: 'dockerfile' } });
  const repo = new EnvironmentRepository();
  const environmentId = formatFlyEnvironmentBinding({ organizationSlug: 'example', projectName: 'planner', environmentName: 'staging' });
  const environment = repo.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'fly', projectId: 'flyorg:example', environmentId, services: {} } });
  new SpecStore().replace(project, { version: 1, project: project.name, environments: { staging: {
    hosting: { provider: 'fly', region: 'ord' }, services: { web: { public: false, volume: { mountPath: '/data' } } }, deploy: { strategy: 'manual' },
  } } });
  const adapter = new FlyAdapter();
  await adapter.connect({ apiToken: 'synthetic-token', organizationSlug: 'example' });
  adapter.configureTarget({ region: 'ord' });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: adapter as never });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'fly', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token', organizationSlug: 'example' }) });
  connections.updateStatus(connection.id, 'verified');
  const stage = async (scope: string) => {
    const plan = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    expect(plan).not.toHaveProperty('error');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.scope).toBe(scope);
    if (stripConfirmation && disk && !machine && scope === 'hosting-bindings') {
      const runs = new RunRepository();
      const persisted = runs.findById(plan.planRunId)!;
      const document = persisted.plan as any;
      document.actions = document.actions.map((action: any) => action.resource.kind === 'service'
        ? { ...action, requiresConfirm: false, billable: false, dataBearing: false } : action);
      runs.updatePlan(plan.planRunId, document);
      const current = new SpecStore().get(project)!;
      const denied = await executePlanApply(createToolContext(), { project, spec: current.spec, specRevision: current.revision, planId: plan.planRunId, confirmActions: [] });
      expect(denied).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(machine).toBeUndefined();
      return;
    }
    const current = new SpecStore().get(project)!;
    const outcome = await executePlanApply(createToolContext(), { project, spec: current.spec, specRevision: current.revision,
      planId: plan.planRunId, confirmActions: plan.actions.filter(a => a.requiresConfirm).map(a => a.id) });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'executed', result: { success: true } });
  };
  await stage('hosting-bindings');
  expect(mutations).toEqual(['/v1/apps']);
  expect(parseFlyServiceBinding((repo.findById(environment.id)!.platformBindings.services as any).web.serviceId).machineId).toBeUndefined();
  await stage('service-volumes');
  expect(mutations).toEqual(['/v1/apps', `/v1/apps/${app.name}/volumes`]);
  await stage('hosting-bindings');
  if (stripConfirmation) {
    expect(mutations).toEqual(['/v1/apps', `/v1/apps/${app.name}/volumes`]);
    return;
  }
  expect(mutations).toEqual(['/v1/apps', `/v1/apps/${app.name}/volumes`, `/v1/apps/${app.name}/machines`]);
  expect(parseFlyServiceBinding((repo.findById(environment.id)!.platformBindings.services as any).web.serviceId).machineId).toBe('machine-ack');
  const finalPlan = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
  expect(finalPlan).not.toHaveProperty('error');
  if ('error' in finalPlan) return;
  expect(finalPlan.actions.filter(a => a.resource.kind === 'volume').every(a => a.type === 'noop')).toBe(true);
});
