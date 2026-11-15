import { createHash } from 'node:crypto';
import { gql, type GraphQLClient } from 'graphql-request';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IDatabaseCredentialAliases } from '../../../domain/ports/database-credential-aliases.port.js';
import type { DatabaseProvisionRecoveryObservation, IDatabaseProvisionRecovery } from '../../../domain/ports/database-provision-recovery.port.js';
import { parseUnresolvedDatabaseMutation } from '../../../domain/ports/database.port.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from '../../../domain/services/recovery-source.js';
import type { RailwayDatabasePersistenceObservation, RailwayServiceInstanceInspection } from './railway.adapter.js';
import { railwayDatabaseReferences, railwayPostgresTemplate, railwayTemplateServices } from './railway-postgres-template.js';

type Input = { environment: Environment; component: Component };
type Template = Awaited<ReturnType<typeof railwayPostgresTemplate>>;
type Nonready = Exclude<DatabaseProvisionRecoveryObservation, { state: 'ready' | 'candidate' }>;
type Reads = {
  client: () => GraphQLClient | null;
  inspectInstance: (serviceId: string, environmentId: string) => Promise<RailwayServiceInstanceInspection>;
  inspectPersistence: (target: { projectId: string; environmentId: string; serviceId: string },
    options: { image: string; expectedVolumeId?: string }) => Promise<RailwayDatabasePersistenceObservation>;
  aliases: IDatabaseCredentialAliases;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  const parsed = recoveryIdentityStringSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}
function scopeMatches(value: unknown, projectId: string, environmentId: string): boolean {
  return record(value) && Object.keys(value).length === 2
    && value.projectId === projectId && value.environmentId === environmentId;
}
const nonready = (state: Nonready['state'], phase: Nonready['phase'], code: Nonready['code']): Nonready => ({ state, phase, code });

/** Read-only inspection of one acknowledged template attempt. A new matching
 * service is only a candidate: workflow completion does not prove its lineage.
 * This capability never adopts, restarts, or repeats template deployment. */
export class RailwayDatabaseProvisionRecovery implements IDatabaseProvisionRecovery {
  constructor(private readonly reads: Reads) {}

  async inspect(input: Input): Promise<DatabaseProvisionRecoveryObservation> {
    if (input.component.bindings.provisioningIncomplete !== true) {
      return nonready('blocked', 'attempt', 'invalid_attempt');
    }
    return this.verify(input);
  }

  /** Creation uses the same verifier, retaining a correlated ID even when a
   * later storage/reference read fails. The callback is local metadata only. */
  async verify(input: Input, options: { template?: Template; onCorrelated?: (component: Component) => void } = {}): Promise<DatabaseProvisionRecoveryObservation> {
    const { environment, component } = input;
    const scope = component.bindings.providerScope;
    const attempt = component.bindings.databaseTemplate;
    const marker = parseUnresolvedDatabaseMutation(component.bindings);
    if (component.type !== 'postgres' || component.environmentId !== environment.id
      || (component.externalId !== null && !identity(component.externalId)) || component.bindings.provider !== 'railway'
      || (environment.platformBindings.provider !== undefined && environment.platformBindings.provider !== 'railway') || !record(scope)
      || !identity(scope.projectId) || !identity(scope.environmentId)
      || !scopeMatches(scope, scope.projectId, scope.environmentId)
      || environment.platformBindings.projectId !== scope.projectId
      || environment.platformBindings.environmentId !== scope.environmentId
      || (component.externalId === null && !marker)
      || (component.bindings.unresolvedMutation !== undefined && (!marker || !scopeMatches(marker.providerScope, scope.projectId, scope.environmentId)))
      || (component.bindings.volumeId !== undefined && !identity(component.bindings.volumeId))
      || !record(attempt) || !identity(attempt.templateId) || !identity(attempt.templateServiceId)
      || !identity(attempt.workflowId) || !Array.isArray(attempt.priorServiceIds)
      || !attempt.priorServiceIds.every(identity)
      || new Set(attempt.priorServiceIds).size !== attempt.priorServiceIds.length) {
      return nonready('blocked', 'attempt', 'invalid_attempt');
    }
    const client = this.reads.client();
    if (!client) return nonready('unknown', 'attempt', 'observation_unavailable');
    const providerScope = { projectId: scope.projectId, environmentId: scope.environmentId };
    const databaseTemplate = { templateId: attempt.templateId, templateServiceId: attempt.templateServiceId,
      workflowId: attempt.workflowId, priorServiceIds: [...attempt.priorServiceIds] };
    let template: Template;
    try { template = options.template ?? await railwayPostgresTemplate(client); }
    catch { return nonready('unknown', 'template', 'template_unavailable'); }
    if (template.templateId !== attempt.templateId || template.serviceKey !== attempt.templateServiceId) {
      return nonready('blocked', 'template', 'template_changed');
    }
    let workflowStatus: unknown;
    try {
      const observed = await client.request<{ workflowStatus?: { status?: unknown } }>(gql`
        query DatabaseTemplateWorkflow($workflowId: String!) { workflowStatus(workflowId: $workflowId) { status } }
      `, { workflowId: attempt.workflowId });
      workflowStatus = observed.workflowStatus?.status;
    } catch { return nonready('unknown', 'workflow', 'workflow_unknown'); }
    if (workflowStatus === 'Running' || workflowStatus === 'NotFound') return nonready('pending', 'workflow', 'workflow_pending');
    if (workflowStatus === 'Error') return nonready('blocked', 'workflow', 'workflow_failed');
    if (workflowStatus !== 'Complete') return nonready('unknown', 'workflow', 'workflow_unknown');
    let inventory: Awaited<ReturnType<typeof railwayTemplateServices>>;
    try { inventory = await railwayTemplateServices(client, providerScope.projectId); }
    catch { return nonready('unknown', 'inventory', 'inventory_unavailable'); }
    const prior = new Set(databaseTemplate.priorServiceIds);
    const candidates = inventory.filter(service => !prior.has(service.id)
      && service.templateId === databaseTemplate.templateId && service.templateServiceId === databaseTemplate.templateServiceId);
    if (candidates.length > 1) return nonready('blocked', 'inventory', 'identity_ambiguous');
    const database = candidates[0];
    if (!database) return nonready('pending', 'inventory', 'identity_absent');
    if (!identity(database.id)) return nonready('unknown', 'inventory', 'inventory_unavailable');
    if (component.externalId !== null && component.externalId !== database.id) return nonready('blocked', 'inventory', 'identity_mismatch');
    let instance: RailwayServiceInstanceInspection;
    try { instance = await this.reads.inspectInstance(database.id, providerScope.environmentId); }
    catch { return nonready('unknown', 'instance', 'observation_unavailable'); }
    if (instance.state === 'unknown') return nonready('unknown', 'instance', 'observation_unavailable');
    if (instance.state !== 'present' || instance.serviceId !== database.id
      || instance.environmentId !== providerScope.environmentId || !identity(instance.instanceId)
      || instance.sourceImage !== template.image) return nonready('blocked', 'instance', 'identity_mismatch');
    const bindings: Record<string, unknown> = {
      provider: 'railway', providerScope, resourceKind: 'service', pluginName: database.name,
      directUrlVariable: template.directUrlVariable, databaseTemplate,
      ...(component.bindings.provisioningIncomplete === true ? { provisioningIncomplete: true } : {}),
    };
    const correlated: Component = { ...component, externalId: database.id, bindings };
    options.onCorrelated?.(correlated);
    try { railwayDatabaseReferences(database.name, template.directUrlVariable); }
    catch { return nonready('blocked', 'references', 'references_unverified'); }
    let persistence: RailwayDatabasePersistenceObservation;
    try { persistence = await this.reads.inspectPersistence({ ...providerScope, serviceId: database.id }, { image: template.image,
      ...(typeof component.bindings.volumeId === 'string' ? { expectedVolumeId: component.bindings.volumeId } : {}) }); }
    catch { return nonready('unknown', 'persistence', 'persistence_unverified'); }
    const volume = persistence.volume;
    if (persistence.persistence.state !== 'configured' || !volume || !identity(volume.volumeId) || !identity(volume.instanceId)
      || volume.projectId !== providerScope.projectId || volume.environmentId !== providerScope.environmentId
      || volume.serviceId !== database.id || volume.mountPath !== template.mountPath
      || persistence.serviceName !== database.name || !identity(persistence.dataPath)) return nonready('unknown', 'persistence', 'persistence_unverified');
    bindings.volumeId = volume.volumeId;
    bindings.volumeTarget = { ...providerScope, serviceId: database.id, mountPath: volume.mountPath };
    options.onCorrelated?.(correlated);
    try {
      // This existing observer compares raw references AND independently
      // rendered credentials; copied working passwords do not establish wiring.
      const aliases = await this.reads.aliases.inspect({ component: correlated, environment });
      const definitions = record(aliases.privateState.definitions) ? aliases.privateState.definitions : {};
      const normalizedReference = (value: string) => value.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, '<$1>');
      const exactReferences = Object.entries(template.referenceDefinitions).every(([key, expected]) =>
        typeof definitions[key] === 'string' && normalizedReference(definitions[key]) === normalizedReference(expected));
      if (aliases.target.provider !== 'railway' || aliases.target.resourceId !== database.id
        || !scopeMatches(aliases.target.providerScope, providerScope.projectId, providerScope.environmentId)
        || aliases.changeNames.length > 0 || !aliases.checkedNames.includes('PGPASSWORD')
        || !aliases.checkedNames.includes(template.directUrlVariable) || !exactReferences) {
        return nonready('blocked', 'references', 'references_unverified');
      }
    } catch { return nonready('unknown', 'references', 'references_unverified'); }
    const parsedSource = recoverySourceIdentitySchema.safeParse({ provider: 'railway', primaryExternalId: database.id,
      providerScope, resourceIdentity: { volumeId: volume.volumeId, volumeInstanceId: volume.instanceId } });
    if (!parsedSource.success) return nonready('unknown', 'persistence', 'persistence_unverified');
    const source = parsedSource.data;
    // Only public identity/configuration evidence is hashed. No credential or
    // rendered URL, even hashed, leaves the private reference observer.
    const evidenceFingerprint = createHash('sha256').update(JSON.stringify({ source, databaseTemplate,
      serviceName: database.name, instanceId: instance.instanceId, image: template.image,
      mountPath: volume.mountPath, dataPath: persistence.dataPath,
      configurationFingerprint: persistence.persistence.configurationFingerprint,
      referenceDefinitions: template.referenceDefinitions })).digest('hex');
    return component.externalId === null
      ? { state: 'candidate', lineage: 'unproven', source, evidenceFingerprint, bindings }
      : { state: 'ready', source, evidenceFingerprint, bindings };
  }
}
