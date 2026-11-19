import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { ObservedState } from '../domain/ports/observe.port.js';
import type { DnsRecordType } from '../domain/ports/dns.port.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { ConvergeExecutor, type PlanRunDocument, type ConvergeResult } from '../domain/plan/converge.executor.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { normalizeProviderDnsRecord, providerDnsRecordShouldBeProxied } from '../domain/services/domain-dns-records.js';
import { dnsEngineState, executeDnsEngineSegment, executeDnsOwnershipReconciliation, getDnsBindingIdentity, hasOwnedDnsRecords, prepareDnsEnginePlan } from './dns-engine.js';
import { verifyDnsTrafficAbsent } from './dns-absence.js';
import { dnsZoneIdentity } from '../domain/services/dns-policy.service.js';
import { desiredDomainServiceName, DOMAIN_RETARGET_OPERATION, observedDomainService } from '../domain/services/domain-attach-policy.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';

const HOSTING_DNS_OWNER = 'hosting-domain';
type PreparedDns = Awaited<ReturnType<typeof prepareDnsEnginePlan>>;
export interface SavedDnsPlan {
  planRunId: string; environmentName: string; specRevision: number; actions: PlanAction[];
  confirmActions: string[]; warnings: string[];
}

/** Persist the already prepared artifact; applying it never prepares another plan. */
export function persistDnsPlanRun(ctx: CommandContext, params: {
  project: Project; environment: Environment; environmentName: string; specRevision: number;
  prepared: PreparedDns; source?: Record<string, unknown>;
}): SavedDnsPlan | { blocked: string[] } {
  if (params.prepared.blocked?.length || !params.prepared.descriptor) {
    return { blocked: params.prepared.blocked ?? ['DNS planning did not produce a reviewed artifact.'] };
  }
  const document: PlanRunDocument = {
    kind: 'hv_plan', scope: 'dns-engine', environmentName: params.environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions: params.prepared.actions,
    dns: { descriptor: params.prepared.descriptor, ...(params.source ? { source: params.source } : {}) },
  };
  const run = ctx.repos.runs.create({ projectId: params.project.id, environmentId: params.environment.id,
    type: 'plan', plan: document as unknown as Record<string, unknown> });
  ctx.repos.runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, environmentName: params.environmentName, specRevision: params.specRevision,
    actions: document.actions,
    confirmActions: document.actions.filter(action => action.type !== 'noop' && (action.requiresConfirm || action.billable || action.dataBearing)).map(action => action.id),
    warnings: ['DNS changes use the saved OpenTofu plan. Run hv_plan again after apply to continue hosting readiness.'] };
}

function hostingSource(environment: Environment, spec: EnvironmentSpec, observed: ObservedState, domain: string): Record<string, unknown> | string {
  const bindings = parseHostingBindings(environment);
  const binding = bindings.domainDns;
  if (!binding || binding.name !== domain || !binding.providerDomainId || !binding.serviceName || !binding.serviceId || !binding.environmentId
    || bindings.provider !== spec.hosting.provider || !bindings.projectId || !bindings.environmentId) return 'The hosting attachment needs exact bound provider, service, environment and domain identities before DNS can change.';
  if (observed.partial || observed.provider !== bindings.provider || observed.projectId !== bindings.projectId || observed.environmentId !== bindings.environmentId
    || observed.completeness?.project !== 'complete' || observed.completeness.environment !== 'complete' || observed.completeness.services !== 'complete') {
    return 'The hosting provider could not verify its exact project, environment and service inventory.';
  }
  const matches = observed.services.filter(service => service.externalId === binding.serviceId && service.name === binding.serviceName
    && service.customDomains.includes(domain));
  if (matches.length !== 1 || matches[0]!.customDomainStatus?.[domain]?.providerDomainId !== binding.providerDomainId
    || binding.environmentId !== observed.environmentId) return 'The exact hosting attachment changed or was not observed. DNS records remain untouched.';
  const requirements = (matches[0]!.customDomainStatus?.[domain]?.dnsRecords ?? []).map(normalizeProviderDnsRecord)
    .map(record => record ? { name: record.name, type: record.type, value: record.value, purpose: record.purpose } : null)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { kind: 'hosting-domain', provider: bindings.provider, projectId: bindings.projectId, environmentId: bindings.environmentId,
    serviceName: binding.serviceName, serviceId: binding.serviceId, providerDomainId: binding.providerDomainId, domain,
    dnsRequirementsFingerprint: createHash('sha256').update(JSON.stringify(requirements)).digest('hex') };
}

/** A DNS removal for retargeting is authorized by both the old claim and its reviewed destination. */
function retargetDestination(environment: Environment, spec: EnvironmentSpec, observed: ObservedState, domain: string) {
  const bindings = parseHostingBindings(environment);
  const serviceName = desiredDomainServiceName(spec);
  const serviceId = serviceName ? bindings.services?.[serviceName]?.serviceId : undefined;
  const target = { projectId: bindings.projectId, environmentId: bindings.environmentId, serviceName, serviceId };
  const owner = bindings.domainDns;
  const owners = observed.services.filter(service => service.customDomains.includes(domain));
  if (spec.domain !== domain || providerRegistry.getMetadata(spec.hosting.provider)?.lifecycle?.hosting?.customDomainRetarget !== 'managed'
    || !owner || owner.serviceId === serviceId || !observedDomainService(observed, target)
    || owners.length > 1 || owners.length === 0 && owner.dnsEngineRemoved !== true) return undefined;
  return target;
}

const bindingFingerprint = (environment: Environment) => createHash('sha256')
  .update(JSON.stringify(parseHostingBindings(environment).domainDns)).digest('hex');

/** Called after the ordinary planner's fresh hosting observation, before exposing its plan. */
export async function planHostedDns(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; observed: ObservedState | null;
  actions?: PlanAction[];
}): Promise<SavedDnsPlan | { blocked: string[] } | null> {
  const spec = params.spec.environments[params.environmentName];
  const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!spec || !environment || spec.domainTarget) return null;
  const binding = parseHostingBindings(environment).domainDns;
  const domain = spec.domain ?? binding?.name;
  if (!domain || !binding?.providerDomainId) return null;
  const domainAction = params.actions?.find(action => action.resource.kind === 'domain'
    && action.resource.provider === spec.hosting.provider && action.resource.name === domain);
  // A blocked hosting decision cannot authorize DNS work, even when the old claim is healthy.
  if (spec.domain && domainAction?.metadata?.blockedReason) return null;
  const retarget = domainAction?.metadata?.operation === DOMAIN_RETARGET_OPERATION;
  let owned: boolean;
  let managed: boolean;
  try {
    owned = hasOwnedDnsRecords(environment, HOSTING_DNS_OWNER);
    managed = Boolean(getDnsBindingIdentity(environment));
  } catch { return { blocked: ['The saved DNS ownership is unreadable. Preserve the hosting claim and repair its ownership evidence.'] }; }
  let remove = !spec.domain;
  let retargetSource: Record<string, unknown> | undefined;
  if (retarget) {
    const target = params.observed && retargetDestination(environment, spec, params.observed, domain);
    if (!target || domainAction.type !== 'replace' || domainAction.requiresConfirm !== true
      || !isDeepStrictEqual(domainAction.metadata?.previousDomain, binding)
      || Object.entries(target).some(([key, value]) => domainAction.metadata?.[key] !== value)) {
      return { blocked: ['The reviewed domain retarget no longer identifies the exact old attachment and public destination. Run hv_plan again.'] };
    }
    if (!owned && managed && binding.dnsEngineRemoved === true) return null;
    // Legacy receipts are not engine ownership. Only an explicit adoption stage can establish it.
    if (!owned && !spec.dns?.adoptRecords?.length) {
      return { blocked: ['The old attachment has no verified engine-owned DNS. Review exact native record IDs and values in dns.adoptRecords before retargeting.'] };
    }
    remove = owned;
    retargetSource = { target, previousBindingFingerprint: bindingFingerprint(environment), stage: remove ? 'remove' : 'adopt' };
  }
  const cancellation = !retarget && remove && !owned;
  if (cancellation && !(binding.dnsStagePending === true && binding.dnsSelection && !binding.zoneId
    && Array.isArray(binding.records) && binding.records.length === 0)) return null;
  if (!params.observed) return { blocked: ['The current hosting attachment could not be observed. DNS remains unchanged.'] };
  const source = hostingSource(environment, spec, params.observed, domain);
  if (typeof source === 'string') return { blocked: [source] };
  if (cancellation) {
    const selection = binding.dnsSelection!;
    const evidence = await verifyDnsTrafficAbsent({ ctx, project: params.project, domain,
      zone: dnsZoneIdentity(selection), connectionScope: selection.connectionScope });
    if (!evidence.ready) return { blocked: [evidence.reason] };
    const action = params.actions?.find(action => action.type === 'destroy' && action.resource.kind === 'domain'
      && action.resource.provider === spec.hosting.provider && action.resource.name === domain);
    if (action?.metadata?.dnsCancellationRequired === true && action.metadata.blockedReason === 'domain_dns_cancellation_unverified') {
      action.metadata = { ...action.metadata, dnsCancellationVerified: true,
        dnsCancellationProof: { zoneFingerprint: evidence.zoneFingerprint, connectionId: evidence.connectionId } };
      delete action.metadata.blockedReason;
      action.reason = 'Cancel the pending hosting attachment after confirming native and public traffic DNS are absent.';
    }
    return null;
  }
  const service = params.observed.services.find(service => service.externalId === source.serviceId)!;
  const requirements = service.customDomainStatus?.[domain]?.dnsRecords;
  if (!remove && !requirements?.length) return { blocked: ['The exact hosting attachment has not supplied its DNS requirements yet. Run hv_plan again when the provider has made them available.'] };
  const groups = new Map<string, { key: string; name: string; type: DnsRecordType; values: string[]; ttl: number; proxied?: boolean }>();
  for (const input of remove ? [] : requirements ?? []) {
    const record = normalizeProviderDnsRecord(input);
    if (!record || !['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX'].includes(record.type)) return { blocked: ['The hosting provider returned an unsupported or incomplete DNS requirement.'] };
    const key = `${record.name}\0${record.type}`;
    const existing = groups.get(key);
    const proxied = providerDnsRecordShouldBeProxied(record, spec.dns?.policy?.proxy === 'on' || spec.domainProxy === true);
    if (existing && existing.proxied !== proxied) return { blocked: ['The hosting provider returned conflicting proxy requirements for one DNS record.'] };
    if (existing) existing.values = [...new Set([...existing.values, record.value])];
    else groups.set(key, { key: `hosting_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
      name: record.name, type: record.type as DnsRecordType, values: [record.value], ttl: spec.dns?.ttl ?? 300, proxied });
  }
  const prepared = await prepareDnsEnginePlan({ ctx, project: params.project, environment, environmentSpec: spec,
    owner: HOSTING_DNS_OWNER, domain, records: [...groups.values()], remove });
  if (prepared.blocked?.length) return { blocked: prepared.blocked };
  if (retargetSource?.stage === 'adopt' && prepared.actions.some(action => !['noop', 'update'].includes(action.type))) {
    return { blocked: ['The legacy retarget stage may only import exact existing DNS records. It cannot create, replace or destroy records before ownership is established.'] };
  }
  if (prepared.ready) {
    if (retarget) return { blocked: ['DNS ownership has not recorded the retarget stage. Preserve the hosting claim and re-plan after reconciling its exact DNS ownership.'] };
    const action = domainAction;
    if (action && !remove && action.type !== 'replace'
      && (!action.metadata?.operation || action.metadata.operation === 'domainDnsReady')) {
      action.metadata = { ...action.metadata, dnsEngineReady: true, operation: 'domainDnsReady' };
      action.type = service.customDomainStatus?.[domain]?.providerVerified === true ? 'noop' : 'update';
      action.reason = action.type === 'noop' ? 'The hosting attachment and engine-managed DNS are verified.' : 'DNS is configured; hosting certificate verification remains pending.';
      action.verified = true;
    }
    return null;
  }
  return persistDnsPlanRun(ctx, { ...params, environment, prepared, source: { ...source, remove,
    ...(retargetSource ? { retarget: retargetSource } : {}) } });
}

export async function applyDnsPlan(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions: string[];
}): Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  const descriptor = loaded.document.dns?.descriptor;
  const environmentName = loaded.document.environmentName;
  const environment = ctx.repos.environments.findByProjectAndName(params.project.id, environmentName);
  const spec = params.spec.environments[environmentName];
  if (loaded.document.scope !== 'dns-engine' || !descriptor || !environment || !spec
    || loaded.run.projectId !== params.project.id || loaded.run.environmentId !== environment.id
    || descriptor.state.projectId !== params.project.id || descriptor.state.environmentId !== dnsEngineState(environment, descriptor.zone.provider, descriptor.owner).environmentId) {
    return { kind: 'blocked', reason: 'The saved DNS plan does not match this project and environment. Run hv_plan again.' };
  }
  const source = loaded.document.dns?.source;
  if (source?.kind === 'hosting-domain') {
    const adapterResult = await ctx.adapterFactory.getProviderAdapter(spec.hosting.provider, params.project);
    if (!adapterResult.success || !adapterResult.adapter?.observe) return { kind: 'blocked', reason: 'The hosting attachment cannot be re-observed before DNS apply.' };
    let observed: ObservedState;
    try { observed = await adapterResult.adapter.observe(environment); }
    catch { return { kind: 'blocked', reason: 'The hosting attachment observation failed. DNS remains unchanged.' }; }
    const current = hostingSource(environment, spec, observed, descriptor.domain);
    if (typeof current === 'string' || Object.entries(current).some(([key, value]) => !isDeepStrictEqual(source[key], value))) {
      return { kind: 'blocked', reason: typeof current === 'string' ? current : 'The hosting attachment changed. Run hv_plan again.' };
    }
    if (source.retarget) {
      const retarget = source.retarget as Record<string, unknown>;
      const target = retargetDestination(environment, spec, observed, descriptor.domain);
      if (!target || !isDeepStrictEqual(retarget.target, target) || retarget.previousBindingFingerprint !== bindingFingerprint(environment)
        || !['remove', 'adopt'].includes(String(retarget.stage)) || source.remove !== (retarget.stage === 'remove')) {
        return { kind: 'blocked', reason: 'The old domain snapshot or reviewed retarget destination changed. Run hv_plan again before DNS changes.' };
      }
      try {
        if (retarget.stage === 'remove' && !getDnsBindingIdentity(environment)) {
          return { kind: 'blocked', reason: 'The reviewed retarget has no saved DNS ownership state. Preserve the hosting claim.' };
        }
      } catch { return { kind: 'blocked', reason: 'The saved DNS ownership cannot be read. Preserve the hosting claim.' }; }
    } else if (source.remove !== !spec.domain) {
      return { kind: 'blocked', reason: 'The hosting removal intent changed. Run hv_plan again.' };
    }
  } else if (source?.kind === 'gcp-domain') {
    const { verifyGcpDnsSource } = await import('./infrastructure-engine.js');
    const verification = await verifyGcpDnsSource(ctx, params.project, params.spec, source);
    if (!verification.ready) return { kind: 'blocked', reason: verification.reason ?? 'The Cloud Run DNS source could not be verified.' };
  } else if (source) {
    const { verifyDnsIntegrationSource } = await import('./dns-integrations.js');
    const verification = await verifyDnsIntegrationSource(ctx, params.project, spec, source);
    if (!verification.ready) return { kind: 'blocked', reason: verification.reason ?? 'The DNS integration source could not be verified.' };
  } else return { kind: 'blocked', reason: 'The saved DNS plan has no verified originating workflow.' };
  const result = await executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision,
    confirmActions: params.confirmActions,
    handler: async action => action.metadata?.operation === 'dnsOwnershipReconcile'
      ? executeDnsOwnershipReconciliation({ ctx, project: params.project, environment, descriptor })
      : { success: false, status: 'blocked', message: 'DNS stages only execute their saved engine segment or exact ownership reconciliation.' },
    segmentHandler: (segment, members) => executeDnsEngineSegment({ ctx, project: params.project, environment, descriptor, segment, members }),
  });
  const executed = result.success && loaded.document.actions.some(action => action.type !== 'noop');
  if (executed && source.kind === 'hosting-domain') {
    const current = ctx.repos.environments.findById(environment.id) ?? environment;
    const binding = parseHostingBindings(current).domainDns;
    if (!binding || ['name', 'providerDomainId', 'serviceName', 'serviceId', 'environmentId']
      .some(key => binding[key as keyof typeof binding] !== source[key === 'name' ? 'domain' : key])) {
      return { kind: 'executed', envName: environmentName, result: { ...result, success: false,
        error: 'The hosting attachment changed during DNS execution. Its DNS receipt was preserved without authorizing another attachment.' } };
    }
    if (source.remove === true) {
      try {
        if (!getDnsBindingIdentity(current) || hasOwnedDnsRecords(current, HOSTING_DNS_OWNER)) {
          return { kind: 'executed', envName: environmentName, result: { ...result, success: false,
            error: 'DNS removal did not verify that the saved engine state relinquished its hosting records. Preserve the hosting claim and re-plan.' } };
        }
      } catch {
        return { kind: 'executed', envName: environmentName, result: { ...result, success: false,
          error: 'DNS removal ownership could not be read. Preserve the hosting claim and re-plan.' } };
      }
    }
    if (binding?.name === descriptor.domain) {
      ctx.repos.environments.updatePlatformBindings(current.id, { domainDns: { ...binding, dnsEngineRemoved: source.remove === true, dnsStagePending: false } });
    }
  }
  return { kind: 'executed', envName: environmentName, result };
}
