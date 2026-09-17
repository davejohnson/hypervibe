import type { IServiceVolumes, ServiceVolumeTarget, ServiceVolumeObservation } from '../../../domain/ports/service-volume.port.js';
import { FlyClient, type FlyMachine } from './fly.client.js';
import { formatFlyServiceBinding, parseFlyServiceBinding, parseFlyEnvironmentBinding, parseFlyOrganizationBinding } from './fly.binding.js';

/** Fly disks must precede Machine creation; they cannot be attached afterward. */
export class FlyServiceVolumes implements IServiceVolumes {
  constructor(private client: () => FlyClient, private region: () => string) {}

  readonly staged: NonNullable<IServiceVolumes['staged']> = {
    runtimeMount: (target, bindings) => bindings.filesystem?.state === 'bound' && bindings.filesystem.externalId
      ? { externalId: bindings.filesystem.externalId, mountPath: target.mountPath, target }
      : undefined,
    resolveTarget: async ({ environment, serviceName, mountPath }) => {
      const raw = environment?.platformBindings;
      const services = raw?.services as Record<string, { serviceId?: string }> | undefined;
      const id = services?.[serviceName]?.serviceId;
      if (!id || typeof raw?.projectId !== 'string' || typeof raw.environmentId !== 'string') return undefined;
      const binding = parseFlyServiceBinding(id);
      return {
        projectId: raw.projectId, environmentId: raw.environmentId,
        serviceId: formatFlyServiceBinding({ organizationSlug: binding.organizationSlug, appId: binding.appId, appName: binding.appName }),
        mountPath, instanceScope: { region: this.region(), sizeGb: '1', serviceName },
      };
    },
    components: () => [{
      key: 'filesystem', dependsOn: [], operation: 'create', billable: true,
      description: 'Create a retained encrypted 1 GB Fly disk (single Machine, no replication; billed while retained).',
    }],
    observeComponent: async (target, key, bindings) => key === 'filesystem'
      ? this.observe(target, bindings.filesystem?.externalId)
      : { state: 'unknown', reason: 'Unknown Fly filesystem component.' },
    applyComponent: async (target, key, bindings) => {
      if (key !== 'filesystem' || bindings.filesystem?.externalId) {
        return { success: false, mutationAttempted: false, error: 'Fly filesystem creation requires an unbound exact filesystem action.' };
      }
      return this.create(target);
    },
  };

  private async scope(target: ServiceVolumeTarget) {
    const client = this.client();
    const organization = parseFlyOrganizationBinding(target.projectId);
    const environment = parseFlyEnvironmentBinding(target.environmentId);
    const binding = parseFlyServiceBinding(target.serviceId);
    if (organization !== client.organizationSlug || binding.organizationSlug !== organization
      || environment.organizationSlug !== organization || binding.machineId
      || target.instanceScope?.region !== this.region() || target.instanceScope?.sizeGb !== '1'
      || !target.instanceScope.serviceName) {
      throw new Error('Fly filesystem scope differs from the reviewed app, organization, region or capacity.');
    }
    const app = await client.getApp(binding.appName);
    if (!app || app.id !== binding.appId || app.name !== binding.appName || app.organization?.slug !== organization) {
      throw new Error('Fly filesystem owning app is missing or outside the reviewed identity.');
    }
    return { client, binding, environment };
  }

  async observe(target: ServiceVolumeTarget, externalId?: string): Promise<ServiceVolumeObservation> {
    try {
      const { client, binding } = await this.scope(target);
      const inventory = await client.listVolumes(binding.appName);
      const machines = await client.listMachines(binding.appName);
      if (inventory.length > 1 || machines.length > 1) throw new Error('Multiple disks or Machines conflict with the single-Machine filesystem contract.');
      if (!externalId && inventory.length === 0) {
        if (machines.length) throw new Error('Adding a disk to an existing Fly Machine requires explicit replacement; automatic replacement is forbidden.');
        return { state: 'absent' };
      }
      const disk = externalId ? await client.getVolume(binding.appName, externalId) : inventory[0];
      if (!disk) {
        if (inventory.length) throw new Error('Fly disk inventory contradicts the exact retained identity.');
        return { state: 'absent' };
      }
      if (inventory.length !== 1 || inventory[0]?.id !== disk.id || disk.region !== this.region()
        || disk.size_gb !== 1 || disk.encrypted !== true || typeof disk.state !== 'string') {
        throw new Error('Fly disk inventory, placement, capacity, or encryption differs from reviewed storage.');
      }
      if (disk.attached_machine_id !== null) {
        if (!disk.attached_machine_id || machines[0]?.id !== disk.attached_machine_id) {
          throw new Error('Fly disk attachment identity is incomplete or outside the reviewed app.');
        }
        this.assertMachineMount(target, disk.id, machines[0]);
      } else if (machines.length) {
        throw new Error('Fly disk is unattached but its app already has a Machine; replacement requires explicit authority.');
      }
      return { state: 'present', externalId: disk.id, pendingDeletion: false, ready: disk.state === 'created' };
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async create(target: ServiceVolumeTarget) {
    let mutationAttempted = false;
    try {
      const current = await this.observe(target);
      if (current.state !== 'absent') throw new Error(current.state === 'unknown' ? current.reason : 'Existing Fly disk is an adoption candidate, not creation authority.');
      const { client, binding } = await this.scope(target);
      mutationAttempted = true;
      const disk = await client.createVolume({ appName: binding.appName, name: 'data', region: this.region(), sizeGb: 1 });
      return { success: true, externalId: disk.id, mutationAttempted };
    } catch (error) {
      return { success: false, mutationAttempted, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async assertReadyMount(target: ServiceVolumeTarget, externalId: string, machine?: FlyMachine): Promise<void> {
    const observed = await this.observe(target, externalId);
    if (observed.state !== 'present' || observed.externalId !== externalId || observed.ready !== true || observed.pendingDeletion) {
      throw new Error('The exact retained Fly disk is not ready for this workload.');
    }
    if (machine) this.assertMachineMount(target, externalId, machine);
  }

  assertMachineMount(target: ServiceVolumeTarget, externalId: string, machine: FlyMachine): void {
    const identity = parseFlyEnvironmentBinding(target.environmentId);
    const metadata = machine.config?.metadata;
    const mounts = machine.config?.mounts as Array<{ volume?: string; path?: string }> | undefined;
    if (!Array.isArray(mounts) || mounts.length !== 1 || mounts[0]?.volume !== externalId || mounts[0]?.path !== target.mountPath
      || metadata?.hypervibe_managed !== 'true' || metadata.hypervibe_project_id !== identity.projectName
      || metadata.hypervibe_environment_id !== target.environmentId || metadata.hypervibe_service_name !== target.instanceScope?.serviceName) {
      throw new Error('Fly Machine does not preserve the exact reviewed filesystem attachment and workload ownership.');
    }
  }
}
