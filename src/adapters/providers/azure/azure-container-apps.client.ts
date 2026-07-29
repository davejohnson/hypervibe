import type { AzureContainerAppsCredentials } from './azure-container-apps.credentials.js';

export const AZURE_CONTAINER_APPS_API_VERSION = '2026-01-01';
const AZURE_RESOURCE_API_VERSION = '2024-11-01';
const AZURE_CONTAINER_REGISTRY_API_VERSION = '2025-11-01';
const AZURE_MANAGEMENT_URL = 'https://management.azure.com';
const PAGE_CAP = 1000;

export interface AzureManagedEnvironment {
  id: string;
  name: string;
  location: string;
  properties?: {
    provisioningState?: string;
    defaultDomain?: string;
    staticIp?: string;
  };
  tags?: Record<string, string>;
}

export interface AzureContainerAppEnv {
  name: string;
  value?: string;
  secretRef?: string;
}

export interface AzureContainerAppContainer {
  name: string;
  image?: string;
  env?: AzureContainerAppEnv[];
  command?: string[];
  args?: string[];
  resources?: {
    cpu?: number;
    memory?: string;
  };
  probes?: Array<{
    type?: string;
    httpGet?: {
      path?: string;
      port?: number;
      scheme?: string;
    };
    initialDelaySeconds?: number;
    periodSeconds?: number;
    timeoutSeconds?: number;
    failureThreshold?: number;
  }>;
}

export interface AzureContainerApp {
  id: string;
  name: string;
  location: string;
  properties?: {
    environmentId?: string;
    managedEnvironmentId?: string;
    provisioningState?: string;
    runningStatus?: string;
    latestRevisionName?: string;
    latestReadyRevisionName?: string;
    latestRevisionFqdn?: string;
    configuration?: {
      activeRevisionsMode?: string;
      ingress?: {
        external?: boolean;
        targetPort?: number;
        fqdn?: string;
        customDomains?: Array<{ name?: string }>;
      };
      registries?: Array<{
        server?: string;
        username?: string;
        passwordSecretRef?: string;
        identity?: string;
      }>;
      secrets?: Array<{ name?: string; value?: string }>;
    };
    template?: {
      revisionSuffix?: string;
      containers?: AzureContainerAppContainer[];
      scale?: {
        minReplicas?: number;
        maxReplicas?: number;
        rules?: unknown[];
      };
      [key: string]: unknown;
    };
  };
  tags?: Record<string, string>;
}

export interface AzureContainerAppRevision {
  id?: string;
  name?: string;
  properties?: {
    active?: boolean;
    healthState?: string;
    provisioningState?: string;
    runningState?: string;
    fqdn?: string;
    template?: {
      containers?: AzureContainerAppContainer[];
    };
  };
}

export interface AzureContainerAppSecret {
  name?: string;
  value?: string;
}

export interface AzureSourceControl {
  id: string;
  name: string;
  properties?: {
    repoUrl?: string;
    branch?: string;
  };
}

interface AzureCollection<T> {
  value?: T[];
  nextLink?: string | null;
}

interface AzureResponse<T> {
  body: T;
  status: number;
  headers: Headers;
}

export class AzureApiError extends Error {
  constructor(readonly status: number) {
    super(`Azure Resource Manager API error: ${status}`);
    this.name = 'AzureApiError';
  }
}

export interface AzureResourceIdentity {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export class AzureContainerAppsClient {
  private accessToken: string | null = null;

  constructor(private readonly credentials: AzureContainerAppsCredentials) {}

  async verifyScope(): Promise<void> {
    await Promise.all([
      this.armRequest(
        'GET',
        `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
          + `/resourceGroups/${encodeURIComponent(this.credentials.resourceGroup)}`,
        AZURE_RESOURCE_API_VERSION
      ),
      this.getRegistry(),
      this.listManagedEnvironments(),
      this.listContainerApps(),
    ]);
  }

  async getRegistry(): Promise<{
    id: string;
    name: string;
    properties?: { loginServer?: string };
  }> {
    const identity = this.parseRegistryId(this.credentials.registryId);
    this.assertSubscription(identity.subscriptionId);
    return this.armRequest(
      'GET',
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.ContainerRegistry',
        'registries',
        identity.name
      ),
      AZURE_CONTAINER_REGISTRY_API_VERSION
    );
  }

  async listManagedEnvironments(): Promise<AzureManagedEnvironment[]> {
    const resources = await this.listAll<AzureManagedEnvironment>(
      this.resourceGroupProviderPath('Microsoft.App', 'managedEnvironments'),
      AZURE_CONTAINER_APPS_API_VERSION
    );
    this.assertResourceCollection(resources, 'managedEnvironments');
    return resources;
  }

  async getManagedEnvironment(
    resourceId: string
  ): Promise<AzureManagedEnvironment | null> {
    const identity = this.parseManagedEnvironmentId(resourceId);
    this.assertConfiguredScope(identity);
    const resource = await this.getNullable<AzureManagedEnvironment>(
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'managedEnvironments',
        identity.name
      )
    );
    if (resource) {
      this.assertResourceIdentity(
        resource,
        'managedEnvironments',
        identity
      );
    }
    return resource;
  }

  async createManagedEnvironment(
    name: string,
    body: Record<string, unknown>
  ): Promise<AzureManagedEnvironment> {
    const resource = await this.armRequest<AzureManagedEnvironment>(
      'PUT',
      this.managedEnvironmentResourceId(name),
      AZURE_CONTAINER_APPS_API_VERSION,
      body
    );
    this.assertResourceIdentity(resource, 'managedEnvironments', {
      subscriptionId: this.credentials.subscriptionId,
      resourceGroup: this.credentials.resourceGroup,
      name,
    });
    return resource;
  }

  managedEnvironmentResourceId(name: string): string {
    return this.resourcePath(
      this.credentials.subscriptionId,
      this.credentials.resourceGroup,
      'Microsoft.App',
      'managedEnvironments',
      name
    );
  }

  async deleteManagedEnvironment(resourceId: string): Promise<void> {
    const identity = this.parseManagedEnvironmentId(resourceId);
    this.assertConfiguredScope(identity);
    try {
      await this.armRequest(
        'DELETE',
        this.resourcePath(
          identity.subscriptionId,
          identity.resourceGroup,
          'Microsoft.App',
          'managedEnvironments',
          identity.name
        )
      );
    } catch (error) {
      if (!(error instanceof AzureApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async listContainerApps(): Promise<AzureContainerApp[]> {
    const resources = await this.listAll<AzureContainerApp>(
      this.resourceGroupProviderPath('Microsoft.App', 'containerApps'),
      AZURE_CONTAINER_APPS_API_VERSION
    );
    this.assertResourceCollection(resources, 'containerApps');
    return resources;
  }

  async getContainerApp(resourceId: string): Promise<AzureContainerApp | null> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    const resource = await this.getNullable<AzureContainerApp>(
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'containerApps',
        identity.name
      )
    );
    if (resource) {
      this.assertResourceIdentity(resource, 'containerApps', identity);
    }
    return resource;
  }

  async createContainerApp(
    name: string,
    body: Record<string, unknown>
  ): Promise<AzureContainerApp> {
    const resource = await this.armRequest<AzureContainerApp>(
      'PUT',
      this.containerAppResourceId(name),
      AZURE_CONTAINER_APPS_API_VERSION,
      body
    );
    this.assertResourceIdentity(resource, 'containerApps', {
      subscriptionId: this.credentials.subscriptionId,
      resourceGroup: this.credentials.resourceGroup,
      name,
    });
    return resource;
  }

  containerAppResourceId(name: string): string {
    return this.resourcePath(
      this.credentials.subscriptionId,
      this.credentials.resourceGroup,
      'Microsoft.App',
      'containerApps',
      name
    );
  }

  async patchContainerApp(
    resourceId: string,
    body: Record<string, unknown>
  ): Promise<AzureContainerApp> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    const resource = await this.armRequest<AzureContainerApp>(
      'PATCH',
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'containerApps',
        identity.name
      ),
      AZURE_CONTAINER_APPS_API_VERSION,
      body
    );
    this.assertResourceIdentity(resource, 'containerApps', identity);
    return resource;
  }

  async deleteContainerApp(resourceId: string): Promise<void> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    try {
      await this.armRequest(
        'DELETE',
        this.resourcePath(
          identity.subscriptionId,
          identity.resourceGroup,
          'Microsoft.App',
          'containerApps',
          identity.name
        )
      );
    } catch (error) {
      if (!(error instanceof AzureApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async listContainerAppSecrets(
    resourceId: string
  ): Promise<AzureContainerAppSecret[]> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    const result = await this.armRequest<AzureCollection<AzureContainerAppSecret>>(
      'POST',
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'containerApps',
        identity.name
      ) + '/listSecrets'
    );
    if (!Array.isArray(result.value)) {
      throw new Error('Azure Container Apps secret observation returned an invalid response.');
    }
    return result.value;
  }

  async listContainerAppRevisions(
    resourceId: string
  ): Promise<AzureContainerAppRevision[]> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    return this.listAll(
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'containerApps',
        identity.name
      ) + '/revisions',
      AZURE_CONTAINER_APPS_API_VERSION
    );
  }

  async listSourceControls(resourceId: string): Promise<AzureSourceControl[]> {
    const identity = this.parseContainerAppId(resourceId);
    this.assertConfiguredScope(identity);
    return this.listAll(
      this.resourcePath(
        identity.subscriptionId,
        identity.resourceGroup,
        'Microsoft.App',
        'containerApps',
        identity.name
      ) + '/sourcecontrols',
      AZURE_CONTAINER_APPS_API_VERSION
    );
  }

  async deleteSourceControl(
    appResourceId: string,
    sourceControlName: string
  ): Promise<void> {
    const identity = this.parseContainerAppId(appResourceId);
    this.assertConfiguredScope(identity);
    try {
      await this.armRequest(
        'DELETE',
        this.resourcePath(
          identity.subscriptionId,
          identity.resourceGroup,
          'Microsoft.App',
          'containerApps',
          identity.name
        ) + `/sourcecontrols/${encodeURIComponent(sourceControlName)}`
      );
    } catch (error) {
      if (!(error instanceof AzureApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  parseManagedEnvironmentId(value: string): AzureResourceIdentity {
    return this.parseResourceId(value, 'managedEnvironments');
  }

  parseContainerAppId(value: string): AzureResourceIdentity {
    return this.parseResourceId(value, 'containerApps');
  }

  parseRegistryId(value: string): AzureResourceIdentity {
    const match = value.match(
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerRegistry\/registries\/([^/]+)$/i
    );
    if (!match) {
      throw new Error('Invalid Azure Container Registry ARM resource ID.');
    }
    return {
      subscriptionId: decodeURIComponent(match[1]!),
      resourceGroup: decodeURIComponent(match[2]!),
      name: decodeURIComponent(match[3]!),
    };
  }

  private async getNullable<T>(path: string): Promise<T | null> {
    try {
      return await this.armRequest<T>('GET', path);
    } catch (error) {
      if (error instanceof AzureApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async listAll<T>(
    initialPath: string,
    apiVersion: string
  ): Promise<T[]> {
    const output: T[] = [];
    const visited = new Set<string>();
    let next: string | null = this.withApiVersion(initialPath, apiVersion);
    for (let page = 1; page <= PAGE_CAP && next; page += 1) {
      if (visited.has(next)) {
        throw new Error('Azure Resource Manager pagination returned a repeated nextLink.');
      }
      visited.add(next);
      const response: AzureResponse<AzureCollection<T>> =
        await this.armRequestResponse('GET', next, apiVersion);
      if (!Array.isArray(response.body.value)) {
        throw new Error('Azure Resource Manager list observation returned an invalid response.');
      }
      output.push(...response.body.value);
      next = response.body.nextLink ?? null;
      if (next) this.assertContinuationUrl(next, initialPath);
    }
    if (next) {
      throw new Error(`Azure Resource Manager pagination exceeded ${PAGE_CAP} pages.`);
    }
    return output;
  }

  private async armRequest<T = void>(
    method: string,
    pathOrUrl: string,
    apiVersion = AZURE_CONTAINER_APPS_API_VERSION,
    body?: unknown
  ): Promise<T> {
    return (
      await this.armRequestResponse<T>(method, pathOrUrl, apiVersion, body)
    ).body;
  }

  private async armRequestResponse<T>(
    method: string,
    pathOrUrl: string,
    apiVersion = AZURE_CONTAINER_APPS_API_VERSION,
    body?: unknown
  ): Promise<AzureResponse<T>> {
    const token = await this.getAccessToken();
    const versionedPathOrUrl = this.withApiVersion(pathOrUrl, apiVersion);
    const url = versionedPathOrUrl.startsWith('https://')
      ? versionedPathOrUrl
      : `${AZURE_MANAGEMENT_URL}${versionedPathOrUrl}`;
    this.assertManagementUrl(url);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new AzureApiError(response.status);
    }
    if (response.status === 204) {
      return {
        body: undefined as T,
        status: response.status,
        headers: response.headers,
      };
    }
    const text = await response.text();
    let parsed: T;
    try {
      parsed = (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new Error('Azure Resource Manager returned invalid JSON.');
    }
    return {
      body: parsed,
      status: response.status,
      headers: response.headers,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const form = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://management.azure.com//.default',
    });
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.credentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );
    if (!response.ok) {
      throw new Error(`Microsoft Entra token request failed: ${response.status}`);
    }
    const text = await response.text();
    let payload: { access_token?: unknown };
    try {
      payload = JSON.parse(text) as { access_token?: unknown };
    } catch {
      throw new Error('Microsoft Entra token endpoint returned invalid JSON.');
    }
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new Error('Microsoft Entra token response did not include an access token.');
    }
    this.accessToken = payload.access_token;
    return payload.access_token;
  }

  private resourceGroupProviderPath(
    namespace: string,
    resourceType: string
  ): string {
    return `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(this.credentials.resourceGroup)}`
      + `/providers/${namespace}/${resourceType}`;
  }

  private resourcePath(
    subscriptionId: string,
    resourceGroup: string,
    namespace: string,
    resourceType: string,
    name: string
  ): string {
    return `/subscriptions/${encodeURIComponent(subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
      + `/providers/${namespace}/${resourceType}/${encodeURIComponent(name)}`;
  }

  private withApiVersion(pathOrUrl: string, apiVersion: string): string {
    const separator = pathOrUrl.includes('?') ? '&' : '?';
    return pathOrUrl.includes('api-version=')
      ? pathOrUrl
      : `${pathOrUrl}${separator}api-version=${encodeURIComponent(apiVersion)}`;
  }

  private assertManagementUrl(value: string): void {
    const url = new URL(value, AZURE_MANAGEMENT_URL);
    if (url.origin !== AZURE_MANAGEMENT_URL) {
      throw new Error('Azure Resource Manager returned an untrusted continuation URL.');
    }
  }

  private assertContinuationUrl(value: string, initialPath: string): void {
    this.assertManagementUrl(value);
    const continuation = new URL(value, AZURE_MANAGEMENT_URL);
    const expected = new URL(initialPath, AZURE_MANAGEMENT_URL);
    if (continuation.pathname.toLowerCase() !== expected.pathname.toLowerCase()) {
      throw new Error(
        'Azure Resource Manager returned a continuation URL for a different collection.'
      );
    }
  }

  private parseResourceId(
    value: string,
    expectedType: 'managedEnvironments' | 'containerApps'
  ): AzureResourceIdentity {
    const pattern = expectedType === 'managedEnvironments'
      ? /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/managedEnvironments\/([^/]+)$/i
      : /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([^/]+)$/i;
    const match = value.match(pattern);
    if (!match) {
      throw new Error(`Invalid Azure ${expectedType} ARM resource ID.`);
    }
    return {
      subscriptionId: decodeURIComponent(match[1]!),
      resourceGroup: decodeURIComponent(match[2]!),
      name: decodeURIComponent(match[3]!),
    };
  }

  private assertConfiguredScope(identity: AzureResourceIdentity): void {
    this.assertSubscription(identity.subscriptionId);
    if (
      identity.resourceGroup.toLowerCase()
      !== this.credentials.resourceGroup.toLowerCase()
    ) {
      throw new Error(
        `Azure resource belongs to resource group ${identity.resourceGroup}, not the configured resource group ${this.credentials.resourceGroup}.`
      );
    }
  }

  private assertResourceCollection(
    resources: Array<AzureManagedEnvironment | AzureContainerApp>,
    resourceType: 'managedEnvironments' | 'containerApps'
  ): void {
    const seen = new Set<string>();
    for (const resource of resources) {
      const identity = this.assertResourceIdentity(resource, resourceType);
      const durableId = [
        identity.subscriptionId,
        identity.resourceGroup,
        resourceType,
        identity.name,
      ].join('/').toLowerCase();
      if (seen.has(durableId)) {
        throw new Error(
          `Azure Resource Manager returned duplicate ${resourceType} identity ${resource.id}.`
        );
      }
      seen.add(durableId);
    }
  }

  private assertResourceIdentity(
    resource: AzureManagedEnvironment | AzureContainerApp,
    resourceType: 'managedEnvironments' | 'containerApps',
    expected?: AzureResourceIdentity
  ): AzureResourceIdentity {
    if (
      !resource
      || typeof resource.id !== 'string'
      || typeof resource.name !== 'string'
      || typeof resource.location !== 'string'
    ) {
      throw new Error(
        `Azure Resource Manager returned an incomplete ${resourceType} identity.`
      );
    }
    const identity = this.parseResourceId(resource.id, resourceType);
    this.assertConfiguredScope(identity);
    if (identity.name.toLowerCase() !== resource.name.toLowerCase()) {
      throw new Error(
        `Azure ${resourceType} name does not match its durable resource ID.`
      );
    }
    if (
      expected
      && (
        identity.subscriptionId.toLowerCase()
          !== expected.subscriptionId.toLowerCase()
        || identity.resourceGroup.toLowerCase()
          !== expected.resourceGroup.toLowerCase()
        || identity.name.toLowerCase() !== expected.name.toLowerCase()
      )
    ) {
      throw new Error(
        `Azure ${resourceType} response does not match the requested durable identity.`
      );
    }
    return identity;
  }

  private assertSubscription(subscriptionId: string): void {
    if (
      subscriptionId.toLowerCase()
      !== this.credentials.subscriptionId.toLowerCase()
    ) {
      throw new Error(
        `Azure resource belongs to subscription ${subscriptionId}, not the configured subscription ${this.credentials.subscriptionId}.`
      );
    }
  }
}
