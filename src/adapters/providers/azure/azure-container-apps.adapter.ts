import type { ProviderEnvironmentVariablesRequest, ProviderEnvironmentVariablesResult } from '../../../domain/ports/provider-env-vars.port.js';
import { createAzureRegistryCredentialLifecycle } from './azure-registry-credential.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { type Service } from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type {
  IWorkloadMaintenanceAdapter,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  DeploymentMutationOptions,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../../../domain/services/managed-runtime.js';
import { environmentForInspection } from '../../../domain/registry/provider-inspection.js';
import {
  AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
  azureRegistryName,
  buildAzureContainerAppsGitHubActionsSteps,
} from './azure-container-apps-ci.workflow.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import { azureVolumeFingerprint } from './azure-volume-runtime.js';
import { azureRuntimeIdentityFingerprint } from './azure-runtime-identity.js';
import {
  azureEnvironmentResourceGroupScope,
  legacyAzureEnvironmentResourceGroupScope,
  parseAzureResourceGroupScope,
} from './azure-environment-scope.js';

const RESOURCE_API = '2024-11-01';
const REGISTRY_API = '2025-11-01';
const CONTAINER_APPS_API = '2026-01-01';
const AUTHORIZATION_API = '2022-04-01';
const BOOTSTRAP_IMAGE = `mcr.microsoft.com/oss/nodejs/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;
const ACR_PUSH_ROLE = '8311e382-0749-4cb8-b61a-304f252e45ec';
const ACR_PULL_ROLE = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const DEPLOY_SHA_KEY = 'HYPERVIBE_DEPLOY_SHA';
const IMAGE_DIGEST_KEY = 'HYPERVIBE_IMAGE_DIGEST';
const INTERNAL_ENV_KEYS = new Set([
  START_COMMAND_KEY,
  HEALTH_CHECK_PATH_KEY,
  DEPLOY_SHA_KEY,
  IMAGE_DIGEST_KEY,
]);

const AzureContainerAppsAuthenticationSchema = z.object({
  tenantId: z.string().uuid('Azure tenant ID must be a UUID'),
  subscriptionId: z.string().uuid('Azure subscription ID must be a UUID'),
  clientId: z.string().uuid('Azure service principal client ID must be a UUID'),
  clientSecret: z.string().min(8, 'Azure service principal client secret is required'),
}).strict();

export const AzureContainerAppsCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { location: _legacyLocation, ...authentication } = input as Record<string, unknown>;
  return authentication;
}, AzureContainerAppsAuthenticationSchema);

export type AzureContainerAppsCredentials = z.infer<typeof AzureContainerAppsCredentialsSchema>;
const DEFAULT_AZURE_CONTAINER_APPS_LOCATION = 'canadacentral';
const AzureLocationSchema = z.string().trim().regex(/^[a-z0-9]+$/, 'Azure location must be a region slug');
type ConnectedAzureContainerAppsCredentials = AzureContainerAppsCredentials & { location: string };

type AzureResource = {
  id: string;
  name: string;
  location?: string;
  identity?: { principalId?: string; tenantId?: string; type?: string; userAssignedIdentities?: Record<string, unknown> };
  properties?: Record<string, any>;
  tags?: Record<string, string>;
};

type AzureProject = {
  environmentId: string;
  environmentName: string;
  registryId: string;
  registryName: string;
  registryServer: string;
  resourceGroupId: string;
  resourceGroupName: string;
};

export class AzureContainerAppsAdapter implements IProviderAdapter, IWorkloadMaintenanceAdapter {
  readonly name = 'azure-container-apps';
  readonly registryCredentialLifecycle = createAzureRegistryCredentialLifecycle(() => this.connected().client);

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    credentialUpdateActivation: 'provider-rollout',
    credentialValueEvidence: 'readback',
    supportsMaintenance: true,
  };

  private credentials: ConnectedAzureContainerAppsCredentials | null = null;
  private client: AzureResourceManagerClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    const parsed = AzureContainerAppsCredentialsSchema.parse(credentials);
    const legacyLocation = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).location === 'string'
      ? (credentials as Record<string, string>).location
      : DEFAULT_AZURE_CONTAINER_APPS_LOCATION;
    this.credentials = { ...parsed, location: AzureLocationSchema.parse(legacyLocation) };
    this.client = new AzureResourceManagerClient(this.credentials);
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    const { credentials } = this.connected();
    this.credentials = { ...credentials, location: AzureLocationSchema.parse(target.region) };
  }

  async verify(): Promise<VerifyResult> {
    try {
      const { client, credentials } = this.connected();
      await client.verifySubscription();
      return {
        success: true,
        email: `Azure subscription ${credentials.subscriptionId} (${credentials.location})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
  }

  async readProviderEnvironmentVariables(request: ProviderEnvironmentVariablesRequest): Promise<ProviderEnvironmentVariablesResult> {
    try {
      const binding = parseHostingBindings(request.environment);
      const appId = binding.services?.[request.service.name]?.serviceId;
      if (binding.provider !== this.name || !binding.projectId || !binding.environmentId || !appId) throw new Error();
      const project = this.projectFromResourceGroup(binding.projectId, binding.environmentId);
      this.assertAppScope(appId, project.resourceGroupId);
      const app = await this.getResource(appId, CONTAINER_APPS_API);
      if (!app || app.id.toLowerCase() !== appId.toLowerCase() || !this.isOwned(app, request.environment.id)) throw new Error();
      this.assertAppEnvironment(app, project.environmentId);
      const container = this.container(app);
      if (!container?.image || !Array.isArray(container.env ?? [])) throw new Error();
      const secrets = await this.listAppSecrets(appId);
      if (secrets.some(secret => !secret.name) || new Set(secrets.map(secret => secret.name)).size !== secrets.length) throw new Error();
      const references = new Set((app.properties?.configuration?.secrets ?? []).filter((secret: any) => secret.keyVaultUrl).map((secret: any) => secret.name));
      const byName = new Map(secrets.map(secret => [secret.name, secret.value]));
      const variables: Record<string, string> = {}; const unresolvedKeys: string[] = [];
      const entries = container.env ?? [];
      if (entries.some((entry: any) => typeof entry.name !== 'string') || new Set(entries.map((entry: any) => entry.name)).size !== entries.length) throw new Error();
      for (const entry of entries) {
        if (typeof entry.value === 'string' && !entry.secretRef) variables[entry.name] = entry.value;
        else if (!references.has(entry.secretRef) && typeof byName.get(entry.secretRef) === 'string') variables[entry.name] = byName.get(entry.secretRef)!;
        else unresolvedKeys.push(entry.name);
      }
      return { success: true, variables, ...(unresolvedKeys.length ? { unresolvedKeys: unresolvedKeys.sort() } : {}) };
    } catch { return { success: false, error: 'Exact Azure Container App configuration could not be verified.' }; }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    if (options.requireCredentialUpdate) return this.setCredentialEnvVars(environment, service, vars);
    return { success: false, message: 'Only reviewed credential updates are available for existing workloads. Resource configuration is moving to OpenTofu.' };
  }

  private async setCredentialEnvVars(environment: Environment, service: Service, vars: Record<string, string>): Promise<Receipt> {
    let attempted = false;
    try {
      const binding = parseHostingBindings(environment);
      const appId = binding.services?.[service.name]?.serviceId;
      if (binding.provider !== this.name || !binding.projectId || !binding.environmentId || !appId) throw new Error();
      const project = this.projectFromResourceGroup(binding.projectId, binding.environmentId);
      this.assertAppScope(appId, project.resourceGroupId);
      const app = await this.getResource(appId, CONTAINER_APPS_API);
      if (!app || !app.location || app.id.toLowerCase() !== appId.toLowerCase() || !this.isOwned(app, environment.id)) throw new Error();
      this.assertAppEnvironment(app, project.environmentId);
      const container = this.container(app);
      if (!container?.image || !Array.isArray(container.env ?? [])) throw new Error();
      const secrets = await this.listAppSecrets(appId);
      if (new Set(secrets.map(secret => secret.name)).size !== secrets.length || secrets.some(secret => !secret.name)) throw new Error();
      const byName = new Map<string, any>((app.properties?.configuration?.secrets ?? []).map((secret: any) => [secret.name, secret]));
      for (const secret of secrets) byName.set(secret.name!, { ...byName.get(secret.name!), ...secret });
      if ([...byName.values()].some(secret => typeof secret.value !== 'string' && typeof secret.keyVaultUrl !== 'string')) throw new Error();
      const remaining = new Map(Object.entries(vars));
      const env = (container.env ?? []).map((entry: any) => {
        if (!remaining.has(entry.name)) return entry;
        remaining.delete(entry.name);
        return { name: entry.name, secretRef: this.secretName(entry.name) };
      }).concat([...remaining].map(([name]) => ({ name, secretRef: this.secretName(name) })));
      if (new Set(env.map((entry: any) => entry.name)).size !== env.length) throw new Error();
      for (const [key, value] of Object.entries(vars)) {
        const name = this.secretName(key);
        const previous = (container.env ?? []).find((entry: any) => entry.name === key);
        // Never reuse an unreviewed secret slot that may belong to another input.
        if (byName.has(name) && previous?.secretRef !== name) throw new Error();
        if ((container.env ?? []).some((entry: any) => entry.secretRef === name && !Object.hasOwn(vars, entry.name))) throw new Error();
        byName.set(name, { name, value });
      }
      const templateChanged = JSON.stringify(env) !== JSON.stringify(container.env ?? []);
      // ARM uses JSON Merge Patch: omitted nested settings are preserved and
      // explicit null removes an old suffix before Azure chooses a new revision.
      const template = { containers: [{ ...container, env }], ...(app.properties?.template?.revisionSuffix ? { revisionSuffix: null } : {}) };
      const patch = { location: app.location, properties: { configuration: { secrets: [...byName.values()] }, ...(templateChanged ? { template } : {}) } };
      const identity = azureRuntimeIdentityFingerprint(app);
      const volumes = azureVolumeFingerprint(app.properties?.template);
      const beforeRevision = app.properties?.latestReadyRevisionName;
      attempted = true;
      await this.connected().client.request('PATCH', appId, CONTAINER_APPS_API, patch);
      const after = await this.waitForProvisioning(appId, CONTAINER_APPS_API);
      if (azureRuntimeIdentityFingerprint(after) !== identity || azureVolumeFingerprint(after.properties?.template) !== volumes) throw new Error();
      const readback = new Map((await this.listAppSecrets(appId)).map(secret => [secret.name, secret.value]));
      if (Object.entries(vars).some(([key, value]) => readback.get(this.secretName(key)) !== value)) throw new Error();
      const observedEnv = this.container(after)?.env ?? [];
      if (Object.keys(vars).some(key => observedEnv.find((entry: any) => entry.name === key)?.secretRef !== this.secretName(key))) throw new Error();
      return { success: true, message: 'Selected Azure credential configuration verified; runtime activation requires revision evidence.', data: {
        serviceId: appId, credentialValueEvidence: 'readback', credentialUpdateActivation: templateChanged ? 'provider-rollout' : 'deferred',
        configurationUpdated: true, runtimeRolloutRequired: true, mutationAttempted: true,
        rolloutBaseline: beforeRevision ? { state: 'present', deploymentId: beforeRevision } : { state: 'unknown' },
        ...(templateChanged && after.properties?.latestRevisionName ? { deploymentId: after.properties.latestRevisionName } : {}),
      } };
    } catch { return { success: false, message: attempted ? 'Azure credential write requires readback recovery.' : 'Exact Azure credential target could not be verified; no write attempted.', data: { mutationAttempted: attempted } }; }
  }

  private async observedCredentialDeployment(app: AzureResource): Promise<ObservedService['deployment']> {
    const id = app.properties?.latestReadyRevisionName;
    if (typeof id !== 'string' || !id) return undefined;
    const base = { id, status: app.properties?.provisioningState };
    try {
      const revisions = await this.connected().client.listAll<AzureResource>(`${app.id}/revisions`, CONTAINER_APPS_API);
      if (!revisions.length || revisions.some(revision => !revision.name || revision.id.toLowerCase() !== `${app.id}/revisions/${revision.name}`.toLowerCase()
        || typeof revision.properties?.active !== 'boolean' || !Number.isInteger(revision.properties?.replicas) || revision.properties.replicas < 0)) return base;
      return { ...base, activeDeploymentIds: revisions.filter(revision => revision.properties?.active || revision.properties?.replicas > 0).map(revision => revision.name!).sort(), activeDeploymentCoverage: 'instances' };
    } catch { return base; }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId) return this.emptyObservation(false);
    const project = this.projectFromResourceGroup(bindings.projectId, bindings.environmentId);
    const [group, registry, managedEnvironment] = await Promise.all([
      this.getResource(project.resourceGroupId, RESOURCE_API),
      this.getResource(project.registryId, REGISTRY_API),
      this.getResource(project.environmentId, CONTAINER_APPS_API),
    ]);
    for (const resource of [group, registry, managedEnvironment]) {
      if (resource?.location && resource.location.toLowerCase() !== this.connected().credentials.location.toLowerCase()) {
        throw new Error(
          `Bound Azure resource ${resource.id} is in ${resource.location}, but desired hosting.region is ${this.connected().credentials.location}. Region changes require an explicit teardown and recreate; Hypervibe will not move bound infrastructure implicitly.`
        );
      }
    }
    const principalId = await this.connected().client.servicePrincipalId();
    const pushReady = await this.roleAssignmentExists(project.registryId, principalId, ACR_PUSH_ROLE);
    const projectExists = Boolean(
      group && this.isOwned(group, environment.id)
      && registry && this.isOwned(registry, environment.id)
      && managedEnvironment && this.isOwned(managedEnvironment, environment.id)
      && pushReady
    );
    const services: ObservedService[] = [];
    const warnings: string[] = [];
    for (const [name, binding] of Object.entries(bindings.services ?? {})) {
      if (!binding.serviceId) continue;
      const app = await this.getResource(binding.serviceId, CONTAINER_APPS_API);
      if (!app) continue;
      this.assertAppEnvironment(app, project.environmentId);
      if (!this.isOwned(app, environment.id)) {
        warnings.push(`Container App ${app.id} is not owned by this Hypervibe environment.`);
        continue;
      }
      if (!app.identity?.principalId
        || !await this.roleAssignmentExists(project.registryId, app.identity.principalId, ACR_PULL_ROLE)) {
        warnings.push(`Container App ${app.id} is missing its exact ACR pull role assignment.`);
        continue;
      }
      const container = this.container(app);
      const secretValues = Object.fromEntries(
        (await this.listAppSecrets(app.id)).filter((item: any) => typeof item.name === 'string' && typeof item.value === 'string')
          .map((item: any) => [item.name, item.value])
      );
      const envValues = Object.fromEntries(
        (container?.env ?? []).map((item: any) => [
          item.name,
          typeof item.value === 'string' ? item.value : secretValues[item.secretRef],
        ]).filter((entry: any[]) => typeof entry[0] === 'string' && typeof entry[1] === 'string')
      ) as Record<string, string>;
      const visible = Object.entries(envValues).filter(([key]) => !INTERNAL_ENV_KEYS.has(key));
      const customDomains = this.azureCustomDomains(app).map((domain) => domain.name).filter(Boolean) as string[];
      const deployment = await this.observedCredentialDeployment(app);
      services.push({
        name,
        externalId: app.id,
        workloadKind: 'web',
        ...(this.appUrl(app) ? { url: this.appUrl(app) } : {}),
        customDomains,
        customDomainStatus: await this.observeAzureDomains(project, app, customDomains),
        config: {
          ...(envValues[START_COMMAND_KEY] ? { startCommand: envValues[START_COMMAND_KEY] } : {}),
          ...(envValues[HEALTH_CHECK_PATH_KEY] ? { healthCheckPath: envValues[HEALTH_CHECK_PATH_KEY] } : {}),
          public: app.properties?.configuration?.ingress?.external === true,
        },
        sourceState: 'disconnected',
        envVarKeys: (container?.env ?? []).map((entry: any) => entry.name).filter((name: unknown): name is string => typeof name === 'string' && !INTERNAL_ENV_KEYS.has(name)).sort(),
        envVarState: (container?.env ?? []).some((entry: any) => typeof envValues[entry.name] !== 'string') ? 'unknown' : 'resolved',
        envVarHashes: Object.fromEntries(visible.map(([key, value]) => [key, hashEnvValue(value)])),
        ...(deployment ? { deployment } : {}),
        status: app.properties?.provisioningState === 'Succeeded'
          ? (container?.image === BOOTSTRAP_IMAGE ? 'empty' : 'running')
          : app.properties?.provisioningState === 'Failed' ? 'failed' : 'unknown',
        maintenance: {
          state: app.properties?.runningStatus === 'Stopped' ? 'suspended'
            : app.properties?.runningStatus === 'Running' ? 'running'
              : 'unknown',
          providerState: { runningStatus: app.properties?.runningStatus ?? 'unknown' },
        },
      });
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      projectId: project.resourceGroupId,
      environmentId: project.environmentId,
      services,
      databases: [],
      completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      partial: false,
      warnings: [
        ...(!projectExists ? ['The bound Azure project is missing its resource group, registry, managed environment, or exact ACR push role assignment.'] : []),
        ...warnings,
      ],
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const environment = environmentForInspection(request);
    const bindings = parseHostingBindings(environment);
    let project = bindings.projectId
      ? this.projectFromResourceGroup(bindings.projectId, bindings.environmentId)
      : this.desiredProject(request.project!.name, environment);
    let group = await this.getResource(project.resourceGroupId, RESOURCE_API);
    if (!bindings.projectId) {
      const legacy = this.desiredProject(request.project!.name, environment, true);
      const legacyGroup = await this.getResource(legacy.resourceGroupId, RESOURCE_API);
      if (group && legacyGroup) throw new Error('Multiple current/legacy Azure environment candidates require explicit identity selection.');
      if (legacyGroup) { project = legacy; group = legacyGroup; }
    }
    if (!group) {
      return {
        observation: 'absent',
        resource: 'environment',
        project: { id: project.resourceGroupId, name: project.resourceGroupName },
        environment: { id: project.environmentId, name: environment.name, region: this.connected().credentials.location },
        services: [],
      };
    }
    const apps = await this.listApps(project.resourceGroupId);
    return {
      observation: 'present',
      resource: 'environment',
      project: { id: project.resourceGroupId, name: project.resourceGroupName },
      environment: { id: project.environmentId, name: environment.name, region: this.connected().credentials.location },
      services: apps.slice(0, request.limit).map((app) => ({
        id: app.id,
        name: app.name,
        workloadKind: 'web',
        resourceType: 'container-app',
        managedByHypervibe: this.hasManagedTag(app),
        status: app.properties?.runningStatus ?? app.properties?.provisioningState ?? null,
      })),
      managedByHypervibe: this.hasManagedTag(group),
      partial: apps.length > request.limit,
    };
  }

  async observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation> {
    const binding = Object.values(parseHostingBindings(environment).services ?? {})
      .find((candidate) => candidate.serviceId === serviceId);
    if (!binding) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_unbound' };
    }
    const app = await this.getResource(serviceId, CONTAINER_APPS_API);
    if (!app || !this.isOwned(app, environment.id)) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_identity_unknown' };
    }
    const runningStatus = String(app.properties?.runningStatus ?? 'unknown');
    return {
      serviceId,
      workloadKind,
      wasRunning: runningStatus === 'Running',
      state: runningStatus === 'Stopped' ? 'suspended'
        : runningStatus === 'Running' ? 'running'
          : 'unknown',
      providerState: { runningStatus },
    };
  }

  async suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(
      environment,
      expected.serviceId,
      expected.workloadKind
    );
    if (current.state === 'suspended') {
      return { success: true, message: `Container App ${expected.serviceId} is already stopped`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'running') {
      return this.failedReceipt('Container App was not stopped', 'The bound workload state is unknown.');
    }
    await this.connected().client.request('POST', `${expected.serviceId}/stop`, CONTAINER_APPS_API);
    const verified = await this.waitForRunningStatus(expected.serviceId, 'Stopped');
    return verified
      ? { success: true, message: `Stopped Container App ${expected.serviceId}`, data: { applied: 1, skipped: 0 } }
      : this.failedReceipt('Container App stop was not verified', 'The provider did not report Stopped before the verification deadline.');
  }

  async resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
    if (!snapshot.wasRunning) {
      return current.state === 'suspended'
        ? { success: true, message: `Container App ${snapshot.serviceId} was stopped before maintenance`, data: { applied: 0, skipped: 1 } }
        : this.failedReceipt('Container App restoration was blocked', 'A workload that was previously stopped is now running.');
    }
    if (current.state === 'running') {
      return { success: true, message: `Container App ${snapshot.serviceId} is already running`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'suspended') {
      return this.failedReceipt('Container App was not started', 'The bound workload state is unknown.');
    }
    await this.connected().client.request('POST', `${snapshot.serviceId}/start`, CONTAINER_APPS_API);
    const verified = await this.waitForRunningStatus(snapshot.serviceId, 'Running');
    return verified
      ? { success: true, message: `Started Container App ${snapshot.serviceId}`, data: { applied: 1, skipped: 0 } }
      : this.failedReceipt('Container App start was not verified', 'The provider did not report Running before the verification deadline.');
  }

  private connected(): { client: AzureResourceManagerClient; credentials: ConnectedAzureContainerAppsCredentials } {
    if (!this.client || !this.credentials) throw new Error('Not connected. Call connect() first.');
    return { client: this.client, credentials: this.credentials };
  }

  private desiredProject(projectName: string, environment: Environment, legacy = false): AzureProject {
    const scope = (legacy ? legacyAzureEnvironmentResourceGroupScope : azureEnvironmentResourceGroupScope)({
      subscriptionId: this.connected().credentials.subscriptionId,
      projectName,
      environmentId: environment.projectId,
      environmentName: environment.name,
    });
    return this.projectFromResourceGroup(scope.resourceGroupId,
      legacy ? undefined : `${scope.resourceGroupId}/providers/Microsoft.App/managedEnvironments/runtime`);
  }

  private projectFromResourceGroup(resourceGroupId: string, boundEnvironmentId?: string): AzureProject {
    const scope = parseAzureResourceGroupScope(
      resourceGroupId,
      this.connected().credentials.subscriptionId
    );
    const canonical = scope.resourceGroupId;
    const registryName = azureRegistryName(canonical);
    const environmentPrefix = `${canonical}/providers/Microsoft.App/managedEnvironments/`;
    if (boundEnvironmentId && (!boundEnvironmentId.toLowerCase().startsWith(environmentPrefix.toLowerCase())
      || !/^[a-z0-9-]+$/i.test(boundEnvironmentId.slice(environmentPrefix.length)))) {
      throw new Error(`Bound managed environment ${boundEnvironmentId} is outside ${canonical}.`);
    }
    const environmentName = boundEnvironmentId?.slice(environmentPrefix.length)
      ?? this.safeName(`hv-${scope.resourceGroup}-env`, 50, canonical);
    return {
      resourceGroupId: canonical,
      resourceGroupName: scope.resourceGroup,
      registryName,
      registryServer: `${registryName}.azurecr.io`,
      registryId: `${canonical}/providers/Microsoft.ContainerRegistry/registries/${registryName}`,
      environmentName,
      environmentId: boundEnvironmentId ?? `${environmentPrefix}${environmentName}`,
    };
  }

  private async roleAssignmentExists(scope: string, principalId: string, roleId: string): Promise<boolean> {
    const id = this.roleAssignmentId(scope, principalId, roleId);
    const assignment = await this.getResource(id, AUTHORIZATION_API);
    if (!assignment) return false;
    const properties = assignment.properties ?? {};
    if (String(properties.principalId).toLowerCase() !== principalId.toLowerCase()
      || !String(properties.roleDefinitionId).toLowerCase().endsWith(`/roledefinitions/${roleId}`)) {
      throw new Error(`Azure role assignment ${id} changed identity.`);
    }
    return true;
  }

  private roleAssignmentId(scope: string, principalId: string, roleId: string): string {
    const hex = this.hash(`${scope.toLowerCase()}:${principalId.toLowerCase()}:${roleId}`).slice(0, 32);
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return `${scope}/providers/Microsoft.Authorization/roleAssignments/${uuid}`;
  }

  private async waitForProvisioning(id: string, apiVersion: string): Promise<AzureResource> {
    for (let attempt = 1; attempt <= 180; attempt += 1) {
      const resource = await this.getResource(id, apiVersion);
      if (!resource) throw new Error(`Azure resource ${id} disappeared during reconciliation.`);
      const state = String(resource.properties?.provisioningState ?? 'Succeeded');
      if (state === 'Succeeded') return resource;
      if (['Failed', 'Canceled', 'DeleteFailed'].includes(state)) throw new Error(`Azure resource ${id} is ${state}.`);
      if (attempt < 180) await this.delay();
    }
    throw new Error(`Azure resource ${id} did not finish provisioning.`);
  }

  private async waitForRunningStatus(id: string, expected: 'Running' | 'Stopped'): Promise<boolean> {
    for (let attempt = 1; attempt <= 180; attempt += 1) {
      const resource = await this.getResource(id, CONTAINER_APPS_API);
      if (!resource) return false;
      const state = String(resource.properties?.runningStatus ?? 'unknown');
      if (state === expected) return true;
      if (!['Progressing', 'Running', 'Stopped'].includes(state)) return false;
      if (attempt < 180) await this.delay();
    }
    return false;
  }

  private async getResource(id: string, apiVersion: string): Promise<AzureResource | null> {
    const resource = await this.connected().client.getNullable<AzureResource>(id, apiVersion);
    if (resource && resource.id.toLowerCase() !== id.toLowerCase()) {
      throw new Error(`Azure returned resource ${resource.id} outside requested identity ${id}.`);
    }
    return resource;
  }

  private async listApps(resourceGroupId: string): Promise<AzureResource[]> {
    const apps = await this.connected().client.listAll<AzureResource>(
      `${resourceGroupId}/providers/Microsoft.App/containerApps`,
      CONTAINER_APPS_API
    );
    for (const app of apps) this.assertAppScope(app.id, resourceGroupId);
    return apps;
  }

  private async listAppSecrets(appId: string): Promise<Array<{ name?: string; value?: string }>> {
    const result = await this.connected().client.request<{ value?: Array<{ name?: string; value?: string }> }>(
      'POST',
      `${appId}/listSecrets`,
      CONTAINER_APPS_API
    );
    if (!Array.isArray(result.value)) throw new Error(`Azure returned incomplete secrets metadata for ${appId}.`);
    return result.value;
  }

  private container(app: AzureResource | null): any | undefined {
    const containers = app?.properties?.template?.containers;
    if (!Array.isArray(containers)) return undefined;
    if (containers.length !== 1) throw new Error(`Container App ${app?.id} has ${containers.length} containers; Hypervibe expects exactly one.`);
    return containers[0];
  }

  private appUrl(app: AzureResource): string | undefined {
    const fqdn = app.properties?.configuration?.ingress?.fqdn;
    return typeof fqdn === 'string' ? `https://${fqdn}` : undefined;
  }

  private assertAppScope(appId: string, resourceGroupId: string): void {
    if (!appId.toLowerCase().startsWith(`${resourceGroupId.toLowerCase()}/providers/microsoft.app/containerapps/`)) {
      throw new Error(`Container App ${appId} is outside bound resource group ${resourceGroupId}.`);
    }
  }

  private assertAppEnvironment(app: AzureResource, environmentId: string): void {
    const observed = app.properties?.environmentId ?? app.properties?.managedEnvironmentId;
    if (typeof observed !== 'string' || observed.toLowerCase() !== environmentId.toLowerCase()) {
      throw new Error(`Container App ${app.id} is outside managed environment ${environmentId}.`);
    }
  }

  private managedCertificateId(project: AzureProject, domain: string): string {
    return `${project.environmentId}/managedCertificates/hv-${this.hash(domain).slice(0, 24)}`;
  }

  private azureCustomDomains(app: AzureResource): Array<{ name?: string; bindingType?: string; certificateId?: string }> {
    const domains = app.properties?.configuration?.ingress?.customDomains
      ?? app.properties?.configuration?.customDomains
      ?? [];
    if (!Array.isArray(domains)) throw new Error(`Azure returned invalid custom domains for ${app.id}.`);
    return domains;
  }

  private async observeAzureDomains(
    project: AzureProject,
    app: AzureResource,
    domains: string[]
  ): Promise<ObservedService['customDomainStatus']> {
    const result: NonNullable<ObservedService['customDomainStatus']> = {};
    for (const domain of domains) {
      const binding = this.azureCustomDomains(app).find((item) => item.name === domain);
      const certificateId = this.managedCertificateId(project, domain);
      const certificate = await this.getResource(certificateId, CONTAINER_APPS_API);
      const state = String(certificate?.properties?.provisioningState ?? 'ABSENT');
      result[domain] = {
        providerVerified: state === 'Succeeded' && binding?.bindingType === 'SniEnabled'
          && binding.certificateId?.toLowerCase() === certificateId.toLowerCase(),
        certificateStatus: state,
        dnsConfigured: state === 'Succeeded',
      };
    }
    return result;
  }

  private secretName(key: string): string {
    return `hv-${this.hash(key).slice(0, 24)}`;
  }

  private safeName(value: string, length: number, salt: string): string {
    const prefix = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, length) || 'hypervibe';
    return `${prefix}-${this.hash(salt).slice(0, 8)}`;
  }

  private isOwned(resource: AzureResource, environmentId: string): boolean {
    return resource.tags?.['managed-by'] === 'hypervibe'
      && resource.tags?.['hypervibe-environment-id'] === environmentId;
  }

  private hasManagedTag(resource: AzureResource): boolean {
    return resource.tags?.['managed-by'] === 'hypervibe';
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private async delay(): Promise<void> {
    const value = Number(process.env.HYPERVIBE_AZURE_WAIT_DELAY_MS ?? 1000);
    if (Number.isFinite(value) && value > 0) await new Promise((resolve) => setTimeout(resolve, value));
  }

  private emptyObservation(projectExists: boolean): ObservedState {
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      services: [],
      databases: [],
      completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      partial: false,
      warnings: [],
    };
  }

  private failedReceipt(message: string, error: string): Receipt {
    return { success: false, message, error };
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: 'azure-container-apps',
    displayName: 'Azure Container Apps',
    category: 'deployment',
    credentialsSchema: AzureContainerAppsCredentialsSchema,
    setupHelpUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      environmentVariableAliases: [
        ['HYPERVIBE_AZURE_TENANT_ID', 'AZURE_TENANT_ID'],
        ['HYPERVIBE_AZURE_SUBSCRIPTION_ID', 'AZURE_SUBSCRIPTION_ID'],
        ['HYPERVIBE_AZURE_CLIENT_ID', 'AZURE_CLIENT_ID'],
        ['HYPERVIBE_AZURE_CLIENT_SECRET', 'AZURE_CLIENT_SECRET'],
      ],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'planned', reason: 'Resource lifecycle is moving to OpenTofu; this adapter provides connections and existing-resource operations only.' },
      },
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: { workloadKindObservation: 'exact' },
      ci: {
        displayName: 'Azure Container Apps',
        rendererRevision: 1,
        requiredSecrets: AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AZURE_TENANT_ID: 'tenantId',
          AZURE_SUBSCRIPTION_ID: 'subscriptionId',
          AZURE_CLIENT_ID: 'clientId',
          AZURE_CLIENT_SECRET: 'clientSecret',
        },
        buildGitHubActionsSteps: buildAzureContainerAppsGitHubActionsSteps,
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new AzureContainerAppsAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['environment'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'region', 'limit'], list: true },
    },
    inspect: (adapter, request) => (
      adapter as AzureContainerAppsAdapter
    ).inspectEnvironmentResources(request),
  },
});
