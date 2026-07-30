import type { AzureDatastoreCredentials } from './azure-datastore.credentials.js';

const AZURE_MANAGEMENT_URL = 'https://management.azure.com';
const AZURE_RESOURCE_API_VERSION = '2024-11-01';
const PAGE_CAP = 1000;

interface AzureCollection<T> {
  value?: T[];
  nextLink?: string | null;
}

export class AzureResourceManagerError extends Error {
  constructor(
    readonly status: number,
    message?: string
  ) {
    super(message ?? `Azure Resource Manager API error: ${status}`);
    this.name = 'AzureResourceManagerError';
  }
}

export interface AzureArmResourceIdentity {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export class AzureResourceManagerClient {
  private accessToken: string | null = null;
  private accessTokenPromise: Promise<string> | null = null;

  constructor(readonly credentials: AzureDatastoreCredentials) {}

  async verifyResourceGroup(): Promise<void> {
    await this.request(
      'GET',
      `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
        + `/resourceGroups/${encodeURIComponent(this.credentials.resourceGroup)}`,
      AZURE_RESOURCE_API_VERSION
    );
  }

  resourceGroupProviderPath(
    namespace: string,
    resourceType: string
  ): string {
    return `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(this.credentials.resourceGroup)}`
      + `/providers/${namespace}/${resourceType}`;
  }

  resourcePath(
    namespace: string,
    resourceType: string,
    name: string
  ): string {
    return `${this.resourceGroupProviderPath(namespace, resourceType)}/${encodeURIComponent(name)}`;
  }

  parseResourceId(
    value: string,
    namespace: string,
    resourceType: string
  ): AzureArmResourceIdentity {
    const segments = value.split('/').filter(Boolean);
    if (
      segments.length !== 8
      || segments[0]?.toLowerCase() !== 'subscriptions'
      || segments[2]?.toLowerCase() !== 'resourcegroups'
      || segments[4]?.toLowerCase() !== 'providers'
      || segments[5]?.toLowerCase() !== namespace.toLowerCase()
      || segments[6]?.toLowerCase() !== resourceType.toLowerCase()
    ) {
      throw new Error(
        `Invalid Azure ${namespace}/${resourceType} ARM resource ID.`
      );
    }
    const identity = {
      subscriptionId: decodeURIComponent(segments[1]!),
      resourceGroup: decodeURIComponent(segments[3]!),
      name: decodeURIComponent(segments[7]!),
    };
    this.assertConfiguredScope(identity);
    return identity;
  }

  assertConfiguredScope(identity: AzureArmResourceIdentity): void {
    if (
      identity.subscriptionId.toLowerCase()
        !== this.credentials.subscriptionId.toLowerCase()
      || identity.resourceGroup.toLowerCase()
        !== this.credentials.resourceGroup.toLowerCase()
    ) {
      throw new Error(
        'Azure resource is outside the configured subscription/resource group.'
      );
    }
  }

  async listAll<T>(
    path: string,
    apiVersion: string
  ): Promise<T[]> {
    const output: T[] = [];
    const resourceIds = new Set<string>();
    const visited = new Set<string>();
    let next: string | null = this.withApiVersion(path, apiVersion);
    for (let page = 1; page <= PAGE_CAP && next; page += 1) {
      if (visited.has(next)) {
        throw new Error(
          'Azure Resource Manager pagination returned a repeated nextLink.'
        );
      }
      visited.add(next);
      const body: AzureCollection<T> = await this.request<AzureCollection<T>>(
        'GET',
        next,
        apiVersion
      );
      if (!Array.isArray(body.value)) {
        throw new Error(
          'Azure Resource Manager list observation returned an invalid response.'
        );
      }
      for (const item of body.value) {
        const id = (
          typeof item === 'object'
          && item !== null
          && 'id' in item
          && typeof item.id === 'string'
        )
          ? item.id.toLowerCase()
          : null;
        if (id && resourceIds.has(id)) {
          throw new Error(
            `Azure Resource Manager returned duplicate resource identity ${id}.`
          );
        }
        if (id) resourceIds.add(id);
      }
      output.push(...body.value);
      next = body.nextLink ?? null;
      if (next) this.assertContinuationUrl(next, path);
    }
    if (next) {
      throw new Error(
        `Azure Resource Manager pagination exceeded ${PAGE_CAP} pages.`
      );
    }
    return output;
  }

  async getNullable<T>(
    path: string,
    apiVersion: string
  ): Promise<T | null> {
    try {
      return await this.request<T>('GET', path, apiVersion);
    } catch (error) {
      if (
        error instanceof AzureResourceManagerError
        && error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async request<T = void>(
    method: string,
    pathOrUrl: string,
    apiVersion: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.getAccessToken();
    const versioned = this.withApiVersion(pathOrUrl, apiVersion);
    const url = versioned.startsWith('https://')
      ? versioned
      : `${AZURE_MANAGEMENT_URL}${versioned}`;
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
    const text = response.status === 204 ? '' : await response.text();
    if (!response.ok) {
      throw new AzureResourceManagerError(
        response.status
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Azure Resource Manager returned invalid JSON.');
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (this.accessTokenPromise) return this.accessTokenPromise;
    this.accessTokenPromise = this.requestAccessToken();
    try {
      this.accessToken = await this.accessTokenPromise;
      return this.accessToken;
    } finally {
      this.accessTokenPromise = null;
    }
  }

  private async requestAccessToken(): Promise<string> {
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
      throw new Error(
        `Microsoft Entra token request failed: ${response.status}`
      );
    }
    const text = await response.text();
    let payload: { access_token?: unknown };
    try {
      payload = JSON.parse(text) as { access_token?: unknown };
    } catch {
      throw new Error(
        'Microsoft Entra token endpoint returned invalid JSON.'
      );
    }
    if (
      typeof payload.access_token !== 'string'
      || payload.access_token.length === 0
    ) {
      throw new Error(
        'Microsoft Entra token response did not include an access token.'
      );
    }
    return payload.access_token;
  }

  private withApiVersion(pathOrUrl: string, apiVersion: string): string {
    const url = new URL(
      pathOrUrl,
      `${AZURE_MANAGEMENT_URL}/`
    );
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', apiVersion);
    }
    return pathOrUrl.startsWith('https://')
      ? url.toString()
      : `${url.pathname}${url.search}`;
  }

  private assertManagementUrl(value: string): void {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== 'management.azure.com'
    ) {
      throw new Error(
        'Azure Resource Manager request URL left management.azure.com.'
      );
    }
  }

  private assertContinuationUrl(value: string, initialPath: string): void {
    this.assertManagementUrl(value);
    const url = new URL(value);
    const expectedPrefix =
      `/subscriptions/${this.credentials.subscriptionId}`
      + `/resourceGroups/${this.credentials.resourceGroup}/`;
    if (
      !decodeURIComponent(url.pathname).toLowerCase()
        .startsWith(expectedPrefix.toLowerCase())
    ) {
      throw new Error(
        'Azure Resource Manager pagination left the configured resource group.'
      );
    }
    const expectedPath = new URL(
      initialPath,
      `${AZURE_MANAGEMENT_URL}/`
    ).pathname;
    if (
      decodeURIComponent(url.pathname).toLowerCase()
        !== decodeURIComponent(expectedPath).toLowerCase()
    ) {
      throw new Error(
        'Azure Resource Manager pagination left the observed collection.'
      );
    }
  }
}
