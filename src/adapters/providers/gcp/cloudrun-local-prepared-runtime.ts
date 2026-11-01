import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LocalPreparedHostingLoader } from '../../../domain/ports/hosting-prepared.port.js';
import type { IRuntimeIdentities, RuntimeIdentityRequest } from '../../../domain/ports/runtime-identity.port.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import { describePreparedHosting } from '../../../domain/services/hosting-prepared.service.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { readGcpLocalPreparedResources } from './gcp-local-holding-preparation.js';
import { gcpPreparedHoldingTransition } from './gcp-prepared-release.js';
import { gcpRuntimeRequest, hasGcpRuntimeRole, parseGcpRuntimePolicy, withGcpRuntimeRole, GcpRuntimeError } from './gcp-runtime-client.js';
import { desiredRuntimeSecrets, readRuntimeSecretPolicies, serializeRuntimeSecrets } from './gcp-runtime-secrets.js';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
}
function runtimeDigest(native: Record<string, any>): string {
  return digest(Object.fromEntries(['name', 'uid', 'uri', 'template', 'traffic', 'trafficStatuses', 'scaling', 'ingress',
    'invokerIamDisabled', 'latestCreatedRevision', 'latestReadyRevision', 'annotations', 'binaryAuthorization', 'customAudiences']
    .map(key => [key, native[key]])));
}
const repairPhase = 'local-prepared-ownership-labels';

/** Local journal/native account proof. Explicit runtime-access actions grant
 * exact secret readers or Cloud SQL client to the final identity only. */
export class CloudRunLocalPreparedRuntime implements IRuntimeIdentities {
  constructor(private readonly load: LocalPreparedHostingLoader, private readonly token: () => Promise<string>, private readonly request: typeof fetch) {}
  private async proof(input: RuntimeIdentityRequest) {
    const receipt = await this.load(), descriptor = describePreparedHosting(receipt), token = await this.token();
    const installed = descriptor.runtimeIdentities.find(item => item.workload === input.service.name), bindings = parseHostingBindings(input.environment);
    const workload = descriptor.deployment.workloads.find(item => item.name === input.service.name), bound = bindings.services?.[input.service.name];
    if (input.environment.name !== descriptor.environment || !installed || installed.principal.kind !== 'gcp-service-account' || !workload
      || bindings.projectId !== descriptor.nativeScope.projectId || bindings.environmentId !== descriptor.deployment.region
      || !bound || workload.kind === 'cron' || input.environmentSpec && input.environmentSpec.services[input.service.name]?.workloadKind !== workload.kind) throw new Error();
    const acknowledgment = input.acknowledgedUpdate;
    const repair = acknowledgment && acknowledgment.serviceId === bound.serviceId && acknowledgment.resourceUid === bound.resourceUid
      && acknowledgment.imageUri === bound.imageUri && bound.resourceType === 'service' && bound.workloadKind === workload.kind
      ? { serviceName: input.service.name, resourceUid: acknowledgment.resourceUid } : undefined;
    const principal = installed.principal, resources = await readGcpLocalPreparedResources(receipt, token, AbortSignal.timeout(30000), this.request, repair);
    const native = resources.workloads[input.service.name] as any, ownership = resources.ownershipLabels[input.service.name];
    if (ownership.missing || input.binding?.pending?.step.target.phase === repairPhase) {
      const attempt = (input.environment.platformBindings.preparedDirectReleaseAttempts as any)?.[input.service.name];
      if (!repair || !acknowledgment || attempt && attempt.status !== 'completed' || typeof native.etag !== 'string' || !native.etag
        || native.reconciling === true || native.terminalCondition?.state !== 'CONDITION_SUCCEEDED' || native.generation !== native.observedGeneration
        || native.template?.containers?.length !== 1 || native.template.containers[0].image !== acknowledgment.imageUri
        || !native.latestCreatedRevision || native.latestCreatedRevision !== native.latestReadyRevision
        || native.template?.serviceAccount !== principal.serviceAccountEmail
        || !native.labels || typeof native.labels !== 'object' || Array.isArray(native.labels)
        || Object.values(native.labels).some(value => typeof value !== 'string')) throw new Error();
    }
    const holding = gcpPreparedHoldingTransition(descriptor, input.environment, input.service.name, native);
    if (native.uid !== bound.resourceUid || native.name.split('/').at(-1) !== bound.serviceId
      || !holding && native.template?.serviceAccount !== principal.serviceAccountEmail) throw new Error();
    const actAs = await gcpRuntimeRequest(`https://iam.googleapis.com/v1/projects/${principal.projectId}/serviceAccounts/${principal.serviceAccountUniqueId}:testIamPermissions`, token,
      { method: 'POST', body: JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }) }, this.request) as { permissions?: string[] } | null;
    if (!actAs?.permissions?.includes('iam.serviceAccounts.actAs')) throw new Error();
    const desired = desiredRuntimeSecrets(input, principal.projectId), readers = await readRuntimeSecretPolicies(principal.projectId, desired, token, desired, this.request);
    const missingReader = readers.find(item => !item.policy || !hasGcpRuntimeRole(item.policy, 'roles/secretmanager.secretAccessor', `serviceAccount:${principal.serviceAccountEmail}`));
    const cloudsql=input.environmentSpec?.database?.provider==='cloudsql'||input.binding?.evidence.cloudsqlClient==='required'||input.binding?.pending?.step.target.cloudsqlClient==='required';
    const policyUrl=`https://cloudresourcemanager.googleapis.com/v1/projects/${principal.projectId}`;
    const policy=cloudsql?parseGcpRuntimePolicy(await gcpRuntimeRequest(`${policyUrl}:getIamPolicy`,token,
      {method:'POST',body:JSON.stringify({options:{requestedPolicyVersion:3}})},this.request)):undefined;
    const sqlReady=!policy||hasGcpRuntimeRole(policy,'roles/cloudsql.client',`serviceAccount:${principal.serviceAccountEmail}`);
    const target = { phase: 'local-prepared-runtime-binding', receiptDigest: descriptor.receiptDigest, runtimeInstallationId: descriptor.installationId,
      runtimePlanDigest: descriptor.planDigest, projectId: principal.projectId, region: descriptor.deployment.region, email: principal.serviceAccountEmail,
      uniqueId: principal.serviceAccountUniqueId, environmentId: input.environment.id, serviceName: input.service.name,
      workloadResource: native.name as string, workloadUid: native.uid as string, readerGrants: serializeRuntimeSecrets(readers.map(item => item.target)),
      ...(cloudsql?{cloudsqlClient:'required'}:{}) };
    const identity: ProviderRuntimeIdentity = { provider: 'gcp', principal: principal.serviceAccountEmail, source: holding ? 'configured' : 'observed',
      scope: { projectId: principal.projectId, region: descriptor.deployment.region, environmentId: input.environment.id, serviceName: input.service.name,
        workloadResource: native.name, workloadUid: native.uid, serviceAccountUniqueId: principal.serviceAccountUniqueId } };
    return { target, identity, policy,policyUrl,token,sqlReady,readers,missingReader,native,ownership,acknowledgment };
  }
  private ownershipTarget(proof: Awaited<ReturnType<CloudRunLocalPreparedRuntime['proof']>>, input: RuntimeIdentityRequest, retained?: Record<string, string>) {
    if (!input.binding || input.binding.provider !== 'cloudrun' || !isDeepStrictEqual(input.binding.evidence, proof.target)
      || !proof.acknowledgment || !proof.sqlReady || proof.missingReader) throw new Error();
    const common = { ...proof.target, phase: repairPhase, acknowledgedApplyId: proof.acknowledgment.applyRunId,
      acknowledgedPlanId: proof.acknowledgment.planRunId, imageUri: proof.acknowledgment.imageUri,
      expectedOwnerLabel: proof.ownership.expected['hv-owner'], expectedAttemptLabel: proof.ownership.expected['hv-attempt'], runtimeDigest: runtimeDigest(proof.native) };
    if (retained) {
      const { resourceEtag, labelsBeforeDigest, labelsAfterDigest, ...previous } = retained;
      if (!isDeepStrictEqual(common, previous) || !resourceEtag || !/^[a-f0-9]{64}$/.test(labelsBeforeDigest ?? '') || !/^[a-f0-9]{64}$/.test(labelsAfterDigest ?? '')
        || digest(proof.native.labels) !== (proof.ownership.missing ? labelsBeforeDigest : labelsAfterDigest)
        || proof.ownership.missing && proof.native.etag !== resourceEtag) throw new Error();
      return retained;
    }
    if (!proof.ownership.missing) throw new Error();
    return { ...common, resourceEtag: proof.native.etag as string, labelsBeforeDigest: digest(proof.native.labels),
      labelsAfterDigest: digest({ ...proof.native.labels, ...proof.ownership.expected }) };
  }
  private reviewedTarget(proof: Awaited<ReturnType<CloudRunLocalPreparedRuntime['proof']>>, target: Record<string,string>) {
    if(target.phase==='local-prepared-cloudsql-access')return {...proof.target,phase:target.phase};
    if(target.phase==='local-prepared-secret-access'){
      if(!proof.readers.some(item=>item.target.resource===target.readerResource))throw new Error();
      return {...proof.target,phase:target.phase,readerResource:target.readerResource};
    }
    return proof.target;
  }
  async inspect(input: RuntimeIdentityRequest): ReturnType<IRuntimeIdentities['inspect']> {
    try {
      const proof = await this.proof(input);
      if (input.mode === 'destroy') return { state: 'ready', warnings: ['Local administrator-prepared identities and grants are retained.'] };
      if (input.binding?.pending) {
        const target = { ...input.binding.pending.step.target }; delete target.recoverAttemptId;
        if (target.phase === repairPhase) return { state: 'action', step: { operation: 'recover', target: { ...this.ownershipTarget(proof, input, target), recoverAttemptId: input.binding.pending.attemptId }, requiresConfirm: false, description: 'Read back the exact ownership-label repair; do not resubmit it.' } };
        const expected=this.reviewedTarget(proof,target);
        if (!isDeepStrictEqual(target, expected)) throw new Error();
        return { state: 'action', step: { operation: 'recover', target: { ...expected, recoverAttemptId: input.binding.pending.attemptId }, requiresConfirm: false,
          description: 'Recover the exact local prepared identity binding without changing Google IAM.' } };
      }
      if (proof.ownership.missing) return { state: 'action', step: { operation: 'attach', target: this.ownershipTarget(proof, input), requiresConfirm: true,
        description: 'Restore only the missing original ownership labels on this acknowledged existing workload, using its exact UID and ETag. Preserve all other labels; do not change its image, template, permissions or run migrations.' } };
      if(input.binding){
        const previous={...input.binding.evidence},current={...proof.target};delete previous.cloudsqlClient;delete current.cloudsqlClient;
        if(input.binding.provider!=='cloudrun'||!isDeepStrictEqual(previous,current))throw new Error();
      }
      if(proof.missingReader)return {state:'action',step:{operation:'attach',target:{...proof.target,phase:'local-prepared-secret-access',readerResource:proof.missingReader.target.resource},requiresConfirm:true,
        description:`Grant roles/secretmanager.secretAccessor on ${proof.missingReader.target.resource} only to ${proof.identity.principal}. This covers all versions of that secret; deployment remains pinned to its reviewed version. Preserve unrelated IAM and the holding identity.`}};
      if(!proof.sqlReady)return {state:'action',step:{operation:'attach',target:{...proof.target,phase:'local-prepared-cloudsql-access'},requiresConfirm:true,
        description:'Grant roles/cloudsql.client on this project only to the journal-verified final runtime identity; preserve unrelated IAM and keep the holding identity unchanged.'}};
      if (input.binding) {
        if(isDeepStrictEqual(input.binding.evidence,proof.target))return { state: 'ready', identity: proof.identity };
      }
      return { state: 'action', step: { operation: 'attach', target: proof.target, requiresConfirm: true,
        description: 'Bind this journal-verified final runtime identity and its existing permissions without changing Google IAM.' } };
    } catch { return { state: 'unknown', reason: 'Local prepared workload ownership, runtime identity or declared permissions could not be verified. Inspect the retained installation and exact workload before planning changes.' }; }
  }
  async apply(input: Parameters<IRuntimeIdentities['apply']>[0]): ReturnType<IRuntimeIdentities['apply']> {
    let mutationAttempted=false,mutationAcknowledged=false;
    try {
      const proof = await this.proof(input);
      const target = { ...input.step.target }; delete target.recoverAttemptId;
      if (target.phase === repairPhase) {
        if (input.mode !== 'ensure' || !['attach', 'recover'].includes(input.step.operation)
          || !input.binding?.pending || input.binding.pending.attemptId !== (input.step.target.recoverAttemptId ?? input.attemptId)) throw new Error();
        this.ownershipTarget(proof, input, target);
        if (proof.ownership.missing) {
          if (input.step.operation === 'recover') throw new Error();
          mutationAttempted = true;
          await gcpRuntimeRequest(`https://run.googleapis.com/v2/${proof.native.name}?updateMask=labels`, proof.token,
            { method: 'PATCH', body: JSON.stringify({ name: proof.native.name, etag: target.resourceEtag, labels: { ...proof.native.labels, ...proof.ownership.expected } }) }, this.request);
          mutationAcknowledged = true;
        }
        const after = await this.proof(input);
        this.ownershipTarget(after, input, target);
        if (after.ownership.missing) throw new Error();
        return { receipt: { success: true, message: 'Verified the exact ownership labels and unchanged workload runtime configuration; no image update or migration was requested.' }, binding: { provider: 'cloudrun', evidence: after.target } };
      }
      if (proof.ownership.missing) throw new Error();
      const grant=target.phase==='local-prepared-cloudsql-access',secretGrant=target.phase==='local-prepared-secret-access';
      if (input.mode !== 'ensure' || !['attach', 'recover'].includes(input.step.operation) || !isDeepStrictEqual(target,this.reviewedTarget(proof,target))
        || input.binding?.pending && input.binding.pending.attemptId !== (input.step.target.recoverAttemptId ?? input.attemptId)) throw new Error();
      if(secretGrant){
        const reader=proof.readers.find(item=>item.target.resource===target.readerResource);
        if(!reader?.policy)throw new Error();
        if(!hasGcpRuntimeRole(reader.policy,'roles/secretmanager.secretAccessor',`serviceAccount:${proof.identity.principal}`)){
          if(input.step.operation==='recover')throw new Error();
          mutationAttempted=true;
          parseGcpRuntimePolicy(await gcpRuntimeRequest(`${reader.url}:setIamPolicy`,proof.token,{method:'POST',body:JSON.stringify({
            policy:withGcpRuntimeRole(reader.policy,'roles/secretmanager.secretAccessor',`serviceAccount:${proof.identity.principal}`),
          })},this.request));
          mutationAcknowledged=true;
          const after=await this.proof(input),observed=after.readers.find(item=>item.target.resource===target.readerResource);
          if(!isDeepStrictEqual(after.target,proof.target)||!observed?.policy||!hasGcpRuntimeRole(observed.policy,'roles/secretmanager.secretAccessor',`serviceAccount:${proof.identity.principal}`))throw new Error();
        }
      }else if(proof.missingReader)throw new Error();
      else if(grant&&!proof.sqlReady){
        if(input.step.operation==='recover'||!proof.policy)throw new Error();
        mutationAttempted=true;
        parseGcpRuntimePolicy(await gcpRuntimeRequest(`${proof.policyUrl}:setIamPolicy`,proof.token,{method:'POST',body:JSON.stringify({policy:withGcpRuntimeRole(proof.policy,'roles/cloudsql.client',`serviceAccount:${proof.identity.principal}`)})},this.request));
        mutationAcknowledged=true;
        if(!(await this.proof(input)).sqlReady)throw new Error();
      }else if(!proof.sqlReady)throw new Error();
      return { receipt: { success: true, message: mutationAttempted?secretGrant?'Verified the separately reviewed secret reader grant on the final runtime identity.':'Verified the separately reviewed Cloud SQL client grant on the final runtime identity.':'Verified the exact local prepared identity action; no cloud permissions changed.' }, binding: { provider: 'cloudrun', evidence: proof.target } };
    } catch(error) { return { receipt: { success: false, message: 'Exact local prepared workload metadata or runtime access is unresolved; retain this attempt for read-only recovery.',data:{mutationAttempted,
      ...(mutationAttempted&&!mutationAcknowledged&&error instanceof GcpRuntimeError&&[400,401,403,409,412].includes(error.status??0)?{mutationRejected:true}:{})} } }; }
  }
}
