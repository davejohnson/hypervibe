import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeServiceVolumes, planServiceVolumes, applyServiceVolumeAction, parseServiceVolumeBindings } from '../service-volume.service.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { IServiceVolumes } from '../../ports/service-volume.port.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';

// Shared orchestration policy fixture, NOT provider API compatibility evidence.
// Requirement: each resource has its own reviewed action and durable write intent.
const target = { projectId: 'project', environmentId: 'staging', serviceId: 'app', mountPath: '/data', instanceScope: { account: 'account-1', region: 'region-1' } };
const spec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: { volume: { mountPath: '/data' } } } });
let environment: Environment;
let writes: string[];
let existing: Map<string, { id: string; ready: boolean }>;
let driver: IServiceVolumes;
let lostResponse: string | undefined;
let unknown: string | undefined;

beforeEach(() => {
  environment = { id: 'env', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'railway', projectId: 'project', environmentId: 'staging', services: { web: { serviceId: 'app' } } } };
  writes = []; existing = new Map(); lostResponse = undefined; unknown = undefined;
  vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ lifecycle: { hosting: { serviceVolumes: { workloadKinds: ['web'], retention: 'retain-only' } } } } as never);
  driver = {
    observe: async () => { throw new Error('legacy path must not be called'); },
    create: async () => { throw new Error('legacy path must not be called'); },
    staged: {
      resolveTarget: async () => target,
      components: () => [
        { key: 'filesystem', dependsOn: [], operation: 'create', billable: true, description: 'Create retained filesystem.' },
        { key: 'attachment', dependsOn: ['filesystem'], operation: 'update', billable: false, description: 'Attach exact filesystem to bound app.' },
      ],
      observeComponent: async (_target: unknown, key: string) => {
        if (unknown === key) return { state: 'unknown', reason: 'synthetic permission failure' };
        const resource = existing.get(key);
        return resource ? { state: 'present', externalId: resource.id, pendingDeletion: false, ready: resource.ready } : { state: 'absent' };
      },
      applyComponent: async (_target: unknown, key: string) => {
        expect((environment.platformBindings.serviceVolumes as any).web.components[key]).toEqual({ state: 'creating' });
        writes.push(key);
        const id = `acknowledged-${key}`;
        existing.set(key, { id, ready: true });
        if (lostResponse === key) throw new Error('synthetic dropped response');
        return { success: true, externalId: id, mutationAttempted: true };
      },
    },
  } as IServiceVolumes;
});
afterEach(() => vi.restoreAllMocks());

async function plan() {
  const serviceVolumes = await observeServiceVolumes({ environment, environmentSpec: spec, volumes: driver });
  return planServiceVolumes({ environment, environmentSpec: spec, observed: { serviceVolumes } as ObservedState }).actions;
}
async function apply(action: PlanAction, confirmed = true) {
  return applyServiceVolumeAction({ environment, environmentSpec: spec, action, volumes: driver,
    confirmedActionIds: new Set(confirmed ? [action.id] : []),
    save: (serviceVolumes) => { environment = { ...environment, platformBindings: { ...environment.platformBindings, serviceVolumes } }; },
  });
}

describe('component-scoped retained filesystems', () => {
  it('rejects credential-shaped scope fields before repository export', () => {
    for (const instanceScope of [{ apiToken: 'must-not-export' }, { password: 'must-not-export' }, { region: 'https://user:secret@example.com' }]) {
      environment.platformBindings.serviceVolumes = { web: { provider: 'railway', target: { ...target, instanceScope }, state: 'staged', components: {} } };
      expect(parseServiceVolumeBindings(environment)).toBeNull();
    }
  });
  it('plans only the ready frontier and never hides attachment inside a filesystem create', async () => {
    const initial = await plan();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ id: 'volume:web:filesystem', type: 'create', billable: true, requiresConfirm: true });
    expect(resolvePlanActionAuthority(initial[0])?.capability).toBe('hosting.volume.mutate');
    expect(await apply(initial[0], false)).toMatchObject({ success: false });
    expect(writes).toEqual([]);
    expect(await apply(initial[0])).toMatchObject({ success: true });
    expect(writes).toEqual(['filesystem']);
    expect(parseServiceVolumeBindings(environment)).toMatchObject({ web: { state: 'staged', components: { filesystem: { state: 'bound', externalId: 'acknowledged-filesystem' } } } });
    const next = await plan();
    expect(next.map(a => [a.id, a.type])).toEqual([['volume:web:filesystem', 'noop'], ['volume:web:attachment', 'update']]);
    expect(await apply(next[1])).toMatchObject({ success: true });
    expect((await plan()).every(a => a.type === 'noop')).toBe(true);
    expect(writes).toEqual(['filesystem', 'attachment']);
  });

  it('retains ambiguous component intent and never adopts by deterministic name', async () => {
    lostResponse = 'filesystem';
    const [action] = await plan();
    expect(await apply(action)).toMatchObject({ success: false });
    expect(environment.platformBindings.serviceVolumes).toMatchObject({ web: { components: { filesystem: { state: 'creating' } } } });
    expect((await plan())[0].metadata?.blockedReason).toBeDefined();
    expect(await apply(action)).toMatchObject({ success: false });
    expect(writes).toEqual(['filesystem']);
  });

  it('does not equate allocated backing storage with ready storage or a mounted workload', async () => {
    const [action] = await plan();
    const original = (driver as any).staged.applyComponent;
    (driver as any).staged.applyComponent = async (...args: unknown[]) => {
      const receipt = await original(...args);
      existing.get('filesystem')!.ready = false;
      return receipt;
    };
    expect(await apply(action)).toMatchObject({ success: false });
    expect(environment.platformBindings.serviceVolumes).toMatchObject({ web: { components: { filesystem: { state: 'identified', externalId: 'acknowledged-filesystem' } } } });
    expect((await plan())[0].metadata?.blockedReason).toBeDefined();
    existing.get('filesystem')!.ready = true;
    const [recover] = await plan();
    expect(recover.metadata?.operation).toBe('serviceVolumeComponentFinalize');
    expect(await apply(recover)).toMatchObject({ success: true });
    expect(writes).toEqual(['filesystem']);
    expect((await plan()).find(a => a.id.endsWith(':attachment'))?.type).toBe('update');
  });

  it('blocks unowned resources, unknown reads, scope changes and forged component authority', async () => {
    existing.set('filesystem', { id: 'someone-elses-filesystem', ready: true });
    expect((await plan())[0].metadata?.blockedReason).toBeDefined();
    existing.clear();
    unknown = 'filesystem';
    expect((await plan())[0].metadata?.blockedReason).toBeDefined();
    unknown = undefined;
    const [action] = await plan();
    expect(await apply({ ...action, metadata: { ...action.metadata, component: 'attachment' } })).toMatchObject({ success: false });
    expect(await apply({ ...action, metadata: { ...action.metadata, target: { ...target, instanceScope: { ...target.instanceScope, account: 'other-account' } } } })).toMatchObject({ success: false });
    expect(writes).toEqual([]);
  });

  it('does not lose acknowledged resources when a later component fails', async () => {
    await apply((await plan())[0]);
    const attachment = (await plan()).find(a => a.type !== 'noop')!;
    lostResponse = 'attachment';
    expect(await apply(attachment)).toMatchObject({ success: false });
    expect(parseServiceVolumeBindings(environment)).toMatchObject({ web: { components: {
      filesystem: { state: 'bound', externalId: 'acknowledged-filesystem' }, attachment: { state: 'creating' },
    } } });
    expect((await plan()).filter(a => a.type === 'create')).toEqual([]);
    expect(writes).toEqual(['filesystem', 'attachment']);
  });
});
