import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationProviderContext, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { OperatorApplicationCapability, OperatorApplicationLocalContext } from '../../../domain/ports/operator-application.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { OperatorCredentialCustody } from '../../../domain/services/operator-credential-custody.js';
import { operatorOutputReceipts, readGithubOperatorSigningKey, withOperatorOutputDelivery } from '../../../domain/services/operator-output-delivery.js';
import { openOperatorAppCallback } from '../../browser/operator-app-callback.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
const text = z.string().min(1).max(2048), id = z.string().regex(/^[1-9]\d{0,19}$/), uuid = z.string().guid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/), origin = text.refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password; } catch { return false; } });
const scopeSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), origin, ownerType: z.enum(['User', 'Organization']), ownerLogin: login, ownerId: id }).strict();
const permissions = { actions: 'read', administration: 'read', checks: 'read', contents: 'read', metadata: 'read' }, events = ['check_run', 'check_suite', 'workflow_run'];
type Intent = OperatorApplicationIntent; type Context = CloudInstallationProviderContext<Intent>;
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function browserExpired(saved: ReturnType<OperatorCredentialCustody['read']>): boolean {
  const browser = saved?.state.browser;
  return !!browser && Date.parse(browser.expiresAt) <= Date.now();
}
function settings(intent: Intent) {
  if (intent.applicationProvider !== 'github-app' || intent.provider !== 'github-app') fail();
  const n = scopeSchema.parse(intent.nativeScope), owner = canonicalJsonSha256([intent.customerId, intent.appId, intent.environment, intent.installationId]);
  return { ...n, appName: `Hypercloud ${n.name.slice(0, 10)} ${owner.slice(0, 12)}`, browserAction: `github-app:${n.name}:browser`, captureAction: `github-app:${n.name}:capture` };
}
function actions(intent: Intent): CloudInstallationAction[] {
  const n = settings(intent);
  return [{ id: n.browserAction, type: 'create', resource: { kind: 'project', provider: 'github-app', name: n.appName }, verified: true, requiresConfirm: true,
    reason: 'Open the reviewed GitHub manifest for its selected owner; browser approval creates the App and generates its credentials.',
    metadata: { operation: 'browser', category: 'identity', execution: 'external', native: {} } },
  { id: n.captureAction, type: 'create', resource: { kind: 'project', provider: 'github-app', name: n.appName }, verified: true, requiresConfirm: true,
    dependsOn: [n.browserAction], reason: 'Exchange the single private manifest code once, verify native ownership and permissions, and encrypt the returned operator credentials.',
    metadata: { operation: 'capture', category: 'identity', execution: 'api', native: {} } }];
}
const browserIdentity = z.object({ origin, ownerId: id, attemptId: uuid, manifestDigest: hash }).strict();
const appIdentity = z.object({ appId: id, slug: z.string().regex(/^[a-z0-9-]{1,100}$/), clientId: text, createdAt: z.string().datetime({ offset: true }),
  ownerId: id, ownerLogin: login, origin, appName: z.string().min(1).max(34), browserAttemptId: uuid, captureAttemptId: uuid, manifestDigest: hash,
  callbackVerification: z.literal('manifest-requested-unverified'), webhookVerification: z.literal('native-url-verified') }).strict();
const evidenceSchema = z.object({ resources: z.array(z.union([
  z.object({ kind: z.literal('github-manifest-browser'), id: uuid, identity: browserIdentity }).strict(),
  z.object({ kind: z.literal('github-application'), id, identity: appIdentity }).strict(),
])).length(1), native: z.object({ operation: z.enum(['browser', 'capture']), installationId: uuid, attemptId: uuid }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = settings(intent), resource = e.resources[0];
  if (e.native.installationId !== intent.installationId || resource.identity.origin !== n.origin || resource.identity.ownerId !== n.ownerId) fail();
  if (resource.kind === 'github-manifest-browser') {
    if (e.native.operation !== 'browser' || resource.id !== intent.installationId || resource.identity.attemptId !== e.native.attemptId) fail();
  } else if (e.native.operation !== 'capture' || resource.id !== resource.identity.appId || resource.identity.appName !== n.appName
    || resource.identity.ownerLogin.toLowerCase() !== n.ownerLogin.toLowerCase() || resource.identity.captureAttemptId !== e.native.attemptId) fail();
  return e;
}
function handoff(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || +url.port < 1024 || +url.port > 65535
    || url.username || url.password || url.search || url.hash || !/^\/begin\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || url.href !== value) fail();
  return value;
}
function manifest(intent: Intent, callback: string) {
  const n = settings(intent);
  return { postUrl: n.ownerType === 'Organization' ? `https://github.com/organizations/${n.ownerLogin}/settings/apps/new` : 'https://github.com/settings/apps/new',
    manifest: { name: n.appName, description: 'Selected-repository deployment visibility and checks for this Hypercloud operator environment.', url: n.origin,
      callback_urls: [`${n.origin}/app/code-host-authorizations/github-user`, `${n.origin}/credential-authorizations/github`],
      setup_url: `${n.origin}/app/code-host-authorizations/github-installation`, redirect_url: callback,
      hook_attributes: { url: `${n.origin}/api/v1/code-host-events`, active: true }, public: true, request_oauth_on_install: false,
      default_permissions: permissions, default_events: events } };
}
async function json(request: typeof fetch, path: string, signal: AbortSignal, token?: string, post = false): Promise<Record<string, any>> {
  const budget = new DestinationBudget({ signal, deadlineMs: 30_000 });
  try {
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) fail();
    const response = await budget.wait(request(url, { method: post ? 'POST' : 'GET', redirect: 'error', signal: budget.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Hypervibe-operator-registration', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }));
    if (response.status !== (post ? 201 : 200) || response.redirected) {
      void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response', response.status);
    }
    const reader = response.body?.getReader(); if (!reader) fail('provider_error');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const next = await budget.wait(reader.read()); if (next.done) break; bytes += next.value.byteLength; if (bytes > 262_144) fail('provider_error'); chunks.push(next.value); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('provider_error'); return parsed as Record<string, any>;
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  } finally { budget.close(); }
}
function numeric(value: unknown): string { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(); return String(value); }
async function verifyOwner(request: typeof fetch, scope: z.infer<typeof scopeSchema>, signal: AbortSignal) {
  const owner = await json(request, `/${scope.ownerType === 'Organization' ? 'orgs' : 'users'}/${scope.ownerLogin}`, signal);
  if (numeric(owner.id) !== scope.ownerId || owner.type !== scope.ownerType || typeof owner.login !== 'string' || owner.login.toLowerCase() !== scope.ownerLogin.toLowerCase()) fail('ownership_mismatch');
}
function jwt(pem: string, clientId: string) {
  const key = createPrivateKey(pem); if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail();
  const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId })).toString('base64url'), data = `${header}.${payload}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}
export function createGithubOperatorApplicationDriver(options: { fetch?: typeof fetch; local?: OperatorApplicationLocalContext } = {}): CloudInstallationDriver<Intent> {
  const request = options.fetch ?? fetch;
  function store(intent: Intent) {
    const local = options.local;
    if (!local || local.projectId !== intent.appId || local.installationId !== intent.installationId || local.intentDigest !== canonicalJsonSha256(intent)) fail();
    return new OperatorCredentialCustody({ ...local, provider: 'github-app' });
  }
  async function verifyApp(context: Context) {
    const n = settings(context.intent), saved = store(context.intent).read();
    if (!saved || !saved.state.identity || !['credentials-stored', 'delivered'].includes(saved.state.phase)) fail('not_installed');
    const identity = appIdentity.parse(saved.state.identity);
    const privateKey = saved.state.credentials?.['private-key'] ?? (options.local ? await readGithubOperatorSigningKey(context.intent, options.local, context.signal) : undefined);
    if (!privateKey) fail('not_converged');
    const token = jwt(privateKey, identity.clientId), app = await json(request, '/app', context.signal, token);
    const browserAttempt = context.attempts?.find(item => item.id === identity.browserAttemptId);
    if (!browserAttempt || numeric(app.id) !== identity.appId || app.client_id !== identity.clientId || app.slug !== identity.slug || app.name !== n.appName
      || numeric(app.owner?.id) !== n.ownerId || app.owner?.type !== n.ownerType || String(app.owner?.login).toLowerCase() !== n.ownerLogin.toLowerCase()
      || app.created_at !== identity.createdAt || Date.parse(identity.createdAt) < Date.parse(browserAttempt.startedAt) - 5000
      || app.external_url !== n.origin || app.html_url !== `https://github.com/apps/${identity.slug}`
      || !isDeepStrictEqual(app.permissions, permissions) || !Array.isArray(app.events) || !isDeepStrictEqual([...app.events].sort(), [...events].sort())) fail('ownership_mismatch');
    const hook = await json(request, '/app/hook/config', context.signal, token);
    if (hook.url !== `${n.origin}/api/v1/code-host-events` || hook.content_type !== 'json' || hook.insecure_ssl !== '0') fail('identity_mismatch');
    return parseEvidence({ resources: [{ kind: 'github-application', id: identity.appId, identity }],
      native: { operation: 'capture', installationId: context.intent.installationId, attemptId: identity.captureAttemptId } }, context.intent);
  }
  async function inspect(context: Context & { action: CloudInstallationAction }) {
    try {
      const n = settings(context.intent); await verifyOwner(request, n, context.signal);
      const saved = store(context.intent).read();
      if (context.action.id === n.browserAction) {
        if (!saved) return { state: 'action-required' as const };
        if (saved.state.phase === 'awaiting-browser') {
          if (browserExpired(saved)) return { state: 'unknown' as const, reason: 'authorization_expired' as const };
          return { state: 'pending' as const, reason: 'not_converged' as const };
        }
        const browser = saved.state.browser, retained = context.completed[n.browserAction];
        if (retained) return { state: 'satisfied' as const, evidence: parseEvidence(retained, context.intent) };
        if (!browser?.formDigest) fail();
        return { state: 'satisfied' as const, evidence: parseEvidence({ resources: [{ kind: 'github-manifest-browser', id: context.intent.installationId,
          identity: { origin: n.origin, ownerId: n.ownerId, attemptId: browser.attemptId, manifestDigest: browser.formDigest } }],
          native: { operation: 'browser', installationId: context.intent.installationId, attemptId: browser.attemptId } }, context.intent) };
      }
      if (context.action.id !== n.captureAction) fail();
      if (saved?.state.phase === 'code-staged') return browserExpired(saved)
        ? { state: 'unknown' as const, reason: 'authorization_expired' as const } : { state: 'action-required' as const };
      if (saved?.state.phase === 'credentials-stored' || saved?.state.phase === 'delivered') return { state: 'satisfied' as const, evidence: await verifyApp(context) };
      return { state: 'unknown' as const, reason: 'not_converged' as const };
    } catch (error) { return { state: 'unknown' as const, reason: error instanceof CloudInstallationBoundaryError ? error.reason : 'provider_error' as const }; }
  }
  const native: CloudInstallationDriver<Intent> = { provider: 'github-app', operatorApplication: { providerName: 'github-app', parseBrowserHandoff: value => handoff(value),
    async pendingBrowser(record) {
      const saved = store(record.intent).read(); if (saved?.state.phase !== 'awaiting-browser' || !saved.state.browser || browserExpired(saved)) return undefined;
      const listener = await openOperatorAppCallback(store(record.intent), callback => manifest(record.intent, callback), options.local?.authorizeCurrent ?? (async () => false));
      return { url: handoff(listener.url), expiresAt: saved.state.browser.expiresAt,
        description: 'Keep this Hypervibe process running, open this private local link, and approve the exact GitHub App under its reviewed owner. Return for the separate code-conversion action. Finish an existing submitted registration instead of creating another.' };
    } },
    parseScope: value => scopeSchema.parse(value), parseEvidence,
    parseAction(value, intent) { const selected = actions(intent).find(item => isDeepStrictEqual(item, value)); if (!selected) fail(); return selected; },
    scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: () => [] },
    async plan(context) {
      const saved = store(context.intent).read();
      if (saved && ['awaiting-browser', 'code-staged'].includes(saved.state.phase) && browserExpired(saved)) fail('authorization_expired');
      const n = settings(context.intent); await verifyOwner(request, n, context.signal);
      return { actions: actions(context.intent), review: { resources: [{ kind: 'GitHub App', name: n.appName, scope: `${n.ownerType}:${n.ownerLogin}:${n.ownerId}` }],
        permissions: [{ principal: 'owner-approved GitHub App installation', scope: 'separately selected repositories', actions: Object.entries(permissions).map(([key, value]) => `${key}:${value}`), purpose: 'installation-verification' }], costs: [],
        warnings: [`Homepage and callback origin: ${n.origin}. The public App is installable by other accounts; repository installation remains separate.`,
          ...(context.intent.predecessor ? [`Create a new App with the reviewed new name. Previous registration ${context.intent.predecessor.installationId} remains native-state unknown; cleanup is unverified. Its history and expired private code are preserved, not retried or cancelled.`] : []),
          'Owner approval in GitHub establishes App creation authority; public account lookup alone does not.',
          'GitHub may let the owner edit the App name. Preserve the exact reviewed name; changed ownership, permissions or identity cannot be adopted.',
          'Private key, OAuth client secret and webhook secret are transiently handled and encrypted locally, then delivered to the reviewed native secret targets.',
          'REST cannot read back OAuth callback URLs. Real user authorization, repository installation and webhook delivery remain required acceptance checks.',
          'A lost one-time conversion response cannot be retried. Expired or uncertain registrations may require owner cleanup in GitHub; no undocumented deletion API is used.'] } };
    }, inspect, recover: inspect,
    async mutate(context) {
      let consumed = false;
      try {
        const n = settings(context.intent); await verifyOwner(request, n, context.signal); const custody = store(context.intent);
        if (context.action.id === n.browserAction) {
          if (custody.read()) fail(); await context.beforeMutation();
          custody.createBrowser({ attemptId: context.attempt.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            state: randomBytes(32).toString('base64url'), launch: randomBytes(32).toString('base64url') });
          const listener = await openOperatorAppCallback(custody, callback => manifest(context.intent, callback), options.local?.authorizeCurrent ?? (async () => false)); return { state: 'external', url: handoff(listener.url) };
        }
        if (context.action.id !== n.captureAction || !context.completed[n.browserAction]) fail();
        const saved = custody.read(); if (!saved || saved.state.phase !== 'code-staged' || !saved.state.browser?.formDigest) fail();
        if (browserExpired(saved)) fail('authorization_expired');
        await context.beforeMutation(); const code = custody.consumeCode(saved);
        if (!code) fail(browserExpired(saved) ? 'authorization_expired' : 'identity_mismatch'); consumed = true;
        const result = await json(request, `/app-manifests/${encodeURIComponent(code.code)}/conversions`, context.signal, undefined, true);
        const credentials = z.object({ pem: z.string().min(1).max(65_536), client_secret: z.string().min(1).max(65_536), webhook_secret: z.string().min(1).max(65_536) }).parse(result);
        const clientId = text.parse(result.client_id); jwt(credentials.pem, clientId);
        const identity = appIdentity.parse({ appId: numeric(result.id), slug: result.slug, clientId, createdAt: result.created_at, ownerId: numeric(result.owner?.id),
          ownerLogin: result.owner?.login, origin: n.origin, appName: result.name, browserAttemptId: saved.state.browser.attemptId, captureAttemptId: context.attempt.id,
          manifestDigest: saved.state.browser.formDigest, callbackVerification: 'manifest-requested-unverified', webhookVerification: 'native-url-verified' });
        const current = custody.read(); if (!current || !custody.storeCredentials(current, { 'private-key': credentials.pem, 'client-secret': credentials.client_secret, 'webhook-secret': credentials.webhook_secret }, identity)) fail();
        return { state: 'acknowledged', evidence: await verifyApp(context) };
      } catch (error) { return { state: consumed ? 'uncertain' : 'rejected', reason: error instanceof CloudInstallationBoundaryError ? error.reason : 'provider_error' }; }
    }, connections: () => [],
  };
  return withOperatorOutputDelivery(native, options.local, intent => [settings(intent).captureAction]);
}
export function createGithubOperatorApplicationCapability(): OperatorApplicationCapability {
  return { schemaVersion: 1, privateOutputRoles: ['private-key', 'client-secret', 'webhook-secret'],
    restart: {
      description: 'If the user requests a new registration, set this exact restartFrom on the same operatorApplications declaration using hv_spec, then run hv_plan and obtain approval for its new App name and actions. The previous registration remains native-state unknown with unverified cleanup; this does not cancel it or reuse its expired code.',
      eligible(record, local) {
        try {
          const n = settings(record.intent);
          if (local.projectId !== record.intent.appId || local.installationId !== record.installationId
            || local.intentDigest !== canonicalJsonSha256(record.intent) || record.status === 'scope-ready'
            || record.attempts.length !== 1 || record.attempts[0].actionId !== n.browserAction
            || Object.keys(record.completed).some(id => id !== n.browserAction)) return false;
          const saved = new OperatorCredentialCustody({ ...local, provider: 'github-app' }).read();
          return !!saved && ['awaiting-browser', 'code-staged'].includes(saved.state.phase) && browserExpired(saved)
            && saved.state.browser?.attemptId === record.attempts[0].id
            && !saved.state.credentials && !saved.state.identity && !saved.state.deliveries;
        } catch { return false; }
      },
    },
    privateVerificationRoles: { 'private-key': 'github-app-signing-key' },
    privateOutputEncodings: { 'private-key': 'base64' },
    async parseDeclaration({ name, declaration, origin }) {
      if (!isDeepStrictEqual(declaration.outputs, { 'private-key': 'GITHUB_APP_PRIVATE_KEY_BASE64', 'client-secret': 'GITHUB_APP_CLIENT_SECRET', 'webhook-secret': 'GITHUB_APP_WEBHOOK_SECRET' })) fail();
      const selected = z.object({ ownerType: z.enum(['user', 'organization']), ownerLogin: login }).strict().parse(declaration.nativeScope);
      const type = selected.ownerType === 'organization' ? 'Organization' : 'User';
      const owner = await json(fetch, `/${type === 'Organization' ? 'orgs' : 'users'}/${selected.ownerLogin}`, AbortSignal.timeout(30_000));
      if (owner.type !== type || String(owner.login).toLowerCase() !== selected.ownerLogin.toLowerCase()) fail();
      return scopeSchema.parse({ name, origin, ownerType: type, ownerLogin: owner.login, ownerId: numeric(owner.id) });
    }, parseRecord: value => parseCloudInstallationRecordV1(value, createGithubOperatorApplicationDriver()),
    async create(scope, local) { scopeSchema.parse(scope); return { driver: createGithubOperatorApplicationDriver({ local }), authentication: { kind: 'operator-application' } }; },
    receipts(record) {
      const n = settings(record.intent); if (record.status !== 'scope-ready') fail('not_converged');
      const app = parseEvidence(record.completed[n.captureAction], record.intent).resources[0];
      return [{ provider: 'github-app', ...app.identity, appUrl: `https://github.com/apps/${app.identity.slug}` }, ...operatorOutputReceipts(record.completed, record.intent)];
    },
  };
}
providerRegistry.register({ metadata: { name: 'github-app', displayName: 'GitHub operator application', category: 'identity', credentialsSchema: z.object({}).strict() },
  factory: () => { throw new Error('Use the reviewed operator application lifecycle.'); }, operatorApplication: createGithubOperatorApplicationCapability() });
