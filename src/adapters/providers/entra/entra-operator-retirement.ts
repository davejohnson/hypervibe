import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJsonSha256 as hash } from '../../../lib/canonical-json.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationProviderContext, type CloudInstallationRecord, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { operatorRetirementOutcomeSchema } from '../../../domain/ports/operator-retirement.port.js';
import { historicalInstallationEvidence, parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { createEntraOperatorApplicationDriver, entraOperatorSettings, entraOperatorEvidence, sameApplicationCreationTime } from './entra-operator-application.js';

type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
const uuid = z.string().guid(), digest = z.string().regex(/^[a-f0-9]{64}$/), date = z.string().datetime({ offset: true });
const targetSchema = z.object({ installationId: uuid, planDigest: digest, evidenceDigest: digest,
  tenantId: uuid, applicationId: uuid, clientId: uuid, createdDateTime: date,
  owner: digest, applicationAttemptId: uuid, federationAttemptId: uuid, federationId: uuid,
  name: z.string().min(1).max(100), origin: z.string().url(), googleSubject: z.string().min(1).max(100),
}).strict();
type Target = z.infer<typeof targetSchema>;
const nativeSchema = z.object({ target: targetSchema, owners: z.array(uuid).max(1000), operation: z.enum(['remove-federation', 'remove-application']) }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['application', 'federation']), id: uuid,
  identity: z.object({ tenantId: uuid, applicationId: uuid, clientId: uuid, createdDateTime: date }).strict() }).strict()).length(1),
  native: z.object({ installationId: uuid, target: targetSchema, operation: nativeSchema.shape.operation,
    retirement: operatorRetirementOutcomeSchema }).strict() }).strict();
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
  ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const; }
function validateTarget(target: Target, intent: Intent) {
  if (intent.mode !== 'retire' || intent.applicationProvider !== 'microsoft-entra' || intent.provider !== 'microsoft-entra'
    || intent.retirement?.targets.length !== 1 || !isDeepStrictEqual(intent.retirement.targets[0], { installationId: target.installationId, planDigest: target.planDigest, evidenceDigest: target.evidenceDigest })
    || !isDeepStrictEqual(intent.predecessor, { installationId: target.installationId, planDigest: target.planDigest })
    || target.tenantId !== intent.nativeScope.tenantId || target.name !== intent.nativeScope.name || target.origin !== intent.nativeScope.origin
    || target.googleSubject !== intent.nativeScope.googleSubject
    || target.owner !== hash([intent.customerId, intent.appId, intent.environment, target.installationId])) fail();
  return target;
}
function compile(records: CloudInstallationRecord<Intent>[]): Target {
  if (records.length !== 1) fail();
  const record = parseCloudInstallationRecordV1(records[0], createEntraOperatorApplicationDriver());
  const completed = historicalInstallationEvidence(record), n = entraOperatorSettings(record.intent);
  if (!completed || record.intent.mode !== 'connect' || record.intent.predecessor) fail();
  const app = entraOperatorEvidence(completed[n.appAction], record.intent).resources[0];
  const fic = entraOperatorEvidence(completed[n.ficAction], record.intent).resources[0];
  if (app.kind !== 'application' || fic.kind !== 'federation' || !isDeepStrictEqual({ ...app.identity, attemptId: fic.identity.attemptId }, fic.identity)) fail();
  return targetSchema.parse({ installationId: record.installationId, planDigest: record.plan.digest, evidenceDigest: hash(completed),
    tenantId: n.tenantId, applicationId: app.id, clientId: app.identity.clientId, createdDateTime: app.identity.createdDateTime,
    owner: n.owner, applicationAttemptId: app.identity.attemptId, federationAttemptId: fic.identity.attemptId, federationId: fic.id,
    name: n.name, origin: n.origin, googleSubject: n.googleSubject });
}
function actions(target: Target, owners: string[]): CloudInstallationAction[] {
  const prefix = `microsoft-entra:${target.name}:retire`, federation = `${prefix}:federation`;
  return [{ id: federation, type: 'destroy', resource: { kind: 'project', provider: 'microsoft-entra', name: target.federationId },
    verified: true, requiresConfirm: true, dataBearing: true, reason: 'Remove only the recorded Google workload trust from this test application.',
    metadata: { operation: 'remove-federation', category: 'trust', execution: 'api', native: { operation: 'remove-federation', target, owners } } },
  { id: `${prefix}:application`, type: 'destroy', resource: { kind: 'project', provider: 'microsoft-entra', name: target.applicationId },
    verified: true, requiresConfirm: true, dataBearing: true, dependsOn: [federation], reason: 'Soft-delete the recorded test application after its trust is removed; retain Microsoft recovery metadata.',
    metadata: { operation: 'remove-application', category: 'identity', execution: 'api', native: { operation: 'remove-application', target, owners } } }];
}
export function createEntraOperatorRetirementDriver(options: { fetch?: typeof fetch; targets?: CloudInstallationRecord<Intent>[] } = {}): CloudInstallationDriver<Intent> {
  const setup = createEntraOperatorApplicationDriver();
  const retained = options.targets ? compile(options.targets) : undefined;
  const targetFor = (value: unknown, intent: Intent) => {
    const target = validateTarget(targetSchema.parse(value), intent);
    if (retained && !isDeepStrictEqual(retained, target)) fail(); return target;
  };
  function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
    if (intent.mode === 'connect') return setup.parseEvidence(value, intent);
    const e = evidenceSchema.parse(value), target = targetFor(e.native.target, intent), resource = e.resources[0];
    const app = e.native.operation === 'remove-application';
    if (e.native.installationId !== intent.installationId || resource.kind !== (app ? 'application' : 'federation') || resource.id !== (app ? target.applicationId : target.federationId)
      || !isDeepStrictEqual(resource.identity, identity(target))) fail();
    if (!app && !isDeepStrictEqual(e.native.retirement, { outcome: 'removed', retained: [] })) fail();
    if (app) {
      const r = e.native.retirement;
      if (r.outcome !== 'deletion-scheduled' || r.retained.length !== 1 || r.retained[0].kind !== 'application'
        || r.retained[0].id !== target.applicationId || r.retained[0].reason !== 'provider-retention' || r.retained[0].retentionUntil !== undefined
        || !isDeepStrictEqual(r.retained[0].identity, { ...identity(target), documentedRecoveryWindowDays: '30', deletedDateTime: r.retained[0].identity.deletedDateTime })) fail();
      date.parse(r.retained[0].identity.deletedDateTime);
    }
    return e;
  }
  function identity(t: Target) { return { tenantId: t.tenantId, applicationId: t.applicationId, clientId: t.clientId, createdDateTime: t.createdDateTime }; }
  function proof(t: Target, intent: Intent, operation: 'remove-federation' | 'remove-application', deletedDateTime?: string) {
    return parseEvidence({ resources: [{ kind: operation === 'remove-application' ? 'application' : 'federation', id: operation === 'remove-application' ? t.applicationId : t.federationId, identity: identity(t) }],
      native: { installationId: intent.installationId, target: t, operation, retirement: deletedDateTime ? { outcome: 'deletion-scheduled', retained: [{ kind: 'application', id: t.applicationId,
        identity: { ...identity(t), deletedDateTime, documentedRecoveryWindowDays: '30' }, reason: 'provider-retention' }] } : { outcome: 'removed', retained: [] } } }, intent);
  }
  async function client<T>(context: Context, work: (read: (path: string) => Promise<Record<string, any> | undefined>, remove: (path: string) => Promise<void>) => Promise<T>) {
    if (!retained) fail(); validateTarget(retained, context.intent);
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://graph.microsoft.com/.default', budget.signal));
      const url = (path: string) => { const result = new URL(path, 'https://graph.microsoft.com/v1.0/');
        if (result.origin !== 'https://graph.microsoft.com' || !result.pathname.startsWith('/v1.0/') || result.username || result.password || result.hash) fail(); return result.href; };
      const read = async (path: string) => {
        try { const result = await destinationJson(async (input, init) => {
          const response = await (options.fetch ?? fetch)(input, init);
          if (response.ok && response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); } return response;
        }, budget, url(path), token);
          if (JSON.stringify(result).includes(token)) throw new DestinationBoundaryError('invalid_response');
          return result; } catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return undefined; throw error; }
      };
      const remove = async (path: string) => {
        const response = await budget.wait((options.fetch ?? fetch)(url(path), { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: budget.signal, redirect: 'error' }));
        void response.body?.cancel().catch(() => {});
        if (response.status !== 204) throw new DestinationBoundaryError('provider_unavailable', response.status);
      };
      const organization = await read('organization?$select=id');
      if (!organization || !Array.isArray(organization.value) || organization.value.length !== 1 || organization.value[0]?.id !== retained.tenantId || organization['@odata.nextLink']) fail();
      return await work(read, remove);
    } finally { budget.close(); }
  }
  async function list(read: (path: string) => Promise<Record<string, any> | undefined>, path: string) {
    const base = new URL(path, 'https://graph.microsoft.com/v1.0/'), seen = new Set<string>(); let next: string | undefined = base.href; const result: any[] = [];
    for (let page = 0; next && page < 10; page++) {
      const url = new URL(next, base); if (url.origin !== base.origin || url.pathname !== base.pathname || seen.has(url.href)) fail('not_converged'); seen.add(url.href);
      const value = await read(url.href); if (!value || !Array.isArray(value.value) || value['@odata.nextLink'] !== undefined && typeof value['@odata.nextLink'] !== 'string') fail('not_converged');
      result.push(...value.value); if (result.length > 1000) fail('not_converged'); next = value['@odata.nextLink'];
    }
    if (next) fail('not_converged'); return result;
  }
  function appIdentity(value: any, t: Target) {
    if (value.id !== t.applicationId || value.appId !== t.clientId || !sameApplicationCreationTime(String(value.createdDateTime), t.createdDateTime)
      || !Array.isArray(value.tags) || !isDeepStrictEqual([...value.tags].sort(), [`hypervibe:owner:${t.owner}`, `hypervibe:attempt:${t.applicationAttemptId}`].sort())) fail('ownership_mismatch');
  }
  async function observe(read: (path: string) => Promise<Record<string, any> | undefined>, t: Target) {
    // Graph-created registrations do not create a service principal. A later
    // home-tenant principal would be cascaded by application DELETE and needs
    // its own accepted lifecycle/consumer review before this narrow retirement.
    const principals = await list(read, `servicePrincipals?$filter=${encodeURIComponent(`appId eq '${t.clientId}'`)}&$select=id,appId`);
    if (principals.length) fail('ownership_mismatch');
    const app = await read(`applications/${t.applicationId}?$select=id,appId,displayName,createdDateTime,signInAudience,web,tags,passwordCredentials,keyCredentials,requiredResourceAccess`);
    if (!app) {
      const deleted = await read(`directory/deletedItems/${t.applicationId}?$select=id,appId,createdDateTime,deletedDateTime,tags`);
      if (!deleted || deleted['@odata.type'] !== '#microsoft.graph.application') fail('not_converged'); appIdentity(deleted, t);
      return { deletedDateTime: date.parse(deleted.deletedDateTime) };
    }
    appIdentity(app, t);
    if (app.displayName !== `Hypercloud ${t.name}` || app.signInAudience !== 'AzureADMultipleOrgs'
      || !isDeepStrictEqual(app.web?.redirectUris, [`${t.origin}/cloud-authorizations/azure`])
      || app.web?.implicitGrantSettings?.enableAccessTokenIssuance !== false || app.web?.implicitGrantSettings?.enableIdTokenIssuance !== false
      || !isDeepStrictEqual(app.passwordCredentials, []) || !isDeepStrictEqual(app.keyCredentials, []) || !isDeepStrictEqual(app.requiredResourceAccess, [])) fail('ownership_mismatch');
    const owners = (await list(read, `applications/${t.applicationId}/owners?$select=id`)).map(value => uuid.parse(value.id)).sort();
    if (new Set(owners).size !== owners.length) fail('not_converged');
    const fics = await list(read, `applications/${t.applicationId}/federatedIdentityCredentials`);
    if (fics.length > 1) fail('ownership_mismatch');
    if (fics.length && (fics[0].id !== t.federationId || fics[0].name !== `hypervibe-${t.owner.slice(0,32)}`
      || fics[0].description !== `hypervibe:${t.owner}:${t.federationAttemptId}` || fics[0].issuer !== 'https://accounts.google.com'
      || fics[0].subject !== t.googleSubject || !isDeepStrictEqual(fics[0].audiences, ['api://AzureADTokenExchange']))) fail('ownership_mismatch');
    return { owners, federationPresent: fics.length === 1 };
  }
  async function inspect(context: Context & { action: CloudInstallationAction }) {
    const n = nativeSchema.parse(context.action.metadata.native), t = targetFor(n.target, context.intent);
    return client(context, async read => {
      const observed = await observe(read, t);
      if (observed.deletedDateTime) return { state: 'satisfied' as const, evidence: proof(t, context.intent, n.operation, n.operation === 'remove-application' ? observed.deletedDateTime : undefined) };
      if (!isDeepStrictEqual(observed.owners, n.owners)) fail('ownership_mismatch');
      if (n.operation === 'remove-federation' && !observed.federationPresent) return { state: 'satisfied' as const, evidence: proof(t, context.intent, n.operation) };
      if (n.operation === 'remove-application' && observed.federationPresent) fail('not_converged');
      const attempt = context.attempts?.filter(item => item.actionId === context.action.id).at(-1);
      return attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
    });
  }
  return { provider: 'microsoft-entra', operatorApplication: { providerName: 'microsoft-entra' }, operatorRetirement: { schemaVersion: 1 },
    scopePreparation: setup.scopePreparation,
    parseScope: value => { const parsed = createEntraOperatorApplicationDriver().parseScope(value); return parsed; }, parseEvidence,
    parseAction(value, intent) { if (intent.mode === 'connect') return setup.parseAction(value, intent);
      const input = z.object({ metadata: z.object({ native: nativeSchema }).passthrough() }).passthrough().parse(value);
      const n = input.metadata.native, t = targetFor(n.target, intent);
      if (!isDeepStrictEqual(n.owners, [...new Set(n.owners)].sort())) fail();
      const found = actions(t, n.owners).find(action => isDeepStrictEqual(action, value)); if (!found) fail(); return found; },
    async plan(context) { try { return await client(context, async read => {
      const t = targetFor(retained, context.intent), observed = await observe(read, t);
      if (observed.deletedDateTime) fail('not_converged');
      return { actions: actions(t, observed.owners!), review: { resources: [
        { kind: 'application', name: t.applicationId, scope: t.tenantId }, { kind: 'federatedIdentityCredential', name: t.federationId, scope: t.applicationId },
        ...observed.owners!.map(id => ({ kind: 'retained-directory-owner', name: id, scope: t.tenantId }))],
        permissions: [{ principal: 'current transient Graph caller', scope: t.tenantId, actions: ['Application.ReadWrite.All', 'Organization.Read.All'], purpose: 'installation-verification' }], costs: [],
        warnings: ['Remove the exact application and its Google workload trust. The tenant, subscription, directory owners and output secret containers remain unchanged.',
          'No home-tenant service principal may remain: application deletion would cascade to it. Foreign-tenant service principals are not inventoried or deleted by this review and require their own cleanup.',
          'Microsoft normally keeps deleted applications recoverable for 30 days. Exact deleted-object metadata is retained; this does not purge the object or prove permanent erasure.',
          'The complete current owner list is included in this review and must remain unchanged. Microsoft Graph offers no conditional ETag delete for this application/trust; concurrent external edits can still race the final read.'] } };
    }); } catch (error) { fail(reason(error)); } },
    async inspect(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { return await inspect(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let started = false, acknowledged = false;
      try { return await client(context, async (read, remove) => {
        const n = nativeSchema.parse(context.action.metadata.native), t = targetFor(n.target, context.intent), before = await observe(read, t);
        if (before.deletedDateTime || !isDeepStrictEqual(before.owners, n.owners)
          || n.operation === 'remove-federation' && !before.federationPresent || n.operation === 'remove-application' && before.federationPresent) fail('ownership_mismatch');
        await context.beforeMutation(); started = true;
        await remove(`applications/${t.applicationId}${n.operation === 'remove-federation' ? `/federatedIdentityCredentials/${t.federationId}` : ''}`); acknowledged = true;
        const after = await inspect(context); if (after.state !== 'satisfied') fail('not_converged');
        return { state: 'acknowledged' as const, evidence: after.evidence };
      }); } catch (error) { return { state: !started || !acknowledged && error instanceof DestinationBoundaryError && [400,401,403,409,422].includes(error.status ?? 0) ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
  };
}
