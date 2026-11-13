import { createHash } from 'node:crypto';
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
import { executeDnsEngineSegment, executeDnsOwnershipReconciliation, hasOwnedDnsRecords, prepareDnsEnginePlan } from './dns-engine.js';
import { verifyDnsTrafficAbsent } from './dns-absence.js';
import { dnsZoneIdentity } from '../domain/services/dns-policy.service.js';

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
  if (observed.provider !== bindings.provider || observed.projectId !== bindings.projectId || observed.environmentId !== bindings.environmentId
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

/** Called after the ordinary planner's fresh hosting observation, before exposing its plan. */
export async function planHostedDns(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; observed: ObservedState | null;
  actions?: PlanAction[];
}): Promise<SavedDnsPlan | { blocked: string[] } | null> {
  const spec = params.spec.environments[params.environmentName];
  const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!spec || !environment || spec.loadBalancer || spec.domainTarget) return null;
  const binding = parseHostingBindings(environment).domainDns;
  const domain = spec.domain ?? binding?.name;
  if (!domain || !binding?.providerDomainId) return null;
  const remove = !spec.domain;
  const cancellation = remove && !hasOwnedDnsRecords(environment, HOSTING_DNS_OWNER);
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
  if (prepared.ready) {
    const action = params.actions?.find(action => action.resource.kind === 'domain' && action.resource.provider === spec.hosting.provider && action.resource.name === domain);
    if (action && !remove) {
      action.metadata = { ...action.metadata, dnsEngineReady: true, operation: 'domainDnsReady' };
      action.type = service.customDomainStatus?.[domain]?.providerVerified === true ? 'noop' : 'update';
      action.reason = action.type === 'noop' ? 'The hosting attachment and engine-managed DNS are verified.' : 'DNS is configured; hosting certificate verification remains pending.';
      action.verified = true;
    }
    return null;
  }
  return persistDnsPlanRun(ctx, { ...params, environment, prepared, source: { ...source, remove } });
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
    || descriptor.state.projectId !== params.project.id || descriptor.state.environmentId !== environment.id) {
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
    if (typeof current === 'string' || Object.entries(current).some(([key, value]) => source[key] !== value)
      || source.remove !== !spec.domain) return { kind: 'blocked', reason: typeof current === 'string' ? current : 'The hosting attachment or removal intent changed. Run hv_plan again.' };
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
    if (binding?.name === descriptor.domain && (source.remove !== true || !hasOwnedDnsRecords(current, HOSTING_DNS_OWNER))) {
      ctx.repos.environments.updatePlatformBindings(current.id, { domainDns: { ...binding, dnsEngineRemoved: source.remove === true, dnsStagePending: false } });
    }
  }
  if (executed && source.kind === 'github-pages' && typeof source.repository === 'string') {
    const current = ctx.repos.environments.findById(environment.id) ?? environment;
    const value = (current.platformBindings as Record<string, unknown> | null)?.github;
    const github = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    ctx.repos.environments.updatePlatformBindings(current.id, { github: { ...github,
      pagesDnsRemoved: source.enabled === false ? { domain: descriptor.domain, repository: source.repository, planId: params.planId } : undefined,
    } });
  }
  return { kind: 'executed', envName: environmentName, result };
}
