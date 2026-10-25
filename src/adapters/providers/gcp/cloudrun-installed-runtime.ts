import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { IRuntimeIdentities, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { gcpRuntimeRequest, hasGcpRuntimeRole, parseGcpRuntimePolicy } from './gcp-runtime-client.js';
import { desiredRuntimeSecrets, readRuntimeSecretPolicies, serializeRuntimeSecrets } from './gcp-runtime-secrets.js';

const phase = 'installed-runtime-binding';
/** Read-only binding of the exact reviewed native account. No IAM repair, adoption or deletion. */
export class CloudRunInstalledRuntimeIdentities implements IRuntimeIdentities {
  constructor(private readonly connection: () => CloudDeploymentConnectionV1, private readonly token: () => Promise<string>) {}
  private async proof(request: RuntimeIdentityRequest) {
    const connection = this.connection(), { projectId } = connection.nativeScope, region = connection.deployment.region;
    const workload = connection.deployment.workloads.find(item => item.name === request.service.name);
    const installed = connection.runtimeIdentities.find(item => item.workload === request.service.name);
    if (!workload || !installed || installed.principal.kind !== 'gcp-service-account' || request.environment.name !== connection.environment
      || request.environmentSpec && (request.environmentSpec.hosting.provider !== 'cloudrun'
        || request.environmentSpec.hosting.region && request.environmentSpec.hosting.region !== region
        || request.environmentSpec.database || request.environmentSpec.cache || Object.keys(request.environmentSpec.storage ?? {}).length
        || Object.keys(request.environmentSpec.queues ?? {}).length)) throw new Error();
    const bindings = parseHostingBindings(request.environment);
    if (bindings.projectId !== projectId || bindings.environmentId && bindings.environmentId !== region) throw new Error();
    if (request.environmentSpec && request.mode !== 'destroy') {
      const desired = Object.entries(request.environmentSpec.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, reference]) => ({ key, reference: runtimeSecretReferenceSchema.parse(reference) }));
      if (!isDeepStrictEqual(desired, workload.runtimeSecrets)) throw new Error();
    }
    const principal = installed.principal, token = await this.token(), email = principal.serviceAccountEmail;
    const accountResource = `projects/${projectId}/serviceAccounts/${principal.serviceAccountUniqueId}`;
    const account = await gcpRuntimeRequest(`https://iam.googleapis.com/v1/${accountResource}`, token) as Record<string, unknown> | null;
    const name = `projects/${projectId}/serviceAccounts/${email}`;
    if (!account || account.name !== name || account.projectId !== projectId || account.email !== email
      || account.uniqueId !== principal.serviceAccountUniqueId || account.disabled !== undefined && account.disabled !== false
      || account.description !== `hypervibe:deployment:v1:${installed.owner}:${installed.installationId}`) throw new Error();
    const policy = parseGcpRuntimePolicy(await gcpRuntimeRequest(`https://iam.googleapis.com/v1/${accountResource}:getIamPolicy`, token,
      { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }));
    for (const deployer of Object.values(connection.principals)) if (deployer.kind !== 'gcp-service-account'
      || !hasGcpRuntimeRole(policy, 'roles/iam.serviceAccountUser', `serviceAccount:${deployer.serviceAccountEmail}`)) throw new Error();
    const secretRequest = { ...request, environmentSpec: request.environmentSpec ?? { secretDestinations: Object.fromEntries(workload.runtimeSecrets.map(item => [item.key, item.reference])) } as RuntimeIdentityRequest['environmentSpec'] };
    const desired = desiredRuntimeSecrets(secretRequest, projectId);
    const readers = await readRuntimeSecretPolicies(projectId, desired, token, desired);
    if (readers.some(reader => !reader.policy || !hasGcpRuntimeRole(reader.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${email}`))) throw new Error();
    const bound = bindings.services?.[workload.name];
    const kind = bound ? bound.jobName ? 'jobs' : 'services' : workload.kind === 'cron' ? 'jobs' : 'services';
    const nativeName = bound?.jobName ?? bound?.serviceId ?? resourceName(workload.name, { maxLength: 49, scope: [projectId, connection.environment] });
    if (!/^[a-z][a-z0-9-]{0,48}$/.test(nativeName)) throw new Error();
    const resource = `projects/${projectId}/locations/${region}/${kind}/${nativeName}`;
    const native = await gcpRuntimeRequest(`https://run.googleapis.com/v2/${resource}`, token) as Record<string, any> | null;
    if (native ? !bound || native.name !== resource || !bound.resourceUid || native.uid !== bound.resourceUid
      || (kind === 'jobs' ? native.template?.template?.serviceAccount : native.template?.serviceAccount) !== email : !!bound) throw new Error();
    const target = { phase, runtimeInstallationId: connection.installationId, runtimePlanDigest: connection.planDigest, runtimeOwner: installed.owner,
      projectId, region, email, name, uniqueId: principal.serviceAccountUniqueId, accountId: email.split('@')[0]!,
      environmentId: request.environment.id, serviceName: workload.name, workloadResource: resource,
      readerGrants: serializeRuntimeSecrets(readers.map(reader => reader.target)),
      readerFingerprint: createHash('sha256').update(JSON.stringify(workload.runtimeSecrets)).digest('hex') };
    const identity: ProviderRuntimeIdentity = { provider: 'gcp', principal: email, source: native ? 'observed' : 'configured', scope: {
      projectId, region, environmentId: request.environment.id, serviceName: workload.name, workloadResource: resource,
      serviceAccountUniqueId: principal.serviceAccountUniqueId, ...(native ? { workloadUid: native.uid as string } : {}) } };
    return { target, identity };
  }
  async inspect(request: RuntimeIdentityRequest): Promise<Awaited<ReturnType<IRuntimeIdentities['inspect']>>> {
    try {
      const proof = await this.proof(request);
      if (request.mode === 'destroy') return { state: 'ready', warnings: ['Administrator-installed runtime identities and reader permissions are retained.'] };
      const pending = request.binding?.pending;
      if (pending) {
        const target = { ...pending.step.target }; delete target.recoverAttemptId;
        if (!isDeepStrictEqual(target, proof.target)) throw new Error();
        return { state: 'action', step: { operation: 'recover', target: { ...proof.target, recoverAttemptId: pending.attemptId }, requiresConfirm: false,
          description: 'Reconcile the exact installed runtime binding without changing Google permissions.' } };
      }
      if (request.binding && (request.binding.provider !== 'cloudrun' || !isDeepStrictEqual(request.binding.evidence, proof.target))) throw new Error();
      if (request.binding) return { state: 'ready', identity: proof.identity };
      return { state: 'action', step: { operation: 'attach', target: proof.target, requiresConfirm: true,
        description: 'Bind the independently verified administrator-installed Google runtime identity and reader permissions.' } };
    } catch { return { state: 'unknown', reason: 'Installed Google runtime identity or permissions could not be verified; a new setup review may be required.' }; }
  }
  async apply(request: RuntimeIdentityRequest & { step: RuntimeIdentityStep; attemptId: string }): Promise<Awaited<ReturnType<IRuntimeIdentities['apply']>>> {
    try {
      const proof = await this.proof(request), target = { ...request.step.target }; delete target.recoverAttemptId;
      if (request.mode !== 'ensure' || !['attach', 'recover'].includes(request.step.operation) || !isDeepStrictEqual(target, proof.target)
        || request.binding?.pending && request.binding.pending.attemptId !== (request.step.target.recoverAttemptId ?? request.attemptId)) throw new Error();
      return { receipt: { success: true, message: 'Verified and bound the installed Google runtime identity; no cloud permissions changed.' },
        binding: { provider: 'cloudrun', evidence: proof.target } };
    } catch { return { receipt: { success: false, message: 'Installed Google runtime binding could not be verified; no cloud permissions changed.' } }; }
  }
}
