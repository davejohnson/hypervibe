import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { parseGcpGithubWorkloadIdentity } from './gcp-github-workload-identity.js';
import type { IRecoveryRuntime, RecoveryRuntimeBinding, RecoveryRuntimeExecutionTarget, RecoveryRuntimeObservation, RecoveryRuntimeRequest, RecoveryRuntimeStep, RecoveryRuntimeTarget } from '../../../domain/ports/recovery-runtime.port.js';
import { getGcpNativeAdminToken, GcpRuntimeError, gcpRuntimeError, gcpRuntimeRequest, hasGcpRuntimeRole, parseGcpRuntimePolicy, withGcpRuntimeRole } from './gcp-runtime-client.js';

export interface CloudRunRecoveryDependencies {
  connection(): { projectId: string; region: string; deployerEmail?: string; defaultAuthentication?: boolean };
  token(): Promise<string>;
  adminToken?: () => Promise<string>;
  request?: typeof fetch;
}
const IAM = 'https://iam.googleapis.com/v1/';
const SM = 'https://secretmanager.googleapis.com/v1/';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GcpRuntimeError('Recovery prerequisite observation is incomplete.');
  return value as Record<string, any>;
};
type Source = Awaited<ReturnType<CloudRunRecoveryRuntime['source']>>;
type Permission = { component: string; resource: string; role: string; member: string; readUrl: string; readMethod?: string; writeUrl: string; writeMethod: string; rawPolicy?: boolean; description: string };

/** Durable identity/access prerequisites. Every returned frontier is one write. */
export class CloudRunRecoveryRuntime implements IRecoveryRuntime {
  constructor(private readonly dependencies: CloudRunRecoveryDependencies) {}

  async inspect(request: RecoveryRuntimeRequest): Promise<RecoveryRuntimeObservation> {
    try { return (await this.frontier(request)).observation; }
    catch (error) { return { state: 'unknown', reason: gcpRuntimeError(error) }; }
  }

  async apply(request: RecoveryRuntimeRequest & { step: RecoveryRuntimeStep; attemptId: string; privateInputs?: Record<string, string> }) {
    let mutationAttempted = false;
    let mutationRejected = false;
    const write = async (url: string, init: RequestInit, admin = false) => {
      const token = await (admin ? (this.dependencies.adminToken ?? getGcpNativeAdminToken)() : this.dependencies.token());
      mutationAttempted = true;
      try { return await gcpRuntimeRequest(url, token, init, this.dependencies.request); }
      catch (error) {
        // Only this exact rejected write establishes no effect. A later failed
        // read, malformed receipt or lost transport response never does.
        mutationRejected = error instanceof GcpRuntimeError && [400, 403].includes(error.status ?? 0);
        throw error;
      }
    };
    try {
      const pending = request.binding?.pending;
      if (!pending || pending.attemptId !== request.attemptId || !/^[a-zA-Z0-9-]{1,80}$/.test(request.attemptId)
        || pending.step.component !== request.step.component) throw new GcpRuntimeError('Recovery prerequisite requires its exact persisted operation intent.');
      const frontier = await this.frontier(request, true);
      if (frontier.observation.state !== 'action' || !same(frontier.observation.step, request.step)) throw new GcpRuntimeError('Recovery prerequisite changed; re-plan the exact current operation.');
      const { source, evidence, step } = frontier;
      if (!step) throw new GcpRuntimeError('Recovery prerequisite operation is unavailable.');
      if (step.operation === 'recover') return { receipt: { success: true, message: 'Recovered the exact observed backup prerequisite without another write.' }, binding: { provider: 'cloudrun', evidence } };
      if (request.mode === 'destroy') {
        await this.remove(source, evidence, step, write);
        return { receipt: { success: true, message: `Verified backup removal: ${step.description}` }, binding: { provider: 'cloudrun', evidence } };
      }
      if (step.component === 'identity') {
        const result = record(await write(`${IAM}projects/${source.projectId}/serviceAccounts`, { method: 'POST', body: JSON.stringify({ accountId: source.accountId, serviceAccount: { displayName: 'Hypervibe backup worker', description: `${source.owner}:${request.attemptId}` } }) }));
        const observed = await this.account(source);
        if (!observed || result.uniqueId !== observed.uniqueId || result.email !== source.email) throw new GcpRuntimeError('Backup identity creation has no exact correlated receipt.');
        this.assertAccountOwner(source, observed, request.attemptId);
        evidence.accountUniqueId = observed.uniqueId; evidence.identityAttemptId = request.attemptId;
      } else if (step.component === 'database-secret') {
        const result = record(await write(`${SM}projects/${source.projectId}/secrets?secretId=${source.secretId}`, { method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels: { hypervibe_recovery: source.targetHash.slice(0, 63), hypervibe_attempt: sha(request.attemptId).slice(0, 63) } }) }));
        const observed = await this.secret(source);
        if (!observed || result.name !== observed.name) throw new GcpRuntimeError('Backup secret creation has no exact correlated receipt.');
        this.assertSecretOwner(source, observed, request.attemptId);
        evidence.secretAttemptId = request.attemptId;
      } else if (step.component === 'database-secret-version') {
        const value = request.privateInputs?.databaseUrl;
        if (!value || sha(value) !== source.credentialHash || Object.keys(request.privateInputs ?? {}).some(key => key !== 'databaseUrl')) throw new GcpRuntimeError('Backup database input differs from the exact encrypted pending intent.');
        this.validateDatabaseUrl(value, source);
        const response = record(await write(`${SM}${source.secretName}:addVersion`, { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }) }));
        const version = await this.verifyVersion(source, response.name);
        evidence.secretVersion = version; evidence.credentialHash = source.credentialHash;
        evidence.ownedVersions = JSON.stringify([...new Set([...JSON.parse(evidence.ownedVersions ?? '[]'), version])].sort());
      } else {
        const permission = this.permissions(source, evidence).find(item => item.component === step.component);
        if (!permission) throw new GcpRuntimeError('Unsupported backup permission operation.');
        const policy = parseGcpRuntimePolicy(await this.api(permission.readUrl, permission.readMethod ? { method: permission.readMethod, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}));
        if (hasGcpRuntimeRole(policy, permission.role, permission.member)) throw new GcpRuntimeError('Backup permission changed before its write; reconcile the existing intent.');
        const desired = withGcpRuntimeRole(policy, permission.role, permission.member);
        await write(permission.writeUrl, { method: permission.writeMethod, body: JSON.stringify(permission.rawPolicy ? desired : { policy: desired, updateMask: 'bindings,etag' }) }, true);
        const observed = parseGcpRuntimePolicy(await this.api(permission.readUrl, permission.readMethod ? { method: permission.readMethod, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}));
        if (!hasGcpRuntimeRole(observed, permission.role, permission.member)) throw new GcpRuntimeError('Backup permission write has not converged.');
        evidence[`permission:${permission.component}`] = source.targetHash;
      }
      return { receipt: { success: true, message: `Verified backup prerequisite: ${step.description}` }, binding: { provider: 'cloudrun', evidence } };
    } catch (error) { return { receipt: { success: false, message: 'Backup runtime prerequisite did not converge.', error: gcpRuntimeError(error), data: { mutationAttempted, ...(mutationRejected ? { mutationRejected: true } : {}) } } }; }
  }

  /** Dispatcher reuses the same read-only prerequisites, including exact IAM. */
  async verifyExecution(target: RecoveryRuntimeTarget, execution: RecoveryRuntimeExecutionTarget): Promise<void> {
    let binding: RecoveryRuntimeBinding;
    try { binding = JSON.parse(execution.configuration.binding); } catch { throw new GcpRuntimeError('Prepared backup runtime binding is malformed.'); }
    const observed = await this.inspect({ target, binding, mode: 'ensure' });
    if (observed.state !== 'ready' || !observed.executionTarget || !same(observed.executionTarget, execution)) throw new GcpRuntimeError('Prepared backup runtime identity, network, credentials or permissions changed.');
  }

  private async frontier(request: RecoveryRuntimeRequest, initialApply = false): Promise<{ source: Source; evidence: Record<string, string>; observation: RecoveryRuntimeObservation; step?: RecoveryRuntimeStep }> {
    const source = await this.source(request.target, request.mode === 'destroy', request.binding?.evidence.deployerEmail, request.binding?.evidence.controllerUniqueId);
    const evidence = { ...(request.binding?.evidence ?? {}) };
    if (request.binding && (request.binding.provider !== 'cloudrun' || (evidence.targetHash && evidence.targetHash !== source.targetHash))) throw new GcpRuntimeError('Backup runtime binding belongs to another exact target.');
    if (evidence.controllerUniqueId && (evidence.controllerUniqueId !== source.controllerUniqueId || evidence.deployerEmail !== source.deployerEmail))
      throw new GcpRuntimeError('Backup controller identity changed; review its retained authority before preparing another identity.');
    evidence.targetHash = source.targetHash;
    if (request.mode === 'destroy') return this.removalFrontier(request, source, evidence, initialApply);
    evidence.sourceSnapshot = JSON.stringify({ database: source.target.database, destination: source.target.destination, objects: source.target.objects, runnerImage: source.target.runnerImage, credentialHash: source.credentialHash });
    if (source.deployerEmail) evidence.deployerEmail = source.deployerEmail;
    if (source.controllerUniqueId) evidence.controllerUniqueId = source.controllerUniqueId;
    const action = (component: string, operation: RecoveryRuntimeStep['operation'], target: Record<string, string>, description: string, privateInputKeys?: readonly string[]) => {
      if (!initialApply && operation !== 'recover' && request.binding?.pending) return { source, evidence, observation: { state: 'waiting', reason: 'The persisted backup prerequisite attempt has no visible effect yet; another write is not authorized.' } as RecoveryRuntimeObservation };
      const step: RecoveryRuntimeStep = { component, operation, target, description, requiresConfirm: operation !== 'recover', billable: operation !== 'recover' && ['database-secret', 'database-secret-version'].includes(component), ...(privateInputKeys ? { privateInputKeys } : {}) };
      return { source, evidence, observation: { state: 'action', step } as RecoveryRuntimeObservation, step };
    };
    const recover = (component: string) => {
      const pending = request.binding?.pending;
      if (!pending || pending.step.component !== component) throw new GcpRuntimeError('An unbound backup prerequisite already exists; it cannot be adopted without its exact prior intent.');
      return action(component, 'recover', pending.step.target, pending.step.description, pending.step.privateInputKeys);
    };
    const account = await this.account(source);
    if (!account) {
      if (evidence.accountUniqueId) throw new GcpRuntimeError('Bound backup identity is missing; replacement requires explicit reconciliation.');
      return action('identity', 'create', { email: source.email, targetHash: source.targetHash }, `Create a separate backup identity for ${request.target.environment.name}`);
    }
    const accountAttempt = evidence.identityAttemptId ?? (request.binding?.pending?.step.component === 'identity' ? request.binding.pending.attemptId : undefined);
    this.assertAccountOwner(source, account, accountAttempt);
    if (evidence.accountUniqueId && evidence.accountUniqueId !== account.uniqueId) throw new GcpRuntimeError('Backup identity was replaced.');
    if (!evidence.accountUniqueId) { evidence.accountUniqueId = account.uniqueId; evidence.identityAttemptId = accountAttempt!; return recover('identity'); }

    if (source.defaultAuthentication) {
      const result = record(await this.api(`${IAM}projects/${source.projectId}/serviceAccounts/${evidence.accountUniqueId}:testIamPermissions`,
        { method: 'POST', body: JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }) }));
      if (!Array.isArray(result.permissions) || !result.permissions.every((value: unknown) => typeof value === 'string')
        || !result.permissions.includes('iam.serviceAccounts.actAs')) throw new GcpRuntimeError('The local caller cannot run the exact dedicated backup identity.');
    }
    const permissions = this.permissions(source, evidence);
    for (const permission of permissions.filter(permission => ['deployer-access', 'database-access'].includes(permission.component))) {
      const policy = parseGcpRuntimePolicy(await this.api(permission.readUrl, permission.readMethod ? { method: permission.readMethod, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}));
      if (!hasGcpRuntimeRole(policy, permission.role, permission.member)) return action(permission.component, 'grant', { resource: permission.resource, role: permission.role, member: permission.member }, permission.description);
      if (!evidence[`permission:${permission.component}`]) { evidence[`permission:${permission.component}`] = source.targetHash; return recover(permission.component); }
    }
    const secret = await this.secret(source);
    if (!secret) {
      if (evidence.secretAttemptId) throw new GcpRuntimeError('Bound backup database secret is missing.');
      return action('database-secret', 'create', { name: source.secretName, targetHash: source.targetHash }, 'Create a dedicated Secret Manager reference for the backup database credential');
    }
    const secretAttempt = evidence.secretAttemptId ?? (request.binding?.pending?.step.component === 'database-secret' ? request.binding.pending.attemptId : undefined);
    this.assertSecretOwner(source, secret, secretAttempt);
    if (!evidence.secretAttemptId) { evidence.secretAttemptId = secretAttempt!; return recover('database-secret'); }
    const versions = await this.versions(source);
    const pending = request.binding?.pending;
    if (pending?.step.component === 'database-secret-version') {
      let prior: unknown;
      try { prior = JSON.parse(pending.step.target.priorVersions); } catch { throw new GcpRuntimeError('Pending secret-version history is invalid.'); }
      if (!Array.isArray(prior) || prior.some(item => typeof item !== 'string') || pending.step.target.credentialHash !== source.credentialHash) throw new GcpRuntimeError('Pending backup credential input changed.');
      const candidates = versions.filter(version => !prior.includes(version));
      if (candidates.length > 1) throw new GcpRuntimeError('Backup secret version creation is ambiguous.');
      if (candidates.length === 1) { evidence.secretVersion = await this.verifyVersion(source, candidates[0]); evidence.credentialHash = source.credentialHash; evidence.ownedVersions = JSON.stringify([...new Set([...JSON.parse(evidence.ownedVersions ?? '[]'), evidence.secretVersion])].sort()); return recover('database-secret-version'); }
      if (pending.step.operation === 'recover') throw new GcpRuntimeError('Expected backup credential recovery version is absent.');
    }
    if (!evidence.secretVersion || evidence.credentialHash !== source.credentialHash) {
      if (!evidence.secretVersion && versions.length > 0) throw new GcpRuntimeError('An unbound backup secret version already exists.');
      return action('database-secret-version', 'write', { secretName: source.secretName, credentialHash: source.credentialHash, priorVersions: JSON.stringify(versions) }, 'Write only the selected database credential into its encrypted backup reference', ['databaseUrl']);
    }
    const versionMetadata = record(await this.api(`${SM}${evidence.secretVersion}`));
    if (versionMetadata.name !== evidence.secretVersion || versionMetadata.state !== 'ENABLED') throw new GcpRuntimeError('The bound backup database credential version is unavailable.');
    for (const permission of permissions.filter(permission => !['deployer-access', 'database-access'].includes(permission.component))) {
      const policy = parseGcpRuntimePolicy(await this.api(permission.readUrl));
      if (!hasGcpRuntimeRole(policy, permission.role, permission.member)) return action(permission.component, 'grant', { resource: permission.resource, role: permission.role, member: permission.member }, permission.description);
      if (!evidence[`permission:${permission.component}`]) { evidence[`permission:${permission.component}`] = source.targetHash; return recover(permission.component); }
    }
    const binding = { provider: 'cloudrun', evidence };
    const worker = { provider: 'cloudrun', configuration: { projectId: source.projectId, instanceConnectionName: source.connectionName, ipType: source.ipType!, runtimeServiceAccountEmail: source.email } };
    return { source, evidence, observation: { state: 'ready', executionTarget: {
      environmentId: request.target.environment.id, region: source.region,
      provider: 'cloudrun', providerScope: { projectId: source.projectId, region: source.region, environmentId: request.target.environment.id },
      identity: { provider: 'gcp', principal: source.email, source: 'observed', scope: { projectId: source.projectId, uniqueId: evidence.accountUniqueId, environmentId: request.target.environment.id } },
      configuration: { binding: JSON.stringify(binding), secretVersion: evidence.secretVersion, credentialHash: source.credentialHash, vpcAccess: JSON.stringify(source.vpcAccess ?? null) }, worker,
    } } };
  }


  private removed(evidence: Record<string, string>): string[] {
    const values: unknown = JSON.parse(evidence.removalState ?? '[]');
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string') || new Set(values).size !== values.length)
      throw new GcpRuntimeError('Retained backup removal progress is malformed.');
    return values;
  }
  private markRemoved(evidence: Record<string, string>, component: string): void {
    evidence.removalState = JSON.stringify([...new Set([...this.removed(evidence), component])].sort());
  }
  private async readPolicy(permission: Permission) {
    return parseGcpRuntimePolicy(await this.api(permission.readUrl, permission.readMethod
      ? { method: permission.readMethod, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}));
  }
  private async noWorkerJobs(source: Source): Promise<void> {
    let pageToken = ''; const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = record(await this.api(`https://run.googleapis.com/v2/projects/${source.projectId}/locations/${source.region}/jobs?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`));
      if (response.jobs !== undefined && !Array.isArray(response.jobs)) throw new GcpRuntimeError('Backup job inventory is incomplete.');
      for (const value of response.jobs ?? []) {
        const job = record(value);
        if (typeof job.name !== 'string' || !job.name.startsWith(`projects/${source.projectId}/locations/${source.region}/jobs/`)
          || typeof job.template?.template?.serviceAccount !== 'string') throw new GcpRuntimeError('Backup job identity is incomplete.');
        if ([source.email].includes(job.template.template.serviceAccount)) throw new GcpRuntimeError('A job still references the backup identity; reconcile its execution and cleanup before removing access.');
      }
      if (!response.nextPageToken) return;
      if (typeof response.nextPageToken !== 'string' || seen.has(response.nextPageToken)) throw new GcpRuntimeError('Backup job inventory did not advance.');
      pageToken = response.nextPageToken; seen.add(pageToken);
    }
    throw new GcpRuntimeError('Backup job inventory exceeded its read budget.');
  }
  private async removalFrontier(request: RecoveryRuntimeRequest, source: Source, evidence: Record<string, string>, initialApply: boolean) {
    if (!request.binding || !evidence.accountUniqueId || !evidence.identityAttemptId || !evidence.sourceSnapshot)
      throw new GcpRuntimeError('Backup removal requires its retained native creation identity and source.');
    const removed = this.removed(evidence), pending = request.binding.pending;
    if (pending && pending.step.operation !== 'destroy') throw new GcpRuntimeError('Recover the prior preparation attempt before changing its lifecycle intent.');
    const account = await this.account(source), secret = await this.secret(source);
    if (account) {
      this.assertAccountOwner(source, account, evidence.identityAttemptId);
      if (account.uniqueId !== evidence.accountUniqueId) throw new GcpRuntimeError('Backup removal identity was replaced.');
      if (removed.includes('identity')) throw new GcpRuntimeError('A removed backup identity unexpectedly reappeared.');
    }
    if (secret) {
      this.assertSecretOwner(source, secret, evidence.secretAttemptId);
      if (typeof secret.etag !== 'string' || !secret.etag) throw new GcpRuntimeError('Backup credential deletion requires a native etag.');
      if (removed.includes('database-secret')) throw new GcpRuntimeError('A removed backup credential unexpectedly reappeared.');
      const owned: unknown = JSON.parse(evidence.ownedVersions ?? '[]');
      if (!Array.isArray(owned) || owned.some(value => typeof value !== 'string') || !same([...owned].sort(), await this.versions(source)))
        throw new GcpRuntimeError('Backup credential contains an unowned or unobserved version; preserve it.');
    }
    await this.noWorkerJobs(source);
    const permissions = this.permissions(source, evidence);
    const observed = new Map<string, Awaited<ReturnType<CloudRunRecoveryRuntime['readPolicy']>>>();
    for (const permission of permissions) {
      if (permission.component === 'deployer-access' && !account || permission.component === 'database-secret-access' && !secret) continue;
      const policy = await this.readPolicy(permission); observed.set(permission.component, policy);
      if (policy.bindings.some(binding => binding.members.includes(`serviceAccount:${source.email}`) && (binding.condition || binding.role !== permission.role)))
        throw new GcpRuntimeError('The backup identity has independently added authority; preserve it for separate review.');
      if (['deployer-access', 'database-secret-access'].includes(permission.component)
        && policy.bindings.some(binding => binding.condition || binding.role !== permission.role || binding.members.some(member => member !== permission.member)))
        throw new GcpRuntimeError('Dedicated backup resource has unrelated access; preserve the resource and review that authority separately.');
    }
    const action = (component: string, target: Record<string, string>, description: string, absent: boolean) => {
      if (pending) {
        if (pending.step.component !== component) throw new GcpRuntimeError('Backup removal observation moved beyond its retained frontier.');
        if (absent && !(initialApply && pending.step.target.nativeAbsent === 'true')) {
          this.markRemoved(evidence, component);
          const step: RecoveryRuntimeStep = { ...pending.step, operation: 'recover', requiresConfirm: false };
          return { source, evidence, observation: { state: 'action', step } as RecoveryRuntimeObservation, step };
        }
        if (!initialApply) return { source, evidence, observation: { state: 'waiting', reason: 'The retained removal attempt has not converged; do not repeat it.' } as RecoveryRuntimeObservation };
      }
      const step: RecoveryRuntimeStep = { component, operation: 'destroy', target: { ...target, ...(absent ? { nativeAbsent: 'true' } : {}) }, description, requiresConfirm: true };
      return { source, evidence, observation: { state: 'action', step } as RecoveryRuntimeObservation, step };
    };
    // Revoke the ability to start new workers before its data permissions. Each
    // following frontier rechecks that no job still uses this exact identity.
    const ordered = [...permissions.filter(p => p.component === 'deployer-access'), ...permissions.filter(p => p.component !== 'deployer-access').reverse()];
    for (const permission of ordered) {
      const policy = observed.get(permission.component);
      const present = Boolean(policy && hasGcpRuntimeRole(policy, permission.role, permission.member));
      if (removed.includes(permission.component)) { if (present) throw new GcpRuntimeError('Removed backup authority reappeared.'); continue; }
      if (!evidence[`permission:${permission.component}`]) { if (present) throw new GcpRuntimeError('Backup permission has no retained grant authority.'); continue; }
      return action(permission.component, { resource: permission.resource, role: permission.role, member: permission.member }, `Remove only the owned backup grant: ${permission.description}`, !present);
    }
    if (evidence.secretAttemptId && !removed.includes('database-secret')) return action('database-secret', { name: source.secretName, etag: secret?.etag ?? 'absent' }, 'Delete the dedicated backup database credential and its owned versions; preserve archive data', !secret);
    if (!removed.includes('identity')) return action('identity', { accountUniqueId: evidence.accountUniqueId, email: source.email }, 'Delete only the verified dedicated backup identity after its grants and jobs are absent', !account);
    if (pending) throw new GcpRuntimeError('Backup removal still has an unresolved attempt.');
    evidence.removalComplete = 'true';
    return { source, evidence, observation: { state: 'ready' } as RecoveryRuntimeObservation };
  }
  private async remove(source: Source, evidence: Record<string, string>, step: RecoveryRuntimeStep,
    write: (url: string, init: RequestInit, admin?: boolean) => Promise<unknown>): Promise<void> {
    if (step.target.nativeAbsent !== 'true') {
      if (step.component === 'database-secret') {
        await write(`${SM}${source.secretName}?etag=${encodeURIComponent(step.target.etag!)}`, { method: 'DELETE' }, true);
        if (await this.secret(source) !== null) throw new GcpRuntimeError('Backup credential deletion has not converged.');
      } else if (step.component === 'identity') {
        await write(`${IAM}projects/${source.projectId}/serviceAccounts/${evidence.accountUniqueId}`, { method: 'DELETE' }, true);
        if (await this.account(source) !== null) throw new GcpRuntimeError('Backup identity deletion has not converged.');
      } else {
        const permission = this.permissions(source, evidence).find(value => value.component === step.component);
        if (!permission) throw new GcpRuntimeError('Unsupported backup removal component.');
        const policy = await this.readPolicy(permission);
        const bindings = policy.bindings.map(binding => binding.role === permission.role && !binding.condition
          ? { ...binding, members: binding.members.filter(member => member !== permission.member) } : binding).filter(binding => binding.members.length > 0);
        const desired = { ...policy, bindings };
        await write(permission.writeUrl, { method: permission.writeMethod, body: JSON.stringify(permission.rawPolicy ? desired : { policy: desired, updateMask: 'bindings,etag' }) }, true);
        if (hasGcpRuntimeRole(await this.readPolicy(permission), permission.role, permission.member)) throw new GcpRuntimeError('Backup authority removal has not converged.');
      }
    }
    this.markRemoved(evidence, step.component);
  }

  private async source(target: RecoveryRuntimeTarget, removal = false, retainedDeployerEmail?: string, retainedControllerUniqueId?: string) {
    const { projectId, region, deployerEmail: connectedDeployerEmail, defaultAuthentication } = this.dependencies.connection();
    let deployerEmail = removal ? retainedDeployerEmail : connectedDeployerEmail;
    let controllerUniqueId = removal ? retainedControllerUniqueId : undefined;
    const bindings = target.environment.platformBindings;
    const database = target.database;
    const credentialHash = target.privateInputFingerprints?.databaseUrl;
    const selected = [{ name: 'archive', identity: target.destination }, ...target.objects];
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[a-z0-9-]+$/.test(region)
      || (!removal && !defaultAuthentication && !deployerEmail) || (deployerEmail !== undefined && !deployerEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`))
      || bindings.provider !== 'cloudrun' || bindings.projectId !== projectId || bindings.environmentId !== region
      || database.provider !== 'cloudsql' || database.providerScope.projectId !== projectId || database.providerScope.region !== region
      || database.resourceIdentity.instanceId !== database.primaryExternalId || !/^[a-z][a-z0-9-]{0,97}$/.test(database.primaryExternalId)
      || !credentialHash || !/^[a-f0-9]{64}$/.test(credentialHash)
      || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(target.runnerImage)
      || selected.length > 33 || new Set(selected.map(item => item.identity.externalId)).size !== selected.length
      || selected.some(item => item.identity.provider !== 'gcs' || item.identity.instanceScope.projectId !== projectId || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(item.identity.externalId))) {
      throw new GcpRuntimeError('Backup runtime requires exact Cloud Run, Cloud SQL and GCS bindings plus the selected encrypted database input.');
    }
    let ipType: string | undefined;
    let vpcAccess: Record<string, unknown> | undefined;
    const connectionName = `${projectId}:${region}:${database.primaryExternalId}`;
    if (!removal) {
    const sql = record(await this.api(`https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${database.primaryExternalId}`));
    if (sql.name !== database.primaryExternalId || sql.project !== projectId || sql.region !== region || sql.connectionName !== connectionName
      || !sql.databaseVersion?.startsWith('POSTGRES') || sql.masterInstanceName || sql.state !== 'RUNNABLE') throw new GcpRuntimeError('The exact primary Cloud SQL recovery source is unverified.');
    const ips = sql.ipAddresses;
    if (!Array.isArray(ips)) throw new GcpRuntimeError('Cloud SQL network observation is incomplete.');
    const publicIp = ips.filter((ip: any) => ip.type === 'PRIMARY');
    const privateIp = ips.filter((ip: any) => ip.type === 'PRIVATE');
    if (publicIp.length > 1 || privateIp.length > 1) throw new GcpRuntimeError('Cloud SQL network observation is ambiguous.');
    const configuredNetwork = bindings.cacheNetwork as Record<string, unknown> | undefined;
    if (privateIp.length === 1 && configuredNetwork && configuredNetwork.provider === 'cloudrun'
      && configuredNetwork.projectId === projectId && configuredNetwork.region === region
      && typeof configuredNetwork.network === 'string' && typeof configuredNetwork.subnetwork === 'string') {
      const network = configuredNetwork.network.startsWith('projects/') ? configuredNetwork.network : `projects/${projectId}/global/networks/${configuredNetwork.network}`;
      const subnetwork = configuredNetwork.subnetwork.startsWith('projects/') ? configuredNetwork.subnetwork : `projects/${projectId}/regions/${region}/subnetworks/${configuredNetwork.subnetwork}`;
      if (!new RegExp(`^projects/${projectId}/global/networks/[a-z][a-z0-9-]{0,62}$`).test(network)
        || !new RegExp(`^projects/${projectId}/regions/${region}/subnetworks/[a-z][a-z0-9-]{0,62}$`).test(subnetwork)) throw new GcpRuntimeError('Backup private VPC binding is out of scope.');
      if (sql.settings?.ipConfiguration?.privateNetwork?.replace('https://www.googleapis.com/compute/v1/', '') !== network) throw new GcpRuntimeError('Backup private VPC route differs from the Cloud SQL network.');
      const observed = record(await this.api(`https://compute.googleapis.com/compute/v1/${subnetwork}`));
      if (observed.selfLink !== `https://www.googleapis.com/compute/v1/${subnetwork}`
        || observed.network !== `https://www.googleapis.com/compute/v1/${network}`
        || observed.region !== `https://www.googleapis.com/compute/v1/projects/${projectId}/regions/${region}`) throw new GcpRuntimeError('Backup private VPC subnet could not be independently verified.');
      vpcAccess = { networkInterfaces: [{ network, subnetwork }], egress: 'PRIVATE_RANGES_ONLY' };
    }
    ipType = vpcAccess ? 'PRIVATE' : publicIp.length === 1 && sql.settings?.ipConfiguration?.ipv4Enabled === true ? 'PUBLIC' : undefined;
    if (!ipType) throw new GcpRuntimeError('Private-only Cloud SQL backup requires an independently observed matching VPC route.');
    }
    const project = record(await this.api(`https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`));
    if (project.projectId !== projectId || project.state !== 'ACTIVE' || typeof project.name !== 'string'
      || !/^projects\/[1-9]\d{5,29}$/.test(project.name)) throw new GcpRuntimeError('The exact recovery project identity is unverified.');
    const projectNumber = project.name.slice('projects/'.length);
    if (!removal && bindings.gcpGithubWorkloadIdentity !== undefined) {
      const ci = parseGcpGithubWorkloadIdentity(bindings.gcpGithubWorkloadIdentity);
      if (ci.projectId !== projectId || ci.projectNumber !== projectNumber || ci.environment !== target.environment.name
        || ci.backupWorkflow !== `.github/workflows/hypervibe-backup-${target.environment.name}.yml`
        || connectedDeployerEmail && connectedDeployerEmail !== ci.serviceAccountEmail)
        throw new GcpRuntimeError('The reviewed CI backup authorization belongs to another exact scope.');
      const identity = record(await this.api(`${IAM}projects/${projectId}/serviceAccounts/${ci.serviceAccountUniqueId}`));
      if (identity.projectId !== projectId || identity.email !== ci.serviceAccountEmail || identity.uniqueId !== ci.serviceAccountUniqueId || identity.disabled === true)
        throw new GcpRuntimeError('The reviewed CI backup identity was replaced or disabled.');
      deployerEmail = ci.serviceAccountEmail; controllerUniqueId = ci.serviceAccountUniqueId;
    }
    if (removal && controllerUniqueId) {
      if (!/^[1-9]\d{5,29}$/.test(controllerUniqueId) || !deployerEmail) throw new GcpRuntimeError('Retained backup controller identity is incomplete.');
      const identity = record(await this.api(`${IAM}projects/${projectId}/serviceAccounts/${controllerUniqueId}`));
      if (identity.projectId !== projectId || identity.email !== deployerEmail || identity.uniqueId !== controllerUniqueId || identity.disabled === true)
        throw new GcpRuntimeError('The retained backup controller identity was replaced or disabled.');
    }
    for (const item of selected) {
      const bucket = record(await this.api(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(item.identity.externalId)}`));
      if (bucket.name !== item.identity.externalId || bucket.projectNumber !== projectNumber
        || bucket.labels?.hypervibe_environment_id !== target.environment.id) throw new GcpRuntimeError('Backup bucket ownership differs from the selected project and environment.');
    }
    const targetHash = canonicalJsonSha256({ environment: target.environment.id, database, destination: target.destination, objects: target.objects });
    const accountId = resourceName('backup', { maxLength: 30, minLength: 6, scope: [projectId, target.environment.id] });
    const secretId = resourceName('backup-database', { maxLength: 63, scope: [projectId, target.environment.id] });
    return { projectId, region, deployerEmail, controllerUniqueId, defaultAuthentication, credentialHash, connectionName, ipType, vpcAccess, target, targetHash, accountId,
      email: `${accountId}@${projectId}.iam.gserviceaccount.com`, owner: `hypervibe-recovery:${targetHash}`,
      secretId, secretName: `projects/${projectId}/secrets/${secretId}` };
  }

  private async account(source: Source): Promise<Record<string, any> | null> {
    const result = await this.api(`${IAM}projects/${source.projectId}/serviceAccounts/${encodeURIComponent(source.email)}`);
    if (result === null) return null;
    const value = record(result);
    if (value.email !== source.email || value.projectId !== source.projectId || !/^\d+$/.test(value.uniqueId) || value.disabled === true) throw new GcpRuntimeError('Backup service account identity is incomplete.');
    return value;
  }
  private assertAccountOwner(source: Source, account: Record<string, any>, attemptId?: string): void {
    if (!attemptId || account.description !== `${source.owner}:${attemptId}`) throw new GcpRuntimeError('Existing backup identity has no exact owned creation intent.');
  }
  private async secret(source: Source): Promise<Record<string, any> | null> {
    const result = await this.api(`${SM}${source.secretName}`);
    return result === null ? null : record(result);
  }
  private assertSecretOwner(source: Source, secret: Record<string, any>, attemptId?: string): void {
    if (!attemptId || secret.name !== source.secretName || secret.labels?.hypervibe_recovery !== source.targetHash.slice(0, 63) || secret.labels?.hypervibe_attempt !== sha(attemptId).slice(0, 63)) throw new GcpRuntimeError('Existing backup secret has no exact owned creation intent.');
  }
  private async versions(source: Source): Promise<string[]> {
    const versions: string[] = []; const seen = new Set<string>(); let pageToken = '';
    for (let page = 0; page < 100; page++) {
      const response = record(await this.api(`${SM}${source.secretName}/versions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`));
      if (response.versions !== undefined && !Array.isArray(response.versions)) throw new GcpRuntimeError('Backup secret version inventory is incomplete.');
      for (const entry of response.versions ?? []) {
        if (typeof entry.name !== 'string' || !entry.name.startsWith(`${source.secretName}/versions/`) || !/^\d+$/.test(entry.name.split('/').at(-1)) || versions.includes(entry.name)) throw new GcpRuntimeError('Backup secret version inventory is ambiguous.');
        versions.push(entry.name);
      }
      if (!response.nextPageToken) return versions.sort();
      if (typeof response.nextPageToken !== 'string' || seen.has(response.nextPageToken)) throw new GcpRuntimeError('Backup secret version pagination did not advance.');
      pageToken = response.nextPageToken; seen.add(pageToken);
    }
    throw new GcpRuntimeError('Backup secret version inventory exceeded its read budget.');
  }
  private async verifyVersion(source: Source, name: unknown): Promise<string> {
    if (typeof name !== 'string' || !name.startsWith(`${source.secretName}/versions/`) || !/^\d+$/.test(name.split('/').at(-1)!)) throw new GcpRuntimeError('Backup secret creation returned an unrelated version.');
    const version = record(await this.api(`${SM}${name}:access`));
    if (version.name !== name || typeof version.payload?.data !== 'string' || sha(Buffer.from(version.payload.data, 'base64').toString('utf8')) !== source.credentialHash) throw new GcpRuntimeError('Backup secret value did not match the selected encrypted input.');
    return name;
  }
  private validateDatabaseUrl(value: string, source: Source): void {
    let url: URL;
    try { url = new URL(value.replace(/^(postgres(?:ql)?:\/\/[^/]+@)\//, '$1localhost/')); } catch { throw new GcpRuntimeError('Selected backup database input is invalid.'); }
    const socket = url.searchParams.get('host');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || url.pathname.length < 2
      || (socket && socket !== `/cloudsql/${source.connectionName}`)) throw new GcpRuntimeError('Selected backup database credential does not match the reviewed Cloud SQL source.');
  }
  private permissions(source: Source, evidence: Record<string, string>): Permission[] {
    const member = `serviceAccount:${source.email}`;
    const account = `projects/${source.projectId}/serviceAccounts/${evidence.accountUniqueId}`;
    const project = `https://cloudresourcemanager.googleapis.com/v1/projects/${source.projectId}`;
    const bucket = (component: string, name: string, role: string, description: string) => ({ component, resource: `projects/_/buckets/${name}`, role, member,
      readUrl: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/iam?optionsRequestedPolicyVersion=3`,
      writeUrl: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/iam`, writeMethod: 'PUT', rawPolicy: true, description });
    return [
      ...(source.deployerEmail ? [{ component: 'deployer-access', resource: account, role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${source.deployerEmail}`, readUrl: `${IAM}${account}:getIamPolicy`, readMethod: 'POST', writeUrl: `${IAM}${account}:setIamPolicy`, writeMethod: 'POST', description: 'Allow the deploy connection to run only the dedicated backup identity' }] : []),
      { component: 'database-access', resource: `projects/${source.projectId}`, role: 'roles/cloudsql.client', member, readUrl: `${project}:getIamPolicy`, readMethod: 'POST', writeUrl: `${project}:setIamPolicy`, writeMethod: 'POST', description: 'Allow the backup identity to use the Cloud SQL connector in the selected project' },
      { component: 'database-secret-access', resource: source.secretName, role: 'roles/secretmanager.secretAccessor', member, readUrl: `${SM}${source.secretName}:getIamPolicy?options.requestedPolicyVersion=3`, writeUrl: `${SM}${source.secretName}:setIamPolicy`, writeMethod: 'POST', description: 'Allow the backup identity to read only its selected database credential' },
      bucket('archive-access', source.target.destination.externalId, 'roles/storage.objectUser', 'Allow verified recovery sets and retention only in the backup archive bucket'),
      ...(source.controllerUniqueId && source.deployerEmail ? [{ ...bucket('controller-archive-access', source.target.destination.externalId, 'roles/storage.objectUser', 'Allow the verified backup controller to read and retain recovery sets only in the selected archive bucket'), member: `serviceAccount:${source.deployerEmail}` }] : []),
      ...source.target.objects.map(object => bucket(`source-access:${object.name}`, object.identity.externalId, 'roles/storage.objectViewer', `Allow read-only backup of the ${object.name} bucket`)),
    ];
  }
  private async api(url: string, init: RequestInit = {}): Promise<unknown | null> {
    return gcpRuntimeRequest(url, await this.dependencies.token(), init, this.dependencies.request);
  }
}
