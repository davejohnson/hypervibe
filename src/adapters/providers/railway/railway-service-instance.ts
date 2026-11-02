import { gql, type GraphQLClient } from 'graphql-request';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { serviceInstanceTargetSchema, type IServiceInstances, type ServiceInstanceObservation, type ServiceInstanceTarget } from '../../../domain/ports/service-instance.port.js';

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function entries(value: unknown): any[] {
  if (!record(value) || !Array.isArray(value.edges) || value.pageInfo?.hasNextPage !== false) throw new Error('incomplete_inventory');
  return value.edges.map((edge: unknown) => {
    if (!record(edge) || !record(edge.node)) throw new Error('invalid_inventory');
    return edge.node;
  });
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,512}$/.test(value)) throw new Error('invalid_identity');
  return value;
}
function source(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (!record(value)) throw new Error('invalid_source');
  const result: Record<string, string> = {};
  for (const key of ['repo', 'image']) {
    const entry = value[key];
    if (entry === null || entry === undefined || entry === '') continue;
    if (typeof entry !== 'string' || entry.length > 1024 || /[\s?#]|:\/\//.test(entry)
      || key === 'repo' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry)
      || key === 'image' && entry.includes('@') && !/@sha256:[a-f0-9]{64}$/.test(entry)) throw new Error('invalid_source');
    result[key] = entry;
  }
  return result;
}
function structurallyEmpty(value: unknown): boolean {
  return value === null || value === undefined || record(value) && Object.keys(value).length === 0;
}
function emptySourceConfig(value: unknown): boolean {
  return structurallyEmpty(value) || record(value) && Object.entries(value).every(([key, entry]) =>
    ['repo','image','branch'].includes(key) && entry === null);
}

export function railwayServiceInstances(getClient: () => GraphQLClient | null): IServiceInstances {
  const observe = async (raw: ServiceInstanceTarget, workflowId?: string): Promise<ServiceInstanceObservation> => {
    try {
      const target = serviceInstanceTargetSchema.parse(raw);
      const client = getClient();
      if (!client) return { state: 'unknown', code: 'connection_unavailable' };
      if (workflowId !== undefined) {
        const workflow = await client.request<any>(gql`query ServiceInstanceCreationWorkflow($workflowId: String!) {
          workflowStatus(workflowId: $workflowId) { status }
        }`, { workflowId });
        if (workflow.workflowStatus?.status !== 'Complete') return { state: 'unknown', code: 'instance_workflow_pending' };
      }
      const result = await client.request<any>(gql`
        query ServiceInstanceCreationState($projectId: String!, $serviceId: String!, $environmentId: String!, $sourceEnvironmentId: String!) {
          project(id: $projectId) { id }
          service(id: $serviceId) { id projectId name
            repoTriggers(first:100) { edges { node { id projectId environmentId serviceId repository branch } } pageInfo { hasNextPage endCursor } }
            serviceInstances(first:100) { edges { node { id serviceId environmentId source { image repo }
              latestDeployment { id } activeDeployments { id }
            } } pageInfo { hasNextPage endCursor } }
          }
          sourceEnvironment: environment(id: $sourceEnvironmentId) { id projectId }
          environment(id: $environmentId) { id projectId config(decryptVariables:false) }
          environmentStagedChanges(environmentId: $environmentId) { id environmentId status patch(decryptVariables:false) }
        }
      `, target);
      if (result.project?.id !== target.projectId || result.service?.id !== target.serviceId
        || result.service.projectId !== target.projectId || result.sourceEnvironment?.id !== target.sourceEnvironmentId
        || result.sourceEnvironment.projectId !== target.projectId || result.environment?.id !== target.environmentId
        || result.environment.projectId !== target.projectId) throw new Error('scope_mismatch');
      const staged = result.environmentStagedChanges;
      if (!record(staged) || staged.environmentId !== target.environmentId || staged.status !== 'STAGED'
        || !record(staged.patch) || Object.keys(staged.patch).length !== 0) throw new Error('staged_changes');
      const nativeInstances = entries(result.service.serviceInstances);
      const instances = nativeInstances.map(instance => {
        if (instance.serviceId !== target.serviceId) throw new Error('instance_scope');
        return { id: identity(instance.id), environmentId: identity(instance.environmentId), source: source(instance.source) };
      });
      if (new Set(instances.map(instance => instance.environmentId)).size !== instances.length
        || instances.filter(instance => instance.environmentId === target.sourceEnvironmentId).length !== 1) throw new Error('ambiguous_instance');
      const targetInstance = instances.find(instance => instance.environmentId === target.environmentId);
      const nativeTarget = nativeInstances.find(instance => instance.environmentId === target.environmentId);
      if (nativeTarget && (nativeTarget.latestDeployment !== null || !Array.isArray(nativeTarget.activeDeployments)
        || nativeTarget.activeDeployments.length !== 0)) throw new Error('target_deployment_present_or_unknown');
      const triggers = entries(result.service.repoTriggers).map(trigger => {
        if (trigger.projectId !== target.projectId || trigger.serviceId !== target.serviceId
          || typeof trigger.branch !== 'string' || !/^[A-Za-z0-9_./-]{1,512}$/.test(trigger.branch)) throw new Error('trigger_scope');
        return { id: identity(trigger.id), environmentId: identity(trigger.environmentId),
          source: source({ repo: trigger.repository }), branch: trigger.branch };
      });
      if (triggers.some(trigger => trigger.environmentId === target.environmentId)) throw new Error('target_trigger_present');
      const config = result.environment.config;
      if (!record(config) || config.services !== undefined && !record(config.services)) throw new Error('config_unknown');
      const instanceConfig = config.services?.[target.serviceId];
      if (targetInstance) {
        if (!record(instanceConfig) || Object.keys(targetInstance.source).length
          || Object.entries(instanceConfig).some(([key, value]) => key === 'isCreated' ? value !== true
            : key === 'isDeleted' ? value !== false : key === 'source' ? !emptySourceConfig(value) : !structurallyEmpty(value))) throw new Error('target_not_empty');
      } else if (instanceConfig !== undefined) throw new Error('target_config_present');
      // Only non-secret identity/source structure enters this fingerprint.
      // Variable values and opaque configuration never enter output or hashes.
      const fingerprint = canonicalJsonSha256({ target,
        siblings: instances.filter(instance => instance.environmentId !== target.environmentId).sort((a,b) => a.id.localeCompare(b.id)),
        triggers: triggers.sort((a,b) => a.id.localeCompare(b.id)),
        otherTargetServiceIds: Object.keys(config.services ?? {}).filter(id => id !== target.serviceId).sort(),
      });
      return { state: targetInstance ? 'empty' : 'absent', fingerprint };
    } catch { return { state: 'unknown', code: 'instance_scope_or_state_unverified' }; }
  };
  return {
    resolveTarget(source, target, serviceName) {
      const from = parseHostingBindings(source), to = parseHostingBindings(target);
      const serviceId = from.services?.[serviceName]?.serviceId;
      if (from.provider !== 'railway' || to.provider !== 'railway' || !serviceId || !from.projectId
        || from.projectId !== to.projectId || !from.environmentId || !to.environmentId || from.environmentId === to.environmentId) return undefined;
      const parsed = serviceInstanceTargetSchema.safeParse({ projectId: from.projectId, environmentId: to.environmentId, serviceId, sourceEnvironmentId: from.environmentId });
      return parsed.success ? parsed.data : undefined;
    },
    observe,
    async create(target, fingerprint, beforeWrite, acknowledged) {
      const live = await observe(target);
      if (live.state !== 'absent' || live.fingerprint !== fingerprint) return { mutationAttempted: false, success: false, code: 'instance_preflight_changed' };
      try { beforeWrite(); } catch { return { mutationAttempted: false, success: false, code: 'instance_authority_changed' }; }
      try {
        const result = await getClient()!.request<any>(gql`
          mutation CreateEnvironmentServiceInstance($environmentId: String!, $patch: EnvironmentConfig!) {
            environmentPatchCommit(environmentId: $environmentId, patch: $patch)
          }
        `, { environmentId: target.environmentId, patch: { services: { [target.serviceId]: { isCreated: true } } } });
        if (typeof result.environmentPatchCommit !== 'string' || !result.environmentPatchCommit.trim()) throw new Error('acknowledgement_missing');
        const workflowId = result.environmentPatchCommit;
        acknowledged(workflowId);
        // Acknowledgement is not completion. Re-observe exact scope and emptiness.
        for (let attempt = 0; attempt < 4; attempt++) {
          const verified = await observe(target, workflowId);
          if (verified.state === 'empty' && verified.fingerprint === fingerprint) return { mutationAttempted: true, success: true };
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch { /* Retained intent owns uncertain outcomes; never compensate. */ }
      return { mutationAttempted: true, success: false, code: 'instance_creation_unverified' };
    },
  };
}
