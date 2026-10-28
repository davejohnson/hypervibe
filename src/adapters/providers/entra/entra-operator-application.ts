import { DefaultAzureCredential } from '@azure/identity';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { OperatorApplicationCapability } from '../../../domain/ports/operator-application.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
const uuid = z.string().guid(), name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), text = z.string().min(1).max(2048);
const scopeSchema = z.object({ tenantId: uuid, name, origin: text.refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password; } catch { return false; } }),
  googleSubject: z.string().regex(/^[1-9][0-9]{5,30}$/), googleServiceAccount: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/) }).strict();
type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function settings(intent: Intent) {
  if (intent.applicationProvider !== 'microsoft-entra' || intent.provider !== 'microsoft-entra') fail();
  const n = scopeSchema.parse(intent.nativeScope), owner = canonicalJsonSha256([intent.customerId, intent.appId, intent.environment, intent.installationId]);
  return { ...n, owner, displayName: `Hypercloud ${n.name}`, redirectUri: `${n.origin}/cloud-authorizations/azure`,
    appAction: `microsoft-entra:${n.name}:application`, ficAction: `microsoft-entra:${n.name}:federation`, ficName: `hypervibe-${owner.slice(0, 32)}` };
}
function actions(intent: Intent): CloudInstallationAction[] {
  const n = settings(intent);
  return [{ id: n.appAction, type: 'create', resource: { kind: 'project', provider: 'microsoft-entra', name: n.displayName },
    verified: true, requiresConfirm: true, reason: 'Create only the reviewed multi-tenant browser application; do not issue a client secret.',
    metadata: { operation: 'application', category: 'identity', execution: 'api', native: {} } },
  { id: n.ficAction, type: 'create', resource: { kind: 'project', provider: 'microsoft-entra', name: n.ficName }, verified: true, requiresConfirm: true,
    dependsOn: [n.appAction], reason: 'Trust only the verified immutable Google service-account subject for browser client authentication.',
    metadata: { operation: 'federation', category: 'trust', execution: 'api', native: {} } }];
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['application', 'federation']), id: uuid,
  identity: z.object({ tenantId: uuid, applicationId: uuid, clientId: uuid, createdDateTime: z.string().datetime({ offset: true }),
    owner: z.string().regex(/^[a-f0-9]{64}$/), origin: text, googleSubject: text, attemptId: uuid }).strict() }).strict()).length(1),
  native: z.object({ operation: z.enum(['application', 'federation']), installationId: uuid, attemptId: uuid }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = settings(intent), resource = e.resources[0], identity = resource.identity;
  if (e.native.installationId !== intent.installationId || e.native.attemptId !== identity.attemptId || e.native.operation !== resource.kind
    || identity.tenantId !== n.tenantId || identity.owner !== n.owner || identity.origin !== n.origin || identity.googleSubject !== n.googleSubject
    || resource.kind === 'application' && resource.id !== identity.applicationId) fail();
  return e;
}
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
  ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const; }
const fields = 'id,appId,displayName,createdDateTime,signInAudience,web,tags,passwordCredentials,keyCredentials,requiredResourceAccess';
function sameApplicationCreationTime(observed: string, retained: string): boolean {
  if (observed === retained) return true;
  // Native Graph create ACKs include fractional seconds while both list and
  // exact-ID reads can return only the UTC second. Preserve the ACK verbatim;
  // do not round arbitrary fractions or relax other providers' lifetime checks.
  const second = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z$/.exec(observed)?.[1];
  return !!second && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/.exec(retained)?.[1] === second;
}
export function createEntraOperatorApplicationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<Intent> {
  async function withClient<T>(context: Context, work: (read: (path: string, body?: unknown) => Promise<Record<string, any>>) => Promise<T>) {
    const n = settings(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://graph.microsoft.com/.default', budget.signal));
      const call = async (path: string, body?: unknown): Promise<Record<string, any>> => {
        const url = new URL(path, 'https://graph.microsoft.com/v1.0/');
        if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password) fail();
        const request: typeof fetch = async (input, init) => {
          const response = await (options.fetch ?? fetch)(input, init);
          if (response.ok && response.status !== (body === undefined ? 200 : 201)) {
            void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response');
          }
          return response;
        };
        return destinationJson(request, budget, url.href, token, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      };
      const organization = await call('organization?$select=id');
      if (!Array.isArray(organization.value) || organization.value.length !== 1 || organization.value[0]?.id !== n.tenantId || organization['@odata.nextLink']) fail('identity_mismatch');
      return await work(call);
    } finally { budget.close(); }
  }
  async function list(call: (path: string) => Promise<Record<string, any>>, path: string) {
    const collection = new URL(path, 'https://graph.microsoft.com/v1.0/');
    const values: any[] = [], seen = new Set<string>(); let next: string | undefined = path;
    for (let page = 0; next && page < 10; page++) {
      const pageUrl = new URL(next, 'https://graph.microsoft.com/v1.0/');
      if (pageUrl.origin !== collection.origin || pageUrl.pathname !== collection.pathname || seen.has(next)) fail('not_converged'); seen.add(next);
      const result = await call(next); if (!Array.isArray(result.value)) fail('not_converged'); values.push(...result.value);
      if (values.length > 1000 || result['@odata.nextLink'] !== undefined && typeof result['@odata.nextLink'] !== 'string') fail('not_converged');
      next = result['@odata.nextLink'];
    }
    if (next) fail('not_converged'); return values;
  }
  function verifyApplication(value: any, context: Context, attempt: CloudInstallationAttempt, expected?: CloudInstallationEvidence) {
    const n = settings(context.intent);
    const id = uuid.parse(value.id), clientId = uuid.parse(value.appId), createdDateTime = z.string().datetime({ offset: true }).parse(value.createdDateTime);
    if (value.displayName !== n.displayName || value.signInAudience !== 'AzureADMultipleOrgs'
      || !isDeepStrictEqual(value.web?.redirectUris, [n.redirectUri])
      || value.web?.implicitGrantSettings?.enableAccessTokenIssuance !== false || value.web?.implicitGrantSettings?.enableIdTokenIssuance !== false
      || !isDeepStrictEqual(value.passwordCredentials, []) || !isDeepStrictEqual(value.keyCredentials, []) || !isDeepStrictEqual(value.requiredResourceAccess, [])
      || !isDeepStrictEqual(value.tags?.slice().sort(), [`hypervibe:owner:${n.owner}`, `hypervibe:attempt:${attempt.id}`].sort())) fail('ownership_mismatch');
    const evidence = parseEvidence({ resources: [{ kind: 'application', id, identity: { tenantId: n.tenantId, applicationId: id, clientId, createdDateTime,
      owner: n.owner, origin: n.origin, googleSubject: n.googleSubject, attemptId: attempt.id } }],
      native: { operation: 'application', installationId: context.intent.installationId, attemptId: attempt.id } }, context.intent);
    if (expected) {
      const retainedTime = expected.resources[0]?.identity.createdDateTime;
      if (typeof retainedTime !== 'string' || !sameApplicationCreationTime(createdDateTime, retainedTime)) fail('identity_mismatch');
      evidence.resources[0].identity.createdDateTime = retainedTime;
      if (!isDeepStrictEqual(evidence, expected)) fail('identity_mismatch');
    }
    // Evaluate the unchanged attempt-age bound only after matching all retained
    // evidence: a precision-losing read must not age the verified ACK by 1s.
    if (Date.parse(String(evidence.resources[0].identity.createdDateTime)) < Date.parse(attempt.startedAt) - 5000) fail('ownership_mismatch');
    return evidence;
  }
  async function application(context: Context, call: (path: string) => Promise<Record<string, any>>) {
    const n = settings(context.intent), attempt = context.attempts?.filter(value => value.actionId === n.appAction).at(-1);
    const acknowledged = attempt && ['acknowledged', 'succeeded'].includes(attempt.status) ? attempt.evidence : undefined;
    const evidence = context.completed[n.appAction] ?? acknowledged;
    if (evidence) {
      const retained = parseEvidence(evidence, context.intent);
      if (!attempt || retained.resources[0].kind !== 'application' || retained.native.attemptId !== attempt.id) fail();
      return verifyApplication(await call(`applications/${retained.resources[0].id}?$select=${fields}`), context, attempt, retained);
    }
    const candidates = await list(call, `applications?$filter=${encodeURIComponent(`displayName eq '${n.displayName}'`)}&$select=${fields}&$top=100`);
    if (!attempt) { if (candidates.length) fail('ownership_mismatch'); return undefined; }
    const matches = candidates.filter(candidate => Array.isArray(candidate.tags) && candidate.tags.includes(`hypervibe:attempt:${attempt.id}`));
    if (matches.length > 1) fail('ownership_mismatch');
    if (!matches.length) return undefined;
    return verifyApplication(matches[0], context, attempt);
  }
  function verifyFederation(value: any, context: Context, app: CloudInstallationEvidence, attempt: CloudInstallationAttempt) {
    const n = settings(context.intent), id = uuid.parse(value.id);
    if (value.name !== n.ficName || value.description !== `hypervibe:${n.owner}:${attempt.id}` || value.issuer !== 'https://accounts.google.com'
      || value.subject !== n.googleSubject || !isDeepStrictEqual(value.audiences, ['api://AzureADTokenExchange'])) fail('ownership_mismatch');
    return parseEvidence({ resources: [{ kind: 'federation', id, identity: { ...app.resources[0].identity, attemptId: attempt.id } }],
      native: { operation: 'federation', installationId: context.intent.installationId, attemptId: attempt.id } }, context.intent);
  }
  async function inspect(context: ActionContext) {
    return withClient(context, async call => {
      const n = settings(context.intent), app = await application(context, call), attempt = context.attempt ?? context.attempts?.filter(value => value.actionId === context.action.id).at(-1);
      if (context.action.id === n.appAction) return app ? { state: 'satisfied' as const, evidence: app }
        : attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      if (context.action.id !== n.ficAction || !app) fail('not_installed');
      const values = await list(call, `applications/${app.resources[0].id}/federatedIdentityCredentials`);
      if (!attempt || attempt.status === 'rejected') { if (values.length) fail('ownership_mismatch'); return { state: 'action-required' as const }; }
      const matches = values.filter(value => value.name === n.ficName);
      if (matches.length > 1) fail('ownership_mismatch'); if (!matches.length) return { state: 'pending' as const, reason: 'not_converged' as const };
      const evidence = verifyFederation(matches[0], context, app, attempt), expected = context.completed[n.ficAction];
      if (expected && !isDeepStrictEqual(evidence, expected)) fail('identity_mismatch');
      return { state: 'satisfied' as const, evidence };
    });
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: 'microsoft-entra', operatorApplication: { providerName: 'microsoft-entra' },
    scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: record => [{ kind: 'application', name: settings(record.intent).displayName, scope: record.intent.nativeScope.tenantId }] },
    parseScope: value => scopeSchema.parse(value), parseEvidence,
    parseAction(value, intent) { const found = actions(intent).find(action => isDeepStrictEqual(action, value)); if (!found) fail(); return found; },
    async plan(context) {
      try { await withClient(context, call => application(context, call)); } catch (error) { throw new CloudInstallationBoundaryError(reason(error)); }
      const n = settings(context.intent);
      return { actions: actions(context.intent), review: { resources: [{ kind: 'application', name: n.displayName, scope: n.tenantId }, { kind: 'federatedIdentityCredential', name: n.googleServiceAccount, scope: n.googleSubject }],
        permissions: [{ principal: 'current transient Graph caller', scope: n.tenantId, actions: ['Application.ReadWrite.All', 'Organization.Read.All'], purpose: 'installation-verification' }], costs: [],
        warnings: [`Browser callback: ${n.redirectUri}. Customer cloud installation remains separately authorized.`,
          'Native tenant reads verify the selected tenant; tenant policy can still reject application creation or trust management. A rejected write is reported without a retry.',
          'The registration issues no client secret. A live multi-tenant browser exchange remains required before declaring compatibility.'] } };
    },
    async inspect(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let started = false;
      try { return await withClient(context, async call => {
        const n = settings(context.intent), app = await application(context, call);
        if (context.action.id === n.appAction) {
          if (app) fail('ownership_mismatch');
          await context.beforeMutation(); started = true;
          const result = await call('applications', { displayName: n.displayName, signInAudience: 'AzureADMultipleOrgs',
            tags: [`hypervibe:owner:${n.owner}`, `hypervibe:attempt:${context.attempt.id}`], requiredResourceAccess: [],
            web: { redirectUris: [n.redirectUri], implicitGrantSettings: { enableAccessTokenIssuance: false, enableIdTokenIssuance: false } } });
          return { state: 'acknowledged' as const, evidence: verifyApplication(result, context, context.attempt) };
        }
        if (context.action.id !== n.ficAction || !app) fail('not_installed');
        const current = await list(call, `applications/${app.resources[0].id}/federatedIdentityCredentials`); if (current.length) fail('ownership_mismatch');
        await context.beforeMutation(); started = true;
        const result = await call(`applications/${app.resources[0].id}/federatedIdentityCredentials`, { name: n.ficName,
          description: `hypervibe:${n.owner}:${context.attempt.id}`, issuer: 'https://accounts.google.com', subject: n.googleSubject, audiences: ['api://AzureADTokenExchange'] });
        return { state: 'acknowledged' as const, evidence: verifyFederation(result, context, app, context.attempt) };
      }); } catch (error) { return { state: !started || error instanceof DestinationBoundaryError && [400, 401, 403, 409, 422].includes(error.status ?? 0) ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}
export function createEntraOperatorApplicationCapability(): OperatorApplicationCapability {
  return { schemaVersion: 1,
    parseDeclaration({ name, declaration, origin, runtimeIdentity }) {
      const selected = z.object({ tenantId: uuid }).strict().parse(declaration.nativeScope);
      if (declaration.provider !== 'microsoft-entra' || declaration.profile !== 'hypercloud-connect-v1' || runtimeIdentity.kind !== 'gcp-service-account') fail();
      return scopeSchema.parse({ ...selected, name, origin, googleSubject: runtimeIdentity.serviceAccountUniqueId, googleServiceAccount: runtimeIdentity.serviceAccountEmail });
    }, parseRecord: value => parseCloudInstallationRecordV1(value, createEntraOperatorApplicationDriver()),
    async create(value) {
      const scope = scopeSchema.parse(value), credential = new DefaultAzureCredential({ tenantId: scope.tenantId });
      return { driver: createEntraOperatorApplicationDriver(), authentication: { kind: 'operator-application', administrator: { async getAccessToken(requested, signal) {
        if (requested !== 'https://graph.microsoft.com/.default' || signal.aborted) fail('authorization_expired');
        try { const access = await credential.getToken(requested, { tenantId: scope.tenantId, abortSignal: signal });
          if (!access?.token || access.expiresOnTimestamp <= Date.now() + 60_000) fail('authorization_expired'); return access.token;
        } catch { fail('authorization_expired'); }
      } } } };
    }, receipts(record) {
      const n = settings(record.intent); if (record.status !== 'scope-ready') fail('not_converged');
      const app = parseEvidence(record.completed[n.appAction], record.intent).resources[0];
      const fic = parseEvidence(record.completed[n.ficAction], record.intent).resources[0];
      return [{ provider: 'microsoft-entra', tenantId: n.tenantId, applicationId: app.id, clientId: app.identity.clientId, federationId: fic.id,
        callback: n.redirectUri, clientAuthentication: 'google-workload-identity', googleSubject: n.googleSubject, browserExchange: 'unverified' }];
    },
  };
}
providerRegistry.register({ metadata: { name: 'microsoft-entra', displayName: 'Microsoft Entra operator application', category: 'identity', credentialsSchema: z.object({}).strict() },
  factory: () => { throw new Error('Use the reviewed operator application lifecycle.'); }, operatorApplication: createEntraOperatorApplicationCapability() });
