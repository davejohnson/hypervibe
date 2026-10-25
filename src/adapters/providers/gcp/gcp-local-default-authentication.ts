import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { redactExactValues } from '../../../utils/redact-exact-values.js';

const hosts = new Set(['run.googleapis.com', 'iam.googleapis.com', 'cloudresourcemanager.googleapis.com',
  'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'cloudscheduler.googleapis.com',
  'logging.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com', 'sqladmin.googleapis.com',
  'secretmanager.googleapis.com', 'pubsub.googleapis.com', 'storage.googleapis.com', 'file.googleapis.com']);
type Principal = { kind: 'user' };

/** Local user ADC only. Neither the file nor its refresh token is projected into state or CI. */
export class GcpLocalDefaultAuthentication {
  readonly auth: GoogleAuth;
  principal?: Principal;
  private quotaProjectId?: string;
  private readonly tokens = new Set<string>();

  constructor(projectId: string) {
    this.auth = new GoogleAuth({ projectId, scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientOptions: { transporterOptions: { fetchImplementation: async (input, init) => {
        // Connector HTTP uses this same authenticated SDK client. Keep its
        // native errors and success echoes behind the ordinary response guard.
        const target = new URL(String(input));
        if (target.hostname === 'sqladmin.googleapis.com') {
          if (target.origin !== 'https://sqladmin.googleapis.com' || target.username || target.password || target.hash) throw new Error('Invalid Google SQL API destination.');
          // This transport is installed only on our GoogleAuth client. Its
          // request pipeline has already acquired and attached this token;
          // acquiring again can refresh a short-lived token before dispatch.
          const authorization = new Headers(init?.headers).get('authorization');
          const issuedToken = authorization?.match(/^Bearer (\S+)$/)?.[1];
          if (!issuedToken) throw new Error('Google SQL authorization is unavailable.');
          this.tokens.add(issuedToken);
          return this.request(input, init);
        }
        return fetch(input, { ...init, redirect: 'error' });
      },
        timeout: 15_000, retry: false } } });
  }

  async initialize(): Promise<void> {
    let client;
    try {
      client = await this.auth.getClient();
    } catch { throw new Error('Local Google Application Default Credentials are unavailable; resume the reviewed local Google sign-in.'); }
    // GoogleAuth does not propagate our protected transport to every ADC client
    // kind. Admit only the local user path exercised through this exact boundary.
    if (!(client instanceof UserRefreshClient)) throw new Error('This local Google credential type is unsupported; use the reviewed local user sign-in or a separately authorized deployment connection.');
    this.quotaProjectId = client.quotaProjectId;
    this.principal = { kind: 'user' };
  }

  async token(): Promise<string> {
    try {
      const token = await this.auth.getAccessToken();
      if (!token) throw new Error('missing');
      this.tokens.add(token);
      return token;
    } catch { throw new Error('Local Google Application Default Credentials could not issue an access token; authorization remains unverified.'); }
  }

  /** Native status survives; provider error text and echoed transient tokens do not. */
  async request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const budget = new DestinationBudget({ signal: init?.signal ?? undefined });
    try {
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
        || !(hosts.has(url.hostname) || /^[a-z]+-[a-z]+[0-9]-run\.googleapis\.com$/.test(url.hostname))) throw new Error('scope');
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
      if (!token || !this.tokens.has(token)) throw new Error('authority');
      let status = 200;
      const result = await destinationJson(async (target, options) => {
        const headers = new Headers(options?.headers);
        if (this.quotaProjectId) headers.set('x-goog-user-project', this.quotaProjectId);
        const response = await fetch(target, { ...options, headers }); status = response.status;
        if (response.redirected) throw new Error('redirect');
        return status === 204 ? Response.json({}) : response;
      }, budget, url.toString(), token, init);
      if (JSON.stringify(redactExactValues(result, this.tokens)) !== JSON.stringify(result)) throw new Error('echo');
      return status === 204 ? new Response(null, { status }) : Response.json(result, { status });
    } catch (error) {
      if (error instanceof DestinationBoundaryError && error.status) return new Response(null, { status: error.status });
      throw new Error('Google API response could not be verified; preserve this exact operation for reconciliation.');
    } finally { budget.close(); }
  }
}
