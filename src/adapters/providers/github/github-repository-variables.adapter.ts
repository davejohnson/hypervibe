import { createHash } from 'node:crypto';
import type { CodeRepositoryIdentity, RepositoryConfigurationPort, RepositoryVariableInventory } from '../../../domain/ports/devops.port.js';
import { RepositoryConfigurationWriteError } from '../../../domain/ports/devops.port.js';
import type { Observation } from '../../../domain/ports/provider-observation.js';
import { GitHubAdapter, GitHubApiError, type GitHubCredentials } from './github.adapter.js';

const UNVERIFIED = 'GitHub repository variables could not be verified.';
const WRITE_FAILED = 'GitHub repository variable write could not be verified; inspect before retrying.';
const PAGE_SIZE = 30;
const MAX_VARIABLES = 500;
const MAX_VALUE_BYTES = 48 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Plain repository variables only. Raw values are hashed inside this boundary. */
export class GitHubRepositoryVariablesAdapter implements RepositoryConfigurationPort {
  private readonly adapter = new GitHubAdapter();
  private readonly secretValues: string[];

  constructor(credentials: GitHubCredentials) {
    this.adapter.connect(credentials);
    this.secretValues = [credentials.apiToken, credentials.packageReadToken]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  private safe(value: string): boolean {
    return !this.secretValues.some(secret => value.toLowerCase().includes(secret.toLowerCase()));
  }

  normalizeName(name: string): string {
    if (typeof name !== 'string' || name.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || /^GITHUB_/i.test(name) || !this.safe(name)) {
      throw new Error('Invalid GitHub repository variable name.');
    }
    return name.toUpperCase();
  }

  private scope(scope: string): [string, string] {
    if (typeof scope !== 'string' || !this.safe(scope)) throw new Error(UNVERIFIED);
    const path = scope.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
    const parts = path.split('/');
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]{1,255}$/.test(part)
      || part === '.' || part === '..')) throw new Error(UNVERIFIED);
    return parts as [string, string];
  }

  private async repository(scope: string): Promise<CodeRepositoryIdentity> {
    const [owner, name] = this.scope(scope);
    const repository = await this.adapter.getRepository(owner, name);
    if (!object(repository) || !Number.isSafeInteger(repository.id) || Number(repository.id) <= 0
      || !this.safe(String(repository.id))
      || typeof repository.full_name !== 'string' || !this.safe(repository.full_name)
      || repository.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()
      || typeof repository.default_branch !== 'string' || !repository.default_branch
      || repository.default_branch.length > 255 || /[\x00-\x1f\x7f]/.test(repository.default_branch)
      || !this.safe(repository.default_branch)) throw new Error(UNVERIFIED);
    const path = repository.full_name;
    const webUrl = `https://github.com/${path}`;
    return {
      provider: 'github', nativeId: String(repository.id), instanceScope: 'https://github.com',
      canonicalScope: webUrl, path, defaultBranch: repository.default_branch, webUrl,
      cloneUrls: [`${webUrl}.git`, `git@github.com:${path}.git`],
    };
  }

  private timestamp(value: unknown): string {
    if (typeof value !== 'string' || value.length > 40 || !this.safe(value)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(UNVERIFIED);
    return value;
  }

  async observe(scope: string): Promise<Observation<RepositoryVariableInventory>> {
    try {
      const repository = await this.repository(scope);
      const [owner, name] = this.scope(repository.path);
      const variables: RepositoryVariableInventory['variables'] = [];
      const names = new Set<string>();
      let total: number | undefined;
      for (let page = 1; page <= Math.ceil(MAX_VARIABLES / PAGE_SIZE); page++) {
        const data = await this.adapter.listRepositoryVariablePage(owner, name, page);
        if (!object(data) || !Number.isSafeInteger(data.total_count)
          || Number(data.total_count) < 0 || Number(data.total_count) > MAX_VARIABLES
          || !Array.isArray(data.variables)) throw new Error(UNVERIFIED);
        if (total === undefined) total = Number(data.total_count);
        if (data.total_count !== total || data.variables.length !== Math.min(PAGE_SIZE, total - variables.length)) {
          throw new Error(UNVERIFIED);
        }
        for (const entry of data.variables) {
          if (!object(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string'
            || Buffer.byteLength(entry.value, 'utf8') > MAX_VALUE_BYTES) throw new Error(UNVERIFIED);
          const variableName = this.normalizeName(entry.name);
          if (names.has(variableName)) throw new Error(UNVERIFIED);
          names.add(variableName);
          variables.push({ name: variableName, valueHash: createHash('sha256').update(entry.value).digest('hex'),
            createdAt: this.timestamp(entry.created_at), updatedAt: this.timestamp(entry.updated_at) });
        }
        if (variables.length === total) {
          return { state: 'present', value: { repository, variables, observedAt: new Date().toISOString() } };
        }
      }
      throw new Error(UNVERIFIED);
    } catch {
      return { state: 'unknown', reason: UNVERIFIED };
    }
  }

  private async write(identity: CodeRepositoryIdentity, name: string, value: string, operation: 'create' | 'update'): Promise<void> {
    let dispatched = false;
    try {
      const variableName = this.normalizeName(name);
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES || !this.safe(value)
        || identity.provider !== 'github' || identity.instanceScope !== 'https://github.com'
        || !/^[1-9]\d*$/.test(identity.nativeId)) throw new Error(WRITE_FAILED);
      const expectedUrl = `https://github.com/${identity.path}`;
      if (identity.canonicalScope.toLowerCase() !== expectedUrl.toLowerCase()) throw new Error(WRITE_FAILED);
      const repository = await this.repository(identity.path);
      if (repository.nativeId !== identity.nativeId) throw new Error(WRITE_FAILED);
      const [owner, repo] = this.scope(repository.path);
      dispatched = true;
      if (operation === 'create') await this.adapter.createRepositoryVariable(owner, repo, variableName, value);
      else await this.adapter.updateRepositoryVariable(owner, repo, variableName, value);
    } catch (error) {
      // GitHub documents these client responses as rejected requests. Neither a
      // transport failure nor an unexpected success/server response proves that.
      if (!dispatched || (error instanceof GitHubApiError && [400, 401, 403, 404, 422, 429].includes(error.status))) {
        throw new RepositoryConfigurationWriteError();
      }
      throw new Error(WRITE_FAILED);
    }
  }

  create(identity: CodeRepositoryIdentity, name: string, value: string): Promise<void> {
    return this.write(identity, name, value, 'create');
  }

  update(identity: CodeRepositoryIdentity, name: string, value: string): Promise<void> {
    return this.write(identity, name, value, 'update');
  }
}
