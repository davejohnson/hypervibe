import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type CloudInstallationRecord, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { OperatorApplicationCapability } from '../../../domain/ports/operator-application.port.js';
import { OperatorCredentialCustody } from '../../../domain/services/operator-credential-custody.js';
import { operatorOutputReceipts, withOperatorOutputDelivery } from '../../../domain/services/operator-output-delivery.js';
import { parseCloudInstallationRecordV1, historicalInstallationEvidence } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';

const PROVIDER = 'google-recaptcha' as const, API = 'recaptchaenterprise.googleapis.com';
const uuid = z.string().guid(), projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), number = z.string().regex(/^[1-9][0-9]{5,19}$/);
const text = z.string().min(1).max(2048), timestamp = z.string().datetime({ offset: true });
const scopeSchema = z.object({ projectId, projectNumber: number, name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  origin: text.refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !u.port; } catch { return false; } }),
}).strict();
type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const permissions = ['serviceusage.services.get', 'serviceusage.services.enable', 'recaptchaenterprise.keys.create',
  'recaptchaenterprise.keys.list', 'recaptchaenterprise.keys.get', 'recaptchaenterprise.keys.retrievelegacysecretkey'];
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function settings(intent: Intent) {
  if (intent.provider !== PROVIDER || intent.applicationProvider !== PROVIDER) fail();
  const n = scopeSchema.parse(intent.nativeScope), owner = canonicalJsonSha256([intent.customerId, intent.appId, intent.environment, intent.installationId]).slice(0, 63);
  return { ...n, owner, hostname: new URL(n.origin).hostname, displayName: `Hypercloud ${n.name}`, keyRoot: `projects/${n.projectNumber}/keys`,
    apiName: `projects/${n.projectNumber}/services/${API}`, apiAction: `${PROVIDER}:${n.name}:api`, keyAction: `${PROVIDER}:${n.name}:key`, captureAction: `${PROVIDER}:${n.name}:capture` };
}
function actions(intent: Intent): CloudInstallationAction[] {
  const n = settings(intent);
  return [{ id: n.apiAction, type: 'update', resource: { kind: 'project', provider: PROVIDER, name: n.apiName }, verified: true, requiresConfirm: true,
    reason: 'Enable only the reviewed CAPTCHA API; Google may create its service identity. Existing enabled APIs remain unchanged.',
    metadata: { operation: 'api', category: 'scope', execution: 'api', native: {} } },
  { id: n.keyAction, type: 'create', resource: { kind: 'project', provider: PROVIDER, name: n.displayName }, verified: true, requiresConfirm: true,
    dataBearing: true, dependsOn: [n.apiAction], reason: 'Allocate a separate score key restricted to the verified operator hostname; preserve all existing keys.',
    metadata: { operation: 'key', category: 'identity', execution: 'api', native: {} } },
  { id: n.captureAction, type: 'update', resource: { kind: 'secret', provider: PROVIDER, name: `${n.name}/secret-key` }, verified: true, requiresConfirm: true,
    dataBearing: true, dependsOn: [n.keyAction], reason: 'Read the exact new key’s retrievable legacy credential directly into encrypted private custody; return no value and perform no deployment.',
    metadata: { operation: 'capture', category: 'verification', execution: 'api', native: {} } }];
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['api', 'key', 'capture']), id: text,
  identity: z.object({ projectId, projectNumber: number, origin: text, keyName: text.optional(), createTime: timestamp.optional(),
    owner: z.string().regex(/^[a-f0-9]{63}$/).optional(), attemptId: uuid.optional() }).strict() }).strict()).length(1),
  native: z.object({ operation: z.enum(['api', 'key', 'capture']), installationId: uuid }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = settings(intent), r = e.resources[0], i = r.identity;
  if (e.native.installationId !== intent.installationId || e.native.operation !== r.kind || i.projectId !== n.projectId || i.projectNumber !== n.projectNumber || i.origin !== n.origin) fail();
  if (r.kind === 'api') {
    if (r.id !== n.apiName || i.keyName || i.createTime || i.owner || i.attemptId) fail();
  } else if (!i.keyName || !keyNameMatches(i.keyName, n)
    || r.id !== i.keyName || !i.createTime || i.owner !== n.owner || !i.attemptId) fail();
  return e;
}
function keyNameMatches(value: unknown, n: { projectId: string; projectNumber: string }): value is string {
  return typeof value === 'string' && new RegExp(`^projects/(?:${n.projectNumber}|${n.projectId})/keys/[A-Za-z0-9_-]{1,200}$`).test(value);
}
function custodyIdentity(e: CloudInstallationEvidence) {
  const i = e.resources[0].identity;
  return { keyName: i.keyName, createTime: i.createTime, siteKey: i.keyName.split('/').at(-1)!, origin: i.origin };
}
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
  ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const; }

export function createGcpOperatorRecaptchaDriver(options: { fetch?: typeof fetch; custody?: OperatorCredentialCustody } = {}): CloudInstallationDriver<Intent> {
  async function withClient<T>(context: Context, work: (call: (url: string, body?: unknown) => Promise<Record<string, any>>) => Promise<T>) {
    const n = settings(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const call = async (url: string, body?: unknown): Promise<Record<string, any>> => {
        const u = new URL(url);
        if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !['cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', API].includes(u.hostname)) fail();
        const request: typeof fetch = async (input, init) => {
          const response = await (options.fetch ?? fetch)(input, init);
          if (response.ok && response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); }
          return response;
        };
        const value = await destinationJson(request, budget, url, token, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
        // Generated credentials are consumed privately below. Never allow token echoes into identity metadata.
        if (JSON.stringify(value).includes(token)) throw new DestinationBoundaryError('invalid_response');
        return value;
      };
      const project = await call(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}`);
      if (project.name !== `projects/${n.projectNumber}` || project.projectId !== n.projectId || project.state !== 'ACTIVE') fail('identity_mismatch');
      return await work(call);
    } finally { budget.close(); }
  }
  async function api(context: Context, call: (url: string) => Promise<Record<string, any>>) {
    const n = settings(context.intent), value = await call(`https://serviceusage.googleapis.com/v1/${n.apiName}`);
    if (value.name !== n.apiName || !['ENABLED', 'DISABLED'].includes(value.state)) fail('not_converged');
    return value.state === 'ENABLED';
  }
  function apiEvidence(intent: Intent) {
    const n = settings(intent);
    return parseEvidence({ resources: [{ kind: 'api', id: n.apiName, identity: { projectId: n.projectId, projectNumber: n.projectNumber, origin: n.origin } }],
      native: { operation: 'api', installationId: intent.installationId } }, intent);
  }
  async function inventory(context: Context, call: (url: string) => Promise<Record<string, any>>) {
    const n = settings(context.intent), values: any[] = [], tokens = new Set<string>(); let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`https://${API}/v1/${n.keyRoot}`); url.searchParams.set('pageSize', '100'); if (pageToken) url.searchParams.set('pageToken', pageToken);
      const value = await call(url.href), keys = value.keys ?? [];
      if (!Array.isArray(keys) || keys.some(key => !key || typeof key !== 'object' || typeof key.name !== 'string'
        || !keyNameMatches(key.name, n))
        || value.nextPageToken !== undefined && typeof value.nextPageToken !== 'string') fail('not_converged');
      values.push(...keys); if (values.length > 1000 || new Set(values.map(key => key.name)).size !== values.length) fail('ownership_mismatch');
      pageToken = value.nextPageToken || undefined; if (!pageToken) return values;
      if (tokens.has(pageToken)) fail('not_converged'); tokens.add(pageToken);
    }
    fail('not_converged');
  }
  function verifyKey(value: any, context: Context, attempt: CloudInstallationAttempt, expected?: CloudInstallationEvidence) {
    const n = settings(context.intent), createTime = timestamp.parse(value.createTime), w = value.webSettings;
    if (!keyNameMatches(value.name, n) || value.displayName !== n.displayName
      || !isDeepStrictEqual(value.labels, { 'hv-owner': n.owner, 'hv-attempt': attempt.id })
      || !w || w.integrationType !== 'SCORE' || !isDeepStrictEqual(w.allowedDomains, [n.hostname])
      || ![undefined, null, false].includes(w.allowAllDomains) || ![undefined, null, false].includes(w.allowAmpTraffic)
      || w.challengeSettings != null || ![undefined, null, 'CHALLENGE_SECURITY_PREFERENCE_UNSPECIFIED'].includes(w.challengeSecurityPreference)
      || value.testingOptions != null || value.wafSettings != null || value.androidSettings != null || value.iosSettings != null || value.expressSettings != null || value.universalSettings != null
      || Date.parse(createTime) < Date.parse(attempt.startedAt) - 5000 || Date.parse(createTime) > Date.now() + 5000) fail('ownership_mismatch');
    const e = parseEvidence({ resources: [{ kind: 'key', id: value.name, identity: { projectId: n.projectId, projectNumber: n.projectNumber, origin: n.origin,
      keyName: value.name, createTime, owner: n.owner, attemptId: attempt.id } }], native: { operation: 'key', installationId: context.intent.installationId } }, context.intent);
    if (expected && !isDeepStrictEqual(expected, e)) fail('identity_mismatch'); return e;
  }
  async function key(context: Context, call: (url: string) => Promise<Record<string, any>>) {
    const n = settings(context.intent), expected = context.completed[n.keyAction], attempt = context.attempts?.filter(a => a.actionId === n.keyAction).at(-1);
    if (expected) {
      const retained = parseEvidence(expected, context.intent); if (!attempt) fail();
      return verifyKey(await call(`https://${API}/v1/${retained.resources[0].id}`), context, attempt, retained);
    }
    const all = await inventory(context, call), owned = all.filter(k => k.labels?.['hv-owner'] === n.owner);
    if (!attempt || attempt.status === 'rejected') { if (owned.length) fail('ownership_mismatch'); return undefined; }
    const matches = owned.filter(k => k.labels?.['hv-attempt'] === attempt.id);
    if (owned.length !== matches.length || matches.length > 1) fail('ownership_mismatch');
    return matches.length ? verifyKey(matches[0], context, attempt) : undefined;
  }
  function captured(context: Context, e: CloudInstallationEvidence) {
    if (!options.custody) fail('not_installed');
    const snapshot = options.custody.read(); if (!snapshot) return undefined;
    if (!isDeepStrictEqual(snapshot.state.identity, custodyIdentity(e)) || !['credentials-stored', 'delivered'].includes(snapshot.state.phase)
      || snapshot.state.phase === 'credentials-stored' && !snapshot.state.credentials?.['secret-key']) fail('ownership_mismatch');
    return parseEvidence({ resources: [{ ...e.resources[0], kind: 'capture' }], native: { operation: 'capture', installationId: context.intent.installationId } }, context.intent);
  }
  async function inspect(context: ActionContext) {
    return withClient(context, async call => {
      const n = settings(context.intent), enabled = await api(context, call), attempt = context.attempt ?? context.attempts?.filter(a => a.actionId === context.action.id).at(-1);
      if (context.action.id === n.apiAction) return enabled ? { state: 'satisfied' as const, evidence: apiEvidence(context.intent) }
        : attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      if (!enabled) return { state: 'pending' as const, reason: 'not_installed' as const };
      const e = await key(context, call);
      if (context.action.id === n.keyAction) return e ? { state: 'satisfied' as const, evidence: e }
        : attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      if (context.action.id !== n.captureAction || !e) fail('not_installed');
      const capturedEvidence = captured(context, e);
      return capturedEvidence ? { state: 'satisfied' as const, evidence: capturedEvidence }
        : attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
    });
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: PROVIDER, operatorApplication: { providerName: PROVIDER }, parseScope: value => scopeSchema.parse(value), parseEvidence,
    scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: record => [{ kind: 'recaptcha-key', name: settings(record.intent).displayName, scope: record.intent.nativeScope.projectNumber }] },
    parseAction(value, intent) { const found = actions(intent).find(action => isDeepStrictEqual(value, action)); if (!found) fail(); return found; },
    async plan(context) {
      try { await withClient(context, async call => {
        const n = settings(context.intent), granted = await call(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`, { permissions });
        if (!Array.isArray(granted.permissions) || !permissions.every(p => granted.permissions.includes(p))) fail('insufficient_permissions');
        if (await api(context, call)) await key(context, call);
      }); } catch (error) { throw new CloudInstallationBoundaryError(reason(error)); }
      const n = settings(context.intent);
      return { actions: actions(context.intent), review: { resources: [{ kind: 'api', name: API, scope: n.projectNumber }, { kind: 'recaptcha-key', name: n.displayName, scope: n.projectNumber }],
        permissions: [{ principal: 'Transient local Google administrator', scope: n.projectNumber, actions: permissions, purpose: 'installation-verification' }],
        costs: [{ resource: n.displayName, description: 'Assessments are metered; the first 10,000 monthly assessments share the organization free allowance. 10,001–100,000 costs US$8/month, then US$1 per 1,000. No hard spending cap.', pricingUrl: 'https://cloud.google.com/security/products/recaptcha' }],
        warnings: [`Exact allowed hostname: ${n.hostname}. SCORE only; no fixed testing score, wildcard domain, or change to existing keys.`,
          'API enablement may create Google service identities and grant roles. Key creation returns a fresh native identity; no request-id or client-selected key ID is supported. Uncertain allocation is inspected without another create.',
          'Encrypted private capture is separate from delivery and deployment. Browser token verification remains untested until the live walkthrough.'] } };
    },
    async inspect(context) { try { driver.parseAction(context.action, context.intent); return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { driver.parseAction(context.action, context.intent); return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let started = false;
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async call => {
        const n = settings(context.intent);
        if (context.action.id === n.apiAction) {
          if (await api(context, call)) fail('not_converged'); await context.beforeMutation(); started = true;
          const result = await call(`https://serviceusage.googleapis.com/v1/${n.apiName}:enable`, {});
          if (typeof result.name !== 'string' || !/^operations\/[A-Za-z0-9._~-]{1,255}$/.test(result.name)) fail('not_converged');
          return { state: 'acknowledged' as const };
        }
        if (!await api(context, call)) fail('not_installed');
        const e = await key(context, call);
        if (context.action.id === n.keyAction) {
          if (e) fail('ownership_mismatch'); await context.beforeMutation(); started = true;
          const value = await call(`https://${API}/v1/${n.keyRoot}`, { displayName: n.displayName,
            labels: { 'hv-owner': n.owner, 'hv-attempt': context.attempt.id },
            webSettings: { integrationType: 'SCORE', allowedDomains: [n.hostname], allowAllDomains: false, allowAmpTraffic: false } });
          return { state: 'acknowledged' as const, evidence: verifyKey(value, context, context.attempt) };
        }
        if (context.action.id !== n.captureAction || !e || !options.custody || captured(context, e)) fail('not_installed');
        await context.beforeMutation();
        const value = await call(`https://${API}/v1/${e.resources[0].id}:retrieveLegacySecretKey`);
        // The published legacy-secret field is opaque text, not a documented token grammar.
        const privateValue = z.string().min(1).max(65_536).refine(value => !value.includes('\0')).parse(value.legacySecretKey);
        started = true;
        if (!options.custody.storeCredentials(null, { 'secret-key': privateValue }, custodyIdentity(e))) fail('not_converged');
        return { state: 'acknowledged' as const, evidence: captured(context, e)! };
      }); } catch (error) { return { state: !started || error instanceof DestinationBoundaryError && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0) ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}

export function createGcpOperatorRecaptchaCapability(): OperatorApplicationCapability {
  const dependencies = (intent: Intent) => [settings(intent).captureAction];
  return { schemaVersion: 1, privateOutputRoles: ['secret-key'],
    parseDeclaration({ name, declaration, origin, runtimeIdentity }) {
      const n = z.object({ projectId, projectNumber: number }).strict().parse(declaration.nativeScope);
      if (declaration.provider !== PROVIDER || declaration.profile !== 'hypercloud-connect-v1' || runtimeIdentity.kind !== 'gcp-service-account'
        || runtimeIdentity.projectId !== n.projectId || runtimeIdentity.projectNumber !== n.projectNumber) fail();
      return scopeSchema.parse({ ...n, name, origin });
    }, parseRecord: value => parseCloudInstallationRecordV1(value, (value as CloudInstallationRecord<Intent>)?.intent?.mode === 'retire'
      ? createGcpRecaptchaRetirementDriver() : withOperatorOutputDelivery(createGcpOperatorRecaptchaDriver(), undefined, dependencies)),
    retirement: { async create(value, _context, targets) {
      const n = scopeSchema.parse(value), auth = new GcpLocalDefaultAuthentication(n.projectId); await auth.initialize();
      return { driver: createGcpRecaptchaRetirementDriver({ targets, fetch: auth.request.bind(auth) }),
        authentication: googleOperatorAuthentication(auth) };
    } },
    async create(value, context) {
      if (!context) fail('not_installed');
      const n = scopeSchema.parse(value), custody = new OperatorCredentialCustody({ ...context, provider: PROVIDER });
      const auth = new GcpLocalDefaultAuthentication(n.projectId); await auth.initialize();
      return { driver: withOperatorOutputDelivery(createGcpOperatorRecaptchaDriver({ custody, fetch: auth.request.bind(auth) }), context, dependencies),
        authentication: googleOperatorAuthentication(auth) };
    }, receipts(record) {
      const n = settings(record.intent); if (record.status !== 'scope-ready') fail('not_converged');
      const e = parseEvidence(record.completed[n.keyAction], record.intent); parseEvidence(record.completed[n.captureAction], record.intent);
      const delivered = operatorOutputReceipts(record.completed, record.intent);
      if (record.intent.outputs?.destinations.length !== 1 || record.intent.outputs.destinations[0].role !== 'secret-key'
        || delivered.length !== 1 || delivered[0].role !== 'secret-key') fail('not_converged');
      return [{ provider: PROVIDER, ...custodyIdentity(e), projectId: n.projectId, projectNumber: n.projectNumber, integrationType: 'SCORE',
        privateCredential: 'delivered', browserVerification: 'unverified' }, ...delivered];
    },
  };
}
providerRegistry.register({ metadata: { name: PROVIDER, displayName: 'Google reCAPTCHA operator key', category: 'identity', credentialsSchema: z.object({}).strict() },
  factory: () => { throw new Error('Use the reviewed operator application lifecycle.'); }, operatorApplication: createGcpOperatorRecaptchaCapability() });

/** Delete only the completed key's exact native lifetime. API enablement,
 * encrypted custody and delivered secret versions have separate lifecycles. */
export function createGcpRecaptchaRetirementDriver(options: { fetch?: typeof fetch; targets?: CloudInstallationRecord<Intent>[] } = {}): CloudInstallationDriver<Intent> {
  const setup = withOperatorOutputDelivery(createGcpOperatorRecaptchaDriver(), undefined, intent => [settings(intent).captureAction]);
  const identity = z.object({ projectId, projectNumber: number, origin: text, keyName: text, createTime: timestamp,
    owner: z.string().regex(/^[a-f0-9]{63}$/), attemptId: uuid }).strict();
  const targetSchema = z.object({ sourceInstallationId: uuid, identity }).strict(); type Target = z.infer<typeof targetSchema>;
  const retained = options.targets?.map(raw => parseCloudInstallationRecordV1(raw, setup));
  function target(value: unknown, intent: Intent): Target {
    const t = targetSchema.parse(value), n = scopeSchema.parse(intent.nativeScope);
    if (intent.mode !== 'retire' || intent.retirement?.resources !== 'delete-owned' || intent.retirement.data !== 'retain'
      || !intent.retirement.targets.some(v => v.installationId === t.sourceInstallationId) || t.identity.projectId !== n.projectId
      || t.identity.projectNumber !== n.projectNumber || t.identity.origin !== n.origin || !keyNameMatches(t.identity.keyName, n)) fail(); return t;
  }
  function targets(intent: Intent): Target[] {
    if (!retained || retained.length !== intent.retirement?.targets.length) fail();
    return intent.retirement.targets.map(reference => {
      const r = retained.find(r => r.installationId === reference.installationId), historical = r && historicalInstallationEvidence(r);
      if (!r || !historical || r.intent.mode !== 'connect' || r.plan.digest !== reference.planDigest || canonicalJsonSha256(historical) !== reference.evidenceDigest
        || !isDeepStrictEqual(r.intent.nativeScope, intent.nativeScope) || r.intent.appId !== intent.appId || r.intent.customerId !== intent.customerId
        || r.intent.environment !== intent.environment || r.intent.source.repository !== intent.source.repository) fail();
      const e = parseEvidence(historical[settings(r.intent).keyAction], r.intent);
      parseEvidence(historical[settings(r.intent).captureAction], r.intent);
      return target({ sourceInstallationId: r.installationId, identity: e.resources[0].identity }, intent);
    });
  }
  function action(t: Target, intent: Intent): CloudInstallationAction {
    return { id: `${PROVIDER}:${intent.nativeScope.name}:retire:${t.sourceInstallationId}`, type: 'destroy',
      resource: { kind: 'project', provider: PROVIDER, name: t.identity.keyName }, verified: true, requiresConfirm: true, dataBearing: true,
      reason: 'Delete only the retained dedicated CAPTCHA key. Preserve unrelated keys, the enabled API, project and separately managed secret containers.',
      metadata: { operation: 'retire-recaptcha-key', category: 'identity', execution: 'api', native: t } };
  }
  function parseAction(value: unknown, intent: Intent) {
    if (intent.mode !== 'retire') return setup.parseAction(value, intent);
    const t = target((value as CloudInstallationAction)?.metadata?.native, intent), expected = action(t, intent);
    if (!isDeepStrictEqual(value, expected) || retained && !targets(intent).some(v => isDeepStrictEqual(v, t))) fail(); return expected;
  }
  const removedSchema = z.object({ resources: z.array(z.object({ kind: z.literal('key'), id: text, identity }).strict()).length(1),
    native: z.object({ operation: z.literal('retire-recaptcha-key'), installationId: uuid, sourceInstallationId: uuid,
      retirement: z.object({ outcome: z.literal('removed'), retained: z.tuple([]) }).strict() }).strict() }).strict();
  function evidence(value: unknown, intent: Intent): CloudInstallationEvidence {
    if (intent.mode !== 'retire') return setup.parseEvidence(value, intent);
    const e = removedSchema.parse(value), t = target({ sourceInstallationId: e.native.sourceInstallationId, identity: e.resources[0].identity }, intent);
    if (e.native.installationId !== intent.installationId || e.resources[0].id !== t.identity.keyName
      || retained && !targets(intent).some(v => isDeepStrictEqual(v, t))) fail(); return e;
  }
  function removed(t: Target, intent: Intent) { return evidence({ resources: [{ kind: 'key', id: t.identity.keyName, identity: t.identity }],
    native: { operation: 'retire-recaptcha-key', installationId: intent.installationId, sourceInstallationId: t.sourceInstallationId, retirement: { outcome: 'removed', retained: [] } } }, intent); }
  async function client<T>(context: Context, mutation: boolean, work: (call: (method: 'GET' | 'DELETE', url: string) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
    const selected = targets(context.intent), n = scopeSchema.parse(context.intent.nativeScope), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      if (!token || token.length > 65_536 || /[\r\n\0]/.test(token)) fail('authorization_expired');
      const projectUrl = `https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}`;
      const permissionUrl = `${projectUrl}:testIamPermissions`;
      const required = ['recaptchaenterprise.keys.get', ...(mutation ? ['recaptchaenterprise.keys.delete'] : [])];
      const call = async (method: 'GET' | 'DELETE' | 'POST', url: string) => {
        if (!(method === 'GET' && url === projectUrl) && !(method === 'POST' && url === permissionUrl)
          && !(method !== 'POST' && selected.some(t => url === `https://${API}/v1/${t.identity.keyName}`))) fail();
        const request: typeof fetch = async (input, init) => {
          const response = await budget.wait((options.fetch ?? fetch)(input, init));
          if (response.ok && response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); } return response;
        };
        const value = await destinationJson(request, budget, url, token, { method, ...(method === 'POST' ? { body: JSON.stringify({ permissions: required }) } : {}) });
        if (JSON.stringify(value).includes(token)) fail('identity_mismatch');
        if (method === 'DELETE' && Object.keys(value).length !== 0) fail('not_converged'); return value;
      };
      const project = await call('GET', projectUrl);
      if (project.name !== `projects/${n.projectNumber}` || project.projectId !== n.projectId || project.state !== 'ACTIVE') fail();
      const permissions = (await call('POST', permissionUrl)).permissions;
      if (!Array.isArray(permissions) || !required.every(p => permissions.includes(p))) fail('insufficient_permissions');
      return await work(call);
    } finally { budget.close(); }
  }
  async function present(call: (method: 'GET' | 'DELETE', url: string) => Promise<Record<string, unknown>>, t: Target) {
    let key;
    try { key = await call('GET', `https://${API}/v1/${t.identity.keyName}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return false; throw error; }
    if (key.name !== t.identity.keyName || key.createTime !== t.identity.createTime
      || !isDeepStrictEqual(key.labels, { 'hv-owner': t.identity.owner, 'hv-attempt': t.identity.attemptId })) fail('ownership_mismatch'); return true;
  }
  async function inspect(context: ActionContext) {
    parseAction(context.action, context.intent); const t = target(context.action.metadata.native, context.intent);
    return client(context, false, async call => !await present(call, t) ? { state: 'satisfied' as const, evidence: removed(t, context.intent) }
      : context.attempt || context.attempts?.some(a => a.actionId === context.action.id && a.status !== 'rejected')
        ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const });
  }
  const driver: CloudInstallationDriver<Intent> = { provider: PROVIDER, operatorApplication: { providerName: PROVIDER }, operatorRetirement: { schemaVersion: 1 }, scopePreparation: setup.scopePreparation,
    parseScope: value => scopeSchema.parse(value), parseAction, parseEvidence: evidence,
    async plan(context) {
      const selected = targets(context.intent); await client(context, true, async call => { for (const t of selected) await present(call, t); });
      return { actions: selected.map(t => action(t, context.intent)), review: {
        resources: selected.map(t => ({ kind: 'recaptcha-key', name: t.identity.keyName, scope: t.identity.projectNumber })),
        permissions: [{ principal: 'Current scoped Google administrator', scope: context.intent.nativeScope.projectNumber, actions: ['resourcemanager.projects.get', 'recaptchaenterprise.keys.get', 'recaptchaenterprise.keys.delete'], purpose: 'installation-verification' }],
        costs: [{ resource: 'Dedicated CAPTCHA key', description: 'No assessments are run. Retained project resources and separately managed secret storage continue to incur their usual charges.', pricingUrl: 'https://cloud.google.com/security/products/recaptcha' }],
        warnings: ['This key stops accepting future CAPTCHA use; remove its reviewed application consumers before deletion.', 'The delete API has no etag or lifetime precondition; external concurrent changes cannot be excluded.', 'The project, enabled API, unrelated keys and delivered secret containers/versions remain unchanged.'] } };
    },
    async inspect(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let started = false;
      try { parseAction(context.action, context.intent); const t = target(context.action.metadata.native, context.intent);
        return await client(context, true, async call => {
          if (!await present(call, t)) return { state: 'acknowledged' as const, evidence: removed(t, context.intent) };
          await context.beforeMutation(); started = true; await call('DELETE', `https://${API}/v1/${t.identity.keyName}`);
          return { state: 'acknowledged' as const };
        });
      } catch (error) { return { state: !started || error instanceof DestinationBoundaryError && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0) ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}

function googleOperatorAuthentication(auth: GcpLocalDefaultAuthentication) {
  return { kind: 'operator-application' as const, administrator: { async getAccessToken(scope: string, signal: AbortSignal) {
    if (scope !== 'https://www.googleapis.com/auth/cloud-platform' || signal.aborted) fail('authorization_expired'); return auth.token();
  } } };
}
