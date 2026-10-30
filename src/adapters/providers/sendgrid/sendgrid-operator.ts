import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ProjectRepository } from '../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { getProjectScopeHints } from '../../../domain/services/project-scope.js';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { OperatorApplicationCapability } from '../../../domain/ports/operator-application.port.js';
import { OperatorCredentialCustody } from '../../../domain/services/operator-credential-custody.js';
import { operatorOutputReceipts, withOperatorOutputDelivery } from '../../../domain/services/operator-output-delivery.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { SendGridAdapter } from './sendgrid.adapter.js';
import { verifySendGridRuntimeMail } from './sendgrid-runtime-mail.js';

const PROVIDER = 'sendgrid' as const, ROOT = 'https://api.sendgrid.com', uuid = z.string().guid(), nativeId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const selectionSchema = z.object({ connectionId: uuid, accountId: z.string().regex(/^[1-9][0-9]{0,15}$/), sender: z.email().max(320), recipient: z.email().max(320) }).strict();
const scopeSchema = selectionSchema.extend({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), origin: z.string().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !u.port; } catch { return false; }
}) }).strict();
type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
const permissions = ['api_keys.create', 'api_keys.read', 'api_keys.delete', 'user.username.read'];
// The pinned API-key response includes these provider requirement flags;
// Twilio documents automatic sender verification / 2FA requirements. They
// are not additional application permissions. Never request them or accept
// arbitrary extra scopes (including exemptions) as a send-only credential.
const requirementFlags = new Set(['sender_verification_eligible', 'sender_verification_legacy', '2fa_required']);
function sendOnlyScopes(value: unknown): boolean {
  return Array.isArray(value) && new Set(value).size === value.length && value.includes('mail.send')
    && value.every(scope => scope === 'mail.send' || typeof scope === 'string' && requirementFlags.has(scope));
}
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function settings(intent: Intent) {
  if (intent.provider !== PROVIDER || intent.applicationProvider !== PROVIDER) fail();
  const n = scopeSchema.parse(intent.nativeScope), tag = canonicalJsonSha256([intent.appId, intent.environment, intent.installationId]).slice(0, 12);
  return { ...n, keyName: `Hypervibe ${n.name} ${tag}`, actionId: `${PROVIDER}:${n.name}:key` };
}
function action(intent: Intent): CloudInstallationAction {
  const n = settings(intent);
  return { id: n.actionId, type: 'create', resource: { kind: 'secret', provider: PROVIDER, name: n.keyName }, verified: true, requiresConfirm: true, dataBearing: true,
    reason: 'Create one separate mail.send-only key, verify its exact account and sender, validate a fixed no-delivery sandbox request, and encrypt the one-time value. On private-capture failure, clean up only the acknowledged new key.',
    metadata: { operation: 'runtime-mail-key', category: 'identity', execution: 'api', native: {} } };
}
const identitySchema = z.object({ accountId: selectionSchema.shape.accountId, apiKeyId: nativeId, name: z.string().min(1).max(200), attemptId: uuid,
  origin: z.string().max(2048), sender: z.email().max(320), senderVerification: z.enum(['verified-domain', 'verified-sender']), sandbox: z.enum(['validated', 'unverified']) }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.literal('runtime-mail-key'), id: nativeId, identity: identitySchema }).strict()).length(1),
  native: z.object({ operation: z.literal('runtime-mail-key'), installationId: uuid, phase: z.enum(['captured', 'capture-unknown', 'cleanup-required']) }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = settings(intent), i = e.resources[0].identity;
  if (e.native.installationId !== intent.installationId || i.accountId !== n.accountId || i.name !== n.keyName || i.origin !== n.origin || i.sender !== n.sender || e.resources[0].id !== i.apiKeyId) fail();
  return e;
}
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
  ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const; }

export function createSendGridOperatorDriver(options: { fetch?: typeof fetch; custody?: OperatorCredentialCustody } = {}): CloudInstallationDriver<Intent> {
  async function withClient<T>(context: Context, work: (client: {
    call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any>;
    request: typeof fetch; managementToken: string; senderVerification: 'verified-domain' | 'verified-sender'; senderReadScopes: string[];
  }) => Promise<T>): Promise<T> {
    const n = settings(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken(ROOT, budget.signal));
      if (!token || token.length > 65_536 || /[\r\n\0]/.test(token)) fail('authorization_expired');
      const request: typeof fetch = async (input, init) => {
        const u = new URL(String(input)), method = init?.method ?? 'GET';
        if (u.origin !== ROOT || u.username || u.password || u.hash || !['GET', 'POST', 'DELETE'].includes(method)
          || !['/v3/user/username', '/v3/scopes', '/v3/whitelabel/domains', '/v3/verified_senders', '/v3/api_keys', '/v3/mail/send'].includes(u.pathname)
          && !/^\/v3\/api_keys\/[A-Za-z0-9_-]{1,200}$/.test(u.pathname)) fail();
        const response = await budget.wait((options.fetch ?? fetch)(input, { ...init, redirect: 'error', signal: budget.signal }));
        if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); }
        if (!response.ok || response.status === 204 || u.pathname === '/v3/mail/send') {
          void response.body?.cancel().catch(() => {}); return new Response(null, { status: response.status });
        }
        const reader = response.body?.getReader(); if (!reader) throw new DestinationBoundaryError('invalid_response');
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const chunk = await budget.wait(reader.read()); if (chunk.done) break; size += chunk.value.byteLength;
          if (size > 1_048_576) throw new DestinationBoundaryError('invalid_response'); chunks.push(chunk.value); }
          return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
      };
      const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
        const response = await request(`${ROOT}/v3${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new DestinationBoundaryError('provider_unavailable', response.status);
        if (response.status !== (method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200)) throw new DestinationBoundaryError('invalid_response');
        if (method === 'DELETE') return undefined;
        try { return await response.json(); } catch { throw new DestinationBoundaryError('invalid_response'); }
      };
      const account = z.object({ user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).passthrough().parse(await call('GET', '/user/username'));
      if (!Number.isSafeInteger(account.user_id) || String(account.user_id) !== n.accountId) fail('identity_mismatch');
      const adapter = new SendGridAdapter(request); adapter.connect({ apiKey: token });
      const scopes = await adapter.getScopes();
      if (!permissions.every(p => scopes.includes(p))) fail('insufficient_permissions');
      const proof = (await adapter.inspectSenderIdentities([n.sender]))[0]?.status;
      if (proof !== 'verified-domain' && proof !== 'verified-sender') fail('insufficient_permissions');
      return await work({ call, request, managementToken: token, senderVerification: proof,
        senderReadScopes: ['whitelabel.read', 'user.email.read', 'verified_senders.read'].filter(scope => scopes.includes(scope)) });
    } finally { budget.close(); }
  }
  async function inventory(call: (method: 'GET', path: string) => Promise<any>) {
    const result = await call('GET', '/api_keys?limit=100');
    const items = z.array(z.object({ api_key_id: nativeId }).passthrough()).max(100).parse(result.result);
    if (new Set(items.map(i => i.api_key_id)).size !== items.length || result.nextPageToken || result.next || result._metadata?.next) fail('ownership_mismatch');
    return items;
  }
  async function readKey(call: (method: 'GET', path: string) => Promise<any>, id: string, expectedName: string) {
    const response = await call('GET', `/api_keys/${nativeId.parse(id)}`);
    // The pinned official schema describes an optional result[] envelope. A
    // redacted native GET 2026-10-27 independently established the direct object.
    const value = Array.isArray(response.result) ? response.result.length === 1 ? response.result[0] : null : response;
    const key = z.object({ api_key_id: nativeId, name: z.string(), scopes: z.array(z.string()) }).passthrough().parse(value);
    if (key.api_key_id !== id || key.name !== expectedName || !sendOnlyScopes(key.scopes)) fail('ownership_mismatch');
    return key;
  }
  function evidence(intent: Intent, identity: z.infer<typeof identitySchema>, phase: z.infer<typeof evidenceSchema>['native']['phase'] = 'captured') {
    return parseEvidence({ resources: [{ kind: 'runtime-mail-key', id: identity.apiKeyId, identity }], native: { operation: 'runtime-mail-key', installationId: intent.installationId, phase } }, intent);
  }
  function stored(context: Context) {
    if (!options.custody) fail('not_installed');
    const snapshot = options.custody.read(); if (!snapshot) return undefined;
    const identity = identitySchema.parse(snapshot.state.identity), n = settings(context.intent), attempt = context.attempts?.filter(a => a.actionId === n.actionId).at(-1);
    if (!attempt || identity.attemptId !== attempt.id || identity.sandbox !== 'validated' || !['credentials-stored', 'delivered'].includes(snapshot.state.phase)
      || snapshot.state.phase === 'credentials-stored' && !snapshot.state.credentials?.['api-key']) fail('ownership_mismatch');
    return { snapshot, identity, evidence: evidence(context.intent, identity) };
  }
  async function inspect(context: Context) {
    return withClient(context, async ({ call }) => {
      const n = settings(context.intent), retained = stored(context), attempt = context.attempts?.filter(a => a.actionId === n.actionId).at(-1);
      if (retained) { await readKey(call, retained.identity.apiKeyId, n.keyName); return { state: 'satisfied' as const, evidence: retained.evidence }; }
      if (attempt?.evidence) {
        const e = parseEvidence(attempt.evidence, context.intent);
        try { await readKey(call, e.resources[0].id, n.keyName); }
        catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return { state: 'rejected' as const, reason: 'not_installed' as const }; throw error; }
        return { state: 'unknown' as const, reason: 'not_converged' as const };
      }
      if (attempt && attempt.status !== 'rejected') return { state: 'unknown' as const, reason: 'create_ownership_unverified' as const };
      if ((await inventory(call)).length === 100) fail('insufficient_permissions');
      return { state: 'action-required' as const };
    });
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: PROVIDER, operatorApplication: { providerName: PROVIDER }, parseScope: value => scopeSchema.parse(value), parseEvidence,
    scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: record => [{ kind: 'runtime-mail-key', name: settings(record.intent).keyName, scope: record.intent.nativeScope.accountId }] },
    parseAction(value, intent) { const expected = action(intent); if (!isDeepStrictEqual(value, expected)) fail(); return expected; },
    async plan(context) {
      let senderReadScopes: string[];
      try { senderReadScopes = await withClient(context, async ({ call, senderReadScopes }) => { await inventory(call); return senderReadScopes; }); } catch (error) { throw new CloudInstallationBoundaryError(reason(error)); }
      const n = settings(context.intent);
      return { actions: [action(context.intent)], review: { resources: [{ kind: 'runtime-mail-key', name: n.keyName, scope: n.accountId }],
        permissions: [{ principal: `Existing verified SendGrid connection ${n.connectionId}`, scope: n.accountId, actions: [...permissions, 'GET /v3/scopes', 'GET /v3/whitelabel/domains', 'GET /v3/verified_senders', ...senderReadScopes], purpose: 'installation-verification' },
          { principal: n.keyName, scope: n.accountId, actions: ['mail.send'], purpose: 'writer' }],
        costs: [{ resource: n.keyName, description: 'Consumes one of the account’s 100 API-key slots. Sandbox validation sends no email and uses no sending credits. Future real messages use the existing SendGrid plan; secret-manager storage is billed separately.', pricingUrl: 'https://www.twilio.com/en-us/sendgrid/pricing' }],
        warnings: ['Existing management authority is inspected through GET /scopes plus both sender-observation routes. Either an exact verified domain or exact verified single sender is sufficient; one route may be denied. Listed sender scopes were observed on this key, not newly granted. No undocumented scopes.read permission is assumed.',
          'The new key has mail.send only, account-wide; SendGrid does not restrict this key to one sender or app. The exact configured sender is verified independently.',
          'The new credential is returned once. Encrypt before acknowledgement; no name adoption or create replay after an uncertain response. Preserve existing keys.',
          'If sandbox validation or private capture fails after an acknowledged create, delete only that exact new ID. Unconfirmed cleanup retains its ID and stops; no automatic repeated deletion.',
          `Sandbox validation uses the reviewed sender and consenting recipient ${n.recipient}; it cannot deliver a message. Private output delivery is a separate confirmed action.`] } };
    },
    async inspect(context) { try { driver.parseAction(context.action, context.intent); return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { driver.parseAction(context.action, context.intent); return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let started = false;
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async ({ call, request, managementToken, senderVerification }) => {
        const n = settings(context.intent); if (!options.custody || options.custody.read()) fail('ownership_mismatch');
        const before = await inventory(call); if (before.length >= 100) fail('insufficient_permissions');
        await context.beforeMutation(); started = true;
        const response = await call('POST', '/api_keys', { name: n.keyName, scopes: ['mail.send'] });
        // Only a returned new native ID, in this exact account and exact creation
        // response, may authorize cleanup. Names alone never establish ownership.
        const id = nativeId.parse(response.api_key_id), privateCandidate = typeof response.api_key === 'string' ? response.api_key : undefined;
        if ([managementToken, privateCandidate].some(value => value && JSON.stringify({ id, name: n.keyName, accountId: n.accountId, origin: n.origin, sender: n.sender }).includes(value))) fail('ownership_mismatch');
        if (response.name !== n.keyName || before.some(item => item.api_key_id === id)) fail('ownership_mismatch');
        const identity = identitySchema.parse({ accountId: n.accountId, apiKeyId: id, name: n.keyName, attemptId: context.attempt.id,
          origin: n.origin, sender: n.sender, senderVerification, sandbox: 'unverified' });
        try {
          if (!sendOnlyScopes(response.scopes)) fail('ownership_mismatch');
          const value = z.string().min(1).max(65_536).refine(v => !/[\r\n\0]/.test(v)).parse(response.api_key);
          if (value === managementToken) fail('ownership_mismatch');
          await readKey(call, id, n.keyName); await context.beforeMutation();
          if ((await verifySendGridRuntimeMail(value, { sender: n.sender, recipient: n.recipient }, { fetch: request, signal: context.signal })).authentication !== 'authenticated') fail('not_converged');
          await readKey(call, id, n.keyName); identity.sandbox = 'validated';
          if (!options.custody.storeCredentials(null, { 'api-key': value }, identity)) fail('not_converged');
          return { state: 'acknowledged' as const, evidence: evidence(context.intent, identity) };
        } catch {
          // A lost local commit acknowledgement is recoverable; never delete a
          // credential whose exact capture is already durable.
          try { const captured = stored(context); if (captured && isDeepStrictEqual(captured.identity, identity))
            return { state: 'acknowledged' as const, evidence: captured.evidence }; }
          catch { return { state: 'acknowledged' as const, evidence: evidence(context.intent, identity, 'capture-unknown') }; }
          try {
            await context.beforeMutation(); await call('DELETE', `/api_keys/${id}`);
            try { await call('GET', `/api_keys/${id}`); } catch (error) {
              if (error instanceof DestinationBoundaryError && error.status === 404) return { state: 'rejected' as const, reason: 'not_installed' as const }; throw error;
            }
          } catch { /* Preserve exact new identity; no blind deletion replay. */ }
          return { state: 'acknowledged' as const, evidence: evidence(context.intent, identity, 'cleanup-required') };
        }
      }); } catch (error) { return { state: !started || error instanceof DestinationBoundaryError && [400, 401, 403, 404, 422].includes(error.status ?? 0) ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}

export function createSendGridOperatorCapability(): OperatorApplicationCapability {
  const dependencies = (intent: Intent) => [settings(intent).actionId];
  return { schemaVersion: 1, privateOutputRoles: ['api-key'],
    parseDeclaration({ name, declaration, origin }) {
      if (declaration.provider !== PROVIDER || declaration.profile !== 'hypercloud-connect-v1') fail();
      return scopeSchema.parse({ ...selectionSchema.parse(declaration.nativeScope), name, origin });
    }, parseRecord: value => parseCloudInstallationRecordV1(value, withOperatorOutputDelivery(createSendGridOperatorDriver(), undefined, dependencies)),
    async create(value, context) {
      if (!context) fail('not_installed');
      const n = scopeSchema.parse(value), custody = new OperatorCredentialCustody({ ...context, provider: PROVIDER });
      const credentials = () => {
        const row = new ConnectionRepository().findById(n.connectionId), project = new ProjectRepository().findById(context.projectId),
          environment = new EnvironmentRepository().findById(context.environmentId);
        if (!project || !environment || environment.projectId !== project.id || !row?.scope
          || !getProjectScopeHints(project, environment.name).includes(row.scope) || row.provider !== PROVIDER || row.status !== 'verified') fail('authorization_expired');
        const value = getSecretStore().decryptObject<{ apiKey?: unknown }>(row.credentialsEncrypted).apiKey;
        if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) fail('authorization_expired'); return value;
      };
      return { driver: withOperatorOutputDelivery(createSendGridOperatorDriver({ custody }), context, dependencies),
        authentication: { kind: 'operator-application', administrator: { async getAccessToken(scope, signal) { if (scope !== ROOT || signal.aborted) fail('authorization_expired'); return credentials(); } } } };
    }, receipts(record) {
      const n = settings(record.intent), e = parseEvidence(record.completed[n.actionId], record.intent), delivered = operatorOutputReceipts(record.completed, record.intent);
      if (record.status !== 'scope-ready' || e.native.phase !== 'captured' || record.intent.outputs?.destinations.length !== 1 || record.intent.outputs.destinations[0].role !== 'api-key'
        || delivered.length !== 1 || delivered[0].role !== 'api-key') fail('not_converged');
      return [{ provider: PROVIDER, ...e.resources[0].identity, permission: 'mail.send', privateCredential: 'delivered', actualDelivery: 'unverified' }, ...delivered];
    },
  };
}
