import { AzureRuntimeIdentities } from './azure-runtime-identities.js';
import { azurePreparedHostingBinding } from './azure-prepared-binding.js';
import { azurePreparedHoldingTransition, azurePreparedApplicationConfiguration, azurePreparedApplicationDigest, azureObservedPreparedApplicationConfiguration } from './azure-prepared-release.js';
import { azurePreparedCoordinates, azurePreparedGrantId, azurePreparedGrantDescription } from './azure-prepared-hosting.js';
import type { CloudDeploymentAdapterInputV1, CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { validateCloudDeploymentAdapterInputV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import { azureDeploymentContract } from './azure-cloud-deployment.js';
import { runtimeAccessBindings } from '../../../domain/services/runtime-access.service.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateRuntimeSecretReferences, runtimeSecretReferenceIdentity } from '../../../domain/services/runtime-secret-references.js';
import type { RuntimeSecretReference } from '../../../domain/ports/secret-destination.port.js';
import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises';
import { z } from 'zod';
import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type {
  IWorkloadMaintenanceAdapter,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  ComponentResult,
  DeploymentMutationOptions,
  DeployResult,
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
import { buildAzureContainerAppsPortableRecipe } from './azure-container-apps-ci.recipe.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import { AzureServiceVolumes } from './azure-service-volumes.js';
import { azureVolumeFingerprint } from './azure-volume-runtime.js';
import {
  azureEnvironmentResourceGroupScope,
  legacyAzureEnvironmentResourceGroupScope,
  parseAzureResourceGroupScope,
} from './azure-environment-scope.js';

const RESOURCE_API = '2024-11-01';
const RESOURCE_LIST_API = '2021-04-01';
const PROVIDER_API = '2021-04-01';
const REGISTRY_API = '2025-11-01';
const CONTAINER_APPS_API = '2026-01-01';
const AUTHORIZATION_API = '2022-04-01';
const BOOTSTRAP_IMAGE = `mcr.microsoft.com/oss/nodejs/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;
const BOOTSTRAP_SCRIPT = "require('http').createServer((_,res)=>{res.writeHead(200);res.end('hypervibe bootstrap')}).listen(8080)";
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
  tenantId: z.string().guid('Azure tenant ID must be a UUID'),
  subscriptionId: z.string().guid('Azure subscription ID must be a UUID'),
  clientId: z.string().guid('Azure service principal client ID must be a UUID'),
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
type ConnectedAzureContainerAppsCredentials = (AzureContainerAppsCredentials | Extract<import('./azure-resource-manager.client.js').AzureResourceManagerCredentials, { authMode: 'federated' }>) & { location: string };

type AzureResource = {
  id: string;
  name: string;
  location?: string;
  identity?: { principalId?: string; tenantId?: string; type?: string; userAssignedIdentities?: Record<string, { principalId?: string; clientId?: string }> };
  properties?: Record<string, any>;
  tags?: Record<string, string>;
  systemData?: { createdAt?: string };
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
  private readonly installedPreparedHosting = azurePreparedHostingBinding(() => this.deploymentConnection, () => this.connected().client);
  get preparedHosting() { return this.deploymentConnection?.preparedResources ? this.installedPreparedHosting : undefined; }
  readonly runtimeIdentities = new AzureRuntimeIdentities(() => { const { client, credentials } = this.connected(); return { client, ...credentials, deployClientId: credentials.clientId, deployment: this.deploymentConnection }; });
  readonly serviceVolumes = new AzureServiceVolumes(() => this.connected().client);

  readonly capabilities: ProviderCapabilities = {
    runtimeSecretReferenceProviders: ['azure-key-vault'],
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    supportsDeferredDeploy: true,
    supportsMaintenance: true,
  };

  private credentials: ConnectedAzureContainerAppsCredentials | null = null;
  private client: AzureResourceManagerClient | null = null;
  private deploymentConnection?: CloudDeploymentConnectionV1;

  /** Internal authenticated broker input; never accepted by connect(credentials). */
  async connectTransient(input: CloudDeploymentAdapterInputV1): Promise<void> {
    const validated = validateCloudDeploymentAdapterInputV1(input, azureDeploymentContract);
    const { authentication, connection } = validated;
    if (authentication.kind !== 'azure-federation') throw new Error('Azure transient authorization is unavailable.');
    const { principal } = authentication;
    const credentials = { authMode: 'federated' as const, ...principal, resourceGroup: connection.nativeScope.resourceGroup,
      location: connection.nativeScope.location, getAccessToken: authentication.getAccessToken,
      readerVaultIds: [...new Set(connection.deployment.workloads.flatMap(workload => workload.runtimeSecrets.map(({ reference }) => {
        const d = reference.destination;
        if (d.provider !== 'azure-key-vault' || d.tenantId !== principal.tenantId || d.subscriptionId !== principal.subscriptionId) throw new Error('Azure reader scope does not match its deployment approval.');
        return `/subscriptions/${d.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`;
      })))] };
    const client = new AzureResourceManagerClient(credentials);
    await client.servicePrincipalId();
    this.credentials = credentials;
    this.client = client;
    this.deploymentConnection = connection;
  }

  async connect(credentials: unknown): Promise<void> {
    this.deploymentConnection = undefined;
    const parsed = AzureContainerAppsCredentialsSchema.parse(credentials);
    const legacyLocation = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).location === 'string'
      ? (credentials as Record<string, string>).location
      : DEFAULT_AZURE_CONTAINER_APPS_LOCATION;
    this.credentials = { ...parsed, location: AzureLocationSchema.parse(legacyLocation) };
    this.client = new AzureResourceManagerClient(this.credentials);
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    if (this.deploymentConnection && target.region !== this.deploymentConnection.nativeScope.location) throw new Error('Azure placement requires a new deployment approval.');
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
    this.deploymentConnection = undefined;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (this.deploymentConnection?.preparedResources) {
      try {
        const connection = this.deploymentConnection, prepared = connection.preparedResources!, c = azurePreparedCoordinates(connection), bound = parseHostingBindings(environment);
        if (environment.name !== connection.environment || bound.projectId && bound.projectId.toLowerCase() !== c.group.toLowerCase()
          || bound.environmentId && bound.environmentId.toLowerCase() !== prepared.project.id.toLowerCase()) throw new Error();
        for (const [id, version] of [[c.group, RESOURCE_API], [prepared.registry.id, REGISTRY_API], [prepared.project.id, CONTAINER_APPS_API]]) {
          const native = await this.getResource(id, version);
          if (!native || !this.isOwned(native, environment.id) || native.properties?.provisioningState !== 'Succeeded' || native.location !== connection.nativeScope.location) throw new Error();
          if (id === prepared.registry.id && (native.properties.loginServer !== c.registryServer || native.properties.adminUserEnabled !== false)) throw new Error();
        }
        if (!await this.roleAssignmentExists(prepared.registry.id, await this.connected().client.servicePrincipalId(), ACR_PUSH_ROLE)) throw new Error();
        return { success: true, message: 'Verified the exact administrator-installed Azure namespace; no cloud resources or permissions changed.', data: {
          projectId: c.group, environmentId: prepared.project.id, providerBindings: { providerScope: { registryResourceId: prepared.registry.id,
            registryCreatedAt: prepared.registry.lifetimeId, registryServer: c.registryServer, managedEnvironmentCreatedAt: prepared.project.lifetimeId } } } };
      } catch { return { success: false, message: 'The exact installed Azure namespace could not be verified.', data: { mutationAttempted: false } }; }
    }
    if (this.deploymentConnection) return { success: false, message: 'Azure namespace creation and setup grants remain blocked until native creation ownership is verified.', data: { mutationAttempted: false, reason: 'create_ownership_unverified' } };
    try {
      const bindings = parseHostingBindings(environment);
      const desired = bindings.projectId
        ? this.projectFromResourceGroup(bindings.projectId, bindings.environmentId)
        : this.desiredProject(projectName, environment);
      if (!bindings.projectId) {
        const legacy = this.desiredProject(projectName, environment, true);
        if (await this.getResource(legacy.resourceGroupId, RESOURCE_API)) {
          throw new Error(`Legacy Azure resource group ${legacy.resourceGroupId} exists without a durable binding; explicit import is required.`);
        }
      }
      if (bindings.environmentId && bindings.environmentId !== desired.environmentId) {
        throw new Error(`Bound Container Apps environment ${bindings.environmentId} does not match ${desired.environmentId}.`);
      }
      const existingGroup = await this.getResource(desired.resourceGroupId, RESOURCE_API);
      const existingEnvironment = await this.getResource(desired.environmentId, CONTAINER_APPS_API);
      if (!bindings.projectId && existingEnvironment) {
        return this.failedReceipt(
          'Failed to ensure Azure Container Apps project',
          `Azure managed environment ${desired.environmentId} already exists. Hypervibe will not silently adopt it.`
        );
      }
      if (!bindings.projectId && existingGroup && !this.isOwned(existingGroup, environment.id)) {
        return this.failedReceipt(
          'Failed to ensure Azure Container Apps project',
          `Azure resource group ${desired.resourceGroupId} already exists but is not owned by this Hypervibe environment.`
        );
      }
      if (bindings.projectId && !existingGroup) {
        return this.failedReceipt(
          'Failed to ensure Azure Container Apps project',
          `Bound Azure resource group ${desired.resourceGroupId} was not found. Hypervibe will not create a replacement from a stale binding.`
        );
      }
      if (bindings.projectId && existingGroup && !this.isOwned(existingGroup, environment.id)) {
        return this.failedReceipt(
          'Failed to ensure Azure Container Apps project',
          `Bound Azure resource group ${desired.resourceGroupId} is not owned by this Hypervibe environment.`
        );
      }
      if (bindings.projectId && existingEnvironment && !this.isOwned(existingEnvironment, environment.id)) {
        return this.failedReceipt(
          'Failed to ensure Azure Container Apps project',
          `Bound Azure managed environment ${desired.environmentId} is not owned by this Hypervibe environment.`
        );
      }

      await this.ensureProviderRegistration('Microsoft.App');
      await this.ensureProviderRegistration('Microsoft.ContainerRegistry');
      if (!existingGroup) {
        await this.connected().client.request('PUT', desired.resourceGroupId, RESOURCE_API, {
          location: this.connected().credentials.location,
          tags: this.tags(environment),
        });
      }
      await this.ensureRegistry(desired, environment);
      await this.ensureRoleAssignment(
        desired.registryId,
        await this.connected().client.servicePrincipalId(),
        ACR_PUSH_ROLE,
        'ServicePrincipal'
      );
      if (!existingEnvironment) {
        await this.connected().client.request('PUT', desired.environmentId, CONTAINER_APPS_API, {
          location: this.connected().credentials.location,
          tags: this.tags(environment),
          properties: {},
        });
      }
      const ready = await this.waitForProvisioning(desired.environmentId, CONTAINER_APPS_API);
      return {
        success: true,
        message: existingEnvironment
          ? `Verified Azure Container Apps project: ${desired.resourceGroupName}`
          : `Created Azure Container Apps project: ${desired.resourceGroupName}`,
        data: {
          projectId: desired.resourceGroupId,
          environmentId: ready.id,
          projectName: desired.resourceGroupName,
          created: !existingEnvironment,
        },
      };
    } catch (error) {
      return this.failedReceipt('Failed to ensure Azure Container Apps project', this.formatError(error));
    }
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    return {
      component: {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: {
        success: false,
        message: 'Azure datastores use separate provider adapters and explicit plan actions.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (this.deploymentConnection && !parseHostingBindings(environment).services?.[service.name]?.serviceId) return this.failedDeploy(service,
      'Azure first workload creation remains blocked until native conditional creation ownership is verified.');
    if (options.requireNewWorkload) return this.failedDeploy(service, 'Azure Container Apps does not expose a verified conditional-create API. This reviewed create-only request is blocked before provider access.');
    let secretVersionRefs: Record<string, RuntimeSecretReference>;
    try {
      secretVersionRefs = validateRuntimeSecretReferences(options.secretVersionRefs, envVars, (destination) =>
        destination.provider === 'azure-key-vault'
        && destination.tenantId.toLowerCase() === this.connected().credentials.tenantId.toLowerCase()
        && destination.subscriptionId.toLowerCase() === this.connected().credentials.subscriptionId.toLowerCase());
    } catch { return this.failedDeploy(service, 'Invalid or conflicting runtime secret reference.'); }
    if (this.deploymentConnection) {
      const reviewed = this.deploymentConnection.deployment.workloads.find(workload => workload.name === service.name);
      const expected = reviewed?.runtimeSecrets.map(({ key, reference }) => [key, reference] as const).sort(([left], [right]) => left.localeCompare(right));
      const supplied = Object.entries(secretVersionRefs).sort(([left], [right]) => left.localeCompare(right));
      if (environment.name !== this.deploymentConnection.environment || !reviewed || reviewed.kind !== serviceWorkloadKind(service)
        || !isDeepStrictEqual(supplied, expected)) return this.failedDeploy(service, 'Runtime secret references differ from the separately approved deployment. Review new deployment access before changing them.');
    }
    if (this.deploymentConnection?.preparedResources) return this.deployPrepared(service, environment, envVars, secretVersionRefs);
    if (serviceWorkloadKind(service) !== 'web') {
      return this.failedDeploy(service, 'Azure Container Apps Jobs and workers require distinct lifecycle resources and are not yet supported.');
    }
    if (service.buildConfig.public === false) {
      return this.failedDeploy(service, 'Private Container Apps ingress requires an explicit network resource and is not yet supported.');
    }
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId || !bindings.environmentId) {
      return this.failedDeploy(service, 'No bound Azure resource group and managed environment exist. The project action must complete first.');
    }
    let runtimeReader: string | undefined;
    let attemptedApp: AzureResource | null = null;
    let createdService = false;
    try {
      const runtimeBinding = runtimeAccessBindings(environment)?.runtimeIdentities[service.name];
      if (runtimeBinding) {
        const runtime = await this.runtimeIdentities.inspect({ environment, service, binding: runtimeBinding, mode: 'ensure',
          environmentSpec: { secretDestinations: secretVersionRefs } as never });
        if (runtime.state !== 'ready' || !runtime.identity) throw new Error('The reviewed Azure runtime identity and reader permissions are not ready.');
        runtimeReader = runtime.identity.scope.identityResourceId ?? 'system';
      }
      const project = this.projectFromResourceGroup(bindings.projectId, bindings.environmentId);
      if (project.environmentId !== bindings.environmentId) {
        throw new Error(`Bound managed environment ${bindings.environmentId} is outside ${bindings.projectId}.`);
      }
      const existingEnvironment = await this.getResource(project.environmentId, CONTAINER_APPS_API);
      if (!existingEnvironment) throw new Error(`Bound managed environment ${project.environmentId} was not found.`);
      const boundId = bindings.services?.[service.name]?.serviceId;
      let previousReadyRevision: string | undefined;
      let app: AzureResource | null = null;
      if (boundId) {
        this.assertAppScope(boundId, project.resourceGroupId);
        app = await this.getResource(boundId, CONTAINER_APPS_API);
        if (!app) return this.failedDeploy(service, `Bound Container App ${boundId} was not found. Hypervibe will not create a replacement from a stale binding.`);
        this.assertAppEnvironment(app, project.environmentId);
        if (!this.isOwned(app, environment.id)) {
          return this.failedDeploy(service, `Bound Container App ${boundId} is not owned by this Hypervibe environment.`);
        }
        attemptedApp = app;
        previousReadyRevision = typeof app.properties?.latestReadyRevisionName === 'string'
          ? app.properties.latestReadyRevisionName
          : undefined;
      } else {
        const name = this.appName(service);
        const legacyName = this.safeName(`hv-${service.name}`, 20, service.id);
        const appId = `${project.resourceGroupId}/providers/Microsoft.App/containerApps/${name}`;
        const duplicates = (await this.listApps(project.resourceGroupId)).filter(
          (candidate) => [name, legacyName].includes(candidate.name.toLowerCase())
        );
        if (duplicates.length > 0) {
          return this.failedDeploy(service, `Azure Container App "${name}" already exists (${duplicates.map((item) => item.id).join(', ')}). Hypervibe will not silently adopt it.`);
        }
        app = await this.connected().client.request<AzureResource>('PUT', appId, CONTAINER_APPS_API, this.appBody({
          app: null,
          environment,
          environmentId: project.environmentId,
          project,
          service,
          envVars,
          secretVersionRefs, runtimeReader,
        }));
        attemptedApp = app;
        createdService = true;
      }
      if (!app) throw new Error('Azure Container App reconciliation returned no resource.');
      const expectedVolumes = azureVolumeFingerprint(app.properties?.template);
      this.assertAppEnvironment(app, project.environmentId);
      const principalId = app.identity?.principalId;
      if (!principalId) throw new Error(`Container App ${app.id} did not return its system-assigned identity.`);
      const desiredBody = this.appBody({
        app,
        environment,
        environmentId: project.environmentId,
        project,
        service,
        envVars,
        secretVersionRefs, runtimeReader,
      });
      await this.ensureRoleAssignment(project.registryId, principalId, ACR_PULL_ROLE, 'ServicePrincipal');
      app = await this.connected().client.request<AzureResource>('PATCH', app.id, CONTAINER_APPS_API, desiredBody);
      app = await this.waitForProvisioning(app.id, CONTAINER_APPS_API);
      app = await this.waitForContainerAppRevision(app.id, previousReadyRevision);
      this.assertSecretReferences(app, secretVersionRefs, runtimeReader ?? 'system');
      if (azureVolumeFingerprint(app.properties?.template) !== expectedVolumes) throw new Error('Azure volume mounts changed during runtime configuration.');
      const url = this.appUrl(app);
      return {
        serviceId: service.id,
        externalId: app.id,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared Azure Container App for exact-digest CI deployment: ${app.name}`
            : `Configured Azure Container App; an exact-digest CI deployment is still required: ${app.name}`,
          data: {
            serviceId: app.id,
            serviceName: app.name,
            resourceType: 'web',
            createdService,
            deploymentDeferred: true,
            pendingImage: this.container(app)?.image === BOOTSTRAP_IMAGE,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error), attemptedApp?.id, createdService);
    }
  }

  private async deployPrepared(service: Service, environment: Environment, vars: Record<string, string>, references: Record<string, RuntimeSecretReference>): Promise<DeployResult> {
    try {
      const connection = this.deploymentConnection!, prepared = connection.preparedResources!.workloads.find(item => item.workload === service.name);
      const bound = parseHostingBindings(environment).services?.[service.name], runtime = connection.runtimeIdentities.find(item => item.workload === service.name)?.principal;
      if (!prepared || !bound || bound.serviceId !== prepared.id || bound.resourceUid !== prepared.lifetimeId || runtime?.kind !== 'azure-managed-identity'
        || serviceWorkloadKind(service) !== 'web') throw new Error('The reviewed Azure prepared workload binding is unavailable.');
      const app = await this.getResource(prepared.id, CONTAINER_APPS_API) as any;
      const c = azurePreparedCoordinates(connection);
      if (!app || app.id?.toLowerCase() !== prepared.id.toLowerCase() || app.systemData?.createdAt !== prepared.lifetimeId
        || app.tags?.hypervibeInstallation !== connection.installationId || app.tags?.hypervibeDeployment !== c.owner
        || app.properties?.managedEnvironmentId?.toLowerCase() !== c.managedEnvironment.toLowerCase()) throw new Error('Azure prepared workload identity changed.');
      const binding = runtimeAccessBindings(environment)?.runtimeIdentities[service.name];
      const authority = await this.runtimeIdentities.inspect({ environment, service, binding, mode: 'ensure', environmentSpec: { secretDestinations: references } as never });
      if (authority.state !== 'ready' || !authority.identity) throw new Error('The installed Azure runtime reader is not ready.');
      const transition = azurePreparedHoldingTransition(connection, environment, service.name, app);
      const configuration = azurePreparedApplicationConfiguration({ identityId: runtime.identityResourceId, environmentId: c.managedEnvironment,
        registryServer: c.registryServer, envVars: vars, secretVersionRefs: references,
        startCommand: service.buildConfig.startCommand?.trim() || null, healthCheckPath: service.buildConfig.healthCheckPath?.trim() || null });
      if (transition) {
        if (azurePreparedApplicationDigest(configuration) !== transition.configurationDigest) throw new Error('Azure first runtime configuration requires a new reviewed preparation plan.');
        return { serviceId: service.id, externalId: prepared.id, status: 'configured', receipt: { success: true,
          message: 'Reviewed the first Azure application configuration; the holding workload remains unchanged until managed CI releases the candidate.',
          data: { serviceId: prepared.id, serviceName: app.name, resourceUid: prepared.lifetimeId, resourceType: 'service',
            imageUri: prepared.holding.image, createdService: false, deploymentDeferred: true, runtimeRolloutRequired: true,
            rolloutBaseline: { state: 'present', deploymentId: transition.deploymentId } } } };
      }
      const current = azureObservedPreparedApplicationConfiguration(app), image = app.properties.template.containers[0].image;
      const nativeIdentity = app.identity.userAssignedIdentities[runtime.identityResourceId];
      if (!nativeIdentity || nativeIdentity.clientId !== runtime.clientId || nativeIdentity.principalId !== runtime.principalId
        || typeof image !== 'string' || !image.startsWith(`${c.registryServer}/`) || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Azure application runtime identity or image changed.');
      if (azurePreparedApplicationDigest(current) !== azurePreparedApplicationDigest(configuration)) {
        const markers = app.properties.template.containers[0].env.filter((entry: any) => ['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(entry.name));
        const body = { ...configuration, properties: { ...configuration.properties, template: { ...configuration.properties.template,
          containers: [{ ...configuration.properties.template.containers[0], image, env: [...configuration.properties.template.containers[0].env, ...markers] }] } } };
        await this.connected().client.request('PATCH', prepared.id, CONTAINER_APPS_API, body);
        const observed = await this.waitForContainerAppRevision(prepared.id, app.properties.latestReadyRevisionName) as any;
        if (observed.systemData?.createdAt !== prepared.lifetimeId || azurePreparedApplicationDigest(azureObservedPreparedApplicationConfiguration(observed)) !== azurePreparedApplicationDigest(configuration)) throw new Error('Azure runtime configuration is not yet verified.');
      }
      return { serviceId: service.id, externalId: prepared.id, status: 'configured', receipt: { success: true, message: 'Verified the exact Azure application runtime configuration.',
        data: { serviceId: prepared.id, resourceUid: prepared.lifetimeId, resourceType: 'service', imageUri: image, deploymentDeferred: true, createdService: false } } };
    } catch { return this.failedDeploy(service, 'Azure prepared runtime identity or configuration could not be verified.'); }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    return (await this.deploy(service, environment, vars, options)).receipt;
  }

  async deleteEnvVars(environment: Environment, service: Service, keys: string[]): Promise<Receipt> {
    if (this.deploymentConnection) {
      const reviewed = this.deploymentConnection.deployment.workloads.find(workload => workload.name === service.name);
      if (environment.name !== this.deploymentConnection.environment || !reviewed || reviewed.runtimeSecrets.some(reference => keys.includes(reference.key)))
        return { success: false, message: 'Reviewed runtime secret references cannot be removed through the existing deployment approval.' };
    }
    const appId = parseHostingBindings(environment).services?.[service.name]?.serviceId;
    if (!appId) return { success: true, message: 'Azure Container App has no retired environment variables to delete.' };
    try {
      const app = await this.getResource(appId, CONTAINER_APPS_API);
      if (!app) return this.failedReceipt('Failed to delete Azure environment variables', `Bound Container App ${appId} was not found.`);
      if (!this.isOwned(app, environment.id)) {
        return this.failedReceipt('Failed to delete Azure environment variables', `Bound Container App ${appId} is not owned by this Hypervibe environment.`);
      }
      const retired = new Set(keys);
      const previousReadyRevision = typeof app.properties?.latestReadyRevisionName === 'string'
        ? app.properties.latestReadyRevisionName
        : undefined;
      const container = this.container(app);
      const expectedVolumes = azureVolumeFingerprint(app.properties?.template);
      await this.connected().client.request('PATCH', appId, CONTAINER_APPS_API, {
        properties: {
          // Retiring a variable removes its use, not an independently retained
          // secret definition. Never read secret payloads to reconstruct it.
          template: {
            ...app.properties?.template,
            containers: [{
              ...container,
              env: (container?.env ?? []).filter((item: any) => !retired.has(item.name)),
            }],
          },
        },
      });
      await this.waitForProvisioning(appId, CONTAINER_APPS_API);
      const ready = await this.waitForContainerAppRevision(appId, previousReadyRevision);
      if (azureVolumeFingerprint(ready.properties?.template) !== expectedVolumes) throw new Error('Azure volume mounts changed during environment variable removal.');
      return { success: true, message: `Deleted ${keys.length} retired Azure environment variable${keys.length === 1 ? '' : 's'}.` };
    } catch (error) {
      return this.failedReceipt('Failed to delete Azure environment variables', this.formatError(error));
    }
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const app = await this.getResource(serviceId, CONTAINER_APPS_API);
      if (!app) return { success: true };
      if (!this.hasManagedTag(app)) {
        return { success: false, error: `Container App ${serviceId} is not Hypervibe-managed.` };
      }
      const project = this.projectFromResourceGroup(this.resourceGroupIdFromChild(serviceId));
      if (app.identity?.principalId) {
        await this.deleteRoleAssignment(project.registryId, app.identity.principalId, ACR_PULL_ROLE);
      }
      await this.connected().client.deleteIfPresent(serviceId, CONTAINER_APPS_API);
      if (await this.getResource(serviceId, CONTAINER_APPS_API)) {
        return { success: false, error: `Container App ${serviceId} remained observable after deletion.` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const project = this.projectFromResourceGroup(projectId);
      const group = await this.getResource(projectId, RESOURCE_API);
      if (!group) return { success: true };
      if (!this.hasManagedTag(group)) {
        return { success: false, error: `Azure resource group ${projectId} is not Hypervibe-managed.` };
      }
      const apps = await this.listApps(project.resourceGroupId);
      if (apps.length > 0) {
        return { success: false, error: `Azure resource group ${projectId} still contains Container Apps: ${apps.map((item) => item.id).join(', ')}.` };
      }
      const resources = await this.connected().client.listAll<AzureResource>(
        `${project.resourceGroupId}/resources`,
        RESOURCE_LIST_API
      );
      const expectedIds = new Set([
        project.registryId.toLowerCase(),
        project.environmentId.toLowerCase(),
        `${project.resourceGroupId}/providers/Microsoft.App/managedEnvironments/runtime`.toLowerCase(),
      ]);
      if (resources.filter((resource) => /\/managedEnvironments\//i.test(resource.id)).length > 1) {
        throw new Error('Multiple Azure managed environments require explicit cleanup identity selection.');
      }
      const unexpected = resources.filter((resource) => !expectedIds.has(resource.id.toLowerCase()));
      if (unexpected.length > 0) {
        return {
          success: false,
          error: `Azure resource group ${projectId} contains resources outside the reviewed Hypervibe project boundary: ${unexpected.map((resource) => resource.id).join(', ')}.`,
        };
      }
      const unowned = resources.filter((resource) => !this.hasManagedTag(resource));
      if (unowned.length > 0) {
        return {
          success: false,
          error: `Azure project resources are not Hypervibe-managed: ${unowned.map((resource) => resource.id).join(', ')}.`,
        };
      }
      await this.connected().client.deleteIfPresent(projectId, RESOURCE_API);
      if (await this.getResource(projectId, RESOURCE_API)) {
        return { success: false, error: `Azure resource group ${projectId} remained observable after deletion.` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    dnsZone?: string;
  }): Promise<Receipt> {
    try {
      if (!params.projectId) throw new Error('Azure custom-domain attachment requires a bound resource group.');
      const project = this.projectFromResourceGroup(params.projectId, params.environmentId);
      if (params.environmentId !== project.environmentId) throw new Error('Azure custom-domain environment identity changed.');
      this.assertAppScope(params.serviceId, project.resourceGroupId);
      let app = await this.getResource(params.serviceId, CONTAINER_APPS_API);
      if (!app) throw new Error(`Bound Container App ${params.serviceId} was not found.`);
      if (!this.hasManagedTag(app)) throw new Error(`Bound Container App ${params.serviceId} is not Hypervibe-managed.`);
      this.assertAppEnvironment(app, project.environmentId);
      const environment = await this.getResource(project.environmentId, CONTAINER_APPS_API);
      if (!environment) throw new Error(`Bound managed environment ${project.environmentId} was not found.`);
      const records = this.azureDomainRecords(params.domain, params.dnsZone, app, environment);
      const certificateId = this.managedCertificateId(project, params.domain);
      const dnsReady = await this.azureDomainDnsReady(records);
      if (!dnsReady) {
        return {
          success: true,
          message: 'Azure Container Apps custom domain is waiting for DNS validation records',
          data: {
            domain: params.domain,
            customDomainId: certificateId,
            created: false,
            providerVerified: false,
            certificateStatus: 'DNS_REQUIRED',
            dnsRecords: records,
          },
        };
      }

      let certificate = await this.getResource(certificateId, CONTAINER_APPS_API);
      if (certificate && !this.isDomainCertificateOwned(certificate, params.serviceId)) {
        throw new Error(`Azure managed-certificate identity ${certificateId} is not owned by this Hypervibe service.`);
      }
      const configuration = app.properties?.configuration ?? {};
      const customDomains = this.withAzureCustomDomain(
        configuration.ingress?.customDomains,
        { name: params.domain, bindingType: 'Disabled' }
      );
      app = await this.connected().client.request<AzureResource>('PATCH', app.id, CONTAINER_APPS_API, {
        properties: {
          configuration: {
            ...configuration,
            ingress: { ...configuration.ingress, customDomains },
          },
        },
      });
      const created = !certificate;
      if (!certificate) {
        certificate = await this.connected().client.request<AzureResource>('PUT', certificateId, CONTAINER_APPS_API, {
          location: this.connected().credentials.location,
          properties: {
            subjectName: params.domain,
            domainControlValidation: this.isApex(params.domain, params.dnsZone) ? 'HTTP' : 'CNAME',
          },
          tags: { 'managed-by': 'hypervibe', 'hypervibe-service': this.hash(params.serviceId) },
        });
      }
      const status = String(certificate.properties?.provisioningState ?? 'Pending');
      if (['Failed', 'Canceled', 'DeleteFailed'].includes(status)) {
        throw new Error(`Azure managed certificate ${certificateId} is ${status}.`);
      }
      const issued = status === 'Succeeded';
      if (issued) {
        const boundDomains = this.withAzureCustomDomain(customDomains, {
          name: params.domain,
          bindingType: 'SniEnabled',
          certificateId,
        });
        app = await this.connected().client.request<AzureResource>('PATCH', app.id, CONTAINER_APPS_API, {
          properties: {
            configuration: {
              ...app.properties?.configuration,
              ingress: {
                ...app.properties?.configuration?.ingress,
                customDomains: boundDomains,
              },
            },
          },
        });
      }
      const attached = this.azureCustomDomains(app).some(
        (domain) => domain.name === params.domain && domain.bindingType === 'SniEnabled' && domain.certificateId?.toLowerCase() === certificateId.toLowerCase()
      );
      return {
        success: true,
        message: issued && attached
          ? 'Azure Container Apps custom domain attached with managed TLS'
          : 'Azure Container Apps custom domain is waiting for managed certificate issuance',
        data: {
          domain: params.domain,
          customDomainId: certificateId,
          created,
          providerVerified: issued && attached,
          certificateStatus: status,
          dnsRecords: records,
        },
      };
    } catch (error) {
      return this.failedReceipt('Failed to attach Azure Container Apps custom domain', this.formatError(error));
    }
  }

  async detachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    customDomainId?: string;
  }): Promise<Receipt> {
    try {
      if (!params.projectId) throw new Error('Azure custom-domain detachment requires a bound resource group.');
      const project = this.projectFromResourceGroup(params.projectId, params.environmentId);
      if (params.environmentId !== project.environmentId) {
        throw new Error('Azure custom-domain environment identity changed.');
      }
      this.assertAppScope(params.serviceId, project.resourceGroupId);
      const certificateId = this.managedCertificateId(project, params.domain);
      if (params.customDomainId && params.customDomainId.toLowerCase() !== certificateId.toLowerCase()) {
        return this.failedReceipt('Azure custom-domain identity changed', `Reviewed certificate ${params.customDomainId} does not match ${certificateId}.`);
      }
      const app = await this.getResource(params.serviceId, CONTAINER_APPS_API);
      if (!app) throw new Error(`Bound Container App ${params.serviceId} was not found, so domain absence cannot be verified.`);
      if (!this.hasManagedTag(app)) throw new Error(`Bound Container App ${params.serviceId} is not Hypervibe-managed.`);
      this.assertAppEnvironment(app, project.environmentId);
      const domains = this.azureCustomDomains(app);
      const certificate = await this.getResource(certificateId, CONTAINER_APPS_API);
      if (certificate && !this.isDomainCertificateOwned(certificate, params.serviceId)) {
        throw new Error(`Azure managed-certificate identity ${certificateId} is not owned by this Hypervibe service.`);
      }
      if (domains.some((domain) => domain.name === params.domain)) {
        await this.connected().client.request('PATCH', app.id, CONTAINER_APPS_API, {
          properties: {
            configuration: {
              ...app.properties?.configuration,
              ingress: {
                ...app.properties?.configuration?.ingress,
                customDomains: domains.filter((domain) => domain.name !== params.domain),
              },
            },
          },
        });
        const refreshed = await this.getResource(app.id, CONTAINER_APPS_API);
        if (refreshed && this.azureCustomDomains(refreshed).some((domain) => domain.name === params.domain)) {
          throw new Error(`${params.domain} remains attached to Container App ${app.id}.`);
        }
      }
      if (certificate) await this.connected().client.deleteIfPresent(certificateId, CONTAINER_APPS_API);
      if (await this.getResource(certificateId, CONTAINER_APPS_API)) {
        throw new Error(`Azure managed certificate ${certificateId} remained observable after deletion.`);
      }
      return {
        success: true,
        message: certificate || domains.some((domain) => domain.name === params.domain)
          ? 'Azure Container Apps custom domain detached'
          : 'Azure Container Apps custom domain is already absent',
        data: {
          domain: params.domain,
          customDomainId: certificateId,
          ...(certificate ? { deleted: true } : { alreadyAbsent: true }),
        },
      };
    } catch (error) {
      return this.failedReceipt('Failed to detach Azure Container Apps custom domain', this.formatError(error));
    }
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
      const prepared = this.deploymentConnection?.preparedResources?.workloads.find(item => item.workload === name);
      const runtime = prepared ? this.deploymentConnection!.runtimeIdentities.find(item => item.workload === name)?.principal : undefined;
      if (prepared) {
        if (runtime?.kind !== 'azure-managed-identity' || !await this.roleAssignmentExists(project.registryId, runtime.principalId, ACR_PULL_ROLE)) throw new Error('Azure installed registry reader authority could not be verified.');
        const holding = azurePreparedHoldingTransition(this.deploymentConnection!, environment, name, app);
        if (!holding) {
          azureObservedPreparedApplicationConfiguration(app);
          const assigned = app.identity?.userAssignedIdentities?.[runtime.identityResourceId];
          if (assigned?.clientId !== runtime.clientId || assigned?.principalId !== runtime.principalId) throw new Error('Azure runtime identity changed.');
          const refs = Object.fromEntries(this.deploymentConnection!.deployment.workloads.find(item => item.name === name)!.runtimeSecrets.map(item => [item.key, item.reference]));
          this.assertSecretReferences(app, refs, runtime.identityResourceId);
        }
      } else if (!app.identity?.principalId
        || !await this.roleAssignmentExists(project.registryId, app.identity.principalId, ACR_PULL_ROLE)) {
        warnings.push(`Container App ${app.id} is missing its exact ACR pull role assignment.`);
        continue;
      }
      const container = this.container(app);
      const definitions = app.properties?.configuration?.secrets ?? [];
      const hasExternalReferences = definitions.some((item: any) => typeof item.keyVaultUrl === 'string');
      const secretValues = Object.fromEntries(
        (hasExternalReferences || this.deploymentConnection ? [] : await this.listAppSecrets(app.id)).filter((item: any) => typeof item.name === 'string' && typeof item.value === 'string')
          .map((item: any) => [item.name, item.value])
      );
      const envValues = Object.fromEntries(
        (container?.env ?? []).map((item: any) => [
          item.name,
          typeof item.value === 'string' ? item.value : secretValues[item.secretRef],
        ]).filter((entry: any[]) => typeof entry[0] === 'string' && typeof entry[1] === 'string')
      ) as Record<string, string>;
      const visible = Object.entries(envValues).filter(([key]) => !INTERNAL_ENV_KEYS.has(key));
      const envVarSecretRefs = this.observedSecretReferences(app);
      const customDomains = this.azureCustomDomains(app).map((domain) => domain.name).filter(Boolean) as string[];
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
        envVarKeys: [...new Set<string>((container?.env ?? []).flatMap((entry: any) => typeof entry.name === 'string' && !INTERNAL_ENV_KEYS.has(entry.name) ? [entry.name] : []))].sort(),
        envVarHashes: Object.fromEntries(visible.map(([key, value]) => [key, hashEnvValue(value)])),
        envVarSecretRefs,
        status: app.properties?.provisioningState === 'Succeeded'
          ? (container?.image === BOOTSTRAP_IMAGE || prepared && container?.image === prepared.holding.image ? 'empty' : 'running')
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
    if (this.deploymentConnection) {
      if (environment.name !== this.deploymentConnection.environment) throw new Error('Azure deployment environment does not match its approval.');
      const group = `/subscriptions/${this.deploymentConnection.nativeScope.subscriptionId}/resourceGroups/${this.deploymentConnection.nativeScope.resourceGroup}`;
      return this.projectFromResourceGroup(group, `${group}/providers/Microsoft.App/managedEnvironments/runtime`);
    }
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
    if (this.deploymentConnection && resourceGroupId.toLowerCase() !== `/subscriptions/${this.deploymentConnection.nativeScope.subscriptionId}/resourceGroups/${this.deploymentConnection.nativeScope.resourceGroup}`.toLowerCase()) {
      throw new Error('Azure bound namespace is outside its deployment approval.');
    }
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

  private async ensureProviderRegistration(namespace: string): Promise<void> {
    const path = `/subscriptions/${this.connected().credentials.subscriptionId}/providers/${namespace}`;
    const current = await this.connected().client.getNullable<AzureResource>(path, PROVIDER_API);
    if (current?.properties?.registrationState === 'Registered') return;
    await this.connected().client.request('POST', `${path}/register`, PROVIDER_API);
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const observed = await this.connected().client.getNullable<AzureResource>(path, PROVIDER_API);
      if (observed?.properties?.registrationState === 'Registered') return;
      if (attempt < 120) await this.delay();
    }
    throw new Error(`Azure resource provider ${namespace} did not become registered.`);
  }

  private async ensureRegistry(project: AzureProject, environment: Environment): Promise<void> {
    const existing = await this.getResource(project.registryId, REGISTRY_API);
    if (existing) {
      if (!this.isOwned(existing, environment.id)) {
        throw new Error(`Azure registry ${project.registryId} exists but is not owned by this Hypervibe environment.`);
      }
      if (existing.properties?.loginServer?.toLowerCase() !== project.registryServer) {
        throw new Error(`Azure registry ${project.registryId} returned an unexpected login server.`);
      }
      return;
    }
    const created = await this.connected().client.request<AzureResource>('PUT', project.registryId, REGISTRY_API, {
      location: this.connected().credentials.location,
      sku: { name: 'Basic' },
      tags: this.tags(environment),
      properties: {
        adminUserEnabled: false,
        publicNetworkAccess: 'Enabled',
        roleAssignmentMode: 'LegacyRegistryPermissions',
      },
    });
    if (created.id.toLowerCase() !== project.registryId.toLowerCase()) {
      throw new Error(`Azure returned registry ${created.id} outside ${project.registryId}.`);
    }
  }

  private async ensureRoleAssignment(
    scope: string,
    principalId: string,
    roleId: string,
    principalType: string
  ): Promise<void> {
    const assignmentId = this.roleAssignmentId(scope, principalId, roleId);
    const existing = await this.getResource(assignmentId, AUTHORIZATION_API);
    if (existing) {
      const properties = existing.properties ?? {};
      if (String(properties.principalId).toLowerCase() !== principalId.toLowerCase()
        || !String(properties.roleDefinitionId).toLowerCase().endsWith(`/roledefinitions/${roleId}`)) {
        throw new Error(`Azure role assignment ${assignmentId} changed identity.`);
      }
      return;
    }
    await this.connected().client.request('PUT', assignmentId, AUTHORIZATION_API, {
      properties: {
        principalId,
        principalType,
        roleDefinitionId: `/subscriptions/${this.connected().credentials.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
      },
    });
  }

  private async deleteRoleAssignment(scope: string, principalId: string, roleId: string): Promise<void> {
    const id = this.roleAssignmentId(scope, principalId, roleId);
    if (!await this.getResource(id, AUTHORIZATION_API)) return;
    await this.connected().client.deleteIfPresent(id, AUTHORIZATION_API);
    if (await this.getResource(id, AUTHORIZATION_API)) throw new Error(`Azure role assignment ${id} remained observable after deletion.`);
  }

  private async roleAssignmentExists(scope: string, principalId: string, roleId: string): Promise<boolean> {
    const connection = this.deploymentConnection, prepared = connection?.preparedResources;
    let key: string | undefined;
    if (connection && prepared) {
      if (roleId === ACR_PUSH_ROLE) {
        const purpose = (['provision', 'release'] as const).find(purpose => connection.principals[purpose].kind === 'azure-managed-identity' && connection.principals[purpose].principalId === principalId);
        if (purpose) key = `${purpose}:push`;
      } else if (roleId === ACR_PULL_ROLE) {
        const runtime = connection.runtimeIdentities.find(item => item.principal.kind === 'azure-managed-identity' && item.principal.principalId === principalId);
        if (runtime) key = `runtime-${runtime.workload}:pull`;
      }
      if (!key || scope.toLowerCase() !== prepared.registry.id.toLowerCase()) throw new Error('Azure installed registry grant scope could not be verified.');
    }
    const owner = connection && prepared ? azurePreparedCoordinates(connection).owner : undefined;
    const id = owner && key ? azurePreparedGrantId(owner, key, scope) : this.roleAssignmentId(scope, principalId, roleId);
    const assignment = await this.getResource(id, AUTHORIZATION_API);
    if (!assignment) return false;
    const properties = assignment.properties ?? {};
    if (String(properties.principalId).toLowerCase() !== principalId.toLowerCase()
      || !String(properties.roleDefinitionId).toLowerCase().endsWith(`/roledefinitions/${roleId}`)
      || owner && key && (String(properties.scope).toLowerCase() !== scope.toLowerCase() || properties.condition != null || properties.principalType !== 'ServicePrincipal'
        || properties.description !== azurePreparedGrantDescription(owner, key))) {
      throw new Error(`Azure role assignment ${id} changed identity.`);
    }
    return true;
  }

  private roleAssignmentId(scope: string, principalId: string, roleId: string): string {
    const hex = this.hash(`${scope.toLowerCase()}:${principalId.toLowerCase()}:${roleId}`).slice(0, 32);
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return `${scope}/providers/Microsoft.Authorization/roleAssignments/${uuid}`;
  }

  private appBody(params: {
    app: AzureResource | null;
    environment: Environment;
    environmentId: string;
    project: AzureProject;
    service: Service;
    envVars: Record<string, string>;
    secretVersionRefs?: Record<string, RuntimeSecretReference>;
    runtimeReader?: string;
  }): Record<string, unknown> {
    const currentContainer = this.container(params.app);
    const currentImage = currentContainer?.image ?? BOOTSTRAP_IMAGE;
    const bootstrap = currentImage === BOOTSTRAP_IMAGE;
    const secretEntries = Object.entries(params.envVars).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
      key,
      name: this.secretName(key),
      value,
    }));
    const configuration = params.app?.properties?.configuration ?? {};
    const { secrets: previousSecrets, ...retainedConfiguration } = configuration;
    const definitions = new Map<string, Record<string, unknown>>();
    for (const entry of previousSecrets ?? []) {
      if (!entry || typeof entry.name !== 'string' || definitions.has(entry.name)) throw new Error('Azure returned ambiguous secret configuration.');
      definitions.set(entry.name, { ...entry });
    }
    const env = new Map<string, Record<string, unknown>>();
    for (const entry of currentContainer?.env ?? []) {
      if (!entry || typeof entry.name !== 'string' || env.has(entry.name)) throw new Error('Azure returned ambiguous environment configuration.');
      env.set(entry.name, { ...entry });
    }
    for (const { key, name, value } of secretEntries) {
      const existingRef = env.get(key)?.secretRef;
      if (typeof existingRef === 'string' && definitions.get(existingRef)?.keyVaultUrl) throw new Error('A literal environment update conflicts with an existing native secret reference.');
      definitions.set(name, { name, value });
      env.set(key, { name: key, secretRef: name });
    }
    for (const [key, reference] of Object.entries(params.secretVersionRefs ?? {})) {
      const native = runtimeSecretReferenceIdentity(reference);
      const name = this.secretName(key);
      definitions.set(name, { name, keyVaultUrl: `${native.resource}/${native.version}`, identity: params.runtimeReader ?? 'system' });
      env.set(key, { name: key, secretRef: name });
    }
    const changeSecrets = secretEntries.length > 0 || Object.keys(params.secretVersionRefs ?? {}).length > 0;
    if (changeSecrets && [...definitions.values()].some(entry => typeof entry.value !== 'string' && !(typeof entry.keyVaultUrl === 'string' && typeof entry.identity === 'string'))) {
      throw new Error('Azure secret configuration contains an opaque existing secret; reference-only updates cannot safely replace its definition.');
    }
    if (params.service.buildConfig.startCommand) env.set(START_COMMAND_KEY, { name: START_COMMAND_KEY, value: params.service.buildConfig.startCommand });
    else env.delete(START_COMMAND_KEY);
    env.set(HEALTH_CHECK_PATH_KEY, { name: HEALTH_CHECK_PATH_KEY, value: params.service.buildConfig.healthCheckPath ?? '/' });
    const template = params.app?.properties?.template ?? {};
    return {
      location: params.app?.location ?? this.connected().credentials.location,
      identity: { type: params.runtimeReader && params.runtimeReader !== 'system'
          ? (String(params.app?.identity?.type ?? 'SystemAssigned').includes('SystemAssigned') ? 'SystemAssigned, UserAssigned' : 'UserAssigned')
          : params.app?.identity?.type ?? 'SystemAssigned',
        ...(params.app?.identity?.userAssignedIdentities || params.runtimeReader && params.runtimeReader !== 'system' ? { userAssignedIdentities: Object.fromEntries(
          [...new Set([...Object.keys(params.app?.identity?.userAssignedIdentities ?? {}), ...(params.runtimeReader && params.runtimeReader !== 'system' ? [params.runtimeReader] : [])])].map(id => [id, {}])) } : {}) },
      properties: {
        managedEnvironmentId: params.environmentId,
        configuration: {
          ...retainedConfiguration,
          activeRevisionsMode: 'Single',
          ingress: {
            ...configuration.ingress,
            external: true,
            targetPort: 8080,
            transport: 'auto',
            allowInsecure: false,
          },
          registries: params.app
            ? [{ server: params.project.registryServer, identity: 'system' }]
            : (configuration.registries ?? []),
          ...(changeSecrets ? { secrets: [...definitions.values()] } : {}),
        },
        template: {
          ...template,
          containers: [{
            ...currentContainer,
            name: 'main',
            image: currentImage,
            env: [...env.values()],
            resources: { cpu: 0.25, memory: '0.5Gi' },
            ...(bootstrap
              ? { command: ['node'], args: ['-e', BOOTSTRAP_SCRIPT], probes: undefined }
              : !params.service.buildConfig.startCommand
                ? { command: undefined, args: undefined, probes: undefined }
                : {
                  command: ['sh'],
                  args: ['-lc', params.service.buildConfig.startCommand],
                  probes: [{
                    type: 'Liveness',
                    httpGet: { path: params.service.buildConfig.healthCheckPath ?? '/', port: 8080, scheme: 'HTTP' },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                    timeoutSeconds: 5,
                    failureThreshold: 6,
                  }],
                }),
          }],
          scale: { ...template.scale, minReplicas: 1, maxReplicas: 4 },
        },
      },
      tags: params.app?.tags ?? this.tags(params.environment),
    };
  }

  private observedSecretReferences(app: AzureResource): NonNullable<ObservedService['envVarSecretRefs']> {
    const definitions: any[] = app.properties?.configuration?.secrets ?? [];
    const refs: NonNullable<ObservedService['envVarSecretRefs']> = {};
    for (const entry of this.container(app)?.env ?? []) {
      if (typeof entry.name !== 'string' || entry.value !== undefined || INTERNAL_ENV_KEYS.has(entry.name)) continue;
      const matches = definitions.filter(def => def.name === entry.secretRef);
      const match = matches.length === 1 && typeof matches[0]?.keyVaultUrl === 'string'
        ? matches[0].keyVaultUrl.match(/^(https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127})\/([a-f0-9]{32})$/) : null;
      if (match) refs[entry.name] = { provider: 'azure-key-vault', resource: match[1].toLowerCase(), version: match[2] };
    }
    return refs;
  }

  private assertSecretReferences(app: AzureResource, refs: Record<string, RuntimeSecretReference>, reader: string): void {
    const observed = this.observedSecretReferences(app);
    for (const [key, ref] of Object.entries(refs)) {
      const expected = runtimeSecretReferenceIdentity(ref);
      const entries = (this.container(app)?.env ?? []).filter((entry: any) => entry.name === key);
      const definition = app.properties?.configuration?.secrets?.find((entry: any) => entry.name === entries[0]?.secretRef);
      if (entries.length !== 1 || observed[key]?.resource !== expected.resource || observed[key]?.version !== expected.version || typeof definition?.identity !== 'string' || definition.identity.toLowerCase() !== reader.toLowerCase()) {
        throw new Error('Azure did not verify the requested runtime secret references.');
      }
    }
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

  private async waitForContainerAppRevision(
    id: string,
    previousReadyRevision?: string
  ): Promise<AzureResource> {
    for (let attempt = 1; attempt <= 180; attempt += 1) {
      const app = await this.getResource(id, CONTAINER_APPS_API);
      if (!app) throw new Error(`Azure Container App ${id} disappeared during revision rollout.`);
      const provisioningState = String(app.properties?.provisioningState ?? 'unknown');
      if (['Failed', 'Canceled', 'DeleteFailed'].includes(provisioningState)) {
        throw new Error(`Azure Container App ${id} is ${provisioningState}.`);
      }
      const latestRevision = typeof app.properties?.latestRevisionName === 'string'
        ? app.properties.latestRevisionName
        : undefined;
      const latestReadyRevision = typeof app.properties?.latestReadyRevisionName === 'string'
        ? app.properties.latestReadyRevisionName
        : undefined;
      if (
        latestRevision
        && latestReadyRevision === latestRevision
        && (!previousReadyRevision || latestReadyRevision !== previousReadyRevision)
      ) {
        return app;
      }
      if (attempt < 180) await this.delay();
    }
    throw new Error(`Azure Container App ${id} did not activate a new ready revision.`);
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

  private resourceGroupIdFromChild(id: string): string {
    const match = id.match(/^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)\/providers\//i);
    if (!match) throw new Error(`Invalid Azure child resource ID: ${id}`);
    return match[1]!;
  }

  private managedCertificateId(project: AzureProject, domain: string): string {
    return `${project.environmentId}/managedCertificates/hv-${this.hash(domain).slice(0, 24)}`;
  }

  private azureDomainRecords(
    domain: string,
    dnsZone: string | undefined,
    app: AzureResource,
    environment: AzureResource
  ): Array<{ name: string; type: string; value: string; purpose: string; proxied: false }> {
    const verificationId = app.properties?.customDomainVerificationId;
    if (typeof verificationId !== 'string' || !verificationId) throw new Error(`Container App ${app.id} returned no domain verification ID.`);
    if (this.isApex(domain, dnsZone)) {
      const staticIp = environment.properties?.staticIp;
      if (typeof staticIp !== 'string' || !staticIp) throw new Error(`Managed environment ${environment.id} returned no static ingress IP.`);
      return [
        { name: domain, type: 'A', value: staticIp, purpose: 'routing', proxied: false },
        { name: `asuid.${domain}`, type: 'TXT', value: verificationId, purpose: 'ownership-verification', proxied: false },
      ];
    }
    const fqdn = app.properties?.configuration?.ingress?.fqdn;
    if (typeof fqdn !== 'string' || !fqdn) throw new Error(`Container App ${app.id} returned no ingress FQDN.`);
    return [
      { name: domain, type: 'CNAME', value: fqdn, purpose: 'routing', proxied: false },
      { name: `asuid.${domain}`, type: 'TXT', value: verificationId, purpose: 'ownership-verification', proxied: false },
    ];
  }

  private async azureDomainDnsReady(records: Array<{ name: string; type: string; value: string }>): Promise<boolean> {
    for (const record of records) {
      try {
        if (record.type === 'CNAME') {
          if (!(await resolveCname(record.name)).some((value) => value.replace(/\.$/, '').toLowerCase() === record.value.toLowerCase())) return false;
        } else if (record.type === 'A') {
          if (!(await resolve4(record.name)).includes(record.value)) return false;
        } else if (record.type === 'TXT') {
          if (!(await resolveTxt(record.name)).some((parts) => parts.join('') === record.value)) return false;
        }
      } catch (error) {
        const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
        if (['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'EAI_AGAIN'].includes(code)) return false;
        throw error;
      }
    }
    return true;
  }

  private azureCustomDomains(app: AzureResource): Array<{ name?: string; bindingType?: string; certificateId?: string }> {
    const domains = app.properties?.configuration?.ingress?.customDomains
      ?? app.properties?.configuration?.customDomains
      ?? [];
    if (!Array.isArray(domains)) throw new Error(`Azure returned invalid custom domains for ${app.id}.`);
    return domains;
  }

  private withAzureCustomDomain(
    domains: unknown,
    desired: { name: string; bindingType: string; certificateId?: string }
  ) {
    const current = Array.isArray(domains) ? domains as Array<{ name?: string }> : [];
    return [...current.filter((domain) => domain.name !== desired.name), desired];
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

  private isApex(domain: string, dnsZone?: string): boolean {
    return Boolean(dnsZone) && domain.toLowerCase() === dnsZone!.toLowerCase();
  }

  private appName(service: Service): string {
    return resourceName(service.name, { maxLength: 32, minLength: 2 });
  }

  private secretName(key: string): string {
    return `hv-${this.hash(key).slice(0, 24)}`;
  }

  private safeName(value: string, length: number, salt: string): string {
    const prefix = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, length) || 'hypervibe';
    return `${prefix}-${this.hash(salt).slice(0, 8)}`;
  }

  private tags(environment: Environment): Record<string, string> {
    return { 'managed-by': 'hypervibe', 'hypervibe-environment-id': environment.id };
  }

  private isOwned(resource: AzureResource, environmentId: string): boolean {
    const connection = this.deploymentConnection, prepared = connection?.preparedResources;
    if (connection && prepared) {
      const c = azurePreparedCoordinates(connection), id = resource.id.toLowerCase();
      const expected = [prepared.project, prepared.registry, ...prepared.workloads].find(item => item.id.toLowerCase() === id);
      return (id === c.group.toLowerCase() || !!expected && resource.systemData?.createdAt === expected.lifetimeId)
        && resource.tags?.hypervibeInstallation === connection.installationId && resource.tags?.hypervibeDeployment === c.owner;
    }
    return resource.tags?.['managed-by'] === 'hypervibe'
      && resource.tags?.['hypervibe-environment-id'] === environmentId;
  }

  private hasManagedTag(resource: AzureResource): boolean {
    return resource.tags?.['managed-by'] === 'hypervibe';
  }

  private isDomainCertificateOwned(resource: AzureResource, serviceId: string): boolean {
    return this.hasManagedTag(resource)
      && resource.tags?.['hypervibe-service'] === this.hash(serviceId);
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

  private failedDeploy(
    service: Service,
    error: string,
    externalId?: string,
    createdService = false
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(externalId ? { externalId } : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `Azure Container Apps deployment failed for ${service.name}`,
        error,
        ...(externalId ? {
          data: { serviceId: externalId, createdService, mutationAttempted: true },
        } : {}),
      },
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
  transientAuthentication: { ...azureDeploymentContract, createAdapter: async input => {
    const adapter = new AzureContainerAppsAdapter(); await adapter.connectTransient(input); return adapter;
  } },
  metadata: {
    name: 'azure-container-apps',
    displayName: 'Azure Container Apps',
    runtimeSecretReferenceProviders: ['azure-key-vault'],
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
        hosting: { status: 'ready-for-live' },
      },
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: { workloadKindObservation: 'exact' },
      ci: {
        transientDeployment: 'github-oidc-broker-v1',
        displayName: 'Azure Container Apps',
        requiredSecrets: AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AZURE_TENANT_ID: 'tenantId',
          AZURE_SUBSCRIPTION_ID: 'subscriptionId',
          AZURE_CLIENT_ID: 'clientId',
          AZURE_CLIENT_SECRET: 'clientSecret',
        },
        buildGitHubActionsSteps: buildAzureContainerAppsGitHubActionsSteps,
        buildPortableRecipe: buildAzureContainerAppsPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64', 'docker-privileged'],
      },
    },
    lifecycle: {
      hosting: { preparedResources: 'installer-receipt-v1', runtimeIdentityTiming: 'before-workload', workloadKinds: ['web'], serviceVolumes: { workloadKinds: ['web'], retention: 'retain-only' }, customDomains: 'managed', domainTrafficProxy: 'dns-only', maintenance: 'managed', teardownBoundary: 'project' },
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
