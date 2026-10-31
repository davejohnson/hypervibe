import { createHash } from 'node:crypto';
import type { IStorageRuntimeAccess, StorageRuntimeAccessBinding, StorageRuntimeAccessTarget } from '../../../domain/ports/storage-runtime-access.port.js';
import { gcpRuntimeOwner } from './cloudrun-runtime-identities.js';
import { gcpRuntimeError, GcpRuntimeError, gcpRuntimeRequest, parseGcpRuntimePolicy, type GcpRuntimePolicy } from './gcp-runtime-client.js';

const ROLE = 'roles/storage.objectUser';
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/** Bucket IAM is an explicit lifecycle resource, never a getRuntimeEnv side effect. */
export class GcsRuntimeAccess implements IStorageRuntimeAccess {
  readonly hostingProviders = ['cloudrun'] as const;
  constructor(private readonly connected: () => Promise<{ projectId: string; managementEmail?: string; token: string }>, private readonly fetcher: typeof fetch) {}

  private coordinates(target: StorageRuntimeAccessTarget) {
    const { identity, environment, context } = target; const scope = identity.scope;
    if (identity.provider !== 'gcp' || !['observed', 'configured'].includes(identity.source) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(context.projectId)
      || scope.projectId !== context.projectId || scope.environmentId !== environment.id || scope.serviceName !== target.serviceName
      || environment.platformBindings.projectId !== context.projectId || !/^[1-9][0-9]{5,30}$/.test(scope.serviceAccountUniqueId ?? '')
      || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(target.externalId)
      || !identity.principal.endsWith(`@${context.projectId}.iam.gserviceaccount.com`)
      || !scope.workloadUid || !scope.workloadResource?.startsWith(`projects/${context.projectId}/locations/`)
      || (identity.source === 'configured' && (!identity.activation?.workloadEtag || !identity.activation.previousPrincipal
        || !identity.activation.previousPrincipal.endsWith(`@${context.projectId}.iam.gserviceaccount.com`)))) {
      throw new GcpRuntimeError('GCS runtime access requires an independently verified per-service workload identity and exact bucket scope. A legacy shared identity needs an explicit reviewed transition.');
    }
    const resource = scope.workloadResource.match(/^projects\/([^/]+)\/locations\/([a-z]+-[a-z]+[0-9])\/(services|jobs)\/([a-z][a-z0-9-]{0,62})$/);
    const service = (environment.platformBindings.services as Record<string, { serviceId?: string; jobName?: string }> | undefined)?.[target.serviceName];
    if (!resource || (resource[3] === 'jobs' ? service?.jobName : service?.serviceId) !== resource[4]) throw new GcpRuntimeError('GCS workload access does not match the exact bound Cloud Run service or job.');
    const evidence = { projectId: context.projectId, bucket: target.externalId, principal: identity.principal,
      serviceAccountUniqueId: scope.serviceAccountUniqueId!, environmentId: environment.id, serviceName: target.serviceName, storageName: target.storageName,
      workloadResource: scope.workloadResource, workloadUid: scope.workloadUid };
    const id = 'hypervibe-storage-' + createHash('sha256').update(stable(evidence)).digest('hex');
    const resourceId = `projects/_/buckets/${target.externalId}`;
    return { evidence, id, resourceId, expression: `resource.name == '${resourceId}' || resource.name.startsWith('${resourceId}/objects/')`,
      iamUrl: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.externalId)}/iam`, job: resource[3] === 'jobs' };
  }

  private binding(target: StorageRuntimeAccessTarget, attemptId: string): StorageRuntimeAccessBinding {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(attemptId)) throw new GcpRuntimeError('GCS workload access requires its exact persisted creation attempt.');
    const scope = this.coordinates(target); return { id: scope.id, attemptId, evidence: scope.evidence };
  }

  private assertBinding(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding) {
    if (stable(binding) !== stable(this.binding(target, binding.attemptId))) throw new GcpRuntimeError('GCS access binding no longer matches its exact bucket and workload identity.');
  }

  private entry(target: StorageRuntimeAccessTarget, attemptId: string) {
    const scope = this.coordinates(target); this.binding(target, attemptId);
    return { role: ROLE, members: [`serviceAccount:${target.identity.principal}`], condition: {
      title: scope.id, description: `hypervibe:storage:v1:${attemptId}`, expression: scope.expression,
    } };
  }

  private async verify(target: StorageRuntimeAccessTarget, retiring = false) {
    const scope = this.coordinates(target); const connection = await this.connected();
    if (connection.projectId !== target.context.projectId || connection.managementEmail === target.identity.principal) throw new GcpRuntimeError('GCS access cannot use a deployment principal or a different Google project.');
    const request = (url: string, init?: RequestInit) => gcpRuntimeRequest(url, connection.token, init, this.fetcher);
    const bucket = await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.externalId)}`) as Record<string, any> | null;
    if (!bucket || bucket.name !== target.externalId || bucket.labels?.hypervibe_environment_id !== target.environment.id
      || bucket.labels?.hypervibe_storage_name !== target.storageName || bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) {
      throw new GcpRuntimeError('GCS bucket ownership and uniform bucket access could not be verified.');
    }
    const workload = await request(`https://run.googleapis.com/v2/${target.identity.scope.workloadResource}`) as Record<string, any> | null;
    const principal = scope.job ? workload?.template?.template?.serviceAccount : workload?.template?.serviceAccount;
    const preparing = target.identity.source === 'configured' && target.identity.activation
      && principal === target.identity.activation.previousPrincipal && workload?.etag === target.identity.activation.workloadEtag;
    if (!workload || workload.name !== target.identity.scope.workloadResource
      || workload.uid !== target.identity.scope.workloadUid || typeof principal !== 'string'
      || (!retiring && principal !== target.identity.principal && !preparing)) {
      throw new GcpRuntimeError('The Cloud Run workload principal changed or is unavailable.');
    }
    const account = await request(`https://iam.googleapis.com/v1/projects/${scope.evidence.projectId}/serviceAccounts/${scope.evidence.serviceAccountUniqueId}`) as Record<string, unknown> | null;
    const marker = gcpRuntimeOwner(scope.evidence.projectId, target.environment, target.serviceName);
    if (!account || account.uniqueId !== scope.evidence.serviceAccountUniqueId || account.projectId !== scope.evidence.projectId
      || account.email !== target.identity.principal || account.name !== `projects/${scope.evidence.projectId}/serviceAccounts/${target.identity.principal}`
      || (account.disabled !== undefined && account.disabled !== false) || typeof account.description !== 'string'
      || !account.description.startsWith(marker) || !/^[A-Za-z0-9-]{1,128}$/.test(account.description.slice(marker.length))) {
      throw new GcpRuntimeError('GCS runtime access cannot prove isolated ownership of the exact workload account.');
    }
    const projectPolicy = parseGcpRuntimePolicy(await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${scope.evidence.projectId}:getIamPolicy`,
      { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }));
    const member = `serviceAccount:${target.identity.principal}`;
    const knownNonStorageRoles = new Set(['roles/cloudsql.client', 'roles/secretmanager.secretAccessor', 'roles/pubsub.publisher', 'roles/pubsub.subscriber', 'roles/run.invoker']);
    if (!retiring && projectPolicy.bindings.some(binding => binding.members.includes(member) && !knownNonStorageRoles.has(binding.role))) {
      throw new GcpRuntimeError('The workload has broader or unknown project-level permissions. Review the legacy permission transition before claiming bucket-scoped access; existing grants were preserved.');
    }
    return { scope, request };
  }

  private async read(target: StorageRuntimeAccessTarget, retiring = false) {
    const verified = await this.verify(target, retiring);
    const policy = parseGcpRuntimePolicy(await verified.request(`${verified.scope.iamUrl}?optionsRequestedPolicyVersion=3`));
    if (policy.resourceId !== verified.scope.resourceId) throw new GcpRuntimeError('GCS IAM policy returned a different or missing bucket resource identity.');
    return { ...verified, policy };
  }

  private observed(target: StorageRuntimeAccessTarget, policy: GcpRuntimePolicy): StorageRuntimeAccessBinding | undefined {
    const scope = this.coordinates(target);
    const matching = policy.bindings.filter(binding => binding.condition?.title === scope.id);
    if (!matching.length) return undefined;
    if (matching.length !== 1) throw new GcpRuntimeError('GCS workload access has duplicate owned grant identities.');
    const description = matching[0]!.condition?.description;
    const prefix = 'hypervibe:storage:v1:';
    if (!description?.startsWith(prefix)) throw new GcpRuntimeError('GCS workload grant has no verifiable creation ownership.');
    const attemptId = description.slice(prefix.length);
    if (stable(matching[0]) !== stable(this.entry(target, attemptId))) throw new GcpRuntimeError('GCS workload grant has conflicting permissions or ownership.');
    return this.binding(target, attemptId);
  }

  async observe(target: StorageRuntimeAccessTarget, binding?: StorageRuntimeAccessBinding) {
    try {
      if (binding) this.assertBinding(target, binding);
      const current = this.observed(target, (await this.read(target)).policy);
      if (!current) return { state: 'absent' as const };
      if (binding && binding.attemptId !== current.attemptId) throw new GcpRuntimeError('GCS grant belongs to a different creation attempt.');
      return { state: 'present' as const, binding: current };
    } catch (error) { return { state: 'unknown' as const, reason: gcpRuntimeError(error) }; }
  }

  async grant(target: StorageRuntimeAccessTarget, attemptId: string, binding?: StorageRuntimeAccessBinding) {
    try {
      const expected = this.binding(target, attemptId); if (binding) this.assertBinding(target, binding);
      const current = await this.read(target); const owned = this.observed(target, current.policy);
      if (owned) {
        if (owned.attemptId !== attemptId || (binding && binding.attemptId !== attemptId)) throw new GcpRuntimeError('Existing GCS grant belongs to another attempt and cannot be adopted.');
        return { receipt: { success: true, message: 'Verified the exact existing bucket-scoped workload grant.' }, binding: owned };
      }
      if (binding) throw new GcpRuntimeError('The bound GCS grant is missing; re-plan its explicit replacement.');
      const desired = { ...current.policy, version: 3, bindings: [...current.policy.bindings, this.entry(target, attemptId)] };
      const acknowledged = parseGcpRuntimePolicy(await current.request(current.scope.iamUrl, { method: 'PUT', body: JSON.stringify(desired) }));
      if (acknowledged.resourceId !== current.scope.resourceId) throw new GcpRuntimeError('GCS grant acknowledgement omitted its exact bucket identity.');
      const observed = this.observed(target, (await this.read(target)).policy);
      if (stable(observed) !== stable(expected)) throw new GcpRuntimeError('GCS grant is not yet independently observable; retain its exact attempt.');
      return { receipt: { success: true, message: 'Verified the bucket-scoped workload grant; Google authorization propagation may still be pending.' }, binding: expected };
    } catch (error) { return { receipt: { success: false, message: 'GCS workload access did not converge.', error: gcpRuntimeError(error) } }; }
  }

  async revoke(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding) {
    try {
      this.assertBinding(target, binding); const current = await this.read(target, true); const owned = this.observed(target, current.policy);
      if (!owned) return { success: true, message: 'The exact owned GCS workload grant is already absent.' };
      if (stable(owned) !== stable(binding)) throw new GcpRuntimeError('The GCS grant was replaced; preserve it for explicit reconciliation.');
      const desired = { ...current.policy, version: 3, bindings: current.policy.bindings.filter(entry => entry.condition?.title !== binding.id) };
      parseGcpRuntimePolicy(await current.request(current.scope.iamUrl, { method: 'PUT', body: JSON.stringify(desired) }));
      if (this.observed(target, (await this.read(target, true)).policy)) throw new GcpRuntimeError('GCS workload grant removal has not converged.');
      return { success: true, message: 'Removed the exact owned GCS grant; cached Google authorization may take time to expire.' };
    } catch (error) { return { success: false, message: 'GCS workload access removal did not converge.', error: gcpRuntimeError(error) }; }
  }
}
