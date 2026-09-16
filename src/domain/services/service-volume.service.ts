import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IServiceVolumes, ObservedServiceVolume, ServiceVolumeBinding, ServiceVolumeObservation, ServiceVolumeTarget } from '../ports/service-volume.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { providerRegistry } from '../registry/provider.registry.js';

export const SERVICE_VOLUME_OPERATIONS = { create: 'serviceVolumeCreate', finalize: 'serviceVolumeFinalize' } as const;
const targetSchema = z.object({ projectId: z.string().min(1), environmentId: z.string().min(1), serviceId: z.string().min(1), mountPath: z.string().min(1) }).strict();
const bindingSchema = z.object({
  provider: z.string().min(1), target: targetSchema,
  state: z.enum(['creating', 'identified', 'bound']), externalId: z.string().min(1).optional(),
}).strict().refine((v) => v.state === 'creating' ? v.externalId === undefined : Boolean(v.externalId));
const bindingsSchema = z.record(bindingSchema);
type VolumeEnvironment = Pick<Environment, 'platformBindings'> | null;

export function hasRetainedServiceVolumes(environment: VolumeEnvironment): boolean {
  const raw = environment?.platformBindings.serviceVolumes;
  return raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 0);
}

export function parseServiceVolumeBindings(environment: VolumeEnvironment): Record<string, ServiceVolumeBinding> | null {
  const parsed = bindingsSchema.safeParse(environment?.platformBindings.serviceVolumes ?? {});
  // A null/corrupt marker must not become proof that no retained disk exists.
  if (environment?.platformBindings.serviceVolumes === null) return null;
  if (!parsed.success) return null;
  const ids = Object.values(parsed.data).flatMap((b) => b.externalId ? [`${b.provider}:${b.target.projectId}:${b.externalId}`] : []);
  if (new Set(ids).size !== ids.length) return null;
  return parsed.data;
}
const bindings = parseServiceVolumeBindings;

function targetFor(environment: VolumeEnvironment, name: string, mountPath: string): ServiceVolumeTarget | undefined {
  const raw = environment?.platformBindings;
  const serviceMap = raw?.services as Record<string, { serviceId?: string }> | undefined;
  const parsed = targetSchema.safeParse({ projectId: raw?.projectId, environmentId: raw?.environmentId, serviceId: serviceMap?.[name]?.serviceId, mountPath });
  return parsed.success ? parsed.data : undefined;
}

function sameTarget(a: ServiceVolumeTarget | undefined, b: ServiceVolumeTarget | undefined): boolean {
  return Boolean(a && b && a.projectId === b.projectId && a.environmentId === b.environmentId && a.serviceId === b.serviceId && a.mountPath === b.mountPath);
}

export async function observeServiceVolumes(params: {
  environment: VolumeEnvironment; environmentSpec: EnvironmentSpec; volumes?: IServiceVolumes;
}): Promise<Record<string, ObservedServiceVolume>> {
  const { environment, environmentSpec, volumes } = params;
  const provider = environmentSpec.hosting.provider;
  const retained = bindings(environment);
  if (!retained) return { __invalid__: { provider, observation: { state: 'unknown', reason: 'Malformed or duplicate retained volume identity; repair state before continuing.' } } };
  const names = new Set([...Object.keys(retained), ...Object.entries(environmentSpec.services).filter(([, s]) => s.volume).map(([n]) => n)]);
  const result: Record<string, ObservedServiceVolume> = Object.create(null);
  for (const name of [...names].sort()) {
    const binding = Object.hasOwn(retained, name) ? retained[name] : undefined;
    const desired = environmentSpec.services[name]?.volume;
    const target = targetFor(environment, name, desired?.mountPath ?? binding?.target.mountPath ?? '');
    const item: ObservedServiceVolume = { provider, target, binding, observation: { state: 'unknown', reason: 'Hosting project, environment and service must be bound first; apply the identity stage and re-plan.' } };
    result[name] = item;
    if (!target) continue;
    const service = environmentSpec.services[name];
    if (service && !providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.serviceVolumes?.workloadKinds.includes(service.workloadKind)) {
      item.observation = { state: 'unknown', reason: 'The retained volume does not support the desired workload kind; removing volume intent does not permit converting its service.' };
      continue;
    }
    if (environment?.platformBindings.provider !== provider || (binding && (binding.provider !== provider || !sameTarget(binding.target, target)))) {
      item.observation = { state: 'unknown', reason: 'Retained volume scope or mount path changed; moving mounts and hosting scopes is not supported.' };
      continue;
    }
    if (!volumes) {
      item.observation = { state: 'unknown', reason: 'Hosting adapter does not support service-volume observation.' };
      continue;
    }
    try { item.observation = await volumes.observe(target, binding?.externalId); }
    catch { item.observation = { state: 'unknown', reason: 'Service-volume observation failed; retained identity is preserved.' }; }
  }
  return result;
}

export function planServiceVolumes(params: {
  environment: VolumeEnvironment; environmentSpec: EnvironmentSpec; observed: ObservedState | null;
}): { actions: PlanAction[]; warnings: string[] } {
  const { environment, environmentSpec, observed } = params;
  const retained = bindings(environment);
  const names = new Set([...Object.keys(retained ?? { __invalid__: true }), ...Object.entries(environmentSpec.services).filter(([, s]) => s.volume).map(([n]) => n)]);
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  for (const name of [...names].sort()) {
    const desired = environmentSpec.services[name]?.volume;
    const binding = retained && Object.hasOwn(retained, name) ? retained[name] : undefined;
    const live = observed?.serviceVolumes?.[name];
    const observation = live?.observation;
    let blocked: string | undefined;
    let type: PlanAction['type'] = 'update';
    let operation: string = SERVICE_VOLUME_OPERATIONS.create;
    let reason = 'Create a retained filesystem volume at the reviewed mount path.';
    if (!desired && binding) warnings.push(`Volume ${name} is retained (and may remain billable) despite omitted intent. Hypervibe does not delete, detach, adopt or move service volumes.`);
    if (!retained) blocked = 'Malformed or duplicate retained volume bindings.';
    else if (!live?.target || !observation || observation.state === 'unknown') blocked = observation?.state === 'unknown' ? observation.reason : 'Volume observation is unavailable; bind the service and re-plan.';
    else if (binding?.state === 'creating') blocked = 'An earlier create has an unresolved outcome without an acknowledged ID. Investigate the exact provider resource; automatic retry/adoption is forbidden.';
    else if (observation.state === 'present' && observation.pendingDeletion) blocked = 'The volume is pending deletion; attachment is not converged.';
    else if (binding) {
      if (observation.state !== 'present' || observation.externalId !== binding.externalId || !sameTarget(live.target, binding.target)) blocked = 'The exact retained volume is missing or changed; automatic replacement with an empty disk is forbidden.';
      else if (binding.state === 'identified') { operation = SERVICE_VOLUME_OPERATIONS.finalize; reason = 'Finalize the acknowledged volume ID after fresh exact attachment observation; no provider write.'; }
      else { type = 'noop'; reason = desired ? 'Exact retained volume attachment verified (control plane only).' : 'Omitted volume retained; exact attachment verified.'; }
    } else if (observation.state === 'present') blocked = 'An unbound volume already occupies this service. Automatic adoption is forbidden.';
    else if (desired && observation.state === 'absent') type = 'create';
    else blocked = 'Volume intent or identity is missing.';
    actions.push({
      id: `volume:${name}`, resource: { kind: 'volume', name, provider: environmentSpec.hosting.provider },
      type, verified: !blocked, reason: blocked ?? reason,
      ...(type !== 'noop' ? { dataBearing: true, requiresConfirm: true, ...(type === 'create' ? { billable: true } : {}) } : {}),
      metadata: { operation, ...(live?.target ? { target: live.target } : {}), ...(binding?.externalId ? { externalId: binding.externalId } : {}), ...(blocked ? { blockedReason: 'service_volume_not_converged' } : {}) },
    });
  }
  return { actions, warnings };
}

/** Retain-only v1 has no provider/service teardown or scope-transition authority. */
export function retainedVolumeHostingBlock(environment: VolumeEnvironment, spec: EnvironmentSpec, action: PlanAction): string | undefined {
  if (!hasRetainedServiceVolumes(environment)) return undefined;
  const retained = bindings(environment);
  if ((['project', 'environment', 'service', 'retained-resource'].includes(action.resource.kind) && ['destroy', 'replace'].includes(action.type))
    || (['project', 'environment'].includes(action.resource.kind) && action.type === 'create')
    || (action.resource.kind === 'service' && action.type === 'create' && (!retained || Object.hasOwn(retained, action.resource.name)))
    || (['project', 'environment', 'service'].includes(action.resource.kind) && environment?.platformBindings.provider !== spec.hosting.provider)) {
    return 'Retained service volumes block hosting teardown, replacement and provider changes. No disk deletion or migration is implemented.';
  }
  return undefined;
}

export function wireServiceVolumeActions(actions: PlanAction[], volumeActions: PlanAction[]): void {
  // Binding-only CI stages deliberately filter these actions out and re-plan
  // once the empty service has an exact ID. Runtime deploys cannot skip them.
  for (const action of actions) {
    if (action.type === 'noop' || action.resource.kind === 'volume') continue;
    if ((action.resource.kind === 'service' && !action.metadata?.operation)
      || (action.resource.kind === 'ci' && /Deploy|Release|AppliedSpec|appliedSpec/i.test(String(action.metadata?.operation)))) {
      const prerequisites = action.resource.kind === 'service'
        ? volumeActions.filter((v) => v.resource.name === action.resource.name)
        : volumeActions;
      action.dependsOn = [...new Set([...(action.dependsOn ?? []), ...prerequisites.map((v) => v.id)])];
    }
  }
}

export async function applyServiceVolumeAction(params: {
  environment: Environment; environmentSpec: EnvironmentSpec; action: PlanAction;
  volumes: IServiceVolumes; confirmedActionIds: ReadonlySet<string>;
  /** Persist SQLite and synchronously export when a matching repo export is enabled. */
  save: (bindings: Record<string, ServiceVolumeBinding>) => void;
}): Promise<{ success: boolean; status?: 'blocked'; message: string; error?: string }> {
  const { environment, environmentSpec, action, volumes, save } = params;
  const block = (message: string) => ({ success: false, status: 'blocked' as const, message });
  if (!['create', 'update'].includes(action.type) || action.resource.kind !== 'volume' || action.resource.provider !== environmentSpec.hosting.provider || action.requiresConfirm !== true || !params.confirmedActionIds.has(action.id)) return block('Exact persisted volume confirmation and resource identity are required.');
  const live = await observeServiceVolumes({ environment, environmentSpec, volumes });
  const expected = planServiceVolumes({ environment, environmentSpec, observed: { serviceVolumes: live } as ObservedState }).actions.find((a) => a.id === action.id);
  if (!expected || expected.metadata?.blockedReason || expected.type !== action.type || expected.resource.name !== action.resource.name
    || expected.metadata?.operation !== action.metadata?.operation || expected.metadata?.externalId !== action.metadata?.externalId
    || !sameTarget(expected.metadata?.target as ServiceVolumeTarget, action.metadata?.target as ServiceVolumeTarget)
    || (action.type === 'create' && (action.billable !== true || action.dataBearing !== true))) return block(expected?.reason ?? 'Volume action no longer matches fresh desired and observed state.');
  const retained = bindings(environment)!;
  const name = action.resource.name;
  const target = expected.metadata!.target as ServiceVolumeTarget;
  if (action.metadata?.operation === SERVICE_VOLUME_OPERATIONS.finalize) {
    save({ ...retained, [name]: { ...retained[name], state: 'bound' } });
    return { success: true, message: 'Exact acknowledged volume attachment finalized; no provider mutation.' };
  }
  const intent: ServiceVolumeBinding = { provider: action.resource.provider, target, state: 'creating' };
  save({ ...retained, [name]: intent }); // Failure here authorizes zero provider writes.
  let receipt: Awaited<ReturnType<IServiceVolumes['create']>>;
  try { receipt = await volumes.create(target); }
  catch { return block('Volume create outcome is unknown. Durable intent retained; automatic retry is blocked.'); }
  if (receipt.externalId && receipt.mutationAttempted === true) {
    const identified: ServiceVolumeBinding = { ...intent, state: 'identified', externalId: receipt.externalId };
    save({ ...retained, [name]: identified }); // Retain acknowledged ID even when provider verification failed.
    let verification: ServiceVolumeObservation;
    try { verification = await volumes.observe(target, receipt.externalId); }
    catch { return block('Acknowledged volume ID retained; attachment observation failed. Re-plan for exact recovery.'); }
    if (verification.state === 'present' && verification.externalId === receipt.externalId && !verification.pendingDeletion) {
      save({ ...retained, [name]: { ...identified, state: 'bound' } });
      return { success: true, message: 'Exact volume attachment verified. Application mount and durability still require deployment checks.' };
    }
  } else if (!receipt.mutationAttempted) {
    save(retained);
  }
  return block('Volume attachment was not verified. Any uncertain create intent or acknowledged ID is retained; re-plan before continuing.');
}
