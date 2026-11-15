import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { PlanAction } from '../../plan/plan.types.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { IServiceVolumes, ServiceVolumeBinding, ServiceVolumeComponent, ServiceVolumeMutationReceipt, ServiceVolumeObservation, ServiceVolumeTarget } from '../../ports/service-volume.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { orderedVolumeComponents } from '../service-volume-components.js';
import { applyServiceVolumeAction, observeServiceVolumes, parseServiceVolumeBindings, planServiceVolumes } from '../service-volume.service.js';

// Synthetic shared-policy evidence, not provider transport or live compatibility.
// Independent contract: each reviewed component owns one mutation; omission is
// retain-only, exact observed identity gates dependencies, unknown writes survive.
const filesystem: ServiceVolumeComponent = { key: 'filesystem', dependsOn: [], operation: 'create', billable: true, description: 'Create retained storage.' };
const attachment: ServiceVolumeComponent = { key: 'attachment', dependsOn: ['filesystem'], operation: 'update', billable: false, description: 'Attach retained storage.' };
const target = (name: string): ServiceVolumeTarget => ({ projectId: 'project', environmentId: 'staging', serviceId: name, mountPath: '/data', instanceScope: { region: 'west' } });
afterEach(() => vi.restoreAllMocks());

function fixture(components = [filesystem, attachment]) {
  vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ lifecycle: { hosting: { serviceVolumes: { workloadKinds: ['web'], retention: 'retain-only' } } } } as never);
  const environment: Environment = { id: 'local-env', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(), platformBindings: {
    provider: 'railway', projectId: 'project', environmentId: 'staging', services: { web: { serviceId: 'web' }, api: { serviceId: 'api' } },
  } };
  const spec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: { volume: { mountPath: '/data' } } } });
  const state = new Map<string, ServiceVolumeObservation>();
  const resourceKey = (t: ServiceVolumeTarget, key: string) => components.find(c => c.key === key)?.sharedPrerequisite ? `shared:${key}` : `${t.serviceId}:${key}`;
  const observeComponent = vi.fn(async (t: ServiceVolumeTarget, key: string): Promise<ServiceVolumeObservation> => state.get(resourceKey(t, key)) ?? { state: 'absent' });
  const applyComponent = vi.fn(async (t: ServiceVolumeTarget, key: string): Promise<ServiceVolumeMutationReceipt> => {
    expect(parseServiceVolumeBindings(environment)?.[t.serviceId]?.components?.[key]).toEqual({ state: 'creating' });
    const externalId = resourceKey(t, key);
    state.set(externalId, { state: 'present', externalId, pendingDeletion: false });
    return { success: true, mutationAttempted: true, externalId };
  });
  const volumes: IServiceVolumes = {
    observe: vi.fn(), create: vi.fn(), staged: {
      resolveTarget: async ({ serviceName }) => target(serviceName), components: () => components,
      observeComponent, applyComponent,
    },
  };
  const save = vi.fn((bindings: Record<string, ServiceVolumeBinding>) => { environment.platformBindings.serviceVolumes = structuredClone(bindings); });
  const plan = async () => {
    const serviceVolumes = await observeServiceVolumes({ environment, environmentSpec: spec, volumes });
    return planServiceVolumes({ environment, environmentSpec: spec, observed: { serviceVolumes } as ObservedState });
  };
  const apply = (action: PlanAction, confirmed = true) => applyServiceVolumeAction({ environment, environmentSpec: spec, volumes, action, confirmedActionIds: new Set(confirmed ? [action.id] : []), save });
  return { environment, spec, state, volumes, save, plan, apply, observeComponent, applyComponent };
}

describe('staged filesystem safety boundaries', () => {
  it.each([
    [filesystem, filesystem],
    [{ ...filesystem, dependsOn: ['missing'] }],
    [{ ...filesystem, dependsOn: ['attachment'] }, attachment],
    [{ ...filesystem, key: 'constructor' }],
    [{ ...filesystem, key: '__proto__' }],
    [{ ...filesystem, sharedPrerequisite: true }],
    [{ ...attachment, dependsOn: [], sharedPrerequisite: 'yes' as unknown as boolean }],
  ])('rejects invalid or prototype-sensitive component DAGs: %j', (...components) => {
    expect(() => orderedVolumeComponents(components)).toThrow();
  });

  it('orders a valid graph without modifying its declaration', () => {
    const declaration = [attachment, filesystem];
    expect(orderedVolumeComponents(declaration).map(c => c.key)).toEqual(['filesystem', 'attachment']);
    expect(declaration[0]).toBe(attachment);
  });

  it.each<ServiceVolumeObservation>([
    { state: 'unknown', reason: 'permission denied' },
    { state: 'present', externalId: 'unowned', pendingDeletion: false },
  ])('blocks unknown or unowned prerequisites without downstream observation: %j', async (observation) => {
    const f = fixture();
    f.state.set('web:filesystem', observation);
    const { actions } = await f.plan();
    expect(actions).toHaveLength(1);
    expect(actions[0].metadata?.blockedReason).toBeDefined();
    expect(await f.apply(actions[0])).toMatchObject({ success: false });
    expect(f.observeComponent.mock.calls.every(([, key]) => key === 'filesystem')).toBe(true);
    expect(f.applyComponent).not.toHaveBeenCalled();
  });

  it('does not observe dependents when a bound prerequisite has a different live identity', async () => {
    const f = fixture();
    f.environment.platformBindings.serviceVolumes = { web: { provider: 'railway', target: target('web'), state: 'staged', components: { filesystem: { state: 'bound', externalId: 'expected' } } } };
    f.state.set('web:filesystem', { state: 'present', externalId: 'replacement', pendingDeletion: false });
    expect((await f.plan()).actions[0].metadata?.blockedReason).toBeDefined();
    expect(f.observeComponent.mock.calls.map(([, key]) => key)).toEqual(['filesystem']);
    expect(f.applyComponent).not.toHaveBeenCalled();
  });

  it('retains omitted intent without creating a missing component or accepting an old action', async () => {
    const f = fixture();
    await f.apply((await f.plan()).actions[0]);
    const stale = (await f.plan()).actions.find(a => a.type !== 'noop')!;
    delete f.spec.services.web.volume;
    const { actions, warnings } = await f.plan();
    expect(warnings.join(' ')).toContain('retained');
    expect(actions.filter(a => a.type !== 'noop').every(a => a.metadata?.blockedReason)).toBe(true);
    expect(await f.apply(stale)).toMatchObject({ success: false });
    expect(f.applyComponent).toHaveBeenCalledTimes(1);
  });

  it('preserves a fully ready retained filesystem as noops after intent is omitted', async () => {
    const f = fixture();
    await f.apply((await f.plan()).actions[0]);
    await f.apply((await f.plan()).actions.find(a => a.type !== 'noop')!);
    delete f.spec.services.web.volume;
    expect((await f.plan()).actions.map(a => a.type)).toEqual(['noop', 'noop']);
    expect(f.applyComponent).toHaveBeenCalledTimes(2);
  });

  it('permits a confirmed non-billable component create when fresh flags match', async () => {
    const f = fixture([{ ...filesystem, billable: false }]);
    const [action] = (await f.plan()).actions;
    expect(action).toMatchObject({ type: 'create', billable: false, dataBearing: true });
    expect(await f.apply(action)).toMatchObject({ success: true });
    expect(f.applyComponent).toHaveBeenCalledTimes(1);
  });

  it('requires persisted data-bearing authority for component update actions', async () => {
    const f = fixture();
    await f.apply((await f.plan()).actions[0]);
    const action = (await f.plan()).actions.find(a => a.type !== 'noop')!;
    expect(await f.apply({ ...action, dataBearing: false })).toMatchObject({ success: false });
    expect(f.applyComponent).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmation', 'requiresConfirm', 'component', 'scope', 'billable', 'operation'] as const)('rejects stale or forged %s before writing', async (field) => {
    const f = fixture();
    const action = (await f.plan()).actions[0];
    if (field === 'component') action.metadata = { ...action.metadata, component: 'attachment' };
    if (field === 'scope') action.metadata = { ...action.metadata, target: { ...target('web'), instanceScope: { region: 'east' } } };
    if (field === 'billable') action.billable = false;
    if (field === 'requiresConfirm') action.requiresConfirm = false;
    if (field === 'operation') action.metadata = { ...action.metadata, operation: 'serviceVolumeComponentFinalize' };
    expect(await f.apply(action, field !== 'confirmation')).toMatchObject({ success: false });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.applyComponent).not.toHaveBeenCalled();
  });

  it('performs no provider write when durable pre-write intent cannot be saved', async () => {
    const f = fixture();
    const action = (await f.plan()).actions[0];
    f.save.mockImplementation(() => { throw new Error('durable write failed'); });
    await expect(f.apply(action)).rejects.toThrow('durable write failed');
    expect(f.applyComponent).not.toHaveBeenCalled();
  });

  it('restores prior bindings only after an explicitly unattempted mutation', async () => {
    const f = fixture();
    f.applyComponent.mockResolvedValue({ success: false, mutationAttempted: false, externalId: 'unowned-race-candidate' });
    const action = (await f.plan()).actions[0];
    expect(await f.apply(action)).toMatchObject({ success: false });
    expect(parseServiceVolumeBindings(f.environment)).toEqual({});
    expect(f.save).toHaveBeenCalledTimes(2);
  });

  it('retains durable intent when a malformed receipt does not prove mutation was unattempted', async () => {
    const f = fixture();
    f.applyComponent.mockResolvedValue({ success: false } as ServiceVolumeMutationReceipt);
    const action = (await f.plan()).actions[0];
    expect(await f.apply(action)).toMatchObject({ success: false });
    expect(parseServiceVolumeBindings(f.environment)).toMatchObject({ web: { components: { filesystem: { state: 'creating' } } } });
  });

  it.each([{ ready: false, pendingDeletion: false }, { ready: true, pendingDeletion: true }])('retains acknowledged but non-ready resources: %j', async (flags) => {
    const f = fixture();
    f.applyComponent.mockImplementation(async () => {
      f.state.set('web:filesystem', { state: 'present', externalId: 'ack', ...flags });
      return { success: true, mutationAttempted: true, externalId: 'ack' };
    });
    expect(await f.apply((await f.plan()).actions[0])).toMatchObject({ success: false });
    expect(parseServiceVolumeBindings(f.environment)).toMatchObject({ web: { components: { filesystem: { state: 'identified', externalId: 'ack' } } } });
    expect((await f.plan()).actions).toHaveLength(1);
    expect(f.applyComponent).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate ownership of a ready shared prerequisite across services', async () => {
    const shared: ServiceVolumeComponent = { key: 'api', operation: 'update', billable: false, sharedPrerequisite: true, dependsOn: [], description: 'Enable shared API.' };
    const f = fixture([shared, { ...filesystem, dependsOn: ['api'] }]);
    expect(await f.apply((await f.plan()).actions[0])).toMatchObject({ success: true });
    f.spec.services.api = { workloadKind: 'web', volume: { mountPath: '/data' } };
    const actions = (await f.plan()).actions;
    expect(actions.find(a => a.id === 'volume:api:api')).toMatchObject({ type: 'noop' });
    expect(await f.apply(actions.find(a => a.id === 'volume:api:filesystem')!)).toMatchObject({ success: true });
    const bindings = parseServiceVolumeBindings(f.environment)!;
    expect(bindings.web.components?.api).toEqual({ state: 'bound', externalId: 'shared:api' });
    expect(bindings.api.components?.api).toBeUndefined();
    expect(f.applyComponent.mock.calls.filter(([, key]) => key === 'api')).toHaveLength(1);
  });

  it('rejects duplicate acknowledged ownership across service roots', () => {
    const f = fixture();
    f.environment.platformBindings.serviceVolumes = Object.fromEntries(['web', 'api'].map(name => [name, { provider: 'railway', target: target(name), state: 'staged', components: { filesystem: { state: 'bound', externalId: 'same-owned-resource' } } }]));
    expect(parseServiceVolumeBindings(f.environment)).toBeNull();
  });
});
