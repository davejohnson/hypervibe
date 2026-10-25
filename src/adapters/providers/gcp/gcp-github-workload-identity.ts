import { z } from 'zod';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { normalizeGitRemoteIdentity } from '../../../lib/git-remote.js';

export const gcpGithubWorkloadIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  projectNumber: z.string().regex(/^[1-9]\d{5,29}$/),
  workloadIdentityProvider: z.string().regex(/^projects\/[1-9]\d{5,29}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/),
  serviceAccountEmail: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/),
  serviceAccountUniqueId: z.string().regex(/^[1-9]\d{5,29}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  repositoryId: z.string().regex(/^[1-9]\d{0,29}$/), repositoryOwnerId: z.string().regex(/^[1-9]\d{0,29}$/),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/).refine(value => !value.includes('..') && !value.endsWith('/')),
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  workflow: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/),
  backupWorkflow: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/).optional(),
}).strict().superRefine((value, context) => {
  if (!value.workloadIdentityProvider.startsWith(`projects/${value.projectNumber}/`)
    || !value.serviceAccountEmail.endsWith(`@${value.projectId}.iam.gserviceaccount.com`)) {
    context.addIssue({ code: 'custom', message: 'Federated Google identity does not match its exact project.' });
  }
});
export type GcpGithubWorkloadIdentity = z.infer<typeof gcpGithubWorkloadIdentitySchema>;
export function parseGcpGithubWorkloadIdentity(value: unknown): GcpGithubWorkloadIdentity {
  if (typeof value === 'string') {
    if (value.length > 8192) throw new Error('Federated Google identity is invalid.');
    try { value = JSON.parse(value); } catch { throw new Error('Federated Google identity is invalid.'); }
  }
  return gcpGithubWorkloadIdentitySchema.parse(value);
}
export const gcpGithubCiBoundAuthentication = {
  bindingKey: 'gcpGithubWorkloadIdentity',
  parse(value: unknown, context: { environment: string; branch: string; providerProjectId?: string; repository?: string | null }): Record<string, unknown> {
    const identity = parseGcpGithubWorkloadIdentity(value);
    const workflow = `.github/workflows/deploy-cloudrun-${context.environment.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.yml`;
    if (identity.environment !== context.environment || identity.branch !== context.branch || identity.projectId !== context.providerProjectId
      || normalizeGitRemoteIdentity(context.repository ?? undefined) !== `github.com/${identity.repository}` || identity.workflow !== workflow) {
      throw new Error('The reviewed GitHub workload identity does not match this exact deployment source, environment and native project.');
    }
    return identity;
  },
};

/** Self-contained so the same reviewed exchange runs in emitted GitHub scripts.
 * Google verifies the signed assertion and installed CEL condition. The local
 * claim checks below are additional scope checks, never signature verification. */
export function createGcpGithubTokenProvider(config: GcpGithubWorkloadIdentity, options: {
  fetch?: typeof fetch; getSubjectToken?: (audience: string) => Promise<string>; now?: () => number;
} = {}) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const audience = `https://iam.googleapis.com/${config.workloadIdentityProvider}`;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<{ token: string; expiresAt: number }> | undefined;
  const unavailable = () => new Error('GitHub workload identity could not authorize the exact Google deployment scope.');
  async function json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 15_000); });
    const bounded = <T>(value: Promise<T>) => Promise.race([value, deadline]);
    try {
      const response = await bounded(request(url, { ...init, redirect: 'error', signal: controller.signal }));
      if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) {
        void response.body?.cancel().catch(() => {}); throw unavailable();
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const chunk = await bounded(reader.read()); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 65536) throw unavailable(); chunks.push(chunk.value); } }
      catch { void reader.cancel().catch(() => {}); throw unavailable(); } finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
      return parsed as Record<string, unknown>;
    } catch { throw unavailable(); } finally { clearTimeout(timer); controller.abort(); }
  }
  async function subjectToken(): Promise<string> {
    if (options.getSubjectToken) return options.getSubjectToken(audience);
    const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const authorization = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!endpoint || !authorization || /[\r\n]/.test(authorization)) throw unavailable();
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.actions\.githubusercontent\.com$/.test(url.hostname)) throw unavailable();
    url.searchParams.set('audience', audience);
    const result = await json(url.toString(), { headers: { Authorization: `Bearer ${authorization}`, Accept: 'application/json' } });
    if (typeof result.value !== 'string') throw unavailable();
    return result.value;
  }
  async function exchange() {
    try {
      const subject = await subjectToken();
      if (typeof subject !== 'string' || subject.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(subject)) throw unavailable();
      const claims = JSON.parse(Buffer.from(subject.split('.')[1], 'base64url').toString('utf8'));
      const seconds = Math.floor(now() / 1000);
      const backup = Boolean(config.backupWorkflow && claims.workflow_ref === `${config.repository}/${config.backupWorkflow}@refs/heads/${config.branch}`);
      if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== audience
        || claims.repository_id !== config.repositoryId || claims.repository_owner_id !== config.repositoryOwnerId
        || claims.repository !== config.repository || claims.ref !== `refs/heads/${config.branch}`
        || claims.sub !== `repo:${config.repository}:environment:${config.environment}`
        || !backup && claims.workflow_ref !== `${config.repository}/${config.workflow}@refs/heads/${config.branch}`
        || !(backup ? ['schedule', 'workflow_dispatch'] : ['push', 'workflow_dispatch']).includes(claims.event_name)
        || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds || claims.exp > seconds + 3600
        || !Number.isSafeInteger(claims.iat) || claims.iat > seconds + 30 || claims.iat < seconds - 600) throw unavailable();
      const exchanged = await json('https://sts.googleapis.com/v1/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: `//iam.googleapis.com/${config.workloadIdentityProvider}`,
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          subject_token: subject, scope: 'https://www.googleapis.com/auth/cloud-platform',
        }).toString() });
      if (typeof exchanged.access_token !== 'string' || !exchanged.access_token || /[\r\n]/.test(exchanged.access_token)
        || exchanged.token_type !== 'Bearer' || exchanged.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token') throw unavailable();
      const token = await json(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccountUniqueId}:generateAccessToken`, {
        method: 'POST', headers: { Authorization: `Bearer ${exchanged.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '900s' }),
      });
      const expiry = typeof token.expireTime === 'string' ? Date.parse(token.expireTime) : NaN;
      if (typeof token.accessToken !== 'string' || !token.accessToken || /[\r\n]/.test(token.accessToken)
        || !Number.isFinite(expiry) || expiry <= now() + 30_000 || expiry > now() + 930_000) throw unavailable();
      return { token: token.accessToken, expiresAt: expiry };
    } catch { throw unavailable(); }
  }
  return async () => {
    if (cached && cached.expiresAt > now() + 60_000) return cached;
    pending ??= exchange();
    try { return cached = await pending; } finally { pending = undefined; }
  };
}

export function buildGcpGithubTokenRuntime(value: unknown): string {
  const identity = parseGcpGithubWorkloadIdentity(value);
  return `const hvGithubGoogleToken = (${createGcpGithubTokenProvider.toString()})(${JSON.stringify(identity)}, { getSubjectToken: audience => core.getIDToken(audience) });\nasync function getAccessToken() { return (await hvGithubGoogleToken()).token; }\n`;
}

const hosts = new Set(['run.googleapis.com', 'iam.googleapis.com', 'cloudresourcemanager.googleapis.com', 'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com', 'cloudscheduler.googleapis.com', 'logging.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com',
  'sqladmin.googleapis.com', 'secretmanager.googleapis.com', 'pubsub.googleapis.com', 'storage.googleapis.com', 'file.googleapis.com']);
/** In-memory external workload access, with the same GoogleAuth facade used by SQL Connector. */
export class GcpGithubWorkloadAuthentication {
  readonly auth: GoogleAuth;
  readonly principal: { kind: 'service-account'; email: string; uniqueId: string };
  private readonly issue: ReturnType<typeof createGcpGithubTokenProvider>;
  private readonly tokens = new Set<string>();
  constructor(readonly identity: GcpGithubWorkloadIdentity, options: Parameters<typeof createGcpGithubTokenProvider>[1] = {}) {
    this.identity = parseGcpGithubWorkloadIdentity(identity);
    this.principal = { kind: 'service-account', email: this.identity.serviceAccountEmail, uniqueId: this.identity.serviceAccountUniqueId };
    this.issue = createGcpGithubTokenProvider(this.identity, options);
    const client = new OAuth2Client({ transporterOptions: { fetchImplementation: (url, init) => this.request(String(url), init), timeout: 15_000, retry: false } });
    client.refreshHandler = async () => { const issued = await this.issue(); this.tokens.add(issued.token); return { access_token: issued.token, expiry_date: issued.expiresAt }; };
    this.auth = new GoogleAuth({ projectId: this.identity.projectId, authClient: client, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  async initialize() { await this.token(); }
  async token() { const issued = await this.issue(); this.tokens.add(issued.token); return issued.token; }
  async request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const budget = new DestinationBudget({ signal: init?.signal ?? undefined });
    try {
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
        || !(hosts.has(url.hostname) || /^[a-z]+-[a-z]+[0-9]-run\.googleapis\.com$/.test(url.hostname))) throw new Error();
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
      if (!token || !this.tokens.has(token)) throw new Error();
      let status = 200;
      const result = await destinationJson(async (target, options) => {
        const response = await fetch(target, options); status = response.status;
        return status === 204 ? Response.json({}) : response;
      }, budget, url.toString(), token, init);
      const serialized = JSON.stringify(result);
      if ([...this.tokens].some(value => serialized.includes(value))) throw new Error();
      return status === 204 ? new Response(null, { status }) : Response.json(result, { status });
    } catch (error) {
      if (error instanceof DestinationBoundaryError && error.status) return new Response(null, { status: error.status });
      throw new Error('Google API response could not be verified; preserve the exact operation for reconciliation.');
    } finally { budget.close(); }
  }
}
