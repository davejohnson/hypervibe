import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationDriver, type CloudInstallationRecord, type OperatorApplicationIntent, type CloudInstallationProviderContext, type CloudInstallationAction } from '../../../domain/ports/cloud-installation.port.js';
import { operatorOutputSelectionSchema } from '../../../domain/ports/operator-output.port.js';
import { operatorRetirementOutcomeSchema } from '../../../domain/ports/operator-retirement.port.js';
import { secretContainerScopeDigest } from '../../../domain/ports/secret-destination-lifecycle.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { parseOperatorOutputEvidence } from '../../../domain/services/operator-output-delivery.js';
import { historicalInstallationEvidence, parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { assertGcpProjectIdentity } from './gcp-project-identity.js';
type Intent = OperatorApplicationIntent;
type Record = CloudInstallationRecord<Intent>;
type Context = CloudInstallationProviderContext<Intent>;
function fail(): never { throw new CloudInstallationBoundaryError('identity_mismatch'); }
const permissions = ['secretmanager.secrets.get', 'secretmanager.secrets.delete', 'secretmanager.secrets.getIamPolicy', 'secretmanager.versions.list'];
function selections(intent: Intent) {
  const output = operatorOutputSelectionSchema.parse(intent.outputs), retirement = intent.retirement;
  if (intent.mode !== 'retire' || !retirement?.continueFrom || retirement.data !== 'delete-owned' || !retirement.outputTargets || output.hostingProvider !== 'cloudrun') fail();
  return output.destinations.filter(destination => retirement.outputTargets!.some(target => target.key === destination.key)).map(destination => {
    const chosen = retirement.outputTargets!.filter(target => target.key === destination.key);
    if (!chosen.length || chosen.some(item => item.role !== destination.role) || destination.binding.destination.provider !== 'gcp-secret-manager'
      || destination.binding.owner.key !== destination.key || destination.binding.owner.repository !== intent.source.repository
      || destination.binding.owner.environment !== intent.environment) fail();
    const versions = chosen.map(item => item.version).sort(); if (new Set(versions).size !== versions.length) fail();
    return { ...destination, versions };
  });
}
function actions(intent: Intent): CloudInstallationAction[] {
  const selected = selections(intent);
  if (!selected.length || selected.reduce((total, item) => total + item.versions.length, 0) !== intent.retirement!.outputTargets!.length) fail();
  return selected.map(({ key, role, binding, versions }) => ({ id: `operator-output:delete:${key}`, type: 'destroy', verified: true,
    requiresConfirm: true, dataBearing: true, resource: { kind: 'secret', name: key, provider: intent.applicationProvider },
    reason: `Permanently delete the entire owned ${key} secret container, currently containing reviewed versions (${versions.join(', ')}).`,
    metadata: { operation: 'operator-output-retirement', category: 'secret-container', execution: 'api', native: {
      key, role, resource: binding.resource!, createTime: binding.createTime!, versions: JSON.stringify(versions),
      ownerDigest: secretContainerScopeDigest(binding), attemptId: binding.attemptId,
    } } }));
}
function selectedAction(value: unknown, intent: Intent) {
  const action = actions(intent).find(item => isDeepStrictEqual(item, value)); return action ?? fail();
}
function evidence(action: CloudInstallationAction) {
  return { resources: [{ kind: 'operator-output-container', id: action.metadata.native.resource as string,
    identity: { createTime: action.metadata.native.createTime as string, versions: action.metadata.native.versions as string,
      ownerDigest: action.metadata.native.ownerDigest as string, attemptId: action.metadata.native.attemptId as string } }],
    native: { operation: 'operator-output-retirement', retirement: { outcome: 'removed' as const, retained: [] } } };
}
const policySchema = z.object({ bindings: z.array(z.object({ role: z.string().min(1).max(1024), members: z.array(z.string().min(1).max(1024)).max(1000), condition: z.unknown().optional() }).passthrough()).max(100).default([]) }).passthrough();
function validateTargets(intent: Intent, targets: Record[]) {
  actions(intent);
  for (const selected of intent.retirement!.outputTargets!) {
    const record = targets.find(item => item.installationId === selected.from.installationId && item.plan.digest === selected.from.planDigest);
    const expected = intent.retirement!.targets.find(item => item.installationId === record?.installationId), prior = record && historicalInstallationEvidence(record);
    if (!record || !expected || !prior || expected.evidenceDigest !== canonicalJsonSha256(prior) || record.intent.mode !== 'connect'
      || record.intent.applicationProvider !== intent.applicationProvider || record.intent.provider !== intent.provider
      || record.intent.appId !== intent.appId || record.intent.customerId !== intent.customerId || record.intent.environment !== intent.environment
      || record.intent.source.repository !== intent.source.repository || !isDeepStrictEqual(record.intent.nativeScope, intent.nativeScope)) fail();
    const matches = Object.values(prior).filter(item => item.native.operation === 'operator-output').map(item => parseOperatorOutputEvidence(item, record.intent));
    const proof = matches.find(item => { const identity = item.resources[0].identity;
      return identity.key === selected.key && identity.role === selected.role && runtimeSecretReferenceSchema.parse(JSON.parse(identity.reference)).version === selected.version; });
    const destination = selections(intent).find(item => item.key === selected.key);
    const original = record.intent.outputs?.destinations.find(item => item.key === selected.key);
    if (!proof || !destination || !original || !isDeepStrictEqual(original.binding, destination.binding)
      || !record.attempts.some(attempt => attempt.id === proof.native.attemptId && attempt.status === 'succeeded' && isDeepStrictEqual(attempt.evidence, proof))
      || record.plan.actions.some(action => record.attempts.filter(attempt => attempt.actionId === action.id).at(-1)?.status !== 'succeeded' && action.type !== 'noop')) fail();
  }
}
/** Exact owned containers only. No value reads, role edits, recreation or delete retry. */
export function createGcpOperatorOutputRetirementDriver(authentication: { token(): Promise<string>; request: typeof fetch } | undefined,
  targets?: Record[], provider: Intent['applicationProvider'] = targets?.[0]?.intent.applicationProvider ?? 'sendgrid'): CloudInstallationDriver<Intent> {
  async function inspectNative(context: Context, action: CloudInstallationAction) {
    selectedAction(action, context.intent); if (!authentication || !targets) fail(); validateTargets(context.intent, targets);
    const selected = selections(context.intent).find(item => item.key === action.metadata.native.key)!, binding = selected.binding, destination = binding.destination;
    if (destination.provider !== 'gcp-secret-manager') fail();
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(authentication.token());
      const read = async (url: string, init?: RequestInit) => {
        const result = await destinationJson(authentication.request, budget, url, token, init);
        if (JSON.stringify(result).includes(token)) fail(); return result;
      };
      await assertGcpProjectIdentity({ request: authentication.request, budget, token, projectId: destination.projectId, projectNumber: destination.projectNumber });
      // Parent-scoped read authority is required even after child deletion. A
      // denied child read or an unauthorized/not-found response is never absence.
      const authority = await read(`https://cloudresourcemanager.googleapis.com/v1/projects/${destination.projectId}:testIamPermissions`,
        { method: 'POST', body: JSON.stringify({ permissions }) });
      if (!isDeepStrictEqual(z.array(z.string()).parse(authority.permissions).sort(), [...permissions].sort())) fail();
      const projectPolicy = policySchema.parse(await read(`https://cloudresourcemanager.googleapis.com/v1/projects/${destination.projectId}:getIamPolicy`,
        { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }));
      for (const grant of projectPolicy.bindings) {
        if (grant.members.every(member => member.startsWith('user:'))) continue;
        if (grant.condition || grant.members.some(member => !member.startsWith('serviceAccount:') && !member.startsWith('user:'))) fail();
        if (!/^(roles\/[a-zA-Z0-9_.]+|projects\/[a-zA-Z0-9-]+\/roles\/[a-zA-Z0-9_.]+)$/.test(grant.role)
          || grant.role.startsWith('projects/') && ![destination.projectId, destination.projectNumber].includes(grant.role.split('/')[1])) fail();
        const role = await read(`https://iam.googleapis.com/v1/${grant.role}`);
        if (role.name !== grant.role || role.deleted === true || !Array.isArray(role.includedPermissions)
          || z.array(z.string().min(1).max(200)).max(5000).parse(role.includedPermissions).some(permission => permission.startsWith('secretmanager.')
            || ['resourcemanager.projects.setIamPolicy', 'iam.roles.update', 'iam.roles.create'].includes(permission))) fail();
      }
      let native: { [key: string]: unknown };
      try { native = await read(`https://secretmanager.googleapis.com/v1/${binding.resource}`); }
      catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return { absent: true as const }; throw error; }
      const labels = z.record(z.string(), z.string()).parse(native.labels);
      if (native.name !== binding.resource || native.createTime !== binding.createTime || labels['hv-secret-scope'] !== secretContainerScopeDigest(binding)
        || labels['hv-secret-attempt'] !== binding.attemptId || !isDeepStrictEqual(native.replication, { automatic: {} })
        || native.versionDestroyTtl || native.rotation || native.expireTime || native.ttl || native.topics || native.versionAliases
        || !z.string().min(1).max(1024).safeParse(native.etag).success) fail();
      const policy = policySchema.parse(await read(`https://secretmanager.googleapis.com/v1/${binding.resource}:getIamPolicy?options.requestedPolicyVersion=3`));
      if (policy.bindings.some(grant => grant.condition || grant.members.some(member => !member.startsWith('user:')))) fail();
      const versions: string[] = []; let pageToken: string | undefined; const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
        const result = await read(`https://secretmanager.googleapis.com/v1/${binding.resource}/versions?${query}`);
        for (const version of z.array(z.object({ name: z.string(), state: z.enum(['ENABLED', 'DISABLED', 'DESTROYED']), createTime: z.string().datetime(),
          etag: z.string().min(1).max(1024), scheduledDestroyTime: z.string().datetime().optional() }).passthrough()).max(100).parse(result.versions ?? [])) {
          if (!version.name.startsWith(`${binding.resource}/versions/`) || version.scheduledDestroyTime) fail();
          const number = version.name.slice(`${binding.resource}/versions/`.length);
          if (!/^[1-9][0-9]{0,19}$/.test(number) || versions.includes(number)) fail(); versions.push(number);
        }
        if (result.nextPageToken === undefined || result.nextPageToken === '') {
          if (!isDeepStrictEqual(versions.sort(), selected.versions)) fail();
          return { absent: false as const, etag: native.etag as string };
        }
        pageToken = z.string().min(1).max(4096).parse(result.nextPageToken); if (seen.has(pageToken)) fail(); seen.add(pageToken);
      }
      return fail();
    } finally { budget.close(); }
  }
  const reason = (error: unknown) => error instanceof CloudInstallationBoundaryError ? error.reason
    : error instanceof DestinationBoundaryError && error.code === 'deadline_exceeded' ? 'timeout' as const
    : error instanceof DestinationBoundaryError && error.status === 401 ? 'authorization_expired' as const
    : error instanceof DestinationBoundaryError && error.status === 403 ? 'insufficient_permissions' as const : 'provider_error' as const;
  const driver: CloudInstallationDriver<Intent> = {
    provider, operatorApplication: { providerName: provider }, operatorRetirement: { schemaVersion: 1 },
    parseScope: value => z.record(z.string(), z.string()).parse(value), parseAction: selectedAction,
    parseEvidence(value, intent) { const parsed = actions(intent).map(evidence).find(item => isDeepStrictEqual(item, value)); if (!parsed) fail(); operatorRetirementOutcomeSchema.parse(parsed.native.retirement); return parsed; },
    scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: () => [] }, connections: () => [],
    async plan(context) { if (!targets) fail(); validateTargets(context.intent, targets); const planned = actions(context.intent);
      for (const action of planned) await inspectNative(context, action);
      return { actions: planned, review: { resources: planned.map(action => ({ kind: 'secret-container-and-all-versions',
        name: String(action.metadata.native.resource), scope: `Current reviewed versions: ${action.metadata.native.versions}` })), permissions: [
          ...planned.map(action => ({ principal: 'Current local operator', scope: String(action.metadata.native.resource), actions: permissions, purpose: 'installation-verification' as const })),
          ...[...new Set(selections(context.intent).map(item => item.binding.destination.provider === 'gcp-secret-manager' ? item.binding.destination.projectId : fail()))].map(projectId => ({
            principal: 'Current local operator', scope: `projects/${projectId}`, actions: ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'iam.roles.get'], purpose: 'installation-verification' as const,
          })),
        ],
        costs: [{ resource: 'Owned Secret Manager containers', description: 'Deletion stops storage charges for these exact secret containers; ordinary API operation charges may apply.', pricingUrl: 'https://cloud.google.com/secret-manager/pricing' }],
        warnings: ['Permanently deletes each entire selected container and all its versions. The listed versions are its current verified contents; no secret values are read.',
          'Managed consumers and writer trust must be removed first. The container ETag does not lock version inventory. A version added by an external administrator after the final check would also be permanently deleted; prevent external changes during this cleanup.'] } }; },
    async inspect(context) { try { return (await inspectNative(context, context.action)).absent ? { state: 'satisfied', evidence: evidence(context.action) } : { state: 'action-required' }; } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let dispatched = false;
      try {
        const native = await inspectNative(context, context.action); if (native.absent) return { state: 'acknowledged' };
        await context.beforeMutation();
        const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
        try { const token = await budget.wait(authentication!.token()); dispatched = true;
          const response = await destinationJson(authentication!.request, budget,
            `https://secretmanager.googleapis.com/v1/${context.action.metadata.native.resource}?${new URLSearchParams({ etag: native.etag })}`, token, { method: 'DELETE' });
          if (Object.keys(response).length) fail(); return { state: 'acknowledged' };
        } finally { budget.close(); }
      } catch (error) { return { state: dispatched ? 'uncertain' : 'rejected', reason: reason(error) }; }
    },
    async recover(context) { const result = await driver.inspect(context); return result.state === 'action-required' ? { state: 'pending', reason: 'not_converged' } : result; },
  };
  return driver;
}
export function parseGcpOperatorOutputRetirementRecord(value: unknown): Record {
  const provider = z.object({ intent: z.object({ applicationProvider: z.enum(['github-app', 'google-oauth', 'google-recaptcha', 'sendgrid', 'microsoft-entra']) }) }).parse(value).intent.applicationProvider;
  return parseCloudInstallationRecordV1(value, createGcpOperatorOutputRetirementDriver(undefined, undefined, provider));
}
