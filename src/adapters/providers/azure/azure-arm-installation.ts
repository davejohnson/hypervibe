import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAttempt } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBoundaryError, type DestinationBudget, destinationJson } from '../secret-destination-http.js';

const ARM = 'https://management.azure.com';
const API = '2025-04-01';
/** Native acknowledgment, not a claim that ARM supports create-only writes. */
export const azureDeploymentProvenanceSchema = z.object({ id: z.string().max(2048), correlationId: z.string().guid(),
  templateHash: z.string().regex(/^\d{1,30}$/), createdAt: z.string().datetime({ offset: true }),
  operation: z.object({ id: z.string().max(2048), serviceRequestId: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/),
    statusCode: z.enum(['Created', '201']) }).strict().optional() }).strict();
export type AzureDeploymentProvenance = z.infer<typeof azureDeploymentProvenanceSchema>;
export interface AzureInstallationTarget {
  id: string;
  apiVersion: string;
  type: string;
  name: string;
  deploymentScope: string;
  location: string;
  subscriptionScope: boolean;
}
function failure(reason: 'identity_mismatch' | 'ownership_mismatch' | 'not_converged' | 'not_installed'): never {
  throw new CloudInstallationBoundaryError(reason);
}
function sameId(a: unknown, b: string) { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
export function azureInstallationDeploymentId(target: AzureInstallationTarget, attempt: CloudInstallationAttempt) {
  return `${target.deploymentScope}/providers/Microsoft.Resources/deployments/hv-${z.string().guid().parse(attempt.id)}`;
}
export function rejectAzureCredentialEcho(value: unknown, token: string) {
  if (token && JSON.stringify(value).includes(token)) failure('identity_mismatch');
}
function provenance(value: Record<string, unknown>, id: string, attempt: CloudInstallationAttempt, token: string): AzureDeploymentProvenance {
  rejectAzureCredentialEcho(value, token);
  const properties = value.properties as Record<string, unknown> | undefined;
  const systemData = value.systemData as Record<string, unknown> | undefined;
  const parsed = azureDeploymentProvenanceSchema.safeParse({ id: value.id, correlationId: properties?.correlationId,
    templateHash: properties?.templateHash, createdAt: systemData?.createdAt });
  if (!parsed.success || !sameId(parsed.data.id, id) || value.type !== 'Microsoft.Resources/deployments'
    || Date.parse(parsed.data.createdAt) < Date.parse(attempt.startedAt)) failure('identity_mismatch');
  return { ...parsed.data, id };
}

/** One reviewed target per native deployment. Never retries an uncertain PUT. */
export async function createAzureInstallationDeployment(input: {
  request: typeof fetch; budget: DestinationBudget; token: string; target: AzureInstallationTarget;
  attempt: CloudInstallationAttempt; resource: Record<string, unknown>; beforeMutation(): Promise<void>; dispatched(): void;
}): Promise<AzureDeploymentProvenance> {
  const { target, attempt, request, budget, token } = input;
  const id = azureInstallationDeploymentId(target, attempt);
  try {
    await destinationJson(request, budget, `${ARM}${id}?api-version=${API}`, token);
    failure('ownership_mismatch');
  } catch (error) {
    if (!(error instanceof DestinationBoundaryError && error.status === 404)) throw error;
  }
  // Namespace exclusivity is reviewed authority, not an undocumented conditional
  // header. An independently authorized actor can race this native upsert.
  const resource = { type: target.type, apiVersion: target.apiVersion, name: target.name, ...input.resource };
  const body = { ...(target.subscriptionScope ? { location: target.location } : {}), properties: { mode: 'Incremental',
    template: { $schema: `https://schema.management.azure.com/schemas/${target.subscriptionScope ? '2018-05-01/subscriptionDeploymentTemplate' : '2019-04-01/deploymentTemplate'}.json#`,
      contentVersion: '1.0.0.0', resources: [resource] } } };
  await budget.wait(input.beforeMutation());
  if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
  input.dispatched();
  let status: number | undefined;
  const response = await destinationJson(async (url, init) => {
    const result = await request(url, init); status = result.status; return result;
  }, budget, `${ARM}${id}?api-version=${API}`, token, { method: 'PUT', body: JSON.stringify(body) });
  // A same-name deployment update can replace history. It is never our new
  // installation acknowledgment, even when its template happens to match.
  if (status !== 201) failure('ownership_mismatch');
  return provenance(response, id, attempt, token);
}

export async function verifyAzureInstallationDeployment(input: {
  request: typeof fetch; budget: DestinationBudget; token: string; target: AzureInstallationTarget;
  attempt: CloudInstallationAttempt; retained: AzureDeploymentProvenance;
}): Promise<AzureDeploymentProvenance> {
  const { target, attempt, request, budget, token } = input;
  const id = azureInstallationDeploymentId(target, attempt);
  const retained = azureDeploymentProvenanceSchema.parse(input.retained);
  if (!sameId(retained.id, id)) failure('identity_mismatch');
  const current = await destinationJson(request, budget, `${ARM}${id}?api-version=${API}`, token);
  const identity = provenance(current, id, attempt, token);
  const { operation: retainedOperation, ...retainedDeployment } = retained;
  if (JSON.stringify(identity) !== JSON.stringify(retainedDeployment)) failure('identity_mismatch');
  const properties = current.properties as Record<string, unknown>;
  if (properties.provisioningState !== 'Succeeded') failure('not_converged');
  const outputs = z.array(z.object({ id: z.string() })).safeParse(properties.outputResources);
  if (!outputs.success || outputs.data.length !== 1 || !sameId(outputs.data[0].id, target.id)) failure('identity_mismatch');
  // The ARM 2025-04-01 published operations route omits /providers/Microsoft.Resources
  // at resource-group scope. Subscription scope uses the provider-qualified route.
  const operationBase = target.subscriptionScope ? id : `${target.deploymentScope}/deployments/hv-${attempt.id}`;
  const operations = await destinationJson(request, budget, `${ARM}${operationBase}/operations?api-version=${API}`, token);
  rejectAzureCredentialEcho(operations, token);
  if (!Array.isArray(operations.value) || operations.value.length > 100 || operations.nextLink) failure('not_converged');
  const writes = operations.value.filter((value: any) => value?.properties?.targetResource);
  if (writes.length !== 1) failure('identity_mismatch');
  const operation = writes[0], p = operation.properties;
  if (!sameId(operation.id, `${id}/operations/${operation.operationId}`) || typeof operation.operationId !== 'string'
    || !/^[A-Za-z0-9-]{1,100}$/.test(operation.operationId) || typeof p.serviceRequestId !== 'string' || !p.serviceRequestId
    || !sameId(p.targetResource.id, target.id) || !sameId(p.targetResource.resourceType, target.type)
    || p.targetResource.apiVersion !== undefined && p.targetResource.apiVersion !== target.apiVersion) failure('identity_mismatch');
  if (p.provisioningState !== 'Succeeded') failure('not_converged');
  if (p.provisioningOperation !== 'Create') failure('ownership_mismatch');
  if (p.statusCode === 'OK' || p.statusCode === '200') failure('ownership_mismatch');
  if (p.statusCode !== 'Created' && p.statusCode !== '201') failure('not_converged');
  const result = azureDeploymentProvenanceSchema.parse({ ...identity, operation: {
    id: operation.id, serviceRequestId: p.serviceRequestId, statusCode: p.statusCode,
  } });
  if (retainedOperation && JSON.stringify(result.operation) !== JSON.stringify(retainedOperation)) failure('identity_mismatch');
  return result;
}
