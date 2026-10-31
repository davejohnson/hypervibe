import { z } from 'zod';
import type { CloudDeploymentAuthenticationV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { CloudDeploymentAccessError } from '../../../domain/services/cloud-deployment-authentication.js';
import { redactExactValues } from '../../../utils/redact-exact-values.js';
import { DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { assertGcpProjectIdentity } from './gcp-project-identity.js';

export const gcpDeploymentScopeSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  projectNumber: z.string().regex(/^[1-9]\d{5,29}$/),
}).strict();
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';
const hosts = new Set(['run.googleapis.com', 'iam.googleapis.com', 'cloudresourcemanager.googleapis.com',
  'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'cloudscheduler.googleapis.com',
  'logging.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com']);

/** An opaque bearer is verified by Google, not by decoding it or trusting its label. */
export class GcpDeploymentAuthentication {
  private cached?: { token: string; expiresAt: number };
  private readonly secrets = new Set<string>();
  constructor(readonly authentication: Extract<CloudDeploymentAuthenticationV1, { kind: 'gcp-impersonation' }>) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token;
    const budget = new DestinationBudget();
    try {
      const issued = await budget.wait(this.authentication.getAccessToken(budget.signal));
      this.secrets.add(issued.token);
      const { principal } = this.authentication;
      const info = await destinationJson((url, init) => fetch(url, { ...init,
        headers: { ...init?.headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } }),
      budget, 'https://oauth2.googleapis.com/tokeninfo', issued.token, { method: 'POST' });
      const nativeExpiry = typeof info.exp === 'string' && /^\d+$/.test(info.exp) ? Number(info.exp) * 1000 : NaN;
      const expiresAt = Date.parse(issued.expiresAt);
      if (info.aud !== principal.serviceAccountUniqueId || info.azp !== principal.serviceAccountUniqueId
        || info.scope !== CLOUD_PLATFORM || !Number.isSafeInteger(nativeExpiry)
        || nativeExpiry <= Date.now() || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
        || nativeExpiry > expiresAt + 1000 || nativeExpiry > Date.now() + 3_600_000)
        throw new CloudDeploymentAccessError('scope_mismatch');
      await assertGcpProjectIdentity({ request: fetch, budget, token: issued.token, projectId: principal.projectId, projectNumber: principal.projectNumber });
      const account = await destinationJson(fetch, budget,
        `https://iam.googleapis.com/v1/projects/${principal.projectId}/serviceAccounts/${principal.serviceAccountUniqueId}`, issued.token);
      if (account.name !== `projects/${principal.projectId}/serviceAccounts/${principal.serviceAccountEmail}`
        || account.projectId !== principal.projectId || account.uniqueId !== principal.serviceAccountUniqueId
        || account.email !== principal.serviceAccountEmail || (account.disabled !== undefined && account.disabled !== false))
        throw new CloudDeploymentAccessError('scope_mismatch');
      this.cached = { token: issued.token, expiresAt: Math.min(expiresAt, nativeExpiry) };
      return issued.token;
    } catch (error) {
      this.cached = undefined;
      throw error instanceof CloudDeploymentAccessError ? error : new CloudDeploymentAccessError('authorization_unavailable');
    } finally { budget.close(); }
  }

  /** All new-path provider output is bounded and checked for echoed bearer values. */
  async request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const budget = new DestinationBudget({ signal: init?.signal ?? undefined });
    try {
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash
        || !(hosts.has(url.hostname) || /^[a-z]+-[a-z]+[0-9]-run\.googleapis\.com$/.test(url.hostname)))
        throw new CloudDeploymentAccessError('scope_mismatch');
      const authorization = new Headers(init?.headers).get('authorization');
      if (!authorization?.startsWith('Bearer ') || !this.secrets.has(authorization.slice(7)))
        throw new CloudDeploymentAccessError('scope_mismatch');
      if (budget.signal.aborted) throw new CloudDeploymentAccessError('authorization_unavailable');
      const response = await budget.wait(fetch(input, { ...init, redirect: 'error', signal: budget.signal }));
      if (response.redirected) throw new CloudDeploymentAccessError('scope_mismatch');
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // Preserve native status for absence/concurrency handling, never native prose.
        return new Response(null, { status: response.status });
      }
      if (response.status === 204) return new Response(null, { status: 204 });
      const reader = response.body?.getReader();
      if (!reader) throw new CloudDeploymentAccessError('authorization_unavailable');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await budget.wait(reader.read());
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1_048_576) throw new CloudDeploymentAccessError('authorization_unavailable');
          chunks.push(part.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (JSON.stringify(redactExactValues(parsed, this.secrets)) !== JSON.stringify(parsed))
        throw new CloudDeploymentAccessError('authorization_unavailable');
      return Response.json(parsed, { status: response.status });
    } catch (error) {
      throw error instanceof CloudDeploymentAccessError ? error : new CloudDeploymentAccessError('authorization_unavailable');
    } finally { budget.close(); }
  }
}
