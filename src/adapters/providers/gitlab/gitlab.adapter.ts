import { createHash } from 'crypto';
import { z } from 'zod';
import type {
  CiArtifactSummary,
  CiDispatchRequest,
  CiJobSummary,
  CiOperationsPort,
  CiPhase,
  CiRunSummary,
  CiVariableObservation,
  CodeChangeRequest,
  CodeHostPort,
  CodeRepositoryCommitAction,
  CodeRepositoryFile,
  CodeRepositoryIdentity,
} from '../../../domain/ports/devops.port.js';
import type { Observation } from '../../../domain/ports/provider-observation.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

export const GitLabCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'GitLab API token is required'),
  instanceUrl: z.string().url().default('https://gitlab.com'),
  /** Durable, read-only pull credential used by hosting providers. */
  registryUsername: z.string().min(1).optional(),
  registryReadToken: z.string().min(1).optional(),
}).strict().superRefine((credentials, ctx) => {
  const url = new URL(credentials.instanceUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitLab instanceUrl must use HTTPS (localhost is allowed for tests)',
      path: ['instanceUrl'],
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitLab instanceUrl cannot contain credentials, query parameters, or fragments',
      path: ['instanceUrl'],
    });
  }
  if (Boolean(credentials.registryUsername) !== Boolean(credentials.registryReadToken)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'registryUsername and registryReadToken must be supplied together',
      path: ['registryReadToken'],
    });
  }
});

export type GitLabCredentials = z.infer<typeof GitLabCredentialsSchema>;

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  ci_config_path?: string | null;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
  ci_pipeline_variables_minimum_override_role?: string;
  ci_forward_deployment_enabled?: boolean;
  container_registry_access_level?: 'disabled' | 'private' | 'enabled';
  container_registry_enabled?: boolean;
  repository_object_format?: 'sha1' | 'sha256';
}

export interface GitLabRunnerSummary {
  id: string;
  runnerType: 'instance_type' | 'group_type' | 'project_type' | string;
  status: string;
  paused: boolean;
  tags: string[];
}

interface GitLabPipeline {
  id: number;
  iid?: number;
  status: string;
  source?: string;
  ref?: string;
  sha: string;
  name?: string;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface GitLabJob {
  id: number;
  name: string;
  status: string;
  stage?: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string;
  artifacts?: Array<{ file_type?: string; filename?: string; size?: number }>;
  artifacts_expire_at?: string | null;
  pipeline?: { id: number };
  retried?: boolean;
}

interface GitLabMergeRequest {
  id: number;
  iid: number;
  state: string;
  title: string;
  source_branch: string;
  target_branch: string;
  sha?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  web_url: string;
}

interface GitLabVariable {
  key: string;
  value?: string;
  variable_type?: string;
  protected?: boolean;
  masked?: boolean;
  hidden?: boolean;
  raw?: boolean;
  environment_scope?: string;
}

export class GitLabHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string
  ) {
    super(`GitLab API ${method} ${path} returned HTTP ${status}`);
    this.name = 'GitLabHttpError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeInstanceUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function safeProjectPath(scope: string, instanceUrl: string): string | null {
  const normalizedScope = scope.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!normalizedScope) return null;
  try {
    const scopeUrl = new URL(normalizedScope);
    const instance = new URL(instanceUrl);
    if (scopeUrl.origin !== instance.origin) return null;
    const instancePath = instance.pathname.replace(/\/+$/, '');
    if (instancePath && !scopeUrl.pathname.startsWith(`${instancePath}/`)) return null;
    const path = scopeUrl.pathname.slice(instancePath.length).replace(/^\/+/, '');
    return path.split('/').filter(Boolean).length >= 2 ? decodeURIComponent(path) : null;
  } catch {
    return normalizedScope.split('/').filter(Boolean).length >= 2 ? normalizedScope : null;
  }
}

function phase(status: string): CiPhase {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'manual':
      return 'queued';
    case 'running':
      return 'running';
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'canceling':
      return 'canceled';
    case 'skipped':
      return 'skipped';
    default:
      return 'unknown';
  }
}

function mergeRequest(value: GitLabMergeRequest): CodeChangeRequest {
  return {
    nativeId: String(value.id),
    number: String(value.iid),
    state: value.state,
    title: value.title,
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    ...(value.sha ? { sourceSha: value.sha } : {}),
    ...(value.merge_commit_sha || value.squash_commit_sha
      ? { mergedSha: value.merge_commit_sha ?? value.squash_commit_sha ?? undefined }
      : {}),
    webUrl: value.web_url,
  };
}

export class GitLabAdapter implements CodeHostPort, CiOperationsPort {
  readonly name = 'gitlab';
  private credentials: GitLabCredentials | null = null;

  connect(credentials: unknown): void {
    const parsed = GitLabCredentialsSchema.parse(credentials);
    this.credentials = {
      ...parsed,
      instanceUrl: normalizeInstanceUrl(parsed.instanceUrl),
    };
  }

  private connected(): GitLabCredentials {
    if (!this.credentials) throw new Error('GitLab adapter is not connected');
    return this.credentials;
  }

  private apiUrl(path: string, query?: URLSearchParams): string {
    const { instanceUrl } = this.connected();
    const suffix = query && query.size > 0 ? `?${query.toString()}` : '';
    return `${instanceUrl}/api/v4${path}${suffix}`;
  }

  private async response(
    method: string,
    path: string,
    body?: unknown,
    query?: URLSearchParams,
    accept = 'application/json'
  ): Promise<Response> {
    const { apiToken } = this.connected();
    const response = await fetch(this.apiUrl(path, query), {
      method,
      headers: {
        'PRIVATE-TOKEN': apiToken,
        Accept: accept,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Provider error bodies can echo submitted variables or other secrets.
      // They are deliberately not read or attached to errors.
      throw new GitLabHttpError(response.status, method, path);
    }
    return response;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: URLSearchParams): Promise<T> {
    return this.response(method, path, body, query).then((response) => response.json() as Promise<T>);
  }

  private async requestText(method: string, path: string, query?: URLSearchParams): Promise<string> {
    return this.response(method, path, undefined, query, 'text/plain').then((response) => response.text());
  }

  private async paginated<T>(path: string, query: URLSearchParams, maxPages = 20): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    while (page <= maxPages) {
      const pageQuery = new URLSearchParams(query);
      pageQuery.set('per_page', '100');
      pageQuery.set('page', String(page));
      const response = await this.response('GET', path, undefined, pageQuery);
      values.push(...await response.json() as T[]);
      const nextPage = response.headers.get('x-next-page');
      if (!nextPage) return values;
      const parsed = Number(nextPage);
      if (!Number.isInteger(parsed) || parsed <= page) {
        throw new Error(`GitLab pagination for ${path} returned an invalid next page`);
      }
      page = parsed;
    }
    throw new Error(`GitLab pagination for ${path} exceeded the bounded ${maxPages}-page limit`);
  }

  private projectPath(scope: string): string {
    const path = safeProjectPath(scope, this.connected().instanceUrl);
    if (!path) throw new Error(`GitLab project scope "${scope}" does not match the connected instance`);
    return path;
  }

  private projectRoute(id: string | number): string {
    return `/projects/${encodeURIComponent(String(id))}`;
  }

  async verify(scope?: string): Promise<{
    success: boolean;
    error?: string;
    login?: string;
    email?: string;
    accountId?: string;
    version?: string;
    warning?: string;
  }> {
    try {
      const user = await this.request<{ id: number; username: string; email?: string }>('GET', '/user');
      let warning: string | undefined;
      if (scope) {
        const observation = await this.observeRepository(scope);
        if (observation.state !== 'present') {
          return {
            success: false,
            error: observation.state === 'absent'
              ? `GitLab project ${scope} was not found`
              : observation.reason,
          };
        }
        const project = await this.getProject(observation.value.nativeId);
        const accessLevel = Math.max(
          project.permissions?.project_access?.access_level ?? 0,
          project.permissions?.group_access?.access_level ?? 0
        );
        if (accessLevel < 40) {
          warning = 'The token can read the project but Maintainer-or-higher access was not proven; managed CI mutations will block.';
        }
      }
      return {
        success: true,
        login: user.username,
        ...(user.email ? { email: user.email } : {}),
        accountId: String(user.id),
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getProject(idOrScope: string | number): Promise<GitLabProject> {
    const id = typeof idOrScope === 'number' || /^\d+$/.test(String(idOrScope))
      ? String(idOrScope)
      : this.projectPath(String(idOrScope));
    return this.request('GET', this.projectRoute(id));
  }

  async verifyRegistryPull(project: GitLabProject): Promise<{ success: true } | { success: false; error: string }> {
    const credentials = this.connected();
    if (!credentials.registryUsername || !credentials.registryReadToken) {
      return { success: false, error: 'GitLab registry pull credentials are missing' };
    }
    const query = new URLSearchParams({
      service: 'container_registry',
      scope: `repository:${project.path_with_namespace}:pull`,
    });
    try {
      const response = await fetch(`${credentials.instanceUrl}/jwt/auth?${query.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.registryUsername}:${credentials.registryReadToken}`, 'utf8').toString('base64')}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        // Registry authentication error bodies can include provider details and
        // are deliberately not read or returned.
        return { success: false, error: `GitLab registry authentication returned HTTP ${response.status}` };
      }
      const payload = await response.json() as { token?: unknown; access_token?: unknown };
      const token = typeof payload.token === 'string'
        ? payload.token
        : typeof payload.access_token === 'string'
          ? payload.access_token
          : '';
      if (!token) {
        return { success: false, error: 'GitLab registry authentication returned no pull token' };
      }
      let claims: {
        access?: Array<{ type?: unknown; name?: unknown; actions?: unknown }>;
      };
      try {
        const encoded = token.split('.')[1];
        if (!encoded) throw new Error('missing claims');
        claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof claims;
      } catch {
        return { success: false, error: 'GitLab registry authentication returned an unreadable authorization grant' };
      }
      const pullGranted = (claims.access ?? []).some((entry) => (
        entry.type === 'repository'
        && entry.name === project.path_with_namespace
        && Array.isArray(entry.actions)
        && entry.actions.includes('pull')
      ));
      if (!pullGranted) {
        return { success: false, error: 'GitLab registry authentication did not grant pull access to the exact project repository' };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: `GitLab registry authentication failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async observeRepository(scope: string): Promise<Observation<CodeRepositoryIdentity>> {
    try {
      const project = await this.getProject(scope);
      if (!project.default_branch) {
        return { state: 'unknown', reason: `GitLab project ${project.path_with_namespace} is not initialized with a default branch` };
      }
      const { instanceUrl } = this.connected();
      return {
        state: 'present',
        value: {
          provider: 'gitlab',
          nativeId: String(project.id),
          instanceScope: instanceUrl,
          canonicalScope: project.web_url,
          path: project.path_with_namespace,
          defaultBranch: project.default_branch,
          webUrl: project.web_url,
          cloneUrls: [project.http_url_to_repo, project.ssh_url_to_repo],
        },
      };
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return { state: 'absent' };
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async observeFile(identity: CodeRepositoryIdentity, path: string, ref: string): Promise<Observation<CodeRepositoryFile>> {
    try {
      const query = new URLSearchParams({ ref });
      const file = await this.request<{
        file_path: string;
        content: string;
        encoding: string;
        blob_id?: string;
        last_commit_id?: string;
      }>('GET', `${this.projectRoute(identity.nativeId)}/repository/files/${encodeURIComponent(path)}`, undefined, query);
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8')
        : file.content;
      return {
        state: 'present',
        value: {
          path: file.file_path,
          ref,
          content,
          contentHash: sha256(content),
          ...(file.last_commit_id ? { lastCommitId: file.last_commit_id } : {}),
        },
      };
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return { state: 'absent' };
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async observeBranch(identity: CodeRepositoryIdentity, branch: string): Promise<Observation<{ name: string; sha: string }>> {
    try {
      const value = await this.request<{ name: string; commit: { id: string } }>(
        'GET',
        `${this.projectRoute(identity.nativeId)}/repository/branches/${encodeURIComponent(branch)}`
      );
      return { state: 'present', value: { name: value.name, sha: value.commit.id } };
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return { state: 'absent' };
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async createBranch(identity: CodeRepositoryIdentity, branch: string, ref: string): Promise<void> {
    await this.request('POST', `${this.projectRoute(identity.nativeId)}/repository/branches`, undefined, new URLSearchParams({ branch, ref }));
  }

  async createCommit(
    identity: CodeRepositoryIdentity,
    request: {
      branch: string;
      commitMessage: string;
      actions: CodeRepositoryCommitAction[];
      startBranch?: string;
      startSha?: string;
      force?: boolean;
    }
  ): Promise<{ id: string; webUrl?: string }> {
    const commit = await this.request<{ id: string; web_url?: string }>(
      'POST',
      `${this.projectRoute(identity.nativeId)}/repository/commits`,
      {
        branch: request.branch,
        commit_message: request.commitMessage,
        ...(request.startBranch ? { start_branch: request.startBranch } : {}),
        ...(request.startSha ? { start_sha: request.startSha } : {}),
        ...(request.force === true ? { force: true } : {}),
        actions: request.actions.map((action) => ({
          action: action.action,
          file_path: action.path,
          ...(action.content !== undefined ? { content: action.content, encoding: 'text' } : {}),
          ...(action.previousPath ? { previous_path: action.previousPath } : {}),
          ...(action.lastCommitId ? { last_commit_id: action.lastCommitId } : {}),
        })),
      }
    );
    return { id: commit.id, ...(commit.web_url ? { webUrl: commit.web_url } : {}) };
  }

  async listChangeRequests(
    identity: CodeRepositoryIdentity,
    request: { sourceBranch: string; targetBranch: string; state: 'opened' | 'merged' | 'closed' }
  ): Promise<CodeChangeRequest[]> {
    const query = new URLSearchParams({
      state: request.state,
      source_branch: request.sourceBranch,
      target_branch: request.targetBranch,
      scope: 'all',
    });
    const values = await this.paginated<GitLabMergeRequest>(`${this.projectRoute(identity.nativeId)}/merge_requests`, query);
    return values.map(mergeRequest);
  }

  async createChangeRequest(
    identity: CodeRepositoryIdentity,
    request: { sourceBranch: string; targetBranch: string; title: string; description: string }
  ): Promise<CodeChangeRequest> {
    const value = await this.request<GitLabMergeRequest>('POST', `${this.projectRoute(identity.nativeId)}/merge_requests`, {
      source_branch: request.sourceBranch,
      target_branch: request.targetBranch,
      title: request.title,
      description: request.description,
      remove_source_branch: false,
      squash: false,
    });
    return mergeRequest(value);
  }

  async compareRepository(
    identity: CodeRepositoryIdentity,
    from: string,
    to: string
  ): Promise<{ commits: Array<{ id: string }>; paths: string[] }> {
    const value = await this.request<{
      commits?: Array<{ id: string }>;
      diffs?: Array<{ old_path?: string; new_path?: string }>;
      compare_timeout?: boolean;
      compare_same_ref?: boolean;
    }>(
      'GET',
      `${this.projectRoute(identity.nativeId)}/repository/compare`,
      undefined,
      new URLSearchParams({ from, to, straight: 'true' })
    );
    if (value.compare_timeout) throw new Error('GitLab repository comparison timed out');
    if (value.compare_same_ref) return { commits: [], paths: [] };
    const paths = new Set<string>();
    for (const diff of value.diffs ?? []) {
      if (diff.old_path) paths.add(diff.old_path);
      if (diff.new_path) paths.add(diff.new_path);
    }
    return { commits: value.commits ?? [], paths: [...paths].sort() };
  }

  async lintConfiguration(projectId: string, content: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const value = await this.request<{ valid: boolean; errors?: string[]; warnings?: string[] }>(
      'POST',
      `${this.projectRoute(projectId)}/ci/lint`,
      { content },
      new URLSearchParams({ include_merged_yaml: 'false' })
    );
    return { valid: value.valid, errors: value.errors ?? [], warnings: value.warnings ?? [] };
  }

  async observeActiveConfiguration(projectId: string, commitSha: string, _branch: string): Promise<Observation<{
    valid: boolean;
    jobs: Array<{ name: string; stage?: string; when?: string; environment?: string | null }>;
    includes: Array<{ type?: string; location?: string; context_sha?: string }>;
  }>> {
    try {
      const query = new URLSearchParams({
        content_ref: commitSha,
        include_jobs: 'true',
      });
      const value = await this.request<{
        valid: boolean;
        jobs?: Array<{ name: string; stage?: string; when?: string; environment?: string | null }>;
        includes?: Array<{ type?: string; location?: string; context_sha?: string }>;
        errors?: string[];
      }>('GET', `${this.projectRoute(projectId)}/ci/lint`, undefined, query);
      if (!value.valid) return { state: 'unknown', reason: `GitLab CI Lint rejected active configuration: ${(value.errors ?? []).join('; ')}` };
      return { state: 'present', value: { valid: true, jobs: value.jobs ?? [], includes: value.includes ?? [] } };
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async listVariables(projectId: string): Promise<CiVariableObservation[]> {
    const values = await this.paginated<GitLabVariable>(
      `${this.projectRoute(projectId)}/variables`,
      new URLSearchParams()
    );
    return values.map((variable) => {
      const rawValue = typeof variable.value === 'string' ? variable.value : undefined;
      return {
        key: variable.key,
        scope: variable.environment_scope ?? '*',
        precedence: 'project',
        protected: variable.protected === true,
        masked: variable.masked === true,
        hidden: variable.hidden === true,
        raw: variable.raw === true,
        valueVisibility: rawValue === undefined ? 'omitted' : 'plaintext',
        ...(rawValue !== undefined ? { valueHash: sha256(rawValue) } : {}),
      };
    });
  }

  async upsertVariable(projectId: string, input: {
    key: string;
    value: string;
    environmentScope: string;
    protected: boolean;
    masked: boolean;
    hidden: boolean;
    raw: boolean;
  }): Promise<void> {
    const variables = await this.listVariables(projectId);
    const matches = variables.filter((variable) => variable.key === input.key && variable.scope === input.environmentScope);
    if (matches.length > 1) throw new Error(`Multiple GitLab variables match ${input.key} at scope ${input.environmentScope}`);
    const body = {
      value: input.value,
      variable_type: 'env_var',
      protected: input.protected,
      masked: input.masked,
      raw: input.raw,
      environment_scope: input.environmentScope,
    };
    if (matches.length === 0) {
      await this.request('POST', `${this.projectRoute(projectId)}/variables`, {
        key: input.key,
        ...body,
        ...(input.hidden ? { masked_and_hidden: true } : {}),
      });
      return;
    }
    if (Boolean(matches[0]?.hidden) !== input.hidden) {
      throw new Error(`GitLab variable ${input.key} hidden visibility cannot be changed safely in place`);
    }
    await this.request(
      'PUT',
      `${this.projectRoute(projectId)}/variables/${encodeURIComponent(input.key)}`,
      body,
      new URLSearchParams({ 'filter[environment_scope]': input.environmentScope })
    );
  }

  async deleteVariable(projectId: string, key: string, environmentScope: string): Promise<void> {
    await this.request(
      'DELETE',
      `${this.projectRoute(projectId)}/variables/${encodeURIComponent(key)}`,
      undefined,
      new URLSearchParams({ 'filter[environment_scope]': environmentScope })
    );
  }

  async listProtectedBranches(projectId: string): Promise<Array<{
    name: string;
    pushAccessLevels: Array<{ accessLevel?: number; userId?: number; groupId?: number; deployKeyId?: number }>;
    allowForcePush: boolean;
  }>> {
    const values = await this.paginated<{
      name: string;
      push_access_levels?: Array<{ access_level?: number; user_id?: number; group_id?: number; deploy_key_id?: number }>;
      allow_force_push?: boolean;
    }>(`${this.projectRoute(projectId)}/protected_branches`, new URLSearchParams());
    return values.map((value) => ({
      name: value.name,
      pushAccessLevels: (value.push_access_levels ?? []).map((level) => ({
        ...(level.access_level !== undefined ? { accessLevel: level.access_level } : {}),
        ...(level.user_id !== undefined ? { userId: level.user_id } : {}),
        ...(level.group_id !== undefined ? { groupId: level.group_id } : {}),
        ...(level.deploy_key_id !== undefined ? { deployKeyId: level.deploy_key_id } : {}),
      })),
      allowForcePush: value.allow_force_push === true,
    }));
  }

  async listProjectRunners(projectId: string, tag: string): Promise<GitLabRunnerSummary[]> {
    const values = await this.paginated<{
      id: number;
      runner_type?: string;
      status?: string;
      paused?: boolean;
      tag_list?: string[];
    }>(
      `${this.projectRoute(projectId)}/runners`,
      new URLSearchParams({ tag_list: tag })
    );
    return values.map((value) => ({
      id: String(value.id),
      runnerType: value.runner_type ?? 'unknown',
      status: value.status ?? 'unknown',
      paused: value.paused !== false,
      tags: value.tag_list ?? [],
    }));
  }

  async getProtectedEnvironment(projectId: string, environment: string): Promise<Observation<{
    deployAccessLevels: Array<{ accessLevel?: number; userId?: number; groupId?: number }>;
  }>> {
    try {
      const value = await this.request<{
        deploy_access_levels?: Array<{ access_level?: number; user_id?: number; group_id?: number }>;
      }>('GET', `${this.projectRoute(projectId)}/protected_environments/${encodeURIComponent(environment)}`);
      return {
        state: 'present',
        value: {
          deployAccessLevels: (value.deploy_access_levels ?? []).map((level) => ({
            ...(level.access_level !== undefined ? { accessLevel: level.access_level } : {}),
            ...(level.user_id !== undefined ? { userId: level.user_id } : {}),
            ...(level.group_id !== undefined ? { groupId: level.group_id } : {}),
          })),
        },
      };
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return { state: 'absent' };
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDefinitions(repository: CodeRepositoryIdentity): Promise<Array<{ id: string; name: string; path?: string; state: string; webUrl?: string }>> {
    const project = await this.getProject(repository.nativeId);
    const path = project.ci_config_path?.trim() || '.gitlab-ci.yml';
    const file = await this.observeFile(repository, path, repository.defaultBranch);
    return [{
      id: path,
      name: 'GitLab pipeline',
      path,
      state: file.state === 'present' ? 'active' : file.state,
      webUrl: `${repository.webUrl}/-/pipelines`,
    }];
  }

  async listRuns(repository: CodeRepositoryIdentity, definition: string, limit: number): Promise<CiRunSummary[]> {
    const project = await this.getProject(repository.nativeId);
    const activePath = project.ci_config_path?.trim() || '.gitlab-ci.yml';
    if (definition !== activePath && definition !== 'pipeline') {
      throw new Error(`GitLab definition must be "${activePath}" or "pipeline"`);
    }
    const query = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)) });
    const pipelines = await this.request<GitLabPipeline[]>('GET', `${this.projectRoute(repository.nativeId)}/pipelines`, undefined, query);
    return pipelines.map((pipeline) => this.runSummary(pipeline));
  }

  async listJobs(repository: CodeRepositoryIdentity, runId: string, limit: number): Promise<CiJobSummary[]> {
    if (!/^\d+$/.test(runId)) throw new Error('GitLab pipeline id must be numeric');
    const jobs = await this.request<GitLabJob[]>(
      'GET',
      `${this.projectRoute(repository.nativeId)}/pipelines/${runId}/jobs`,
      undefined,
      new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)), include_retried: 'true' })
    );
    return jobs.map((job) => ({
      id: String(job.id),
      attempt: job.retried ? 'retried' : 'current',
      name: job.name,
      phase: phase(job.status),
      nativeStatus: job.status,
      ...(job.started_at ? { startedAt: job.started_at } : {}),
      ...(job.finished_at ? { completedAt: job.finished_at } : {}),
      ...(job.web_url ? { webUrl: job.web_url } : {}),
    }));
  }

  async getJobLog(repository: CodeRepositoryIdentity, jobId: string): Promise<string> {
    if (!/^\d+$/.test(jobId)) throw new Error('GitLab job id must be numeric');
    return this.requestText('GET', `${this.projectRoute(repository.nativeId)}/jobs/${jobId}/trace`);
  }

  async listArtifacts(repository: CodeRepositoryIdentity, runId?: string, limit = 100): Promise<CiArtifactSummary[]> {
    let resolvedRunId = runId;
    if (!resolvedRunId) {
      const runs = await this.listRuns(repository, 'pipeline', 1);
      resolvedRunId = runs[0]?.id;
    }
    if (!resolvedRunId) return [];
    if (!/^\d+$/.test(resolvedRunId)) throw new Error('GitLab pipeline id must be numeric');
    const jobs = await this.request<GitLabJob[]>(
      'GET',
      `${this.projectRoute(repository.nativeId)}/pipelines/${resolvedRunId}/jobs`,
      undefined,
      new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)), include_retried: 'true' })
    );
    return jobs.flatMap((job) => (job.artifacts ?? []).map((artifact, index) => ({
      id: `${job.id}:${artifact.file_type ?? index}`,
      name: artifact.filename ?? artifact.file_type ?? `artifact-${index + 1}`,
      runId: resolvedRunId!,
      jobId: String(job.id),
      ...(job.created_at ? { createdAt: job.created_at } : {}),
      ...(job.artifacts_expire_at ? { expiresAt: job.artifacts_expire_at } : {}),
    })));
  }

  async dispatch(repository: CodeRepositoryIdentity, request: CiDispatchRequest): Promise<CiRunSummary> {
    const project = await this.getProject(repository.nativeId);
    const activePath = project.ci_config_path?.trim() || '.gitlab-ci.yml';
    if (request.definition !== activePath && request.definition !== 'pipeline') {
      throw new Error(`GitLab dispatch is restricted to the active reviewed definition "${activePath}"`);
    }
    if (!request.sha) {
      throw new Error('GitLab pipeline dispatch requires an exact reviewed commit SHA');
    }
    const branch = await this.observeBranch(repository, request.ref);
    if (branch.state !== 'present' || branch.value.sha !== request.sha) {
      throw new Error(`GitLab ref ${request.ref} is not at reviewed commit ${request.sha}`);
    }
    const pipeline = await this.request<GitLabPipeline>(
      'POST',
      `${this.projectRoute(repository.nativeId)}/pipeline`,
      { inputs: { ...(request.inputs ?? {}), commit_sha: request.sha } },
      new URLSearchParams({ ref: request.ref })
    );
    if (pipeline.sha !== request.sha) {
      throw new Error(`GitLab acknowledged pipeline ${pipeline.id} at ${pipeline.sha}, not reviewed commit ${request.sha}`);
    }
    return this.runSummary(pipeline);
  }

  private runSummary(pipeline: GitLabPipeline): CiRunSummary {
    return {
      id: String(pipeline.id),
      name: pipeline.name ?? `Pipeline ${pipeline.id}`,
      phase: phase(pipeline.status),
      nativeStatus: pipeline.status,
      sha: pipeline.sha,
      ...(pipeline.ref ? { ref: pipeline.ref } : {}),
      ...(pipeline.source ? { source: pipeline.source } : {}),
      ...(pipeline.created_at ? { createdAt: pipeline.created_at } : {}),
      ...(pipeline.updated_at ? { updatedAt: pipeline.updated_at } : {}),
      ...(pipeline.web_url ? { webUrl: pipeline.web_url } : {}),
    };
  }
}

providerRegistry.register({
  metadata: {
    name: 'gitlab',
    displayName: 'GitLab',
    category: 'deployment',
    credentialsSchema: GitLabCredentialsSchema,
    setupHelpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    credentials: {
      defaultScalarKey: 'apiToken',
      environmentVariableAliases: [['HYPERVIBE_GITLAB_TOKEN', 'GITLAB_TOKEN']],
    },
  },
  factory: (credentials) => {
    const adapter = new GitLabAdapter();
    adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['repository', 'ref', 'branch'],
    inspect: async (rawAdapter, request) => {
      const adapter = rawAdapter as GitLabAdapter;
      if (!request.scope) throw new Error('GitLab inspection requires scope.');
      const repository = await adapter.observeRepository(request.scope);
      if (request.resource === 'repository' || !request.resource) return { observation: repository.state, repository: repository.state === 'present' ? repository.value : undefined };
      if (repository.state !== 'present') return { observation: repository.state, reason: repository.state === 'unknown' ? repository.reason : undefined };
      if (request.resource === 'ref' || request.resource === 'branch') {
        const branch = request.id ?? request.name ?? repository.value.defaultBranch;
        const observation = await adapter.observeBranch(repository.value, branch);
        return { observation: observation.state, branch: observation.state === 'present' ? observation.value : undefined };
      }
      throw new Error(`Unsupported GitLab inspection resource "${request.resource}".`);
    },
  },
});
