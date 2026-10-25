import { createHash } from 'node:crypto';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import type { IRuntimeIdentities, RuntimeIdentityBinding, RuntimeIdentityObservation, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { getGcpNativeAdminToken, gcpRuntimeError, GcpRuntimeError, gcpRuntimeRequest, hasGcpRuntimeRole, parseGcpRuntimePolicy, withGcpRuntimeRole } from './gcp-runtime-client.js';
import { cloudRunJobUpdateBody } from './cloudrun-job-request.js';
import { desiredRuntimeQueues, parseRuntimeQueues, readRuntimeQueuePolicies, serializeRuntimeQueues, unionRuntimeQueues, type GcpRuntimeQueue } from './gcp-runtime-queues.js';
import { hasRuntimeSecretConsumers, desiredRuntimeSecrets, parseRuntimeSecrets, readRuntimeSecretPolicies, serializeRuntimeSecrets, unionRuntimeSecrets, type GcpRuntimeSecret } from './gcp-runtime-secrets.js';

interface Scope { projectId: string; region: string; deployEmail: string }
const IAM = 'https://iam.googleapis.com/v1';
const attempt = (value: string) => /^[A-Za-z0-9-]{1,128}$/.test(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export function gcpRuntimeOwner(projectId: string, environment: Environment, serviceName: string): string {
  return 'hypervibe:runtime:v1:' + createHash('sha256').update(JSON.stringify([projectId, environment.projectId, environment.id, serviceName])).digest('hex') + ':';
}
export function gcpRuntimeAccount(projectId: string, environment: Environment, serviceName: string): string {
  return resourceName('runtime', { scope: [projectId, environment.projectId, environment.id, serviceName], minLength: 6, maxLength: 30 });
}

export class CloudRunRuntimeIdentities implements IRuntimeIdentities {
  constructor(private readonly connected: () => Scope, private readonly token: () => Promise<string>,
    private readonly workloadName: (environment: Environment, serviceName: string, boundId?: string) => string,
    private readonly adminToken: () => Promise<string> = getGcpNativeAdminToken) {}

  private coordinates(request: RuntimeIdentityRequest) {
    const scope = this.connected(); const { environment, service } = request;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(scope.projectId) || !/^[a-z]+-[a-z]+[0-9]$/.test(scope.region)
      || !scope.deployEmail.endsWith(`@${scope.projectId}.iam.gserviceaccount.com`)
      || environment.platformBindings.projectId !== scope.projectId
      || (environment.platformBindings.environmentId && environment.platformBindings.environmentId !== scope.region)
      || (environment.platformBindings.region && environment.platformBindings.region !== scope.region)) throw new GcpRuntimeError('Runtime identity requires the exact prepared Google project and region.');
    const accountId = request.binding?.evidence.accountId ?? gcpRuntimeAccount(scope.projectId, environment, service.name);
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(accountId)) throw new GcpRuntimeError('The recorded runtime account identifier is invalid.');
    const email = `${accountId}@${scope.projectId}.iam.gserviceaccount.com`;
    const name = `projects/${scope.projectId}/serviceAccounts/${email}`;
    if (request.binding && Object.entries({ projectId: scope.projectId, region: scope.region, environmentId: environment.id,
      serviceName: service.name, email, name }).some(([key, value]) => request.binding!.evidence[key] !== undefined && request.binding!.evidence[key] !== value)) {
      throw new GcpRuntimeError('The recorded Google runtime account belongs to a different project, environment, or service.');
    }
    const bindings = environment.platformBindings.services as Record<string, { serviceId?: string; jobName?: string }> | undefined;
    const binding = bindings?.[service.name];
    const retainedResource = request.binding?.evidence.workloadResource;
    const prefix = `projects/${scope.projectId}/locations/${scope.region}/`;
    if (retainedResource !== undefined && (!retainedResource.startsWith(prefix)
      || !/^(services|jobs)\/[a-z][a-z0-9-]{0,62}$/.test(retainedResource.slice(prefix.length)))) {
      throw new GcpRuntimeError('The retained Cloud Run workload belongs to a different or invalid native scope.');
    }
    const job = Boolean(binding?.jobName) || (!binding && (retainedResource ? retainedResource.startsWith(prefix + 'jobs/') : service.buildConfig.workloadKind === 'cron'));
    const boundId = job ? binding?.jobName : binding?.serviceId;
    if (binding && !boundId) throw new GcpRuntimeError('Cloud Run workload binding has no exact native resource identity.');
    const workloadName = this.workloadName(environment, service.name, boundId ?? retainedResource?.split('/').at(-1));
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(workloadName)) throw new GcpRuntimeError('Cloud Run workload resource name is invalid.');
    const resource = `${prefix}${job ? 'jobs' : 'services'}/${workloadName}`;
    if (retainedResource && retainedResource !== resource) throw new GcpRuntimeError('The bound Cloud Run workload differs from its retained runtime identity scope.');
    return { ...scope, accountId, email, name, boundId, job,
      resource,
      marker: gcpRuntimeOwner(scope.projectId, environment, service.name),
      cloudsql: request.environmentSpec?.database?.provider === 'cloudsql' || request.binding?.evidence.cloudsqlClient === 'required' };
  }

  private async account(scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, token: string, uniqueId?: string) {
    if (uniqueId !== undefined && !/^[1-9][0-9]{5,30}$/.test(uniqueId)) throw new GcpRuntimeError('The recorded Google runtime account immutable identity is invalid.');
    const value = await gcpRuntimeRequest(`${IAM}/projects/${scope.projectId}/serviceAccounts/${encodeURIComponent(uniqueId ?? scope.email)}`, token);
    if (value === null) return null;
    const account = value as Record<string, unknown>;
    if (!account || account.name !== scope.name || account.projectId !== scope.projectId || account.email !== scope.email
      || typeof account.uniqueId !== 'string' || !/^[1-9][0-9]{5,30}$/.test(account.uniqueId)
      || (uniqueId && account.uniqueId !== uniqueId) || (account.disabled !== undefined && account.disabled !== false)) {
      throw new GcpRuntimeError('Google runtime service account identity is incomplete, replaced, or disabled.');
    }
    return account as Record<string, unknown> & { uniqueId: string; email: string; name: string };
  }

  private owned(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, account: NonNullable<Awaited<ReturnType<CloudRunRuntimeIdentities['account']>>>) {
    const evidence = request.binding?.evidence;
    const creationAttempt = evidence?.attemptId ?? request.binding?.pending?.step.target.recoverAttemptId ?? request.binding?.pending?.attemptId;
    if (!creationAttempt || !attempt(creationAttempt) || account.description !== scope.marker + creationAttempt
      || (evidence?.uniqueId && evidence.uniqueId !== account.uniqueId)
      || (evidence?.email && evidence.email !== scope.email) || (request.binding && request.binding.provider !== 'cloudrun')) {
      throw new GcpRuntimeError('A Google runtime service account already exists without this exact owned creation evidence; explicit reviewed reconciliation is required.');
    }
    return { provider: 'cloudrun', evidence: { projectId: scope.projectId, region: scope.region, accountId: scope.accountId,
      email: scope.email, name: scope.name, uniqueId: account.uniqueId, attemptId: creationAttempt,
      environmentId: request.environment.id, serviceName: request.service.name, cloudsqlClient: scope.cloudsql ? 'required' : 'not-required',
      workloadResource: scope.resource,
      ...(this.releaseJobResource(request, scope) ? { releaseJobResource: this.releaseJobResource(request, scope)! } : {}),
      ...(evidence?.queueGrants ? { queueGrants: serializeRuntimeQueues(parseRuntimeQueues(evidence.queueGrants, scope.projectId)) } : {}),
      ...(evidence?.readerGrants ? { readerGrants: serializeRuntimeSecrets(parseRuntimeSecrets(evidence.readerGrants)) } : {}),
      ...((evidence?.legacyPrincipal ?? request.binding?.pending?.step.target.previousPrincipal)
        ? { legacyPrincipal: evidence?.legacyPrincipal ?? request.binding!.pending!.step.target.previousPrincipal! } : {}),
    } } satisfies RuntimeIdentityBinding;
  }

  private identity(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, principal: string,
    source: 'observed' | 'configured', account?: NonNullable<Awaited<ReturnType<CloudRunRuntimeIdentities['account']>>>, workloadUid?: string): ProviderRuntimeIdentity {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(principal) || !principal.endsWith(`@${scope.projectId}.iam.gserviceaccount.com`) || principal === scope.deployEmail) throw new GcpRuntimeError('The Cloud Run workload principal is missing, outside the selected project, or equals the deployment identity.');
    return { provider: 'gcp', principal, source, scope: { projectId: scope.projectId, region: scope.region,
      environmentId: request.environment.id, serviceName: request.service.name, workloadResource: scope.resource,
      ...(workloadUid ? { workloadUid } : {}),
      ...(account ? { serviceAccountUniqueId: account.uniqueId } : {}) } };
  }

  private workloadFingerprint(workload: Record<string, any>, job: boolean): string {
    const template = structuredClone(workload.template);
    if (!template || typeof template !== 'object') throw new GcpRuntimeError('Cloud Run workload template is unavailable.');
    const task = job ? template.template : template;
    if (!task || !Array.isArray(task.containers) || !task.containers.length
      || task.containers.some((container: any) => typeof container?.image !== 'string' || !/^[^@\s]+@sha256:[a-f0-9]{64}$/i.test(container.image))) {
      throw new GcpRuntimeError('A runtime identity transition requires the current exact immutable workload image and configuration.');
    }
    delete task.serviceAccount; delete template.revision;
    return createHash('sha256').update(canonical({ template, labels: workload.labels ?? {}, annotations: workload.annotations ?? {},
      ...(job ? { client: workload.client, clientVersion: workload.clientVersion, launchStage: workload.launchStage, binaryAuthorization: workload.binaryAuthorization }
        : { ingress: workload.ingress, launchStage: workload.launchStage, binaryAuthorization: workload.binaryAuthorization, traffic: workload.traffic ?? [] }) })).digest('hex');
  }

  private activationTarget(scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, workload: Record<string, any>, principal: string) {
    if (typeof workload.uid !== 'string' || !workload.uid || typeof workload.etag !== 'string' || !workload.etag
      || workload.reconciling === true || workload.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
      || !workload.generation || workload.observedGeneration !== workload.generation) throw new GcpRuntimeError('Cloud Run runtime activation requires exact ready workload identity and revision evidence.');
    if (!scope.job && workload.traffic !== undefined && (!Array.isArray(workload.traffic)
      || workload.traffic.some((entry: any) => entry.revision || (entry.type !== undefined && entry.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST')))) {
      throw new GcpRuntimeError('Cloud Run identity transition is blocked by revision-pinned or ambiguous traffic; review that traffic transition before changing the runtime account.');
    }
    return { ...this.step(scope, 'attach').target, phase: 'activate', workloadResource: scope.resource,
      resourceKind: scope.job ? 'job' : 'service',
      workloadUid: workload.uid, workloadEtag: workload.etag, previousPrincipal: principal,
      configurationHash: this.workloadFingerprint(workload, scope.job) };
  }

  private activationComplete(scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, workload: Record<string, any> | null, target: Record<string, string>): boolean {
    if (!workload || workload.name !== target.workloadResource || workload.uid !== target.workloadUid
      || (scope.job ? workload.template?.template?.serviceAccount : workload.template?.serviceAccount) !== scope.email
      || workload.reconciling === true || workload.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
      || !workload.generation || workload.observedGeneration !== workload.generation) return false;
    return this.workloadFingerprint(workload, scope.job) === target.configurationHash;
  }

  private releaseJobResource(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>): string | undefined {
    const name = (request.environment.platformBindings.services as Record<string, { releaseJobName?: string }> | undefined)?.[request.service.name]?.releaseJobName;
    const retained = request.binding?.evidence.releaseJobResource;
    const prefix = `projects/${scope.projectId}/locations/${scope.region}/jobs/`;
    if (retained !== undefined && (!retained.startsWith(prefix) || !/^[a-z][a-z0-9-]{0,62}$/.test(retained.slice(prefix.length)))) {
      throw new GcpRuntimeError('The retained Cloud Run release job belongs to a different or invalid native scope.');
    }
    if (name === undefined) return retained;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new GcpRuntimeError('The bound Cloud Run release job has an invalid resource identity.');
    const resource = prefix + name;
    if (retained && retained !== resource) throw new GcpRuntimeError('The bound release job differs from its retained runtime identity scope.');
    return resource;
  }

  private async activationWorkload(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, target: Record<string, string>, token: string) {
    const release = this.releaseJobResource(request, scope);
    if (target.workloadResource !== scope.resource && target.workloadResource !== release) throw new GcpRuntimeError('Runtime activation is not authorized for that bound workload.');
    const selected = { ...scope, resource: target.workloadResource!, job: target.workloadResource === release || scope.job };
    if (target.resourceKind !== (selected.job ? 'job' : 'service')) throw new GcpRuntimeError('Runtime activation resource kind changed.');
    const workload = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${selected.resource}`, token) as Record<string, any> | null;
    if (workload && workload.name !== selected.resource) throw new GcpRuntimeError('Runtime activation returned a different workload identity.');
    return { scope: selected, workload };
  }

  private step(scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, operation: RuntimeIdentityStep['operation'], uniqueId?: string): RuntimeIdentityStep {
    return { operation, requiresConfirm: true, target: { projectId: scope.projectId, region: scope.region, email: scope.email, name: scope.name,
      ...(uniqueId ? { uniqueId } : {}), cloudsqlClient: scope.cloudsql ? 'required' : 'not-required' },
      description: operation === 'attach' ? 'Grant the deployer permission to use this exact workload identity and the application’s declared Cloud SQL access using native administrator sign-in.'
        : operation === 'create' ? 'Create an isolated, keyless Google runtime identity for this service and environment.'
          : operation === 'recover' ? 'Reconcile the exact previously attempted Google runtime identity creation.' : 'Remove the exact owned Google runtime identity after its workload and storage grants are gone.' };
  }

  private async read(request: RuntimeIdentityRequest) {
    const scope = this.coordinates(request); const token = await this.token();
    const workload = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${scope.resource}`, token) as Record<string, any> | null;
    if (workload && (workload.name !== scope.resource || (!scope.boundId && request.mode !== 'destroy'))) throw new GcpRuntimeError('An unbound or different Cloud Run workload requires explicit adoption before runtime identity preparation.');
    if (!workload && scope.boundId && request.mode === 'ensure') throw new GcpRuntimeError('The bound Cloud Run workload is missing; runtime identity remains unknown.');
    const principal = workload ? (scope.job ? workload.template?.template?.serviceAccount : workload.template?.serviceAccount) : undefined;
    if (workload && (typeof principal !== 'string' || !principal)) throw new GcpRuntimeError('The bound Cloud Run workload omitted its runtime principal.');
    const releaseResource = this.releaseJobResource(request, scope);
    const releaseWorkload = request.mode === 'destroy' && releaseResource
      ? await gcpRuntimeRequest(`https://run.googleapis.com/v2/${releaseResource}`, token) as Record<string, unknown> | null : null;
    if (releaseWorkload && releaseWorkload.name !== releaseResource) throw new GcpRuntimeError('The retained release job returned a different native identity.');
    const account = await this.account(scope, token, request.binding?.evidence.uniqueId);
    return { scope, token, workload, principal, account, releaseWorkload };
  }

  private async permissions(scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, uniqueId: string, token: string) {
    const saUrl = `${IAM}/projects/${scope.projectId}/serviceAccounts/${uniqueId}`;
    const projectUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${scope.projectId}`;
    const read = async (url: string) => parseGcpRuntimePolicy(await gcpRuntimeRequest(`${url}:getIamPolicy`, token,
      { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }));
    const sa = await read(saUrl); const project = await read(projectUrl);
    return { saUrl, projectUrl, sa, project, ready: hasGcpRuntimeRole(sa, 'roles/iam.serviceAccountUser', `serviceAccount:${scope.deployEmail}`)
      && (!scope.cloudsql || hasGcpRuntimeRole(project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`)) };
  }

  private async queuePermissionStep(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, uniqueId: string, token: string, desired: GcpRuntimeQueue[]): Promise<RuntimeIdentityObservation | undefined> {
    const previous = parseRuntimeQueues(request.binding?.evidence.queueGrants, scope.projectId);
    const policies = await readRuntimeQueuePolicies(request, unionRuntimeQueues(previous, desired), token, desired);
    const next = policies.find(entry => entry.policy && hasGcpRuntimeRole(entry.policy, entry.role, `serviceAccount:${scope.email}`) !== entry.desired);
    if (!next && serializeRuntimeQueues(desired) === serializeRuntimeQueues(previous)) return undefined;
    return { state: 'action', step: { ...this.step(scope, 'attach', uniqueId),
      target: { ...this.step(scope, 'attach', uniqueId).target, phase: 'queues', queueGrants: serializeRuntimeQueues(desired), previousQueueGrants: serializeRuntimeQueues(previous),
        queueResource: next?.resource ?? scope.name, queueOperation: next ? (next.desired ? 'grant' : 'revoke') : 'record', ...(next ? { queueRole: next.role } : {}) },
      description: next ? `${next.desired ? 'Grant' : 'Remove'} ${next.role} for this exact workload account on ${next.resource}.`
        : 'Record the independently verified queue permission scope without changing any provider policy.' } };
  }

  private async secretPermissionStep(request: RuntimeIdentityRequest, scope: ReturnType<CloudRunRuntimeIdentities['coordinates']>, uniqueId: string, token: string, desired: GcpRuntimeSecret[]): Promise<RuntimeIdentityObservation | undefined> {
    const previous = parseRuntimeSecrets(request.binding?.evidence.readerGrants);
    const policies = await readRuntimeSecretPolicies(scope.projectId, unionRuntimeSecrets(previous, desired), token, desired);
    const next = policies.find(entry => entry.policy && hasGcpRuntimeRole(entry.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${scope.email}`) !== entry.desired);
    if (next && !next.desired && await hasRuntimeSecretConsumers(scope.projectId, next.target,
      [{ name: scope.resource, job: scope.job }, ...(this.releaseJobResource(request, scope)
        ? [{ name: this.releaseJobResource(request, scope)!, job: true }] : [])], token))
      return { state: 'waiting', reason: 'Remove the retained workload, revision and release-job references before revoking their secret reader access.' };
    const retained = policies.filter(entry => entry.desired).map(entry => entry.target);
    if (!next && serializeRuntimeSecrets(retained) === serializeRuntimeSecrets(previous)) return undefined;
    return { state: 'action', step: { ...this.step(scope, 'attach', uniqueId),
      target: { ...this.step(scope, 'attach', uniqueId).target, phase: 'secrets', readerGrants: serializeRuntimeSecrets(retained),
        previousReaderGrants: serializeRuntimeSecrets(policies.filter(entry => previous.some(target => target.resource === entry.target.resource)).map(entry => entry.target)),
        readerResource: next?.target.resource ?? scope.name, readerOperation: next ? next.desired ? 'grant' : 'revoke' : 'record' },
      description: next ? `${next.desired ? 'Grant' : 'Remove'} secret-version reading for this exact runtime account on ${next.target.resource}; application references stay pinned to immutable versions.`
        : 'Record independently verified runtime secret targets without changing values or provider permissions.' } };
  }

  async inspect(request: RuntimeIdentityRequest): Promise<RuntimeIdentityObservation> {
    try {
      if (!request.environment.platformBindings.projectId) return { state: 'waiting', reason: 'Prepare and bind the Google project before its runtime identities.' };
      const { scope, token, workload, principal, account, releaseWorkload } = await this.read(request);
      if (request.binding?.pending) {
        const pending = request.binding.pending;
        return { state: 'action', step: { ...pending.step, operation: 'recover', requiresConfirm: false,
          target: { ...pending.step.target, recoverOperation: pending.step.target.recoverOperation ?? pending.step.operation,
            recoverAttemptId: pending.step.target.recoverAttemptId ?? pending.attemptId },
          description: 'Read and reconcile the exact previously attempted Google runtime identity operation without repeating its write.' } };
      }
      if (request.mode === 'destroy') {
        if (!request.binding) return { state: 'ready' };
        if (workload || releaseWorkload) return { state: 'waiting', reason: 'Remove the bound workload and release job before their runtime identity.' };
        if (!account) {
          if (!request.binding.evidence.uniqueId) throw new GcpRuntimeError('Runtime account deletion cannot finalize without its recorded immutable identity.');
          return { state: 'action', step: this.step(scope, 'destroy', request.binding.evidence.uniqueId) };
        }
        this.owned(request, scope, account);
        const secretStep = await this.secretPermissionStep(request, scope, account.uniqueId, token, []);
        if (secretStep) return secretStep;
        const queueStep = await this.queuePermissionStep(request, scope, account.uniqueId, token, []);
        if (queueStep) return queueStep;
        return { state: 'action', step: this.step(scope, 'destroy', account.uniqueId) };
      }
      if (!account) {
        if (request.binding && Object.keys(request.binding.evidence).length) throw new GcpRuntimeError('The recorded Google runtime identity is missing; its pending or replaced identity requires exact reconciliation.');
        if (workload) {
          this.identity(request, scope, principal!, 'observed');
          const previous = this.activationTarget(scope, workload, principal!);
          return { state: 'action', step: { ...this.step(scope, 'create'), target: { ...this.step(scope, 'create').target,
            previousPrincipal: principal!, workloadUid: previous.workloadUid!, workloadResource: scope.resource } } };
        }
        return { state: 'action', step: this.step(scope, 'create') };
      }
      this.owned(request, scope, account);
      const permissions = await this.permissions(scope, account.uniqueId, token);
      if (!permissions.ready) return { state: 'action', step: this.step(scope, 'attach', account.uniqueId) };
      const desiredQueues = desiredRuntimeQueues(request, scope.projectId);
      if (desiredQueues === null) return { state: 'waiting', reason: 'Create and bind the declared queues through their reviewed lifecycle before preparing runtime queue access.' };
      const queueStep = await this.queuePermissionStep(request, scope, account.uniqueId, token, desiredQueues);
      if (queueStep) return queueStep;
      const secretStep = await this.secretPermissionStep(request, scope, account.uniqueId, token, desiredRuntimeSecrets(request, scope.projectId));
      if (secretStep) return secretStep;
      const releaseResource = this.releaseJobResource(request, scope);
      if (workload && releaseResource && !scope.job) {
        const release = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${releaseResource}`, token) as Record<string, any> | null;
        if (!release || release.name !== releaseResource || !release.template?.template?.serviceAccount) throw new GcpRuntimeError('The bound release job identity is missing or unverified; preserve it for exact reconciliation.');
        if (release.template.template.serviceAccount !== scope.email) {
          if (release.template.template.serviceAccount !== request.binding?.evidence.legacyPrincipal) throw new GcpRuntimeError('The release job uses a different unreviewed legacy principal; preserve it for explicit identity review.');
          const target = { ...this.activationTarget({ ...scope, job: true, resource: releaseResource }, release, release.template.template.serviceAccount),
            uniqueId: account.uniqueId, primaryWorkloadUid: String(workload.uid ?? ''), primaryWorkloadEtag: String(workload.etag ?? '') };
          const prepared = this.identity(request, scope, scope.email, principal === scope.email ? 'observed' : 'configured', account, workload.uid);
          if (principal !== scope.email) {
            if (principal !== request.binding?.evidence.legacyPrincipal) throw new GcpRuntimeError('The service legacy principal changed during release job identity preparation.');
            this.activationTarget(scope, workload, principal!);
            prepared.activation = { previousPrincipal: principal!, workloadEtag: workload.etag };
          }
          return { state: 'action', step: { operation: 'attach', target, requiresConfirm: true, restartsWorkload: false,
            description: 'Update the exact bound release job to the prepared service identity after its bucket grants are verified; retain its image and configuration without executing it.' },
            preparedIdentity: prepared, requiresStorageAccess: true };
        }
      }
      if (workload && principal !== scope.email) {
        if (request.binding?.evidence.legacyPrincipal !== principal) throw new GcpRuntimeError('The live legacy principal changed after identity preparation; explicit reconciliation is required.');
        const target = { ...this.activationTarget(scope, workload, principal!), uniqueId: account.uniqueId };
        const identity = this.identity(request, scope, scope.email, 'configured', account, workload.uid);
        identity.scope.workloadUid = workload.uid;
        return { state: 'action', step: { operation: 'attach', target, requiresConfirm: true, restartsWorkload: !scope.job,
          description: 'Switch this exact ready workload to its prepared service identity after its declared bucket grants are verified; preserve its image and runtime configuration.' },
          preparedIdentity: { ...identity, activation: { previousPrincipal: principal!, workloadEtag: workload.etag } }, requiresStorageAccess: true };
      }
      const legacy = request.binding?.evidence.legacyPrincipal;
      const remaining = legacy && /^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(legacy) && legacy.endsWith(`@${scope.projectId}.iam.gserviceaccount.com`)
        ? permissions.project.bindings.filter(binding => binding.members.includes(`serviceAccount:${legacy}`)
          && !['roles/cloudsql.client', 'roles/secretmanager.secretAccessor', 'roles/pubsub.publisher', 'roles/pubsub.subscriber', 'roles/run.invoker'].includes(binding.role)) : [];
      const warnings = remaining.slice(0, 25).map(binding => {
        const role = ['roles/storage.objectUser', 'roles/storage.admin', 'roles/storage.objectAdmin', 'roles/storage.objectViewer', 'roles/storage.objectCreator', 'roles/owner', 'roles/editor', 'roles/viewer'].includes(binding.role)
          ? binding.role : 'unclassified project permissions';
        return `Retained ${role} for ${legacy} on project ${scope.projectId}. The new workload account is active, but cleanup of legacy access requires review because other cloud or external consumers are not proven absent.`;
      });
      return { state: 'ready', identity: this.identity(request, scope, scope.email, workload ? 'observed' : 'configured', account, workload?.uid), ...(warnings.length ? { warnings } : {}) };
    } catch (error) { return { state: 'unknown', reason: gcpRuntimeError(error) }; }
  }

  async apply(request: RuntimeIdentityRequest & { step: RuntimeIdentityStep; attemptId: string }) {
    let mutationAttempted = false;
    let createAcknowledged = false;
    try {
      if (!attempt(request.attemptId)) throw new GcpRuntimeError('Google runtime identity requires its exact persisted attempt.');
      if (request.binding?.pending?.attemptId !== request.attemptId || canonical(request.binding.pending.step) !== canonical(request.step)) {
        throw new GcpRuntimeError('Google runtime identity mutation requires matching persisted intent.');
      }
      if (request.step.operation === 'recover') {
        const { scope, token, account, workload, releaseWorkload } = await this.read(request);
        if (!account && !workload && !releaseWorkload && request.step.target.recoverOperation === 'destroy'
          && request.binding.evidence.uniqueId === request.step.target.uniqueId
          && request.step.target.email === scope.email && request.step.target.name === scope.name) {
          return { receipt: { success: true, message: 'Verified terminal absence of the exact runtime account and its workload after the recorded deletion.' }, binding: undefined };
        }
        if (!account) throw new GcpRuntimeError('The pending runtime identity is not observable; retain the exact attempt for reconciliation.');
        const binding = this.owned(request, scope, account);
        if (request.step.target.phase === 'secrets') {
          const desired = parseRuntimeSecrets(request.step.target.readerGrants);
          const previous = parseRuntimeSecrets(request.step.target.previousReaderGrants);
          const possible = unionRuntimeSecrets(previous, desired);
          const entries = await readRuntimeSecretPolicies(scope.projectId, possible, token, desired);
          const entry = entries.find(value => value.target.resource === request.step.target.readerResource);
          if (request.step.target.readerOperation !== 'record' && (!entry || entry.policy
            && hasGcpRuntimeRole(entry.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${scope.email}`) !== entry.desired))
            throw new GcpRuntimeError('The attempted secret reader grant has no verified result; retain it without resubmitting.');
          binding.evidence.readerGrants = serializeRuntimeSecrets(request.step.target.readerOperation === 'record' ? desired : possible);
        }
        if (request.step.target.phase === 'queues') {
          const desired = parseRuntimeQueues(request.step.target.queueGrants, scope.projectId);
          const previous = parseRuntimeQueues(request.step.target.previousQueueGrants, scope.projectId);
          const possible = unionRuntimeQueues(previous, desired);
          await readRuntimeQueuePolicies(request, possible, token, []);
          binding.evidence.queueGrants = serializeRuntimeQueues(possible);
        }
        if (request.step.target.phase === 'activate') {
          const selected = await this.activationWorkload(request, scope, request.step.target, token);
          if (!this.activationComplete(selected.scope, selected.workload, request.step.target)) throw new GcpRuntimeError('The pending runtime activation is not yet independently verified; retain its exact attempt.');
        }
        if (request.step.target.recoverOperation === 'attach') await this.permissions(scope, account.uniqueId, token);
        return { receipt: { success: true, message: 'Recovered the independently verified runtime identity from its exact recorded attempt.' }, binding };
      }
      const preview = await this.inspect({ ...request, binding: { provider: request.binding.provider, evidence: request.binding.evidence } });
      if (preview.state !== 'action' || canonical(preview.step) !== canonical(request.step)) throw new GcpRuntimeError('The Google runtime identity action changed; re-plan before mutation.');
      const scope = this.coordinates(request); const token = await this.token();
      if (request.step.operation === 'create') {
        mutationAttempted = true;
        const created = await gcpRuntimeRequest(`${IAM}/projects/${scope.projectId}/serviceAccounts`, token, { method: 'POST', body: JSON.stringify({
          accountId: scope.accountId, serviceAccount: { displayName: 'Hypervibe workload identity', description: scope.marker + request.attemptId },
        }) }) as Record<string, unknown> | null;
        createAcknowledged = true;
        const observed = await this.account(scope, token);
        if (!observed || created?.uniqueId !== observed.uniqueId || created?.email !== scope.email || created?.name !== scope.name) throw new GcpRuntimeError('Runtime identity creation has not converged; retain this attempt for exact recovery.');
        const binding = this.owned({ ...request, binding: { provider: 'cloudrun', evidence: {}, pending: { attemptId: request.attemptId, step: request.step } } }, scope, observed);
        return { receipt: { success: true, message: 'Created and verified the isolated Google runtime identity; permission preparation is a separate action.' }, binding };
      }
      const account = await this.account(scope, token, request.step.target.uniqueId);
      if (!account && request.step.operation === 'destroy') return { receipt: { success: true, message: 'The exact recorded runtime account and workload are already absent.' }, binding: undefined };
      if (!account) throw new GcpRuntimeError('The exact owned runtime identity disappeared before mutation.');
      const binding = this.owned(request, scope, account);
      if (request.step.operation === 'attach' && request.step.target.phase === 'secrets') {
        const desired = parseRuntimeSecrets(request.step.target.readerGrants);
        const previous = parseRuntimeSecrets(request.step.target.previousReaderGrants);
        if (request.step.target.readerOperation === 'record') {
          binding.evidence.readerGrants = serializeRuntimeSecrets(desired);
          return { receipt: { success: true, message: 'Recorded exact independently verified secret reader targets without reading or changing values.' }, binding };
        }
        const targets = unionRuntimeSecrets(previous, desired); const admin = await this.adminToken();
        const ownedAccount = await this.account(scope, admin, account.uniqueId);
        if (!ownedAccount) throw new GcpRuntimeError('The exact runtime account disappeared before secret reader preparation.');
        this.owned(request, scope, ownedAccount);
        const entries = await readRuntimeSecretPolicies(scope.projectId, targets, admin, desired);
        const entry = entries.find(value => value.target.resource === request.step.target.readerResource);
        if (!entry || (entry.desired ? 'grant' : 'revoke') !== request.step.target.readerOperation) throw new GcpRuntimeError('The exact reviewed secret reader action changed.');
        if (!entry.desired && await hasRuntimeSecretConsumers(scope.projectId, entry.target,
          [{ name: scope.resource, job: scope.job }, ...(this.releaseJobResource(request, scope)
            ? [{ name: this.releaseJobResource(request, scope)!, job: true }] : [])], admin))
          throw new GcpRuntimeError('A retained runtime consumer still requires this secret reader grant.');
        if (entry.policy && hasGcpRuntimeRole(entry.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${scope.email}`) !== entry.desired) {
          mutationAttempted = true;
          parseGcpRuntimePolicy(await gcpRuntimeRequest(`${entry.url}:setIamPolicy`, admin, { method: 'POST', body: JSON.stringify({
            policy: withGcpRuntimeRole(entry.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${scope.email}`, !entry.desired),
          }) }));
          const observed = (await readRuntimeSecretPolicies(scope.projectId, [entry.target], token, desired))[0];
          if (!observed || observed.policy && hasGcpRuntimeRole(observed.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${scope.email}`) !== entry.desired)
            throw new GcpRuntimeError('Secret reader access has not converged; preserve its exact permission attempt.');
        }
        binding.evidence.readerGrants = serializeRuntimeSecrets(targets);
        return { receipt: { success: true, message: 'Verified the exact runtime secret reader grant; secret values and unrelated permissions are preserved.' }, binding };
      }
      if (request.step.operation === 'attach' && request.step.target.phase === 'queues') {
        const desired = parseRuntimeQueues(request.step.target.queueGrants, scope.projectId);
        const previous = parseRuntimeQueues(request.step.target.previousQueueGrants, scope.projectId);
        if (request.step.target.queueOperation === 'record') {
          binding.evidence.queueGrants = serializeRuntimeQueues(desired);
          return { receipt: { success: true, message: 'Recorded independently verified runtime queue permissions without changing provider policies.' }, binding };
        }
        const targets = unionRuntimeQueues(previous, desired); const admin = await this.adminToken();
        const ownedAccount = await this.account(scope, admin, account.uniqueId);
        if (!ownedAccount) throw new GcpRuntimeError('The exact runtime account disappeared before queue permission preparation.');
        this.owned(request, scope, ownedAccount);
        const entries = await readRuntimeQueuePolicies(request, targets, admin, desired);
        const entry = entries.find(value => value.resource === request.step.target.queueResource && value.role === request.step.target.queueRole);
        if (!entry || (entry.desired ? 'grant' : 'revoke') !== request.step.target.queueOperation) throw new GcpRuntimeError('The exact reviewed queue permission frontier changed.');
        if (entry.policy && hasGcpRuntimeRole(entry.policy, entry.role, `serviceAccount:${scope.email}`) !== entry.desired) {
          mutationAttempted = true;
          parseGcpRuntimePolicy(await gcpRuntimeRequest(`${entry.url}:setIamPolicy`, admin, { method: 'POST', body: JSON.stringify({
            policy: withGcpRuntimeRole(entry.policy, entry.role, `serviceAccount:${scope.email}`, !entry.desired),
          }) }));
          const verified = await readRuntimeQueuePolicies(request, targets.filter(target => target.topicName === entry.resource || target.subscriptionName === entry.resource), token, desired);
          const observed = verified.find(value => value.resource === entry.resource);
          if (!observed || observed.policy && hasGcpRuntimeRole(observed.policy, entry.role, `serviceAccount:${scope.email}`) !== entry.desired) {
            throw new GcpRuntimeError('Exact Pub/Sub runtime access has not converged; preserve this permission attempt.');
          }
        }
        binding.evidence.queueGrants = serializeRuntimeQueues(targets);
        return { receipt: { success: true, message: 'Verified the exact reviewed queue permission for this workload identity; re-plan its next permission frontier.' }, binding };
      }
      if (request.step.operation === 'attach' && request.step.target.phase === 'activate') {
        const before = await this.read(request);
        const selected = await this.activationWorkload(request, scope, request.step.target, token);
        const selectedPrincipal = selected.scope.job ? selected.workload?.template?.template?.serviceAccount : selected.workload?.template?.serviceAccount;
        const actualTarget = selected.workload ? { ...this.activationTarget(selected.scope, selected.workload, selectedPrincipal), uniqueId: account.uniqueId,
          ...(selected.scope.resource !== scope.resource ? { primaryWorkloadUid: String(before.workload?.uid ?? ''), primaryWorkloadEtag: String(before.workload?.etag ?? '') } : {}) } : undefined;
        if (!before.workload || !selected.workload || canonical(actualTarget) !== canonical(request.step.target)) {
          throw new GcpRuntimeError('The reviewed runtime activation workload changed before mutation.');
        }
        const body = selected.scope.job ? cloudRunJobUpdateBody(selected.workload, { template: { template: { serviceAccount: scope.email } } })
          : { name: selected.scope.resource, etag: selected.workload.etag, template: { serviceAccount: scope.email } };
        mutationAttempted = true;
        let operation = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${selected.scope.resource}${selected.scope.job ? '' : '?updateMask=template.serviceAccount'}`, token,
          { method: 'PATCH', body: JSON.stringify(body) }) as Record<string, any> | null;
        const operationName = operation?.name;
        if (typeof operationName !== 'string' || !operationName.startsWith(`projects/${scope.projectId}/locations/${scope.region}/operations/`)
          || !/^[A-Za-z0-9_-]+$/.test(operationName.split('/').at(-1)!)) throw new GcpRuntimeError('Runtime activation returned no exact operation identity; retain its pending attempt.');
        for (let count = 0; count < 10 && operation?.done !== true; count++) {
          await new Promise(resolve => setTimeout(resolve, 200));
          operation = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${operationName}`, token) as Record<string, any> | null;
          if (operation?.name !== operationName) throw new GcpRuntimeError('Runtime activation operation identity changed.');
        }
        if (operation?.done !== true || operation.error || operation.response?.name !== selected.scope.resource || operation.response?.uid !== selected.workload.uid) {
          throw new GcpRuntimeError('Runtime activation operation did not complete for the exact reviewed workload.');
        }
        for (let count = 0; count < 6; count++) {
          if (this.activationComplete(selected.scope, (await this.activationWorkload(request, scope, request.step.target, token)).workload, request.step.target)) {
            return { receipt: { success: true, message: 'Verified the exact workload switched to its prepared identity without changing its image or runtime configuration. Legacy project grants remain preserved for separate scope review.' }, binding };
          }
          if (count < 5) await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new GcpRuntimeError('Runtime activation is not yet independently observable; retain its pending attempt.');
      }
      const admin = await this.adminToken();
      // Recheck the immutable identity using the selected administrator before grants.
      const adminObserved = await this.account(scope, admin, account.uniqueId);
      if (!adminObserved) throw new GcpRuntimeError('The exact runtime account disappeared during native administrator preparation.');
      this.owned(request, scope, adminObserved);
      const policies = await this.permissions(scope, account.uniqueId, admin);
      const write = async (url: string, policy: ReturnType<typeof parseGcpRuntimePolicy>) => {
        mutationAttempted = true;
        parseGcpRuntimePolicy(await gcpRuntimeRequest(`${url}:setIamPolicy`, admin, { method: 'POST', body: JSON.stringify({ policy }) }));
      };
      if (request.step.operation === 'attach') {
        if (!hasGcpRuntimeRole(policies.sa, 'roles/iam.serviceAccountUser', `serviceAccount:${scope.deployEmail}`)) {
          await write(policies.saUrl, withGcpRuntimeRole(policies.sa, 'roles/iam.serviceAccountUser', `serviceAccount:${scope.deployEmail}`));
        }
        if (scope.cloudsql && !hasGcpRuntimeRole(policies.project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`)) {
          await write(policies.projectUrl, withGcpRuntimeRole(policies.project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`));
        }
        if (!(await this.permissions(scope, account.uniqueId, token)).ready) throw new GcpRuntimeError('Runtime identity permissions have not converged; retain this exact permission action.');
        return { receipt: { success: true, message: 'Verified exact workload identity permissions; Google authorization propagation may still be pending.' }, binding };
      }
      if (request.step.operation !== 'destroy') throw new GcpRuntimeError('Unsupported Google runtime identity operation.');
      if (hasGcpRuntimeRole(policies.project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`)) {
        await write(policies.projectUrl, withGcpRuntimeRole(policies.project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`, true));
        if (hasGcpRuntimeRole((await this.permissions(scope, account.uniqueId, admin)).project, 'roles/cloudsql.client', `serviceAccount:${scope.email}`)) throw new GcpRuntimeError('Runtime database access removal has not converged.');
      }
      mutationAttempted = true;
      await gcpRuntimeRequest(`${IAM}/projects/${scope.projectId}/serviceAccounts/${account.uniqueId}`, token, { method: 'DELETE' });
      if (await this.account(scope, token, account.uniqueId)) throw new GcpRuntimeError('Runtime service account deletion is not yet observable.');
      return { receipt: { success: true, message: 'Deleted the exact owned Google runtime identity and verified its absence.' } };
    } catch (error) {
      const mutationRejected = request.step.operation === 'create' && mutationAttempted && !createAcknowledged && error instanceof GcpRuntimeError
        && error.status !== undefined && [400, 401, 403, 409, 412].includes(error.status);
      return { receipt: { success: false, message: 'Google runtime identity action did not converge.', error: gcpRuntimeError(error), data: { mutationAttempted, ...(mutationRejected ? { mutationRejected: true } : {}) } } };
    }
  }
}
