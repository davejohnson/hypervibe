const RENDER_API_URL = 'https://api.render.com/v1';
const PAGE_LIMIT = 100;

export interface RenderOwner {
  id: string;
  name: string;
  email?: string;
  type?: string;
}

export interface RenderRegistryCredential {
  id: string;
  name: string;
  registry: string;
  username?: string;
}

export type RenderServiceType =
  | 'web_service'
  | 'private_service'
  | 'background_worker'
  | 'cron_job'
  | 'static_site';

export interface RenderService {
  id: string;
  name: string;
  ownerId: string;
  type: RenderServiceType;
  autoDeploy?: 'yes' | 'no';
  repo?: string;
  branch?: string;
  imagePath?: string;
  suspended?: string;
  registryCredential?: { id: string; name?: string };
  serviceDetails?: {
    runtime?: string;
    plan?: string;
    region?: string;
    url?: string;
    healthCheckPath?: string;
    schedule?: string;
    envSpecificDetails?: {
      dockerCommand?: string;
    };
  };
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderDeploy {
  id: string;
  status?: string;
  image?: {
    ref?: string;
    sha?: string;
    registryCredential?: string;
  };
  createdAt?: string;
}

export interface RenderPostgres {
  id: string;
  name: string;
  owner?: RenderOwner;
  plan?: string;
  region?: string;
  status?: string;
  version?: string;
  databaseName?: string;
  databaseUser?: string;
  connectionPool?: string;
}

export interface RenderPostgresConnectionInfo {
  password: string;
  internalConnectionString: string;
  externalConnectionString: string;
  internalConnectionPoolString?: string;
  externalConnectionPoolString?: string;
}

export interface RenderKeyValue {
  id: string;
  name: string;
  owner?: RenderOwner;
  plan?: string;
  region?: string;
  status?: string;
  version?: string;
}

export interface RenderKeyValueConnectionInfo {
  internalConnectionString: string;
  externalConnectionString: string;
}

interface CursorItem<T> {
  cursor?: string;
  service?: T;
  postgres?: T;
  keyValue?: T;
  envVar?: T;
  deploy?: T;
}

export class RenderApiError extends Error {
  constructor(readonly status: number) {
    super(`Render API error: ${status}`);
    this.name = 'RenderApiError';
  }
}

export class RenderClient {
  constructor(private readonly apiKey: string) {}

  async getOwner(ownerId: string): Promise<RenderOwner | null> {
    return this.getNullable<RenderOwner>(`/owners/${encodeURIComponent(ownerId)}`);
  }

  async getRegistryCredential(
    credentialId: string
  ): Promise<RenderRegistryCredential | null> {
    return this.getNullable<RenderRegistryCredential>(
      `/registrycredentials/${encodeURIComponent(credentialId)}`
    );
  }

  async listServices(ownerId: string): Promise<RenderService[]> {
    return this.listCursor<RenderService>(
      '/services',
      'service',
      { ownerId }
    );
  }

  async getService(serviceId: string): Promise<RenderService | null> {
    return this.getNullable<RenderService>(
      `/services/${encodeURIComponent(serviceId)}`
    );
  }

  async createService(input: Record<string, unknown>): Promise<{
    service: RenderService;
    deployId?: string;
  }> {
    return this.request('POST', '/services', { body: input });
  }

  async updateService(
    serviceId: string,
    input: Record<string, unknown>
  ): Promise<RenderService> {
    return this.request(
      'PATCH',
      `/services/${encodeURIComponent(serviceId)}`,
      { body: input }
    );
  }

  async deleteService(serviceId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/services/${encodeURIComponent(serviceId)}`
    );
  }

  async listEnvVars(serviceId: string): Promise<RenderEnvVar[]> {
    return this.listCursor<RenderEnvVar>(
      `/services/${encodeURIComponent(serviceId)}/env-vars`,
      'envVar'
    );
  }

  async replaceEnvVars(
    serviceId: string,
    envVars: RenderEnvVar[]
  ): Promise<void> {
    await this.request(
      'PUT',
      `/services/${encodeURIComponent(serviceId)}/env-vars`,
      { body: envVars }
    );
  }

  async getDeploy(
    serviceId: string,
    deployId: string
  ): Promise<RenderDeploy | null> {
    return this.getNullable<RenderDeploy>(
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`
    );
  }

  async listDeploys(serviceId: string): Promise<RenderDeploy[]> {
    return this.listCursor<RenderDeploy>(
      `/services/${encodeURIComponent(serviceId)}/deploys`,
      'deploy'
    );
  }

  async listPostgres(ownerId: string): Promise<RenderPostgres[]> {
    return this.listCursor<RenderPostgres>(
      '/postgres',
      'postgres',
      { ownerId }
    );
  }

  async getPostgres(postgresId: string): Promise<RenderPostgres | null> {
    return this.getNullable<RenderPostgres>(
      `/postgres/${encodeURIComponent(postgresId)}`
    );
  }

  async createPostgres(
    input: Record<string, unknown>
  ): Promise<RenderPostgres> {
    return this.request('POST', '/postgres', { body: input });
  }

  async deletePostgres(postgresId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/postgres/${encodeURIComponent(postgresId)}`
    );
  }

  async getPostgresConnectionInfo(
    postgresId: string
  ): Promise<RenderPostgresConnectionInfo> {
    return this.request(
      'GET',
      `/postgres/${encodeURIComponent(postgresId)}/connection-info`
    );
  }

  async listKeyValues(ownerId: string): Promise<RenderKeyValue[]> {
    return this.listCursor<RenderKeyValue>(
      '/key-value',
      'keyValue',
      { ownerId }
    );
  }

  async getKeyValue(keyValueId: string): Promise<RenderKeyValue | null> {
    return this.getNullable<RenderKeyValue>(
      `/key-value/${encodeURIComponent(keyValueId)}`
    );
  }

  async createKeyValue(
    input: Record<string, unknown>
  ): Promise<RenderKeyValue> {
    return this.request('POST', '/key-value', { body: input });
  }

  async deleteKeyValue(keyValueId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/key-value/${encodeURIComponent(keyValueId)}`
    );
  }

  async getKeyValueConnectionInfo(
    keyValueId: string
  ): Promise<RenderKeyValueConnectionInfo> {
    return this.request(
      'GET',
      `/key-value/${encodeURIComponent(keyValueId)}/connection-info`
    );
  }

  private async getNullable<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>('GET', path);
    } catch (error) {
      if (
        error instanceof RenderApiError
        && [404, 410].includes(error.status)
      ) {
        return null;
      }
      throw error;
    }
  }

  private async listCursor<T>(
    path: string,
    field: 'service' | 'postgres' | 'keyValue' | 'envVar' | 'deploy',
    query: Record<string, string> = {}
  ): Promise<T[]> {
    const output: T[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= 1000; page += 1) {
      const response = await this.request<Array<CursorItem<T>>>(
        'GET',
        path,
        {
          query: {
            ...query,
            limit: String(PAGE_LIMIT),
            ...(cursor ? { cursor } : {}),
          },
        }
      );
      if (!Array.isArray(response)) {
        throw new Error('Render list observation returned an invalid response.');
      }
      for (const item of response) {
        const value = item[field];
        if (!value) {
          throw new Error(`Render list observation omitted ${field}.`);
        }
        output.push(value);
      }
      if (response.length < PAGE_LIMIT) {
        return output;
      }
      const next = response.at(-1)?.cursor;
      if (!next || visited.has(next)) {
        throw new Error('Render list pagination returned a missing or repeated cursor.');
      }
      visited.add(next);
      cursor = next;
    }
    throw new Error('Render list pagination exceeded 1000 pages.');
  }

  private async request<T = void>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(`${RENDER_API_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      throw new RenderApiError(response.status);
    }
    if (response.status === 204 || response.status === 202) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
