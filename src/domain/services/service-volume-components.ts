import type { PlanAction } from '../plan/plan.types.js';
import type { IStagedServiceVolumes, ObservedServiceVolume, ServiceVolumeBinding, ServiceVolumeComponent, ServiceVolumeComponentBinding, ServiceVolumeObservation, ServiceVolumeTarget } from '../ports/service-volume.port.js';

export const COMPONENT_OPERATIONS = { apply: 'serviceVolumeComponentApply', finalize: 'serviceVolumeComponentFinalize' } as const;

/** Validate the provider-owned DAG before observation or mutation. */
export function orderedVolumeComponents(components: ServiceVolumeComponent[]): ServiceVolumeComponent[] {
  const remaining = new Map<string, ServiceVolumeComponent>();
  for (const c of components) {
    if (typeof c.key !== 'string' || !/^[a-z][a-z0-9-]*$/.test(c.key) || Object.hasOwn(Object.prototype, c.key)
      || remaining.has(c.key) || typeof c.description !== 'string' || !c.description.trim()
      || !['create', 'update'].includes(c.operation) || typeof c.billable !== 'boolean'
      || !Array.isArray(c.dependsOn) || new Set(c.dependsOn).size !== c.dependsOn.length
      || (c.sharedPrerequisite !== undefined && typeof c.sharedPrerequisite !== 'boolean')
      || (c.sharedPrerequisite && c.operation !== 'update')) throw new Error('Invalid volume component contract.');
    remaining.set(c.key, c);
  }
  const ordered: ServiceVolumeComponent[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(c => c.dependsOn.every(d => ordered.some(p => p.key === d)));
    if (!ready.length) throw new Error('Unknown or cyclic volume component dependency.');
    for (const c of ready) { ordered.push(c); remaining.delete(c.key); }
  }
  if (!ordered.length) throw new Error('A staged volume requires components.');
  return ordered;
}

function ready(observation: ServiceVolumeObservation): boolean {
  return observation.state === 'present' && !observation.pendingDeletion && observation.ready !== false;
}

export async function observeVolumeComponents(driver: IStagedServiceVolumes, target: ServiceVolumeTarget, binding?: ServiceVolumeBinding): Promise<NonNullable<ObservedServiceVolume['components']>> {
  if (binding && binding.state !== 'staged') throw new Error('Cannot reinterpret a retained volume lifecycle.');
  const components = orderedVolumeComponents(driver.components(target));
  const retained = binding?.components ?? {};
  if (Object.keys(retained).some(key => !components.some(c => c.key === key))) throw new Error('Retained component omitted by adapter contract.');
  const observed: NonNullable<ObservedServiceVolume['components']> = [];
  for (const component of components) {
    const prerequisitesReady = component.dependsOn.every(key => {
      const dependency = observed.find(o => o.component.key === key)!;
      const binding = Object.hasOwn(retained, key) ? retained[key] : undefined;
      return ready(dependency.observation) && (binding
        ? binding.state === 'bound' && dependency.observation.state === 'present' && dependency.observation.externalId === binding.externalId
        : dependency.component.sharedPrerequisite === true);
    });
    let observation: ServiceVolumeObservation = { state: 'unknown', reason: 'Apply and verify the prerequisite component, then re-plan.' };
    if (prerequisitesReady) {
      try { observation = await driver.observeComponent(target, component.key, retained); }
      catch { observation = { state: 'unknown', reason: 'Filesystem component observation failed; retained identity is preserved.' }; }
    }
    observed.push({ component, observation });
  }
  return observed;
}

/** Emit only the current frontier. Dependent creation needs a fresh reviewed plan. */
export function planVolumeComponents(name: string, live: ObservedServiceVolume): PlanAction[] {
  const actions: PlanAction[] = [];
  const retained = live.binding?.components ?? {};
  for (const { component, observation } of live.components ?? []) {
    if (!component.dependsOn.every(key => actions.some(a => a.metadata?.component === key && a.type === 'noop'))) continue;
    const binding = Object.hasOwn(retained, component.key) ? retained[component.key] : undefined;
    let blocked: string | undefined;
    let operation: string = COMPONENT_OPERATIONS.apply;
    let type: PlanAction['type'] = component.operation;
    let reason = component.description;
    if (binding?.state === 'creating') blocked = 'An earlier component write has an unresolved outcome. Automatic retry and name-based adoption are forbidden.';
    else if (observation.state === 'unknown') blocked = observation.reason;
    else if (observation.state === 'present' && !ready(observation)) blocked = 'The exact component is not ready or is pending deletion; wait and re-plan.';
    else if (binding) {
      if (observation.state !== 'present' || observation.externalId !== binding.externalId) blocked = 'The exact retained component is missing or changed; replacement is forbidden.';
      else if (binding.state === 'identified') { type = 'update'; operation = COMPONENT_OPERATIONS.finalize; reason = 'Finalize the acknowledged component after exact observation; no provider mutation.'; }
      else { type = 'noop'; reason = 'Exact retained filesystem component verified (control plane only).'; }
    } else if (observation.state === 'present') {
      if (component.sharedPrerequisite) { type = 'noop'; reason = 'Shared prerequisite is ready; no ownership or teardown authority acquired.'; }
      else blocked = 'An unbound filesystem component exists. Automatic adoption is forbidden.';
    }
    actions.push({ id: `volume:${name}:${component.key}`, resource: { kind: 'volume', name, provider: live.provider }, type,
      verified: !blocked, reason: blocked ?? reason,
      dependsOn: component.dependsOn.map(key => `volume:${name}:${key}`),
      ...(type !== 'noop' ? { requiresConfirm: true, dataBearing: true, billable: component.billable } : {}),
      metadata: { operation, component: component.key, target: live.target, ...(binding?.externalId ? { externalId: binding.externalId } : {}), ...(blocked ? { blockedReason: 'service_volume_not_converged' } : {}) },
    });
  }
  return actions;
}

export async function applyVolumeComponent(params: {
  driver: IStagedServiceVolumes; action: PlanAction; retained: Record<string, ServiceVolumeBinding>;
  save: (bindings: Record<string, ServiceVolumeBinding>) => void;
}): Promise<{ success: boolean; status?: 'blocked'; message: string }> {
  const { driver, action, retained, save } = params;
  const name = action.resource.name;
  const key = action.metadata!.component as string;
  const target = action.metadata!.target as ServiceVolumeTarget;
  const components = retained[name]?.components ?? {};
  const persist = (next: Record<string, ServiceVolumeComponentBinding>) => save({ ...retained, [name]: { provider: action.resource.provider, target, state: 'staged', components: next } });
  if (action.metadata?.operation === COMPONENT_OPERATIONS.finalize) {
    persist({ ...components, [key]: { ...components[key], state: 'bound' } });
    return { success: true, message: 'Exact acknowledged component finalized without provider mutation. Re-plan remaining prerequisites.' };
  }
  persist({ ...components, [key]: { state: 'creating' } });
  const block = (message: string) => ({ success: false, status: 'blocked' as const, message });
  let receipt;
  try { receipt = await driver.applyComponent(target, key, components); }
  catch { return block('Component write outcome is unknown. Durable intent retained; automatic retry is blocked.'); }
  if (receipt.externalId && receipt.mutationAttempted === true) {
    const identified = { ...components, [key]: { state: 'identified' as const, externalId: receipt.externalId } };
    persist(identified);
    let observation: ServiceVolumeObservation;
    try { observation = await driver.observeComponent(target, key, identified); }
    catch { return block('Acknowledged component retained; observation failed. Re-plan for exact recovery.'); }
    if (ready(observation) && observation.state === 'present' && observation.externalId === receipt.externalId) {
      persist({ ...identified, [key]: { ...identified[key], state: 'bound' } });
      return { success: true, message: 'Exact component verified. Re-plan before dependent infrastructure or deployment; live filesystem durability remains unverified.' };
    }
  } else if (receipt.mutationAttempted === false) save(retained);
  return block('Filesystem component not verified. Retained intent and acknowledged identities prevent duplicate creation.');
}
