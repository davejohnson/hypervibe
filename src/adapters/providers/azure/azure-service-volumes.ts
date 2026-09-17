import type {
  IServiceVolumes,
  ServiceVolumeComponent,
  ServiceVolumeComponentBinding,
  ServiceVolumeMutationReceipt,
  ServiceVolumeObservation,
  ServiceVolumeTarget,
} from '../../../domain/ports/service-volume.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { resourceName, resourceScopeSuffix } from '../../../domain/services/resource-names.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';

const STORAGE_API = '2025-08-01';
const APP_API = '2026-01-01';
const PROVIDER_API = '2021-04-01';
const VOLUME_NAME = 'hypervibe-data';
type Bindings = Record<string, ServiceVolumeComponentBinding>;
type Resource = { id?: string; location?: string; kind?: string; sku?: { name?: string }; tags?: Record<string, string>; properties?: Record<string, any>; registrationState?: string };

/** Each invocation owns one ARM resource, never a compound storage bootstrap. */
export class AzureServiceVolumes implements IServiceVolumes {
  constructor(private readonly client: () => AzureResourceManagerClient) {}

  readonly staged: NonNullable<IServiceVolumes['staged']> = {
    resolveTarget: async ({ environment, serviceName, mountPath }) => {
      if (!environment) return undefined;
      const bindings = parseHostingBindings(environment);
      const serviceId = bindings.services?.[serviceName]?.serviceId;
      if (!bindings.projectId || !bindings.environmentId || !serviceId) return undefined;
      const target: ServiceVolumeTarget = { projectId: bindings.projectId, environmentId: bindings.environmentId, serviceId, mountPath };
      const { managedEnvironment } = await this.scope(target);
      return { ...target, instanceScope: { location: managedEnvironment.location! } };
    },
    components: (target) => this.components(target),
    observeComponent: (target, key, bindings) => this.observeComponent(target, key, bindings),
    applyComponent: (target, key, bindings) => this.applyComponent(target, key, bindings),
  };

  async observe(): Promise<ServiceVolumeObservation> {
    return { state: 'unknown', reason: 'Azure Files requires component-scoped observation.' };
  }

  async create(): Promise<ServiceVolumeMutationReceipt> {
    return { success: false, mutationAttempted: false, error: 'Azure Files requires separately reviewed component actions.' };
  }

  private components(_target: ServiceVolumeTarget): ServiceVolumeComponent[] {
    return [
      { key: 'storage-provider', dependsOn: [], operation: 'update', billable: false, sharedPrerequisite: true, description: 'Enable the shared subscription Microsoft.Storage API; this does not claim ownership of that subscription registration.' },
      { key: 'account', dependsOn: ['storage-provider'], operation: 'create', billable: true, description: 'Create a dedicated Standard_LRS StorageV2 account for retained Azure Files; used storage, transactions and transfer are billed.' },
      { key: 'share', dependsOn: ['account'], operation: 'create', billable: true, description: 'Create a retained classic SMB file share with a 5 GiB quota and pay-as-you-go storage/transaction charges.' },
      { key: 'environment-storage', dependsOn: ['share'], operation: 'create', billable: false, description: 'Register the exact existing file share in this Container Apps managed environment.' },
      { key: 'attachment', dependsOn: ['environment-storage'], operation: 'update', billable: false, description: 'Attach the existing Azure Files share to the exact Container App and verify its ready revision.' },
    ];
  }

  private identities(target: ServiceVolumeTarget) {
    const client = this.client();
    const app = client.parseResourceId(target.serviceId, 'Microsoft.App', 'containerApps');
    client.parseResourceId(target.environmentId, 'Microsoft.App', 'managedEnvironments');
    const group = `/subscriptions/${app.subscriptionId}/resourceGroups/${app.resourceGroup}`;
    if (group.toLowerCase() !== target.projectId.toLowerCase()
      || !target.environmentId.toLowerCase().startsWith(`${group.toLowerCase()}/providers/microsoft.app/managedenvironments/`)) {
      throw new Error('Azure volume scope does not match its hosting resource group.');
    }
    if (!/^\/(?!\/)(?:[^\s\\/]+\/)*[^\s\\/]+$/.test(target.mountPath)
      || target.mountPath.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid Azure mount path.');
    const accountName = resourceName('files', { compact: true, maxLength: 24, minLength: 3, scope: [target.projectId.toLowerCase(), target.serviceId.toLowerCase()] });
    const account = `${target.projectId}/providers/Microsoft.Storage/storageAccounts/${accountName}`;
    const storageName = resourceName(app.name, { maxLength: 63 });
    return {
      'storage-provider': `/subscriptions/${app.subscriptionId}/providers/Microsoft.Storage`,
      account,
      share: `${account}/fileServices/default/shares/data`,
      'environment-storage': `${target.environmentId}/storages/${storageName}`,
      attachment: target.serviceId,
      accountName,
      storageName,
      ownership: resourceScopeSuffix([target.projectId.toLowerCase(), target.serviceId.toLowerCase()]),
    };
  }

  private async scope(target: ServiceVolumeTarget) {
    this.identities(target);
    const client = this.client();
    const [group, managedEnvironment, app] = await Promise.all([
      client.getNullable<Resource>(target.projectId, '2024-11-01'),
      client.getNullable<Resource>(target.environmentId, APP_API),
      client.getNullable<Resource>(target.serviceId, APP_API),
    ]);
    this.assertIdentity(group, target.projectId);
    this.assertIdentity(managedEnvironment, target.environmentId);
    this.assertIdentity(app, target.serviceId);
    const parent = app!.properties?.environmentId ?? app!.properties?.managedEnvironmentId;
    if (typeof parent !== 'string' || parent.toLowerCase() !== target.environmentId.toLowerCase()
      || typeof managedEnvironment!.location !== 'string' || !managedEnvironment!.location
      || (target.instanceScope?.location && target.instanceScope.location !== managedEnvironment!.location)
      || managedEnvironment!.properties?.provisioningState !== 'Succeeded') {
      throw new Error('Azure managed environment membership or location could not be verified.');
    }
    return { managedEnvironment: managedEnvironment!, app: app! };
  }

  private assertIdentity(resource: Resource | null | undefined, id: string): asserts resource is Resource {
    if (typeof resource?.id !== 'string' || resource.id.toLowerCase() !== id.toLowerCase()) {
      throw new Error('Azure resource returned an absent or different identity.');
    }
  }

  private async observeComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeObservation> {
    try {
      const descriptor = this.components(target).find((component) => component.key === key);
      if (!descriptor) throw new Error('Unknown Azure Files component.');
      const { app } = await this.scope(target);
      const ids = this.identities(target);
      const id = ids[key as 'account'];
      const binding = bindings[key];
      if (binding?.externalId && binding.externalId.toLowerCase() !== id.toLowerCase()) throw new Error('Azure Files component binding changed scope.');
      const resource = key === 'attachment' ? app : await this.client().getNullable<Resource>(id,
        key === 'storage-provider' ? PROVIDER_API : key === 'environment-storage' ? APP_API : STORAGE_API);
      if (!resource) return { state: 'absent' };
      this.assertIdentity(resource, id);
      const present = (ready = true, pendingDeletion = false): ServiceVolumeObservation => ({ state: 'present', externalId: resource.id!, pendingDeletion, ready });
      if (key === 'storage-provider') {
        if (resource.registrationState === 'Registered') return present();
        if (resource.registrationState === 'NotRegistered' || resource.registrationState === 'Unregistered') return { state: 'absent' };
        if (resource.registrationState === 'Registering') return present(false);
        throw new Error('Unknown Azure provider registration state.');
      }
      if (key === 'account') {
        if (resource.tags?.['managed-by'] !== 'hypervibe' || resource.tags?.['hypervibe-volume-service'] !== ids.ownership
          || resource.kind !== 'StorageV2' || resource.sku?.name !== 'Standard_LRS'
          || resource.location !== target.instanceScope?.location
          || resource.properties?.supportsHttpsTrafficOnly !== true
          || resource.properties?.minimumTlsVersion !== 'TLS1_2'
          || resource.properties?.allowBlobPublicAccess !== false
          || resource.properties?.allowSharedKeyAccess !== true) throw new Error('Azure Files account ownership or configuration is unknown or drifted.');
        if (resource.properties.provisioningState === 'Succeeded') return present();
        if (['Creating', 'ResolvingDNS'].includes(resource.properties.provisioningState)) return present(false);
        throw new Error('Azure Files account provisioning did not converge.');
      }
      if (key === 'share') {
        if (resource.properties?.enabledProtocols !== 'SMB' || resource.properties?.shareQuota !== 5) throw new Error('Azure Files share configuration drifted.');
        return present(true, Boolean(resource.properties?.deletedTime));
      }
      if (key === 'environment-storage') {
        const file = resource.properties?.azureFile;
        if (file?.accountName !== ids.accountName || file?.shareName !== 'data' || file?.accessMode !== 'ReadWrite') throw new Error('Azure environment storage targets a different file share.');
        return present();
      }
      const template = resource.properties?.template;
      const containers = template?.containers;
      if (!Array.isArray(containers) || containers.length !== 1) throw new Error('Azure Files requires one observable Container App container.');
      const volumes = template.volumes ?? [];
      const mounts = containers[0].volumeMounts ?? [];
      if (!Array.isArray(volumes) || !Array.isArray(mounts)) throw new Error('Malformed Azure volume inventory.');
      const selectedVolumes = volumes.filter((volume: any) => volume.name === VOLUME_NAME || volume.storageName === ids.storageName);
      const selectedMounts = mounts.filter((mount: any) => mount.volumeName === VOLUME_NAME || mount.mountPath === target.mountPath);
      if (selectedVolumes.length === 0 && selectedMounts.length === 0) return { state: 'absent' };
      if (selectedVolumes.length !== 1 || selectedMounts.length !== 1
        || selectedVolumes[0].name !== VOLUME_NAME || selectedVolumes[0].storageName !== ids.storageName
        || selectedVolumes[0].storageType !== 'AzureFile'
        || selectedMounts[0].volumeName !== VOLUME_NAME || selectedMounts[0].mountPath !== target.mountPath
        || selectedMounts[0].subPath) throw new Error('Azure mount configuration is conflicting, duplicated or drifted.');
      const properties = resource.properties!;
      return present(properties.provisioningState === 'Succeeded'
        && typeof properties.latestRevisionName === 'string'
        && properties.latestReadyRevisionName === properties.latestRevisionName);
    } catch {
      return { state: 'unknown', reason: `Azure Files ${key} scope, identity or configuration could not be verified.` };
    }
  }

  private async applyComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeMutationReceipt> {
    let mutationAttempted = false;
    let externalId: string | undefined;
    try {
      const component = this.components(target).find((entry) => entry.key === key);
      if (!component) throw new Error('Unknown Azure component.');
      const { managedEnvironment } = await this.scope(target);
      const ids = this.identities(target);
      for (const dependency of component.dependsOn) {
        const descriptor = this.components(target).find((entry) => entry.key === dependency)!;
        if (!descriptor.sharedPrerequisite && bindings[dependency]?.state !== 'bound') throw new Error('Azure Files prerequisite has no bound identity.');
        const observed = await this.observeComponent(target, dependency, bindings);
        if (observed.state !== 'present' || observed.ready === false || observed.pendingDeletion) throw new Error('Azure Files prerequisite is not ready.');
      }
      const before = await this.observeComponent(target, key, bindings);
      if (before.state !== 'absent' || bindings[key]?.externalId) throw new Error('Azure Files creation requires observed absence and no existing binding.');
      const id = ids[key as 'account'];
      let method = 'PUT';
      let path = id;
      let version = STORAGE_API;
      let body: unknown;
      if (key === 'storage-provider') {
        method = 'POST'; path = `${id}/register`; version = PROVIDER_API;
      } else if (key === 'account') {
        body = { location: managedEnvironment.location, kind: 'StorageV2', sku: { name: 'Standard_LRS' }, tags: { 'managed-by': 'hypervibe', 'hypervibe-volume-service': ids.ownership }, properties: { supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, allowSharedKeyAccess: true } };
      } else if (key === 'share') {
        body = { properties: { enabledProtocols: 'SMB', shareQuota: 5, accessTier: 'TransactionOptimized' } };
      } else if (key === 'environment-storage') {
        const keys = await this.client().request<{ keys?: Array<{ permissions?: string; value?: string }> }>('POST', `${ids.account}/listKeys`, STORAGE_API);
        const accountKey = keys.keys?.find((entry) => entry.permissions?.toLowerCase() === 'full')?.value;
        if (!accountKey) throw new Error('Azure storage did not return an account key.');
        version = APP_API;
        body = { properties: { azureFile: { accountName: ids.accountName, accountKey, shareName: 'data', accessMode: 'ReadWrite' } } };
      } else {
        method = 'PATCH'; version = APP_API;
        // Prerequisite reads may span a code deployment. Never patch the stale
        // template captured before those reads back over the latest runtime.
        const template = (await this.scope(target)).app.properties!.template;
        if ((template.volumes ?? []).some((volume: any) => volume.name === VOLUME_NAME || volume.storageName === ids.storageName)
          || (template.containers?.[0]?.volumeMounts ?? []).some((mount: any) => mount.volumeName === VOLUME_NAME || mount.mountPath === target.mountPath)) throw new Error('Azure attachment changed during preflight.');
        body = { properties: { template: { ...template,
          volumes: [...(template.volumes ?? []), { name: VOLUME_NAME, storageType: 'AzureFile', storageName: ids.storageName }],
          containers: [{ ...template.containers[0], volumeMounts: [...(template.containers[0].volumeMounts ?? []), { volumeName: VOLUME_NAME, mountPath: target.mountPath }] }],
        } } };
      }
      mutationAttempted = true;
      const receipt = await this.client().request<Resource>(method, path, version, body);
      this.assertIdentity(receipt, id);
      externalId = receipt.id!;
      // A durable provider acknowledgement is returned even when readiness needs a later plan.
      const observed = await this.observeComponent(target, key, { ...bindings, [key]: { state: 'identified', externalId } });
      return { success: observed.state === 'present' && observed.ready !== false && !observed.pendingDeletion, externalId, mutationAttempted: true,
        ...(observed.state === 'present' && observed.ready !== false && !observed.pendingDeletion ? {} : { error: 'Azure Files component was acknowledged but is not yet verified ready; re-plan to finalize the exact identity.' }) };
    } catch {
      return { success: false, mutationAttempted, ...(externalId ? { externalId } : {}), error: `Azure Files ${key} did not converge; retained intent must be reviewed before retry.` };
    }
  }
}
