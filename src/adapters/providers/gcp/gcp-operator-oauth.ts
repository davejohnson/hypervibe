import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { credentialSourceSchema } from '../../../domain/spec/credential.schema.js';
import { resolveSecretValueRef } from '../../../domain/services/secret-value-ref.js';
import { OperatorCredentialCustody, type OperatorCustodyState } from '../../../domain/services/operator-credential-custody.js';
import { operatorOutputReceipts, withOperatorOutputDelivery } from '../../../domain/services/operator-output-delivery.js';
import { historicalInstallationEvidence, parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationProviderContext, type CloudInstallationRecord, type OperatorApplicationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { OperatorApplicationCapability, OperatorApplicationLocalContext } from '../../../domain/ports/operator-application.port.js';
const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const clientId = z.string().max(256).regex(/^[0-9]+(?:-[A-Za-z0-9_-]+)?\.apps\.googleusercontent\.com$/);
const commitment = z.string().regex(/^[a-f0-9]{64}$/);
const origin = z.string().max(2048).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; } catch { return false; } });
const credentialsRef = credentialSourceSchema.refine(value => !value.startsWith('file:') || path.isAbsolute(value.slice(5)), 'Use an absolute private configuration path.');
const declarationScope = z.object({ projectId, credentialsRef }).strict();
const scopeSchema = declarationScope.extend({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), origin }).strict();
const configSchema = z.object({ web: z.object({ client_id: clientId, client_secret: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/), project_id: projectId,
  auth_uri: z.enum(['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth']),
  token_uri: z.enum(['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token']),
  auth_provider_x509_cert_url: z.literal('https://www.googleapis.com/oauth2/v1/certs').optional(),
  redirect_uris: z.array(z.string().max(2048)).length(1), javascript_origins: z.array(origin).max(1).optional(),
}).strict() }).strict();
type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
const operation = 'owner-json-import';
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function settings(intent: Intent) {
  if (intent.provider !== 'google-oauth' || intent.applicationProvider !== 'google-oauth') fail();
  const scope = scopeSchema.parse(intent.nativeScope);
  return { ...scope, callback: `${scope.origin}/cloud-authorizations/gcp`, actionId: `google-oauth:${scope.name}:owner-import` };
}
function action(intent: Intent, reviewedClientId: string, configurationCommitment: string): CloudInstallationAction {
  const n = settings(intent); clientId.parse(reviewedClientId); commitment.parse(configurationCommitment);
  return { id: n.actionId, type: 'create', resource: { kind: 'project', provider: 'google-oauth', name: reviewedClientId }, verified: true,
    requiresConfirm: true, dataBearing: true, reason: 'Import the owner-selected confidential web configuration into private encrypted custody; native ownership and browser authorization remain unverified.',
    metadata: { operation, category: 'identity', execution: 'api', native: { clientId: reviewedClientId, configurationCommitment } } };
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.literal('oauth-client-configuration'), id: clientId,
  identity: z.object({ clientId, projectId, origin, callback: z.string().max(2048), configurationCommitment: commitment,
    configuration: z.literal('imported-unverified'), attemptId: z.string().guid() }).strict() }).strict()).length(1),
  native: z.object({ operation: z.literal(operation), installationId: z.string().guid(), attemptId: z.string().guid() }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = settings(intent), item = e.resources[0];
  if (e.native.installationId !== intent.installationId || item.identity.attemptId !== e.native.attemptId
    || item.id !== item.identity.clientId || item.identity.projectId !== n.projectId || item.identity.origin !== n.origin || item.identity.callback !== n.callback) fail();
  return e;
}
function evidence(intent: Intent, identity: NonNullable<OperatorCustodyState['identity']>): CloudInstallationEvidence {
  return parseEvidence({ resources: [{ kind: 'oauth-client-configuration', id: identity.clientId, identity }],
    native: { operation, installationId: intent.installationId, attemptId: identity.attemptId } }, intent);
}
async function configuration(intent: Intent) {
  try {
    const n = settings(intent), raw = await resolveSecretValueRef(n.credentialsRef, { projectId: intent.appId, environmentName: intent.environment });
    if (Buffer.byteLength(raw, 'utf8') > 32_768) fail();
    const config = configSchema.parse(JSON.parse(raw)).web;
    if (config.project_id !== n.projectId || !isDeepStrictEqual(config.redirect_uris, [n.callback])
      || config.javascript_origins?.some(value => value !== n.origin)) fail();
    // Commit to the full canonical input without publishing an unkeyed digest
    // that would permit guessing a private value. The intent does not include
    // this action-level commitment, so recomputation has no circular dependency.
    const material = getSecretStore().deriveSecret('google-operator-owner-import.v1', {
      intentDigest: canonicalJsonSha256(intent), inputDigest: canonicalJsonSha256(config),
    });
    const configurationCommitment = material.toString('hex'); material.fill(0);
    return { config, configurationCommitment };
  } catch { fail(); }
}
export function createGoogleOperatorOAuthDriver(local?: OperatorApplicationLocalContext): CloudInstallationDriver<Intent> {
  function custody(intent: Intent) {
    if (!local || local.projectId !== intent.appId || local.projectId !== intent.customerId
      || local.installationId !== intent.installationId || local.intentDigest !== canonicalJsonSha256(intent)) fail();
    const environment = new EnvironmentRepository().findById(local.environmentId);
    if (!environment || environment.projectId !== intent.appId || environment.name !== intent.environment) fail();
    return new OperatorCredentialCustody({ ...local, provider: 'google-oauth' });
  }
  function parseAction(value: unknown, intent: Intent) {
    const selected = z.object({ metadata: z.object({ native: z.object({ clientId, configurationCommitment: commitment }) }) }).parse(value).metadata.native;
    const expected = action(intent, selected.clientId, selected.configurationCommitment); if (!isDeepStrictEqual(value, expected)) fail(); return expected;
  }
  function inspect(context: Context & { action: CloudInstallationAction }) {
    try {
      const reviewed = parseAction(context.action, context.intent), snapshot = custody(context.intent).read();
      const attempt = context.attempts?.filter(item => item.actionId === reviewed.id).at(-1);
      if (!snapshot) return attempt && attempt.status !== 'rejected' ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      if (!['credentials-stored', 'delivered'].includes(snapshot.state.phase) || !snapshot.state.identity
        || !attempt || snapshot.state.identity.attemptId !== attempt.id || snapshot.state.identity.clientId !== reviewed.metadata.native.clientId
        || snapshot.state.identity.configurationCommitment !== reviewed.metadata.native.configurationCommitment) fail();
      const retained = evidence(context.intent, snapshot.state.identity), completed = context.completed[reviewed.id];
      if (completed && !isDeepStrictEqual(retained, completed)) fail();
      return { state: 'satisfied' as const, evidence: retained };
    } catch { return { state: 'unknown' as const, reason: 'identity_mismatch' as const }; }
  }
  const native: CloudInstallationDriver<Intent> = { provider: 'google-oauth', operatorApplication: { providerName: 'google-oauth' },
    scopePreparation: { resolvedScope: record => record.intent.nativeScope,
      reviewResources: record => [{ kind: 'owner-supplied-oauth-client', name: settings(record.intent).name, scope: settings(record.intent).projectId }] },
    parseScope: value => scopeSchema.parse(value), parseAction, parseEvidence,
    async plan(context) {
      const n = settings(context.intent), { config, configurationCommitment } = await configuration(context.intent);
      return { actions: [action(context.intent, config.client_id, configurationCommitment)], review: {
        resources: [{ kind: 'owner-supplied-oauth-client', name: config.client_id, scope: n.projectId }], permissions: [], costs: [],
        warnings: [`Google requires the owner to create a standard Web application client in https://console.cloud.google.com/auth/clients?project=${n.projectId}.`,
          `Review Audience at https://console.cloud.google.com/auth/audience?project=${n.projectId}. An external app in Testing allows only listed Test users to authorize this cloud access. Add the approved Google accounts, including invited cloud administrators. Check the selected Google account when sign-in is denied. The hosted app requests cloud-platform access, so Google's identity-only exception does not apply.`,
          'This operator-owned shared OAuth app serves customer connections; customers do not create their own client. Production customer onboarding needs an appropriate production audience and Google verification where applicable. Preserve Testing for a test deployment; publishing the app is a separate decision.',
          `The reviewed callback is ${n.callback}. Imported JSON is owner-supplied configuration, not native ownership or redirect proof.`,
          'This step stores the client secret encrypted locally. Separately reviewed native delivery and a real browser authorization exchange are required; no cloud client-creation API is called.'] } };
    },
    async inspect(context) { return inspect(context); }, async recover(context) { return inspect(context); },
    async mutate(context) {
      let started = false;
      try {
        const reviewed = parseAction(context.action, context.intent), n = settings(context.intent), store = custody(context.intent);
        if (store.read()) fail('ownership_mismatch');
        const { config, configurationCommitment } = await configuration(context.intent);
        if (config.client_id !== reviewed.metadata.native.clientId || configurationCommitment !== reviewed.metadata.native.configurationCommitment || context.signal.aborted) fail();
        await context.beforeMutation(); started = true;
        const identity = { clientId: config.client_id, projectId: n.projectId, origin: n.origin, callback: n.callback,
          configurationCommitment, configuration: 'imported-unverified', attemptId: context.attempt.id };
        const captured = store.storeCredentials(null, { 'client-secret': config.client_secret }, identity);
        if (!captured) fail('not_converged');
        return { state: 'acknowledged', evidence: evidence(context.intent, identity) };
      } catch { return { state: started ? 'uncertain' : 'rejected', reason: 'identity_mismatch' }; }
    }, connections: () => [],
  };
  return withOperatorOutputDelivery(native, local, intent => [settings(intent).actionId]);
}
const retirementTargetSchema = z.object({ installationId: z.string().guid(), planDigest: commitment, evidenceDigest: commitment,
  ownerScopeDigest: commitment, identity: evidenceSchema.shape.resources.element.shape.identity }).strict();
type RetirementTarget = z.infer<typeof retirementTargetSchema>;
function retirementUrl(intent: Intent) { return `https://console.cloud.google.com/auth/clients?project=${settings(intent).projectId}`; }
function retirementAction(intent: Intent, target: RetirementTarget): CloudInstallationAction {
  const n = settings(intent);
  return { id: `google-oauth:${n.name}:retire-browser`, type: 'destroy', resource: { kind: 'project', provider: 'google-oauth', name: target.identity.clientId },
    verified: true, requiresConfirm: true, dataBearing: true,
    reason: 'Review this exact client in the Google console and delete it only if you own it and it is no longer used. Imported configuration does not prove native ownership; deletion remains unverified.',
    metadata: { operation: 'retire-browser', category: 'identity', execution: 'external', native: { target } } };
}
/** Standard Web OAuth clients have an owner-console flow, not the Workforce
 * OAuth API. A saved handoff is not native proof of deletion or erasure. */
function createGoogleOperatorRetirementDriver(local?: OperatorApplicationLocalContext, targets?: CloudInstallationRecord<Intent>[]): CloudInstallationDriver<Intent> {
  const setup = createGoogleOperatorOAuthDriver();
  let retained: RetirementTarget | undefined;
  if (targets) {
    if (targets.length !== 1) fail();
    const original = parseCloudInstallationRecordV1(targets[0], setup), proof = historicalInstallationEvidence(original);
    if (original.intent.mode !== 'connect' || !proof) fail();
    const imported = parseEvidence(proof[settings(original.intent).actionId], original.intent), identity = evidenceSchema.parse(imported).resources[0].identity;
    const attempt = original.attempts.filter(item => item.actionId === settings(original.intent).actionId).at(-1);
    if (!attempt || attempt.status !== 'succeeded' || attempt.id !== identity.attemptId || !isDeepStrictEqual(attempt.evidence, imported)) fail();
    retained = retirementTargetSchema.parse({ installationId: original.installationId, planDigest: original.plan.digest,
      evidenceDigest: canonicalJsonSha256(proof), ownerScopeDigest: canonicalJsonSha256([original.intent.customerId, original.intent.appId, original.intent.environment, original.intent.source.repository]), identity });
  }
  function targetFor(value: unknown, intent: Intent) {
    const target = retirementTargetSchema.parse(value), n = settings(intent), reference = { installationId: target.installationId, planDigest: target.planDigest };
    if (intent.mode !== 'retire' || intent.retirement?.resources !== 'delete-owned' || intent.retirement.data !== 'retain'
      || intent.retirement.continueFrom || intent.retirement.outputTargets
      || !isDeepStrictEqual(intent.retirement.from, reference) || !isDeepStrictEqual(intent.predecessor, reference)
      || !isDeepStrictEqual(intent.retirement.targets, [{ ...reference, evidenceDigest: target.evidenceDigest }])
      || target.identity.projectId !== n.projectId || target.identity.origin !== n.origin || target.identity.callback !== n.callback
      || target.ownerScopeDigest !== canonicalJsonSha256([intent.customerId, intent.appId, intent.environment, intent.source.repository])
      || retained && !isDeepStrictEqual(target, retained)) fail();
    return target;
  }
  function actionFor(value: unknown, intent: Intent) {
    const target = targetFor((value as CloudInstallationAction)?.metadata?.native?.target, intent), expected = retirementAction(intent, target);
    if (!isDeepStrictEqual(value, expected)) fail(); return expected;
  }
  function inspect(context: Context & { action: CloudInstallationAction }) {
    try {
      const action = actionFor(context.action, context.intent), attempt = context.attempts?.filter(item => item.actionId === action.id).at(-1);
      if (attempt) {
        if (attempt.externalUrl && attempt.externalUrl !== retirementUrl(context.intent)) fail();
        return { state: 'pending' as const, reason: 'not_converged' as const };
      }
      if (!local || !retained || local.projectId !== context.intent.appId || local.projectId !== context.intent.customerId
        || local.installationId !== context.intent.installationId || local.intentDigest !== canonicalJsonSha256(context.intent)) fail();
      const environment = new EnvironmentRepository().findById(local.environmentId);
      if (!environment || environment.projectId !== context.intent.appId || environment.name !== context.intent.environment) fail();
      return { state: 'action-required' as const };
    } catch { return { state: 'unknown' as const, reason: 'identity_mismatch' as const }; }
  }
  return { provider: 'google-oauth', operatorRetirement: { schemaVersion: 1 }, parseScope: setup.parseScope, scopePreparation: setup.scopePreparation,
    parseAction: (value, intent) => intent.mode === 'connect' ? setup.parseAction(value, intent) : actionFor(value, intent),
    parseEvidence(value, intent) { if (intent.mode === 'connect') return setup.parseEvidence(value, intent); return fail(); },
    operatorApplication: { providerName: 'google-oauth',
      parseBrowserHandoff(value, intent) { if (intent.mode !== 'retire' || value !== retirementUrl(intent)) fail(); return value; },
      async pendingBrowser(record) {
        const action = actionFor(record.plan.actions[0], record.intent), target = targetFor(action.metadata.native.target, record.intent);
        const attempt = record.attempts.filter(item => item.actionId === action.id).at(-1);
        if (!attempt?.externalUrl) return undefined;
        if (attempt.externalUrl !== retirementUrl(record.intent)) fail();
        return { url: attempt.externalUrl, description: `In Google project ${target.identity.projectId}, verify that you own client ${target.identity.clientId} and that it is no longer used, then select it and click Delete. Deletion stops sign-in and Google access through this client. Google allows recovery for 30 days. Imported configuration does not prove ownership. Deletion remains unverified in Hypervibe; private values remain and any storage charges may continue until independent provider proof allows cleanup.` };
      } },
    async plan(context) {
      if (!retained) fail(); const target = targetFor(retained, context.intent), action = retirementAction(context.intent, target), observed = inspect({ ...context, action });
      if (observed.state !== 'action-required') fail('reason' in observed ? observed.reason : 'not_converged');
      return { actions: [action], review: { resources: [{ kind: 'Google OAuth client', name: target.identity.clientId, scope: target.identity.projectId }], permissions: [], costs: [],
        warnings: [`Open ${retirementUrl(context.intent)} and verify the exact client ID and ownership before deletion. The imported configuration is not native ownership proof.`,
          'Deleting this shared operator client stops sign-in and Google access through it. Check that it is no longer used; preserve unrelated clients and the shared project.',
          'Google allows recovery for 30 days after deletion. This handoff does not verify deletion or permanent erasure. Hypervibe keeps this retirement pending and preserves encrypted private values and history; storage charges may continue.',
          'An operator manages this shared client. Customers connecting their own clouds do not create or delete operator clients.'] } };
    },
    async inspect(context) { return inspect(context); }, async recover(context) { return inspect(context); },
    async mutate(context) {
      const observed = inspect({ ...context, attempts: context.attempts?.filter(item => item.id !== context.attempt.id) });
      if (observed.state !== 'action-required') return { state: 'rejected', reason: 'not_converged' };
      await context.beforeMutation(); return { state: 'external', url: retirementUrl(context.intent) };
    }, connections: () => [],
  };
}
export function createGoogleOperatorOAuthCapability(): OperatorApplicationCapability {
  return { schemaVersion: 1, privateOutputRoles: ['client-secret'],
    parseDeclaration({ name, declaration, origin }) {
      if (declaration.provider !== 'google-oauth' || declaration.profile !== 'hypercloud-connect-v1') fail();
      return scopeSchema.parse({ ...declarationScope.parse(declaration.nativeScope), name, origin });
    }, parseRecord: value => parseCloudInstallationRecordV1(value,
      (value as { intent?: { mode?: unknown } })?.intent?.mode === 'retire' ? createGoogleOperatorRetirementDriver() : createGoogleOperatorOAuthDriver()),
    async create(scope, local) { scopeSchema.parse(scope); return { driver: createGoogleOperatorOAuthDriver(local), authentication: { kind: 'operator-application' } }; },
    retirement: { async create(scope, local, targets) { scopeSchema.parse(scope); return { driver: createGoogleOperatorRetirementDriver(local, targets), authentication: { kind: 'operator-application' } }; } },
    receipts(record) {
      if (record.status !== 'scope-ready') fail('not_converged');
      const n = settings(record.intent), identity = parseEvidence(record.completed[n.actionId], record.intent).resources[0].identity;
      return [{ provider: 'google-oauth', ...identity, clientAuthentication: 'client-secret', browserExchange: 'unverified' }, ...operatorOutputReceipts(record.completed, record.intent)];
    },
  };
}
providerRegistry.register({ metadata: { name: 'google-oauth', displayName: 'Google operator OAuth configuration', category: 'identity', credentialsSchema: z.object({}).strict() },
  factory: () => { throw new Error('Use the reviewed operator application lifecycle.'); }, operatorApplication: createGoogleOperatorOAuthCapability() });
