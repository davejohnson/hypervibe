import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { gcpBillingPreparationScopeSchema } from './gcp-billing-installation.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';

// This prerequisite must remain independent of the API it enables. In
// particular, a billingInfo read would recreate the observed quota deadlock.
const api = 'cloudbilling.googleapis.com';
const operation = 'enable-quota-api-v1';
const readPermissions = ['serviceusage.services.get', 'serviceusage.services.use'];
const enablePermission = 'serviceusage.services.enable';
export const gcpLocalQuotaApiScopeSchema = gcpBillingPreparationScopeSchema.omit({ billingAccountName: true, assignmentMode: true })
  .extend({ scopeKind: z.literal('project-quota-api-v1') }).strict();
const evidenceSchema = z.object({
  resources: z.array(z.object({ kind: z.literal('service'), id: z.string(), identity: z.object({ state: z.literal('ENABLED') }).strict() }).strict()).max(1),
  native: z.object({ operation: z.literal(operation), installationId: z.string().guid(), quotaProjectId: z.string(),
    operationName: z.string().regex(/^operations\/[A-Za-z0-9._~-]{1,255}$/).optional() }).strict(),
}).strict();
type Context = CloudInstallationProviderContext<LocalCloudScopePreparationIntent>;
function name(intent: LocalCloudScopePreparationIntent): string {
  return `projects/${gcpLocalQuotaApiScopeSchema.parse(intent.nativeScope).projectNumber}/services/${api}`;
}
function action(intent: LocalCloudScopePreparationIntent, enabled = false): CloudInstallationAction {
  const scope = gcpLocalQuotaApiScopeSchema.parse(intent.nativeScope);
  return { id: `gcp:local-scope:quota-api:${api}`, type: enabled ? 'noop' : 'update',
    resource: { kind: 'project', name: name(intent), provider: 'gcp' }, verified: true, requiresConfirm: !enabled,
    reason: enabled ? 'Verify the already enabled Cloud Billing API in this exact quota project without changing it.'
      : 'Enable only the Cloud Billing API in this exact project so separately authorized requests can use its quota. Google may automatically create service identities or grant roles.',
    metadata: { operation, category: 'scope', execution: 'api', native: { service: api, quotaProjectId: scope.projectId } } };
}
function evidence(intent: LocalCloudScopePreparationIntent, complete: boolean, operationName?: string): CloudInstallationEvidence {
  return { resources: complete ? [{ kind: 'service', id: name(intent), identity: { state: 'ENABLED' } }] : [],
    native: { operation, installationId: intent.installationId, quotaProjectId: intent.nativeScope.projectId, ...(operationName ? { operationName } : {}) } };
}
function reason(error: unknown) {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.status === 403 ? 'insufficient_permissions' as const
    : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const;
  return 'provider_error' as const;
}
export function createGcpLocalQuotaApiDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<LocalCloudScopePreparationIntent> {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient) => Promise<T>): Promise<T> {
    const scope = gcpLocalQuotaApiScopeSchema.parse(context.intent.nativeScope);
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request, beforeWrite: context.beforeMutation, sleep: async () => {} });
      const project = await client.bootstrap.getProject(scope.projectId);
      const owner = createHash('sha256').update(JSON.stringify([context.intent.customerId, context.intent.appId, context.intent.environment, scope.projectInstallationId])).digest('hex');
      if (!project || project.name !== `projects/${scope.projectNumber}` || project.projectId !== scope.projectId || project.state !== 'ACTIVE'
        || project.createTime !== scope.projectCreateTime || (project.parent ?? 'none') !== scope.projectParent
        || project.labels?.['hv-installation'] !== owner.slice(0, 63) || project.labels?.['hv-attempt'] !== scope.projectAttemptId)
        throw new CloudInstallationBoundaryError('ownership_mismatch');
      return await work(client);
    } finally { budget.close(); }
  }
  async function permissions(client: GcpSecretWriterClient, intent: LocalCloudScopePreparationIntent, enable = false): Promise<void> {
    const required = [...readPermissions, ...(enable ? [enablePermission] : [])];
    const response = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${intent.nativeScope.projectNumber}:testIamPermissions`,
      { method: 'POST', body: JSON.stringify({ permissions: required }) });
    const granted = response.permissions;
    if (!Array.isArray(granted) || !required.every(permission => granted.includes(permission)))
      throw new CloudInstallationBoundaryError('insufficient_permissions');
  }
  async function enabled(client: GcpSecretWriterClient, intent: LocalCloudScopePreparationIntent): Promise<boolean> {
    const response = await client.service(name(intent));
    if (response.name !== name(intent) || !['ENABLED', 'DISABLED'].includes(String(response.state)))
      throw new CloudInstallationBoundaryError('provider_error');
    return response.state === 'ENABLED';
  }
  const driver: CloudInstallationDriver<LocalCloudScopePreparationIntent> = {
    provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun', continuation: true },
    parseScope: value => gcpLocalQuotaApiScopeSchema.parse(value),
    parseAction(value, intent) {
      for (const candidate of [action(intent), action(intent, true)]) if (isDeepStrictEqual(candidate, value)) return candidate;
      throw new CloudInstallationBoundaryError('identity_mismatch');
    },
    parseEvidence(value, intent) {
      const parsed = evidenceSchema.parse(value);
      if (parsed.native.installationId !== intent.installationId || parsed.native.quotaProjectId !== intent.nativeScope.projectId
        || (!parsed.resources.length && !parsed.native.operationName)
        || parsed.resources.length && !isDeepStrictEqual(parsed.resources, evidence(intent, true).resources))
        throw new CloudInstallationBoundaryError('identity_mismatch');
      return parsed;
    },
    scopePreparation: {
      resolvedScope(record) {
        if (record.status !== 'scope-ready' || !record.completed[action(record.intent).id]?.resources.length)
          throw new CloudInstallationBoundaryError('not_converged');
        return gcpLocalQuotaApiScopeSchema.parse(record.intent.nativeScope);
      },
      reviewResources: record => [{ kind: 'quota-project', name: record.intent.nativeScope.projectId, scope: `projects/${record.intent.nativeScope.projectNumber}` }],
    },
    async plan(context) {
      const complete = await withClient(context, async client => {
        const ready = await enabled(client, context.intent); await permissions(client, context.intent, !ready); return ready;
      });
      return { actions: [action(context.intent, complete)], review: {
        resources: [{ kind: 'api', name: api, scope: `projects/${context.intent.nativeScope.projectNumber}` }],
        permissions: [{ principal: 'Local browser-authorized administrator', scope: `projects/${context.intent.nativeScope.projectNumber}`,
          actions: [...readPermissions, ...(!complete ? [enablePermission] : [])], purpose: 'installation-verification' }],
        costs: [], warnings: [
          `For subsequent owned invocations, carry this reviewed quota selection as GOOGLE_CLOUD_QUOTA_PROJECT=${context.intent.nativeScope.projectId}; preserve any different explicit quota selection for separate review.`,
          'This stage changes no credential files, billing association, application workload or stored secret. Quota attribution is separate from resource placement and the billing account.',
          'Google may automatically create service identities or grant roles when an API is enabled. Later API usage and separately approved resources can incur charges.',
          'An uncertain enable response is reconciled through the exact service state and is never automatically resubmitted.',
        ],
      } };
    },
    async inspect(context) {
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async client => {
          await permissions(client, context.intent);
          return await enabled(client, context.intent)
            ? { state: 'satisfied' as const, evidence: evidence(context.intent, true, context.completed[context.action.id]?.native.operationName as string | undefined) }
            : { state: 'action-required' as const };
        });
      } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    async mutate(context) {
      let mayHaveWritten = () => false;
      try {
        driver.parseAction(context.action, context.intent);
        if (context.action.type === 'noop') throw new CloudInstallationBoundaryError('confirmation_required');
        return await withClient(context, async client => {
          await permissions(client, context.intent, true);
          if (await enabled(client, context.intent)) throw new CloudInstallationBoundaryError('not_converged');
          client.beginMutation(); mayHaveWritten = () => !client.canRetryRejectedMutation();
          const response = await client.json(`https://serviceusage.googleapis.com/v1/${name(context.intent)}:enable`, { method: 'POST', body: '{}' }, true);
          if (response.error !== undefined || response.done !== undefined && typeof response.done !== 'boolean')
            throw new CloudInstallationBoundaryError('provider_error');
          const proof = driver.parseEvidence(evidence(context.intent, false, z.string().parse(response.name)), context.intent);
          return { state: 'acknowledged' as const, evidence: proof };
        });
      } catch (error) { return { state: mayHaveWritten() ? 'uncertain' : 'rejected', reason: reason(error) }; }
    },
    async recover(context) {
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async client => {
          await permissions(client, context.intent);
          return await enabled(client, context.intent)
            ? { state: 'satisfied' as const, evidence: evidence(context.intent, true, context.attempt.evidence?.native.operationName as string | undefined) }
            : { state: 'pending' as const, reason: 'not_converged' as const };
        });
      } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    connections: () => [],
  };
  return driver;
}
