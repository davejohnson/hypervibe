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
    const principal = installed.principal, native = (await readGcpLocalPreparedResources(receipt, token, AbortSignal.timeout(30000), this.request)).workloads[input.service.name] as any;
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
    return { target, identity, policy,policyUrl,token,sqlReady,readers,missingReader };
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
        const expected=this.reviewedTarget(proof,target);
        if (!isDeepStrictEqual(target, expected)) throw new Error();
        return { state: 'action', step: { operation: 'recover', target: { ...expected, recoverAttemptId: input.binding.pending.attemptId }, requiresConfirm: false,
          description: 'Recover the exact local prepared identity binding without changing Google IAM.' } };
      }
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
    } catch { return { state: 'unknown', reason: 'Local prepared runtime identity, actAs authority or declared secret-reader permissions could not be verified. Review those permissions separately.' }; }
  }
  async apply(input: Parameters<IRuntimeIdentities['apply']>[0]): ReturnType<IRuntimeIdentities['apply']> {
    let mutationAttempted=false,mutationAcknowledged=false;
    try {
      const proof = await this.proof(input);
      const target = { ...input.step.target }; delete target.recoverAttemptId;
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
    } catch(error) { return { receipt: { success: false, message: 'Exact local prepared runtime identity, secret reader or Cloud SQL grant is unresolved; retain this attempt for read-only recovery.',data:{mutationAttempted,
      ...(mutationAttempted&&!mutationAcknowledged&&error instanceof GcpRuntimeError&&[400,401,403,409,412].includes(error.status??0)?{mutationRejected:true}:{})} } }; }
  }
}
