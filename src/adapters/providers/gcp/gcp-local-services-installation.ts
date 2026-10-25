import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';
import { gcpBillingPreparationScopeSchema } from './gcp-billing-installation.js';

// Reviewed bounded set for Cloud Run, Cloud SQL, runtime secrets, managed CI,
// backup jobs/schedules and identity federation. No workloads are created here.
export const GCP_OPERATOR_SERVICES = ['artifactregistry.googleapis.com', 'cloudbuild.googleapis.com',
  'cloudresourcemanager.googleapis.com', 'cloudscheduler.googleapis.com', 'compute.googleapis.com',
  'iam.googleapis.com', 'iamcredentials.googleapis.com', 'logging.googleapis.com', 'run.googleapis.com',
  'secretmanager.googleapis.com', 'serviceusage.googleapis.com', 'sqladmin.googleapis.com', 'storage.googleapis.com', 'sts.googleapis.com'] as const;
export const gcpLocalServicesScopeSchema = gcpBillingPreparationScopeSchema.omit({ assignmentMode: true }).extend({ scopeKind: z.literal('project-services') }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.literal('service'), id: z.string(), identity: z.object({ state: z.literal('ENABLED') }).strict() }).strict()).max(20),
  native: z.object({ operation: z.literal('enable-operator-services-v1'), installationId: z.string().guid(),
    operationName: z.string().regex(/^operations\/[A-Za-z0-9._~-]{1,255}$/).optional() }).strict() }).strict();
type Context = CloudInstallationProviderContext<LocalCloudScopePreparationIntent>;
function action(intent: LocalCloudScopePreparationIntent): CloudInstallationAction {
  const scope = gcpLocalServicesScopeSchema.parse(intent.nativeScope);
  return { id: 'gcp:local-scope:services', type: 'update', resource: { kind: 'project', name: `projects/${scope.projectNumber}`, provider: 'gcp' },
    verified: true, requiresConfirm: true,
    reason: 'Enable only the reviewed operator hosting APIs in the exact allocated project; create no workloads or identities.',
    metadata: { operation: 'enable-operator-services-v1', category: 'scope', execution: 'api', native: { services: [...GCP_OPERATOR_SERVICES] } } };
}
function evidence(intent: LocalCloudScopePreparationIntent, complete: boolean, operationName?: string): CloudInstallationEvidence {
  const scope = gcpLocalServicesScopeSchema.parse(intent.nativeScope);
  return { resources: complete ? GCP_OPERATOR_SERVICES.map(api => ({ kind: 'service', id: `projects/${scope.projectNumber}/services/${api}`, identity: { state: 'ENABLED' } })) : [],
    native: { operation: 'enable-operator-services-v1', installationId: intent.installationId, ...(operationName ? { operationName } : {}) } };
}
function reason(error: unknown) {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const;
  return 'provider_error' as const;
}
export function createGcpLocalServicesDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<LocalCloudScopePreparationIntent> {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient) => Promise<T>): Promise<T> {
    const scope = gcpLocalServicesScopeSchema.parse(context.intent.nativeScope);
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
      const billing = await client.bootstrap.getProjectBillingInfo(scope.projectId);
      if (!billing || billing.billingAccountName !== scope.billingAccountName || !billing.billingEnabled) throw new CloudInstallationBoundaryError('ownership_mismatch');
      return await work(client);
    } finally { budget.close(); }
  }
  async function enabled(client: GcpSecretWriterClient, intent: LocalCloudScopePreparationIntent): Promise<boolean> {
    const scope = gcpLocalServicesScopeSchema.parse(intent.nativeScope); let complete = true;
    for (const api of GCP_OPERATOR_SERVICES) {
      const name = `projects/${scope.projectNumber}/services/${api}`;
      const response = await client.json(`https://serviceusage.googleapis.com/v1/${name}`);
      if (response.name !== name || typeof response.state !== 'string' || !['ENABLED', 'DISABLED'].includes(response.state)) throw new CloudInstallationBoundaryError('provider_error');
      if (response.state !== 'ENABLED') complete = false;
    }
    return complete;
  }
  const driver: CloudInstallationDriver<LocalCloudScopePreparationIntent> = {
    provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun', continuation: true },
    parseScope: value => gcpLocalServicesScopeSchema.parse(value),
    parseAction(value, intent) { const expected = action(intent); if (!isDeepStrictEqual(expected, value)) throw new CloudInstallationBoundaryError('identity_mismatch'); return expected; },
    parseEvidence(value, intent) {
      const parsed = evidenceSchema.parse(value);
      if (parsed.native.installationId !== intent.installationId || (!parsed.resources.length && !parsed.native.operationName)
        || parsed.resources.length && !isDeepStrictEqual(parsed.resources, evidence(intent, true).resources)) throw new CloudInstallationBoundaryError('identity_mismatch');
      return parsed;
    },
    scopePreparation: { resolvedScope(record) {
      if (record.status !== 'scope-ready' || !record.completed[action(record.intent).id]?.resources.length) throw new CloudInstallationBoundaryError('not_converged');
      return gcpLocalServicesScopeSchema.parse(record.intent.nativeScope);
    }, reviewResources(record) { return [{ kind: 'project', name: record.intent.nativeScope.projectId, scope: `projects/${record.intent.nativeScope.projectNumber}` }]; } },
    async plan(context) {
      await withClient(context, async client => {
        await enabled(client, context.intent);
        const response = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${context.intent.nativeScope.projectNumber}:testIamPermissions`,
          { method: 'POST', body: JSON.stringify({ permissions: ['serviceusage.services.get', 'serviceusage.services.enable'] }) });
        const permissions = response.permissions;
        if (!Array.isArray(permissions) || !['serviceusage.services.get', 'serviceusage.services.enable'].every(permission => permissions.includes(permission)))
          throw new CloudInstallationBoundaryError('insufficient_permissions');
      });
      return { actions: [action(context.intent)], review: { resources: GCP_OPERATOR_SERVICES.map(name => ({ kind: 'api', name, scope: `projects/${context.intent.nativeScope.projectNumber}` })),
        permissions: [{ principal: 'Local browser-authorized administrator', scope: `projects/${context.intent.nativeScope.projectNumber}`,
          actions: ['serviceusage.services.get', 'serviceusage.services.enable'], purpose: 'installation-verification' }],
        costs: [], warnings: ['API enablement creates no workloads. Later separately approved resources can incur charges.',
          'This native batch is atomic. An uncertain acknowledgment is recovered by reading these exact APIs; it never causes an automatic resubmission.'] } };
    },
    async inspect(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async client => await enabled(client, context.intent)
        ? { state: 'satisfied' as const, evidence: evidence(context.intent, true) } : { state: 'action-required' as const }); }
      catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    async mutate(context) {
      let write = false;
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async client => {
          if (await enabled(client, context.intent)) throw new CloudInstallationBoundaryError('not_converged');
          client.beginMutation(); write = true;
          const response = await client.json(`https://serviceusage.googleapis.com/v1/projects/${context.intent.nativeScope.projectNumber}/services:batchEnable`,
            { method: 'POST', body: JSON.stringify({ serviceIds: GCP_OPERATOR_SERVICES }) }, true);
          const proof = driver.parseEvidence(evidence(context.intent, false, z.string().parse(response.name)), context.intent);
          return { state: 'acknowledged' as const, evidence: proof };
        });
      } catch (error) { return { state: write ? 'uncertain' : 'rejected', reason: reason(error) }; }
    },
    async recover(context) {
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async client => await enabled(client, context.intent)
          ? { state: 'satisfied' as const, evidence: evidence(context.intent, true, context.attempt.evidence?.native.operationName as string | undefined) }
          : { state: 'pending' as const, reason: 'not_converged' as const });
      } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}
