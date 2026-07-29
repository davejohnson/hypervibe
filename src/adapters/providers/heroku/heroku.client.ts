const HEROKU_API_URL = 'https://api.heroku.com';
const HEROKU_ACCEPT = 'application/vnd.heroku+json; version=3';
const PAGE_LIMIT = 200;
const PAGE_CAP = 1000;

export interface HerokuAccount {
  id: string;
  email: string;
  name?: string | null;
}

export interface HerokuApp {
  id: string;
  name: string;
  git_url?: string;
  maintenance?: boolean;
  released_at?: string | null;
  web_url?: string | null;
  owner?: { id?: string; email?: string };
  region?: { id?: string; name?: string };
  stack?: { id?: string; name?: string };
}

export interface HerokuFormation {
  id: string;
  type: string;
  command?: string;
  quantity: number;
  size?: string;
  dyno_size?: { id?: string; name?: string };
}

export interface HerokuRelease {
  id: string;
  version: number;
  status: 'failed' | 'pending' | 'succeeded' | 'expired';
  current?: boolean;
  created_at?: string;
  updated_at?: string;
}

export class HerokuApiError extends Error {
  constructor(readonly status: number) {
    super(`Heroku Platform API error: ${status}`);
    this.name = 'HerokuApiError';
  }
}

interface HerokuResponse<T> {
  body: T;
  status: number;
  headers: Headers;
}

export class HerokuClient {
  constructor(private readonly apiKey: string) {}

  async getAccount(): Promise<HerokuAccount> {
    return this.request('GET', '/account');
  }

  async listApps(): Promise<HerokuApp[]> {
    return this.listRange('/apps', 'id');
  }

  async getApp(appIdOrName: string): Promise<HerokuApp | null> {
    return this.getNullable(`/apps/${encodeURIComponent(appIdOrName)}`);
  }

  async createApp(input: {
    name: string;
    region: string;
    stack: 'container';
  }): Promise<HerokuApp> {
    return this.request('POST', '/apps', { body: input });
  }

  async deleteApp(appIdOrName: string): Promise<void> {
    await this.request(
      'DELETE',
      `/apps/${encodeURIComponent(appIdOrName)}`
    );
  }

  async getConfigVars(appIdOrName: string): Promise<Record<string, string>> {
    return this.request(
      'GET',
      `/apps/${encodeURIComponent(appIdOrName)}/config-vars`
    );
  }

  async patchConfigVars(
    appIdOrName: string,
    values: Record<string, string | null>
  ): Promise<Record<string, string>> {
    return this.request(
      'PATCH',
      `/apps/${encodeURIComponent(appIdOrName)}/config-vars`,
      { body: values }
    );
  }

  async listFormations(appIdOrName: string): Promise<HerokuFormation[]> {
    return this.listRange(
      `/apps/${encodeURIComponent(appIdOrName)}/formation`,
      'id'
    );
  }

  async listReleases(appIdOrName: string): Promise<HerokuRelease[]> {
    return this.listRange(
      `/apps/${encodeURIComponent(appIdOrName)}/releases`,
      'version',
      'desc'
    );
  }

  private async getNullable<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>('GET', path);
    } catch (error) {
      if (error instanceof HerokuApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async listRange<T>(
    path: string,
    field: string,
    order: 'asc' | 'desc' = 'asc'
  ): Promise<T[]> {
    const output: T[] = [];
    const visited = new Set<string>();
    let range = order === 'desc'
      ? `${field} ..; order=desc,max=${PAGE_LIMIT};`
      : `${field} ..; max=${PAGE_LIMIT};`;
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const response = await this.requestResponse<T[]>('GET', path, {
        headers: { Range: range },
      });
      if (!Array.isArray(response.body)) {
        throw new Error('Heroku list observation returned an invalid response.');
      }
      output.push(...response.body);
      if (response.status !== 206) {
        return output;
      }
      const nextRange = response.headers.get('Next-Range')?.trim();
      if (!nextRange || visited.has(nextRange)) {
        throw new Error(
          'Heroku list pagination returned a missing or repeated Next-Range header.'
        );
      }
      visited.add(nextRange);
      range = nextRange;
    }
    throw new Error(`Heroku list pagination exceeded ${PAGE_CAP} pages.`);
  }

  private async request<T = void>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      accept?: string;
    } = {}
  ): Promise<T> {
    return (await this.requestResponse<T>(method, path, options)).body;
  }

  private async requestResponse<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      accept?: string;
    } = {}
  ): Promise<HerokuResponse<T>> {
    const response = await fetch(`${HEROKU_API_URL}${path}`, {
      method,
      headers: {
        Accept: options.accept ?? HEROKU_ACCEPT,
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'Hypervibe',
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      throw new HerokuApiError(response.status);
    }
    if (response.status === 204) {
      return {
        body: undefined as T,
        status: response.status,
        headers: response.headers,
      };
    }
    const text = await response.text();
    let body: T;
    try {
      body = (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new Error('Heroku Platform API returned invalid JSON.');
    }
    return { body, status: response.status, headers: response.headers };
  }
}
