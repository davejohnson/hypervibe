import { GcpBootstrapClient, type GcpServiceAccount } from './gcp-bootstrap.client.js';
import { assertGcpProjectIdentity } from './gcp-project-identity.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';

export interface WriterIamBinding { role: string; members: string[]; condition?: Record<string, unknown> }
export interface WriterIamPolicy extends Record<string, unknown> { etag: string; version?: number; bindings: WriterIamBinding[] }
export interface WriterCustomRole { name: string; description: string; includedPermissions: string[]; stage: 'GA' }
export interface WriterMutationContext { secretId?: string }
const ROOTS = new Set(['iam.googleapis.com', 'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com']);

/** Fixed GCP REST endpoints; one shared deadline includes provider body reads. */
export class GcpSecretWriterClient {
  readonly bootstrap: GcpBootstrapClient;
  private dispatched = false;
  private rejected = false;
  beginMutation(): void { this.dispatched = false; this.rejected = false; }
  canRetryRejectedMutation(): boolean { return !this.dispatched || this.rejected; }
  constructor(private readonly input: { token: string; budget: DestinationBudget; request: typeof fetch;
    beforeWrite: (context?: WriterMutationContext) => Promise<void>; sleep: (milliseconds: number) => Promise<void> }) {
    // Reuse account/API parsing and convergence without the old client's
    // unbounded response-body path or implicit transport redirect behavior.
    const boundedFetch: typeof fetch = async (url, init = {}) => {
      try {
        const value = await this.json(String(url), init, init.method === 'POST' && !String(url).endsWith(':getIamPolicy'));
        return Response.json(value);
      } catch (error) {
        if (error instanceof DestinationBoundaryError && error.status) return Response.json({}, { status: error.status });
        throw error;
      }
    };
    this.bootstrap = new GcpBootstrapClient({ accessToken: input.token, fetch: boundedFetch,
      sleep: milliseconds => input.budget.wait(input.sleep(milliseconds)), maxAttempts: 3, delayMs: 250 });
  }
  async json(url: string, init: RequestInit = {}, mutation = false, context?: WriterMutationContext): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !ROOTS.has(target.hostname) || target.username || target.password || target.port) {
      throw new DestinationBoundaryError('scope_mismatch');
    }
    if (mutation) {
      try { await this.input.budget.wait(this.input.beforeWrite(context)); }
      catch { throw new DestinationBoundaryError(this.input.budget.signal.aborted ? 'deadline_exceeded' : 'authorization_unconfirmed'); }
    }
    if (mutation) this.dispatched = true;
    try { return await destinationJson(this.input.request, this.input.budget, url, this.input.token, init); }
    catch (error) {
      // Only the actual write response can prove rejection. A failed later
      // operation/readback request cannot make an accepted write replayable.
      if (mutation && error instanceof DestinationBoundaryError
        && [400, 401, 403, 404, 409, 412, 422].includes(error.status ?? 0)) this.rejected = true;
      throw error;
    }
  }
  async project(projectId: string, projectNumber: string): Promise<void> {
    return assertGcpProjectIdentity({ request: this.input.request, budget: this.input.budget, token: this.input.token, projectId, projectNumber });
  }
  async secret(resource: string): Promise<void> {
    const result = await this.json(`https://secretmanager.googleapis.com/v1/${resource}`);
    if (result.name !== resource) throw new DestinationBoundaryError('scope_mismatch');
  }
  async role(name: string): Promise<WriterCustomRole | null> {
    try {
      const result = await this.json(`https://iam.googleapis.com/v1/${name}?view=FULL`);
      if (result.name !== name || typeof result.description !== 'string' || !Array.isArray(result.includedPermissions)
        || !result.includedPermissions.every(value => typeof value === 'string') || result.stage !== 'GA'
        || (result.deleted !== undefined && result.deleted !== false)) throw new DestinationBoundaryError('invalid_response');
      return { name, description: result.description, stage: 'GA', includedPermissions: result.includedPermissions as string[] };
    } catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  async createRole(projectId: string, roleId: string, description: string, permissions: string[]): Promise<void> {
    const name = `projects/${projectId}/roles/${roleId}`;
    const result = await this.json(`https://iam.googleapis.com/v1/projects/${projectId}/roles`, {
      method: 'POST', body: JSON.stringify({ roleId, role: { title: 'Hypervibe secret writer', description, stage: 'GA', includedPermissions: permissions } }),
    }, true);
    if (result.name !== name) throw new DestinationBoundaryError('invalid_response');
  }
  async createAccount(projectId: string, accountId: string, description: string): Promise<{ uniqueId: string }> {
    const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
    const result = await this.json(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`, {
      method: 'POST', body: JSON.stringify({ accountId, serviceAccount: { displayName: 'Hypervibe secret writer', description } }),
    }, true);
    if (result.name !== `projects/${projectId}/serviceAccounts/${email}` || result.email !== email || result.projectId !== projectId
      || result.description !== description || typeof result.uniqueId !== 'string' || !/^[1-9]\d*$/.test(result.uniqueId)
      || (result.disabled !== undefined && result.disabled !== false)) throw new DestinationBoundaryError('invalid_response');
    return { uniqueId: result.uniqueId };
  }
  async policy(kind: 'project' | 'account' | 'secret', resource: string): Promise<WriterIamPolicy> {
    const root = kind === 'secret' ? 'secretmanager.googleapis.com/v1' : kind === 'account' ? 'iam.googleapis.com/v1' : 'cloudresourcemanager.googleapis.com/v3';
    const result = kind === 'secret'
      ? await this.json(`https://${root}/${resource}:getIamPolicy?options.requestedPolicyVersion=3`)
      : await this.json(`https://${root}/${resource}:getIamPolicy`, { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) });
    const bindings = result.bindings ?? [];
    if (typeof result.etag !== 'string' || !result.etag || !Array.isArray(bindings)
      || (result.version !== undefined && ![0, 1, 3].includes(result.version as number))) throw new DestinationBoundaryError('invalid_response');
    for (const value of bindings) {
      if (!value || typeof value !== 'object' || typeof value.role !== 'string' || !value.role
        || !Array.isArray(value.members) || !value.members.every((member: unknown) => typeof member === 'string' && member)
        || (value.condition !== undefined && (!value.condition || typeof value.condition !== 'object' || Array.isArray(value.condition) || result.version !== 3))) {
        throw new DestinationBoundaryError('invalid_response');
      }
    }
    return { ...result, etag: result.etag, bindings } as WriterIamPolicy;
  }
  async setPolicy(kind: 'project' | 'account' | 'secret', resource: string, policy: WriterIamPolicy): Promise<void> {
    const root = kind === 'secret' ? 'secretmanager.googleapis.com/v1' : kind === 'account' ? 'iam.googleapis.com/v1' : 'cloudresourcemanager.googleapis.com/v3';
    await this.json(`https://${root}/${resource}:setIamPolicy`, { method: 'POST', body: JSON.stringify({ policy }) }, true,
      kind === 'secret' ? { secretId: resource.split('/secrets/')[1] } : undefined);
  }
  account(projectId: string, accountId: string): Promise<GcpServiceAccount | null> { return this.bootstrap.getServiceAccount(projectId, accountId); }
}
