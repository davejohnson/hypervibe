import { createHash } from 'node:crypto';
import type { Receipt } from '../../../domain/ports/provider.port.js';
import type { IStorageRuntimeAccess, StorageRuntimeAccessBinding, StorageRuntimeAccessObservation, StorageRuntimeAccessTarget } from '../../../domain/ports/storage-runtime-access.port.js';
import { AzureResourceManagerClient, type AzureResourceManagerCredentials } from './azure-resource-manager.client.js';

const API = '2022-04-01';
const ROLE = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const equal = (left: unknown, right: string) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const errorMessage = (_error: unknown) => 'Exact Azure Blob workload identity, container ownership or access assignment could not be verified.';

/** Azure owns exact container RBAC resources; environment wiring never writes IAM. */
export class AzureBlobRuntimeAccess implements IStorageRuntimeAccess {
  readonly hostingProviders = ['azure-container-apps'] as const;
  constructor(private readonly credentials: () => Promise<AzureResourceManagerCredentials>) {}

  async observe(target: StorageRuntimeAccessTarget, binding?: StorageRuntimeAccessBinding): Promise<StorageRuntimeAccessObservation> {
    try {
      const prepared = await this.prepare(target);
      if (binding) this.assertBinding(prepared, binding);
      const assignment = await prepared.arm.getNullable<any>(prepared.id, API);
      if (!assignment) return { state: 'absent' };
      const observed = this.bindingFromAssignment(prepared, assignment);
      if (binding && observed.attemptId !== binding.attemptId) throw new Error('Azure Blob access assignment belongs to a different creation attempt.');
      return { state: 'present', binding: observed };
    } catch (error) { return { state: 'unknown', reason: errorMessage(error) }; }
  }

  async grant(target: StorageRuntimeAccessTarget, attemptId: string, binding?: StorageRuntimeAccessBinding): Promise<{ receipt: Receipt; binding?: StorageRuntimeAccessBinding }> {
    try {
      this.assertAttempt(attemptId);
      const prepared = await this.prepare(target);
      if (binding) this.assertBinding(prepared, binding);
      const current = await prepared.arm.getNullable<any>(prepared.id, API);
      if (current) {
        const owned = this.bindingFromAssignment(prepared, current);
        if (owned.attemptId !== attemptId || (binding && owned.attemptId !== binding.attemptId)) throw new Error('Azure Blob access assignment belongs to a different creation attempt.');
        return { receipt: { success: true, message: 'Verified the existing container-scoped workload access assignment.' }, binding: owned };
      }
      if (binding) throw new Error('Bound Azure Blob access assignment is missing; re-plan its replacement explicitly.');
      await prepared.arm.request('PUT', prepared.id, API, { properties: {
        principalId: target.identity.principal,
        principalType: 'ServicePrincipal',
        roleDefinitionId: prepared.evidence.roleDefinitionId,
        description: `${prepared.marker}${attemptId}`,
      } });
      const observed = await prepared.arm.getNullable<any>(prepared.id, API);
      if (!observed) throw new Error('Azure Blob access creation was acknowledged but is not yet observable.');
      const owned = this.bindingFromAssignment(prepared, observed);
      if (owned.attemptId !== attemptId) throw new Error('Azure Blob access creation returned a different attempt identity.');
      return { receipt: { success: true, message: 'Created and verified container-scoped workload access; Azure permission propagation may still be pending.' }, binding: owned };
    } catch (error) { return { receipt: { success: false, message: 'Failed to grant Azure Blob workload access.', error: errorMessage(error) } }; }
  }

  async revoke(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding): Promise<Receipt> {
    try {
      const prepared = await this.prepare(target);
      this.assertBinding(prepared, binding);
      const current = await prepared.arm.getNullable<any>(prepared.id, API);
      if (!current) return { success: true, message: 'The exact Azure Blob access assignment is already absent.' };
      const observed = this.bindingFromAssignment(prepared, current);
      if (observed.attemptId !== binding.attemptId) throw new Error('Azure Blob access assignment belongs to another creation attempt.');
      await prepared.arm.deleteIfPresent(prepared.id, API);
      if (await prepared.arm.getNullable(prepared.id, API)) throw new Error('Azure Blob access assignment remains observable after deletion.');
      return { success: true, message: 'Removed and verified the exact Azure Blob access assignment; cached Azure authorization may take time to expire.' };
    } catch (error) { return { success: false, message: 'Failed to revoke Azure Blob workload access.', error: errorMessage(error) }; }
  }

  private async prepare(target: StorageRuntimeAccessTarget) {
    const credentials = await this.credentials();
    const identity = target.identity;
    const scope = identity.scope;
    const appId = scope.workloadResource;
    const resourceGroupId = target.environment.platformBindings.projectId;
    const managedEnvironmentId = target.environment.platformBindings.environmentId;
    const bindings = target.environment.platformBindings;
    const group = `/subscriptions/${credentials.subscriptionId}/resourceGroups/${target.context.resourceGroup}`;
    const prefix = `${group}/providers/Microsoft.Storage/storageAccounts/`;
    const suffix = target.externalId.slice(prefix.length);
    if (!target.context.resourceGroup || /[/?#%]/.test(target.context.resourceGroup)
      || !equal(target.context.subscriptionId, credentials.subscriptionId)
      || !target.externalId.toLowerCase().startsWith(prefix.toLowerCase())
      || !/^[a-z0-9]{3,24}\/blobServices\/default\/containers\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(suffix)
      || identity.provider !== 'azure' || identity.source !== 'observed' || !UUID.test(identity.principal)
      || !UUID.test(scope.tenantId ?? '')
      || ('tenantId' in credentials && !equal(scope.tenantId, credentials.tenantId))
      || !equal(scope.subscriptionId, credentials.subscriptionId)
      || scope.environmentId !== target.environment.id
      || typeof resourceGroupId !== 'string' || typeof managedEnvironmentId !== 'string' || !appId
      || !equal(resourceGroupId, group) || scope.serviceName !== target.serviceName
      || !equal((bindings.services as Record<string, { serviceId?: string }> | undefined)?.[target.serviceName]?.serviceId, appId)
      || !appId.toLowerCase().startsWith(`${resourceGroupId.toLowerCase()}/providers/microsoft.app/containerapps/`)
      || !managedEnvironmentId.toLowerCase().startsWith(`${resourceGroupId.toLowerCase()}/providers/microsoft.app/managedenvironments/`)) {
      throw new Error('Azure Blob runtime access requires the exact observed workload and container scope.');
    }
    const arm = new AzureResourceManagerClient(credentials);
    arm.parseResourceId(appId, 'Microsoft.App', 'containerApps');
    arm.parseResourceId(managedEnvironmentId, 'Microsoft.App', 'managedEnvironments');
    const subscription = await arm.request<{ subscriptionId?: unknown; tenantId?: unknown; state?: unknown }>('GET', `/subscriptions/${credentials.subscriptionId}`, '2022-12-01');
    if (!equal(subscription.subscriptionId, credentials.subscriptionId) || !equal(subscription.tenantId, scope.tenantId)
      || subscription.state !== 'Enabled') throw new Error('Azure storage subscription identity is unavailable.');
    const accountId = `${prefix}${suffix.split('/')[0]}`;
    const account = await arm.getNullable<any>(accountId, '2025-06-01');
    if (!account || !equal(account.id, accountId) || account.name !== suffix.split('/')[0]
      || account.tags?.['hypervibe-environment-id'] !== target.environment.id || account.tags?.['hypervibe-storage-name'] !== target.storageName) {
      throw new Error('Azure Blob account ownership could not be verified for this environment and storage binding.');
    }
    const container = await arm.getNullable<any>(target.externalId, '2025-08-01');
    if (!container || !equal(container.id, target.externalId) || container.name !== suffix.split('/').at(-1)) throw new Error('The exact Azure Blob access container could not be verified.');
    const app = await arm.getNullable<any>(appId, '2026-01-01');
    const settings = app?.properties?.configuration?.identitySettings;
    const selectedIdentity = scope.identityResourceId ?? 'system';
    const selectedSettings = Array.isArray(settings) ? settings.filter((setting: any) => equal(setting?.identity, selectedIdentity)) : [];
    if (!app || !equal(app.id, appId)
      || app.tags?.['managed-by'] !== 'hypervibe' || app.tags?.['hypervibe-environment-id'] !== target.environment.id
      || !equal(app.properties?.environmentId ?? app.properties?.managedEnvironmentId, managedEnvironmentId)
      || (settings !== undefined && !Array.isArray(settings)) || selectedSettings.length > 1
      || selectedSettings.some((setting: any) => !['All', 'Main'].includes(setting.lifecycle ?? 'All'))) {
      throw new Error('Azure workload identity changed or is unavailable to the application container.');
    }
    const types = String(app.identity?.type ?? '').split(',').map(type => type.trim());
    if (scope.identityResourceId) {
      arm.parseResourceId(scope.identityResourceId, 'Microsoft.ManagedIdentity', 'userAssignedIdentities');
      if (!scope.identityResourceId.toLowerCase().startsWith(`${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/`.toLowerCase())
        || !UUID.test(scope.clientId ?? '') || !types.includes('UserAssigned')
        || !Object.keys(app.identity?.userAssignedIdentities ?? {}).some(id => equal(id, scope.identityResourceId!))) {
        throw new Error('The selected user-assigned workload identity is not attached.');
      }
      const retained = (bindings.runtimeIdentities as Record<string, { provider?: string; evidence?: Record<string, string> }> | undefined)?.[target.serviceName];
      const native = await arm.getNullable<any>(scope.identityResourceId, '2024-11-30');
      const expected = { workloadId: appId, identityId: scope.identityResourceId, principalId: identity.principal,
        clientId: scope.clientId!, tenantId: scope.tenantId!, subscriptionId: credentials.subscriptionId, environmentId: target.environment.id, serviceName: target.serviceName };
      if (retained?.provider !== 'azure-container-apps' || retained.evidence?.kind !== 'user'
        || Object.entries(expected).some(([key, value]) => !equal(retained.evidence?.[key], value))
        || !native || !equal(native.id, scope.identityResourceId) || !equal(native.properties?.principalId, identity.principal)
        || !equal(native.properties?.clientId, scope.clientId!) || !equal(native.properties?.tenantId, scope.tenantId!)
        || !retained.evidence.createdAt || native.systemData?.createdAt !== retained.evidence.createdAt) {
        throw new Error('The retained user-assigned workload identity lifetime changed.');
      }
    } else if (!types.includes('SystemAssigned') || !equal(app.identity?.principalId, identity.principal)
      || !equal(app.identity?.tenantId, scope.tenantId!)) {
      throw new Error('The selected system-assigned workload identity changed.');
    }
    if (equal(await arm.servicePrincipalId(), identity.principal)) throw new Error('Azure deployment identity cannot receive workload Blob access.');
    const targetHash = createHash('sha256').update(JSON.stringify([target.environment.id, target.serviceName, target.storageName, target.externalId.toLowerCase(), identity.principal.toLowerCase(), appId.toLowerCase()])).digest('hex');
    const hex = targetHash.slice(0, 32);
    const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return {
      arm, id: `${target.externalId}/providers/Microsoft.Authorization/roleAssignments/${guid}`,
      marker: `hypervibe:blob-runtime:v1:${targetHash}:`,
      evidence: { targetHash, principalId: identity.principal.toLowerCase(), scope: target.externalId.toLowerCase(), appId: appId.toLowerCase(), roleDefinitionId: `/subscriptions/${credentials.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${ROLE}` },
    };
  }

  private bindingFromAssignment(prepared: Awaited<ReturnType<AzureBlobRuntimeAccess['prepare']>>, assignment: any): StorageRuntimeAccessBinding {
    const properties = assignment?.properties;
    const description = properties?.description;
    if (!equal(assignment?.id, prepared.id) || !equal(properties?.principalId, prepared.evidence.principalId)
      || !equal(properties?.scope, prepared.evidence.scope) || !equal(properties?.roleDefinitionId, prepared.evidence.roleDefinitionId)
      || (properties?.principalType !== undefined && properties.principalType !== 'ServicePrincipal')
      || (properties?.condition !== undefined && properties.condition !== null && properties.condition !== '')
      || typeof description !== 'string' || !description.startsWith(prepared.marker)) {
      throw new Error('Azure Blob access assignment is conflicting, incomplete, or not independently owned.');
    }
    const attemptId = description.slice(prepared.marker.length);
    this.assertAttempt(attemptId);
    return { id: prepared.id, attemptId, evidence: prepared.evidence };
  }

  private assertBinding(prepared: Awaited<ReturnType<AzureBlobRuntimeAccess['prepare']>>, binding: StorageRuntimeAccessBinding): void {
    this.assertAttempt(binding.attemptId);
    if (!equal(binding.id, prepared.id) || Object.keys(binding.evidence).length !== Object.keys(prepared.evidence).length
      || Object.entries(prepared.evidence).some(([key, value]) => binding.evidence[key] !== value)) {
      throw new Error('Azure Blob access binding does not match the exact workload and container.');
    }
  }

  private assertAttempt(attemptId: string): void {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(attemptId)) throw new Error('Azure Blob access requires its persisted creation attempt identity.');
  }
}
