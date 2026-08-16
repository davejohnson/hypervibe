import type { VercelCredentials } from './vercel.credentials.js';

const VERCEL_API_URL = 'https://api.vercel.com';
const PAGE_LIMIT = 100;
const PAGE_CAP = 1000;

export interface VercelUser {
  id: string;
  email?: string;
  username?: string;
  name?: string | null;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProjectLink {
  type: string;
  org?: string;
  repo?: string;
  projectName?: string;
  projectNameWithNamespace?: string;
  projectUrl?: string;
  productionBranch?: string;
  sourceless?: boolean;
}

export interface VercelProjectAlias {
  domain: string;
  environment: 'preview' | 'production' | string;
  target: 'PREVIEW' | 'PRODUCTION' | 'STAGING' | string;
}

export interface VercelProject {
  id: string;
  accountId: string;
  name: string;
  paused?: boolean;
  live?: boolean;
  alias?: VercelProjectAlias[];
  link?: VercelProjectLink;
  framework?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
}

export interface VercelEnvironmentVariable {
  id?: string;
  key: string;
  value: string;
  type: string;
  target?: string | string[];
  decrypted?: boolean;
  configurationId?: string | null;
  comment?: string;
}

export interface VercelDeployment {
  uid: string;
  projectId: string;
  name: string;
  url: string;
  createdAt: number;
  readyState:
    | 'BLOCKED'
    | 'BUILDING'
    | 'CANCELED'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | string;
  target?: string | null;
  meta?: Record<string, string>;
}

export interface VercelProjectDomain {
  name: string;
  apexName?: string;
  projectId: string;
  verified: boolean;
  verification?: Array<{
    type: string;
    domain: string;
    value: string;
    reason?: string;
  }>;
}

export interface VercelDomainConfig {
  configuredBy?: string | null;
  acceptedChallenges?: string[];
  misconfigured: boolean;
}

export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string
  ) {
    super(
      `Vercel REST API error: ${status}${code ? ` (${code})` : ''}`
    );
    this.name = 'VercelApiError';
  }
}

interface VercelResponse<T> {
  body: T;
  status: number;
  headers: Headers;
}

export class VercelClient {
  constructor(private readonly credentials: VercelCredentials) {}

  get configuredTeamId(): string | undefined {
    return this.credentials.teamId;
  }

  async getUser(): Promise<VercelUser> {
    return this.request('GET', '/v2/user', { includeTeamScope: false });
  }

  async getTeam(teamId: string): Promise<VercelTeam> {
    return this.request(
      'GET',
      `/v2/teams/${encodeURIComponent(teamId)}`,
      { includeTeamScope: false }
    );
  }

  async listProjects(): Promise<VercelProject[]> {
    const projects: VercelProject[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const response = await this.request<
        | VercelProject[]
        | {
            projects?: unknown;
            pagination?: { next?: unknown };
          }
      >('GET', '/v10/projects', {
        query: {
          limit: PAGE_LIMIT,
          ...(cursor ? { from: cursor } : {}),
        },
      });
      if (Array.isArray(response)) {
        projects.push(...response);
        this.assertProjectCollection(projects);
        return projects;
      }
      if (!Array.isArray(response.projects)) {
        throw new Error('Vercel project observation returned an invalid response.');
      }
      projects.push(...response.projects as VercelProject[]);
      const nextValue = response.pagination?.next;
      if (nextValue === undefined || nextValue === null) {
        this.assertProjectCollection(projects);
        return projects;
      }
      const next = String(nextValue).trim();
      if (!next || cursors.has(next)) {
        throw new Error(
          'Vercel project pagination returned an empty or repeated continuation token.'
        );
      }
      cursors.add(next);
      cursor = next;
    }
    throw new Error(`Vercel project pagination exceeded ${PAGE_CAP} pages.`);
  }

  async getProject(projectIdOrName: string): Promise<VercelProject | null> {
    const project = await this.getNullable<VercelProject>(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}`
    );
    if (project) this.assertProject(project);
    return project;
  }

  async createProject(name: string): Promise<VercelProject> {
    const project = await this.request<VercelProject>(
      'POST',
      '/v11/projects',
      { body: { name } }
    );
    this.assertProject(project);
    return project;
  }

  async deleteProject(projectIdOrName: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v9/projects/${encodeURIComponent(projectIdOrName)}`
    );
  }

  async pauseProject(projectId: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/projects/${encodeURIComponent(projectId)}/pause`
    );
  }

  async unpauseProject(projectId: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/projects/${encodeURIComponent(projectId)}/unpause`
    );
  }

  async listProjectEnvironmentVariables(
    projectIdOrName: string
  ): Promise<VercelEnvironmentVariable[]> {
    const response = await this.request<
      | VercelEnvironmentVariable
      | {
          envs?: unknown;
          pagination?: { next?: unknown };
          hiddenProductionEnvCount?: unknown;
        }
    >(
      'GET',
      `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`,
      { query: { decrypt: 'true' } }
    );
    if (this.isEnvironmentVariable(response)) {
      return [response];
    }
    if (!Array.isArray(response.envs)) {
      throw new Error(
        'Vercel environment-variable observation returned an invalid response.'
      );
    }
    if (
      response.pagination?.next !== undefined
      && response.pagination.next !== null
    ) {
      throw new Error(
        'Vercel environment-variable observation was paginated without a supported continuation parameter.'
      );
    }
    const variables = response.envs as VercelEnvironmentVariable[];
    this.assertEnvironmentVariables(variables);
    return variables;
  }

  async upsertProjectEnvironmentVariables(
    projectIdOrName: string,
    variables: Array<{
      key: string;
      value: string;
      type: 'sensitive';
      target: ['production'];
      comment: string;
    }>
  ): Promise<void> {
    if (variables.length === 0) return;
    await this.request(
      'POST',
      `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`,
      {
        query: { upsert: 'true' },
        body: variables,
      }
    );
  }

  async deleteProjectEnvironmentVariable(
    projectIdOrName: string,
    variableId: string
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/env/${encodeURIComponent(variableId)}`
    );
  }

  async listDeployments(projectId: string): Promise<VercelDeployment[]> {
    const response = await this.request<{
      deployments?: unknown;
      pagination?: { next?: unknown };
    }>('GET', '/v7/deployments', {
      query: {
        projectId,
        target: 'production',
        limit: PAGE_LIMIT,
      },
    });
    if (!Array.isArray(response.deployments)) {
      throw new Error('Vercel deployment observation returned an invalid response.');
    }
    const deployments = response.deployments as VercelDeployment[];
    const ids = new Set<string>();
    for (const deployment of deployments) {
      if (
        typeof deployment.uid !== 'string'
        || typeof deployment.projectId !== 'string'
        || typeof deployment.url !== 'string'
        || typeof deployment.readyState !== 'string'
        || typeof deployment.createdAt !== 'number'
      ) {
        throw new Error(
          'Vercel deployment observation returned an incomplete durable identity.'
        );
      }
      if (deployment.projectId !== projectId) {
        throw new Error(
          `Vercel returned deployment ${deployment.uid} for project ${deployment.projectId}, not requested project ${projectId}.`
        );
      }
      if (ids.has(deployment.uid)) {
        throw new Error(
          `Vercel returned duplicate deployment identity ${deployment.uid}.`
        );
      }
      ids.add(deployment.uid);
    }
    return deployments.sort((left, right) => right.createdAt - left.createdAt);
  }

  async listProjectDomains(
    projectIdOrName: string
  ): Promise<VercelProjectDomain[]> {
    const domains: VercelProjectDomain[] = [];
    const cursors = new Set<string>();
    let until: string | undefined;
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const response = await this.request<{
        domains?: unknown;
        pagination?: { next?: unknown };
      }>(
        'GET',
        `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains`,
        {
          query: {
            limit: PAGE_LIMIT,
            ...(until ? { until } : {}),
          },
        }
      );
      if (!Array.isArray(response.domains)) {
        throw new Error('Vercel project-domain observation returned an invalid response.');
      }
      domains.push(...response.domains as VercelProjectDomain[]);
      const nextValue = response.pagination?.next;
      if (nextValue === undefined || nextValue === null) {
        this.assertDomainCollection(domains, projectIdOrName);
        return domains;
      }
      const next = String(nextValue).trim();
      if (!next || cursors.has(next)) {
        throw new Error(
          'Vercel project-domain pagination returned an empty or repeated continuation token.'
        );
      }
      cursors.add(next);
      until = next;
    }
    throw new Error(`Vercel project-domain pagination exceeded ${PAGE_CAP} pages.`);
  }

  async getProjectDomain(
    projectIdOrName: string,
    domain: string
  ): Promise<VercelProjectDomain | null> {
    const result = await this.getNullable<VercelProjectDomain>(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}`
    );
    if (result) this.assertProjectDomain(result, projectIdOrName);
    return result;
  }

  async addProjectDomain(
    projectIdOrName: string,
    domain: string
  ): Promise<VercelProjectDomain> {
    const result = await this.request<VercelProjectDomain>(
      'POST',
      `/v10/projects/${encodeURIComponent(projectIdOrName)}/domains`,
      { body: { name: domain } }
    );
    this.assertProjectDomain(result, projectIdOrName);
    return result;
  }

  async removeProjectDomain(
    projectIdOrName: string,
    domain: string
  ): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}`
      );
    } catch (error) {
      if (error instanceof VercelApiError && error.status === 404) return;
      throw error;
    }
  }

  async getDomainConfig(domain: string): Promise<VercelDomainConfig> {
    const result = await this.request<VercelDomainConfig>(
      'GET',
      `/v6/domains/${encodeURIComponent(domain)}/config`
    );
    if (!result || typeof result.misconfigured !== 'boolean') {
      throw new Error('Vercel domain configuration returned an incomplete response.');
    }
    return result;
  }

  private async getNullable<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>('GET', path);
    } catch (error) {
      if (error instanceof VercelApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async request<T = void>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      includeTeamScope?: boolean;
    } = {}
  ): Promise<T> {
    return (await this.requestResponse<T>(method, path, options)).body;
  }

  private async requestResponse<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      includeTeamScope?: boolean;
    } = {}
  ): Promise<VercelResponse<T>> {
    const url = new URL(path, VERCEL_API_URL);
    if (
      options.includeTeamScope !== false
      && this.credentials.teamId
    ) {
      url.searchParams.set('teamId', this.credentials.teamId);
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'User-Agent': 'Hypervibe',
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      throw new VercelApiError(
        response.status,
        await this.errorCode(response)
      );
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
      throw new Error('Vercel REST API returned invalid JSON.');
    }
    return { body, status: response.status, headers: response.headers };
  }

  private async errorCode(response: Response): Promise<string | undefined> {
    try {
      const body = await response.json() as {
        error?: { code?: unknown };
        code?: unknown;
      };
      const code = body.error?.code ?? body.code;
      return typeof code === 'string' && /^[A-Za-z0-9_.-]+$/.test(code)
        ? code
        : undefined;
    } catch {
      return undefined;
    }
  }

  private assertProjectCollection(projects: VercelProject[]): void {
    const ids = new Set<string>();
    for (const project of projects) {
      this.assertProject(project);
      if (ids.has(project.id)) {
        throw new Error(`Vercel returned duplicate project identity ${project.id}.`);
      }
      ids.add(project.id);
    }
  }

  private assertProject(project: VercelProject): void {
    if (
      !project
      || typeof project.id !== 'string'
      || typeof project.accountId !== 'string'
      || typeof project.name !== 'string'
    ) {
      throw new Error('Vercel returned an incomplete project identity.');
    }
    if (project.paused !== undefined && typeof project.paused !== 'boolean') {
      throw new Error('Vercel returned an invalid project pause state.');
    }
    if (project.live !== undefined && typeof project.live !== 'boolean') {
      throw new Error('Vercel returned an invalid project live state.');
    }
    if (project.alias !== undefined) {
      if (!Array.isArray(project.alias)) {
        throw new Error('Vercel returned an invalid project alias collection.');
      }
      const domains = new Set<string>();
      for (const alias of project.alias) {
        if (
          !alias
          || typeof alias.domain !== 'string'
          || typeof alias.environment !== 'string'
          || typeof alias.target !== 'string'
        ) {
          throw new Error('Vercel returned an incomplete project alias.');
        }
        const domain = alias.domain.toLowerCase();
        if (domains.has(domain)) {
          throw new Error(`Vercel returned duplicate project alias ${alias.domain}.`);
        }
        domains.add(domain);
      }
    }
  }

  private isEnvironmentVariable(
    value: unknown
  ): value is VercelEnvironmentVariable {
    const candidate = value as Partial<VercelEnvironmentVariable> | null;
    return Boolean(
      candidate
      && typeof candidate.key === 'string'
      && typeof candidate.value === 'string'
      && typeof candidate.type === 'string'
    );
  }

  private assertEnvironmentVariables(
    variables: VercelEnvironmentVariable[]
  ): void {
    const ids = new Set<string>();
    for (const variable of variables) {
      if (!this.isEnvironmentVariable(variable)) {
        throw new Error(
          'Vercel environment-variable observation returned an incomplete entry.'
        );
      }
      if (variable.id) {
        if (ids.has(variable.id)) {
          throw new Error(
            `Vercel returned duplicate environment-variable identity ${variable.id}.`
          );
        }
        ids.add(variable.id);
      }
    }
  }

  private assertDomainCollection(
    domains: VercelProjectDomain[],
    projectIdOrName: string
  ): void {
    const names = new Set<string>();
    for (const domain of domains) {
      this.assertProjectDomain(domain, projectIdOrName);
      const normalized = domain.name.toLowerCase();
      if (names.has(normalized)) {
        throw new Error(
          `Vercel returned duplicate project-domain identity ${domain.name}.`
        );
      }
      names.add(normalized);
    }
  }

  private assertProjectDomain(
    domain: VercelProjectDomain,
    projectIdOrName: string
  ): void {
    if (
      !domain
      || typeof domain.name !== 'string'
      || typeof domain.projectId !== 'string'
      || typeof domain.verified !== 'boolean'
    ) {
      throw new Error('Vercel returned an incomplete project-domain identity.');
    }
    if (
      projectIdOrName.startsWith('prj_')
      && domain.projectId !== projectIdOrName
    ) {
      throw new Error(
        `Vercel returned domain ${domain.name} for project ${domain.projectId}, not requested project ${projectIdOrName}.`
      );
    }
    if (domain.verification && domain.verification.some((record) => (
      !record
      || typeof record.type !== 'string'
      || typeof record.domain !== 'string'
      || typeof record.value !== 'string'
    ))) {
      throw new Error(`Vercel returned incomplete verification records for ${domain.name}.`);
    }
  }
}
