import { isDeepStrictEqual } from 'node:util';
import { getDb } from '../adapters/db/sqlite.adapter.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import { DomainHandoffBlocked, handoffReviewSchema, ownedEdgeEndpoint, type HandoffReview, type HandoffStep } from '../domain/plan/domain-handoff.js';
import { requiresActionConfirmation, type PlanAction } from '../domain/plan/plan.types.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { engineSegmentOf } from '../domain/ports/infrastructure-engine.port.js';
import { supportsEdgeTraffic, supportsWorkloadMaintenance } from '../domain/ports/maintenance.port.js';
import { getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import { observedDomainService, supportsCustomDomainDetach, supportsScopedCustomDomainRead } from '../domain/services/domain-attach-policy.js';
import { normalizeProviderDnsRecord } from '../domain/services/domain-dns-records.js';
import { observeEngineDomainOrigin } from '../domain/services/domain-target.service.js';
import { parseEnvironmentMaintenanceBinding } from '../domain/services/environment-maintenance.service.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import { observeEdgeDomainDns, prepareDnsEnginePlan } from './dns-engine.js';
import { persistDnsPlanRun, type SavedDnsPlan } from './dns-hosting.js';

interface Params { project: Project; spec: ProjectSpec; environmentName: string; specRevision: number }
type Dns = Awaited<ReturnType<typeof observeEdgeDomainDns>>;
const stop = (message: string): never => { throw new DomainHandoffBlocked(message); };
const blocked = (error: unknown) => ({ blocked: [error instanceof DomainHandoffBlocked || typeof error === 'string' ? String(error instanceof Error ? error.message : error)
  : 'The hostname transfer could not verify its saved identities or provider observations. Preserve the live route.'] });

async function verifyRoute(params: Params, target: Environment, edge: HandoffReview['edge']) {
  const spec = params.spec.environments[target.name]!;
  const route = spec.edgeDomain!;
  const observed = await observeEngineDomainOrigin(params.project, target, spec, route.hostname, route.service);
  if (!observed.target || observed.target.targetFingerprint !== edge.targetFingerprint || observed.target.origin !== edge.origin) {
    stop('The exact target web service or its provider HTTPS endpoint has changed or is unavailable.');
  }
  const connection = getCloudflareAdapter(route.hostname);
  if ('error' in connection || !supportsEdgeTraffic(connection.adapter)) return stop('The owned Cloudflare Worker route cannot be observed.');
  const live = await connection.adapter.observeTrafficEdge(route.hostname, edge, edge);
  if (live.state !== 'active' || !live.markerVerified) stop('The public hostname does not return the verified marker for this exact Worker and destination.');
  const url = new URL(spec.services[route.service]!.healthCheckPath ?? '/', `https://${route.hostname}`);
  if (url.origin !== `https://${route.hostname}` || url.hash) stop('The public health check must stay on the reviewed HTTPS hostname.');
  const response = await fetch(url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  if (response.status < 200 || response.status >= 400) stop('The public hostname must return a healthy application response or redirect through the verified Worker.');
}

async function inspect(ctx: CommandContext, params: Params, observation: 'ownership' | 'serving' = 'ownership') {
  const target = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  const desired = params.spec.environments[params.environmentName]?.edgeDomain;
  if (!target || !desired || target.projectId !== params.project.id) return stop('Set edgeDomain on the destination environment after the source hostname is forwarding there.');
  const { hostname, service, fromEnvironment } = desired;
  const completed = target.platformBindings.edgeDomain;
  if (completed) {
    const review = handoffReviewSchema.parse(completed);
    if (review.projectId !== params.project.id || review.targetId !== target.id || review.targetEnvironment !== target.name
      || review.sourceEnvironment !== fromEnvironment || review.hostname !== hostname || review.targetService !== service) return stop('The target intent differs from its durable hostname ownership.');
    await verifyRoute(params, target, review.edge);
    const dns = await observeEdgeDomainDns(ctx, params.project, target, hostname, true, undefined, observation);
    if (dns.connectionId !== review.dnsConnectionId || !isDeepStrictEqual(dns.zone, review.zone) || dns.traffic.id !== review.recordId
      || dns.traffic.address !== review.recordAddress || dns.traffic.value !== new URL(review.edge.origin).hostname || dns.verification.length || dns.pending) {
      return stop('The transferred DNS record or its saved ownership no longer matches the target.');
    }
    return { status: 'owned' as const, review, target };
  }
  const source = ctx.repos.environments.findByProjectAndName(params.project.id, fromEnvironment);
  const sourceSpec = params.spec.environments[fromEnvironment];
  if (!source || source.id === target.id || source.projectId !== target.projectId || !sourceSpec || sourceSpec.domain !== hostname
    || sourceSpec.domainTarget?.environment !== target.name || sourceSpec.domainTarget.service !== service
    || sourceSpec.maintenance?.enabled !== true || sourceSpec.maintenance.mode !== 'application' || sourceSpec.maintenance.page !== 'off') {
    return stop('Keep the source in application maintenance with its verified hostname forwarding to this destination until ownership transfers.');
  }
  if (target.platformBindings['dnsEngine_edge-domain'] !== undefined) return stop('The target already has DNS state for a different or incomplete hostname transfer.');
  const maintenance = parseEnvironmentMaintenanceBinding(source);
  const edge = maintenance?.edge;
  if (maintenance?.state !== 'active' || maintenance.pendingEdge || !edge?.origin || !edge.targetFingerprint || edge.hostname !== hostname) {
    return stop('The source must have a completed, verified forwarding route before ownership can move.');
  }
  const route = { ...edge, origin: edge.origin, targetFingerprint: edge.targetFingerprint };
  await verifyRoute(params, target, route);
  const bindings = parseHostingBindings(source);
  const attachment = bindings.domainDns;
  if (!bindings.provider || bindings.provider !== sourceSpec.hosting.provider || !bindings.projectId || !bindings.environmentId
    || attachment?.name !== hostname || !attachment.providerDomainId || !attachment.serviceName || !attachment.serviceId
    || attachment.environmentId !== bindings.environmentId || bindings.services?.[attachment.serviceName]?.serviceId !== attachment.serviceId) {
    return stop('The source needs the exact adopted hosting project, environment, service and custom-domain identities.');
  }
  for (const project of ctx.repos.projects.findAll()) for (const other of ctx.repos.environments.findByProjectId(project.id)) {
    if (other.id === source.id) continue;
    const owner = parseHostingBindings(other);
    const otherEdge = parseEnvironmentMaintenanceBinding(other)?.edge;
    if (owner.provider === bindings.provider && owner.projectId === bindings.projectId && owner.environmentId === bindings.environmentId
      || otherEdge?.zoneId === edge.zoneId && otherEdge.routeId === edge.routeId) return stop('Another environment claims the same hosting environment or Worker route. Resolve the competing identity first.');
  }
  const active = await ctx.adapterFactory.getProviderAdapter(bindings.provider, params.project, undefined, { environment: source, hosting: sourceSpec.hosting });
  if (!active.success || active.adapter?.name !== bindings.provider || !active.adapter?.observe || !supportsCustomDomainDetach(active.adapter)
    || !supportsWorkloadMaintenance(active.adapter) || !supportsScopedCustomDomainRead(active.adapter)) return stop('The source hosting connection cannot verify and release this exact attachment.');
  for (const [name, workload] of Object.entries(sourceSpec.services)) {
    const snapshot = maintenance.workloads?.[name];
    if (!snapshot || snapshot.serviceId !== bindings.services?.[name]?.serviceId || snapshot.workloadKind !== workload.workloadKind) {
      return stop('The paused source no longer has an exact snapshot for every declared workload.');
    }
    const current = await active.adapter.observeMaintenanceWorkload(source, snapshot.serviceId, snapshot.workloadKind);
    if (current.state !== 'suspended' || current.serviceId !== snapshot.serviceId || current.workloadKind !== snapshot.workloadKind
      || snapshot.environmentId && current.environmentId !== snapshot.environmentId) return stop('Every source workload must remain paused on its exact serving environment.');
  }
  const live = await active.adapter.observe(source);
  const owner = observedDomainService(live, { ...bindings, serviceId: attachment.serviceId, serviceName: attachment.serviceName });
  if (!owner || !live.projectExists || live.partial || live.provider !== bindings.provider || live.completeness?.project !== 'complete'
    || live.completeness.environment !== 'complete' || live.completeness.services !== 'complete') return stop('The source hosting inventory is incomplete or the serving service changed.');
  const owners = live.services.filter(item => item.customDomains.includes(hostname));
  const status = owner.customDomainStatus?.[hostname];
  const scoped = await active.adapter.getCustomDomainStatus({ projectId: bindings.projectId, environmentId: bindings.environmentId,
    serviceId: attachment.serviceId, domain: hostname }).catch(() => stop('The exact source service domain inventory is incomplete. Preserve the route and verification records.'));
  if (scoped === null ? owners.length !== 0 : !scoped || scoped.id !== attachment.providerDomainId
    || scoped.domain.toLowerCase().replace(/\.$/, '') !== hostname || owners.length !== 1) return stop('The exact source attachment changed or the scoped domain reads disagree.');
  if (owners.length && (owners.length !== 1 || owners[0] !== owner || status?.providerDomainId !== attachment.providerDomainId)) {
    return stop('A different source service or attachment now owns the hostname.');
  }
  const pending = source.platformBindings.domainHandoff ? handoffReviewSchema.parse(source.platformBindings.domainHandoff) : undefined;
  const started = source.platformBindings.domainHandoffRoute ? handoffReviewSchema.parse(source.platformBindings.domainHandoffRoute) : undefined;
  const incoming = target.platformBindings.domainHandoffIncoming ? handoffReviewSchema.parse(target.platformBindings.domainHandoffIncoming) : undefined;
  if (!owners.length && !pending) return stop('Source absence alone does not prove an authorized release. Preserve the DNS and verify the exact original attachment.');
  const dns = await observeEdgeDomainDns(ctx, params.project, source, hostname, false);
  if (dns.zone.zoneId !== edge.zoneId || dns.zone.scope.accountId !== edge.accountId) return stop('The Worker and the adopted DNS record belong to different Cloudflare zones or accounts.');
  const directHost = new URL(route.origin).hostname;
  if (owners.length) {
    const requirements = status?.dnsRecords?.map(normalizeProviderDnsRecord);
    const traffic = requirements?.filter(row => row?.name === hostname && row.type === 'CNAME');
    if (traffic?.length !== 1 || !traffic[0] || ![traffic[0].value, directHost].includes(dns.traffic.value)
      || dns.verification.some(record => !requirements?.some(row => row?.type === 'TXT' && row.name === record.name && row.value === record.value))) {
      return stop('The source provider’s domain requirements do not identify the adopted traffic and verification records.');
    }
  } else if (dns.traffic.value !== directHost) return stop('The source hosting attachment is gone but its public DNS does not point to the replacement.');
  const verification = dns.verification.map(({ name, id, address }) => ({ name, id, address })).sort((a,b) => a.id.localeCompare(b.id));
  if (pending && (verification.some(record => !pending.verification.some(old => isDeepStrictEqual(old, record)))
    || owners.length && !isDeepStrictEqual(verification, pending.verification))) return stop('The saved verification records changed during hostname release.');
  const review = handoffReviewSchema.parse({ hostname, projectId: params.project.id, sourceEnvironment: source.name, sourceId: source.id,
    targetEnvironment: target.name, targetId: target.id, targetService: service, sourceProvider: bindings.provider, providerProjectId: bindings.projectId,
    providerEnvironmentId: bindings.environmentId, sourceService: attachment.serviceName, sourceServiceId: attachment.serviceId,
    attachmentId: attachment.providerDomainId, zone: dns.zone, dnsConnectionId: dns.connectionId, recordId: dns.traffic.id,
    recordAddress: dns.traffic.address, verification: pending?.verification ?? verification, edge: route });
  if (pending && !isDeepStrictEqual(pending, review) || started && !isDeepStrictEqual(started, review) || incoming && !isDeepStrictEqual(incoming, review)) {
    return stop('The source or destination changed during the reviewed handoff. Preserve both ownership receipts.');
  }
  return { status: owners.length ? 'attached' as const : 'released' as const, review, target, source, sourceSpec, dns, adapter: active.adapter };
}

export type PublicEdgeStatus =
  | { state: 'awaiting_handoff'; hostname: string; service: string }
  | { state: 'unverified'; reason: string; publicUrl?: string; nativeOrigin?: string; service?: string }
  | { state: 'serving'; publicUrl: string; nativeOrigin: string; service: string };

/** Only live provider, DNS and HTTP reads for a recorded transfer. A desired route alone is reported as pending. */
export async function publicEdgeStatus(ctx: CommandContext, params: Params): Promise<PublicEdgeStatus | undefined> {
  const desired = params.spec.environments[params.environmentName]?.edgeDomain;
  const target = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!target?.platformBindings.edgeDomain) return desired ? { state: 'awaiting_handoff', hostname: desired.hostname, service: desired.service } : undefined;
  const endpoint = ownedEdgeEndpoint(target);
  if (!endpoint || !desired) return { state: 'unverified', ...endpoint, reason: 'The recorded public route differs from current intent.' };
  try {
    if ((await inspect(ctx, params, 'serving')).status === 'owned') return { state: 'serving', ...endpoint };
  } catch (error) { return { state: 'unverified', ...endpoint, reason: blocked(error).blocked[0]! }; }
  return { state: 'unverified', ...endpoint, reason: 'The target has no fully verified public route.' };
}

function actionFor(review: HandoffReview, step: HandoffStep): PlanAction {
  const type = step === 'detach' ? 'destroy' : step === 'claim' ? 'update' : 'noop';
  return { id: `domain-handoff:${step}:${review.hostname}`, type, verified: true,
    resource: { kind: 'domain', provider: step === 'detach' ? review.sourceProvider : 'cloudflare', name: review.hostname },
    ...(type !== 'noop' && { requiresConfirm: true }), metadata: { operation: 'domainHandoff', step },
    reason: step === 'detach' ? `Release the exact ${review.sourceProvider} attachment ${review.attachmentId} for ${review.hostname}. The verified Worker and proxied DNS continue serving ${review.targetEnvironment}.`
      : step === 'claim' ? `Transfer the existing Worker route and DNS ownership for ${review.hostname} to ${review.targetEnvironment}. The source workloads stay paused.`
      : `${review.targetEnvironment} owns and serves ${review.hostname} through its verified Worker and proxied CNAME.` };
}

function dnsStepFits(review: HandoffReview, dns: Dns, step: 'route' | 'cleanup', actions: PlanAction[]) {
  return actions.every(action => {
    if (action.type === 'noop') return true;
    if (action.metadata?.operation === 'dnsOwnershipReconcile') return dns.pending && action.type === 'update' && actions.length === 1;
    const addresses = engineSegmentOf(action)?.addresses;
    if (!addresses?.length || action.requiresConfirm !== true) return false;
    return step === 'route' ? action.type === 'update' && addresses.every(address => address === review.recordAddress)
      : action.type === 'destroy' && addresses.every(address => review.verification.some(old => old.address === address));
  });
}

export async function planDomainHandoff(ctx: CommandContext, params: Params): Promise<SavedDnsPlan | { blocked: string[] }> {
  try {
    const observed = await inspect(ctx, params);
    const { review, target } = observed;
    const targetHost = new URL(review.edge.origin).hostname;
    if (observed.status !== 'owned' && (observed.dns.traffic.value !== targetHost || observed.dns.pending
      || observed.status === 'released' && observed.dns.verification.length)) {
      const stage = observed.status === 'attached' ? 'route' : 'cleanup';
      const prepared = await prepareDnsEnginePlan({ ctx, project: params.project, environment: observed.source,
        environmentSpec: observed.sourceSpec, owner: 'hosting-domain', domain: review.hostname, handoff: { review, stage },
        records: [{ name: review.hostname, key: observed.dns.traffic.key, values: [targetHost], type: 'CNAME', ttl: 1, proxied: true }],
        ...(stage === 'route' && { retainExistingTypes: ['TXT'] }) });
      if (prepared.blocked?.length) return { blocked: prepared.blocked };
      if (prepared.ready || !dnsStepFits(review, observed.dns, stage, prepared.actions)) return blocked('The DNS plan does not isolate the in-place traffic update or the exact obsolete source verification records.');
      for (const action of prepared.actions.filter(item => item.type !== 'noop')) {
        action.reason = stage === 'route'
          ? `Keep Cloudflare proxying on and update the same CNAME for ${review.hostname} to ${targetHost}. The existing Worker continues forwarding traffic.`
          : `Remove only source verification records previously owned for ${review.hostname}. Its verified destination CNAME stays in place.`;
      }
      return persistDnsPlanRun(ctx, { project: params.project, environment: observed.source, environmentName: observed.source.name,
        specRevision: params.specRevision, prepared, source: { kind: 'domain-handoff', stage, review } });
    }
    const step = observed.status === 'owned' ? 'verify' : observed.status === 'attached' ? 'detach' : 'claim';
    const action = actionFor(review, step);
    const document: PlanRunDocument = { kind: 'hv_plan', scope: 'domain-handoff', environmentName: target.name,
      specRevision: params.specRevision, observedFingerprint: null, actions: [action], handoff: review,
      ...(step !== 'verify' && { lockEnvironmentIds: [review.sourceId] }) };
    const run = ctx.repos.runs.create({ projectId: params.project.id, environmentId: target.id, type: 'plan', plan: document });
    ctx.repos.runs.updateStatus(run.id, 'succeeded');
    return { planRunId: run.id, environmentName: target.name, specRevision: params.specRevision, actions: [action],
      confirmActions: requiresActionConfirmation(action) ? [action.id] : [], warnings: [] };
  } catch (error) { return blocked(error); }
}

function saveBoth(ctx: CommandContext, source: Environment, target: Environment, donor: Record<string, unknown>, recipient: Record<string, unknown>) {
  getDb().transaction(() => {
    if (!ctx.repos.environments.replacePlatformBindingsIfUnchanged(source, donor)
      || !ctx.repos.environments.replacePlatformBindingsIfUnchanged(target, recipient)) stop('A hostname owner changed while saving the transfer. Neither binding was changed.');
  })();
  ctx.repos.environments.syncRepoBindingsForId(target.id);
  ctx.repos.environments.syncRepoBindingsForId(source.id);
}

function rememberTransfer(ctx: CommandContext, source: Environment, target: Environment, review: HandoffReview, detach = false) {
  if (source.platformBindings.domainHandoffRoute && target.platformBindings.domainHandoffIncoming && (!detach || source.platformBindings.domainHandoff)) return;
  saveBoth(ctx, source, target, { ...source.platformBindings, domainHandoffRoute: review, ...(detach && { domainHandoff: review }) },
    { ...target.platformBindings, domainHandoffIncoming: review });
}

export async function verifyHandoffDnsSource(ctx: CommandContext, params: Omit<Params, 'environmentName'>,
  source: Record<string, unknown>, actions: PlanAction[], stateId: string) {
  const reviewed = handoffReviewSchema.parse(source.review);
  const stage = source.stage;
  if (reviewed.sourceId !== stateId || stage !== 'route' && stage !== 'cleanup') return stop('The saved DNS plan has a different handoff source.');
  const observed = await inspect(ctx, { ...params, environmentName: reviewed.targetEnvironment });
  if (observed.status === 'owned' || (stage === 'route') !== (observed.status === 'attached') || !isDeepStrictEqual(observed.review, reviewed)
    || !dnsStepFits(reviewed, observed.dns, stage, actions)) return stop('The verified route, source attachment or DNS record identity changed since review.');
  // The executor holds both environments and the zone. Preserve this destination before the first DNS change even if its reply is lost.
  rememberTransfer(ctx, observed.source, observed.target, reviewed);
}

async function runStep(ctx: CommandContext, params: Params, step: HandoffStep, review: HandoffReview) {
  const observed = await inspect(ctx, params);
  if (!isDeepStrictEqual(review, observed.review)) return stop('The reviewed hostname, route or native ownership changed. Run hv_plan again.');
  if (observed.status === 'owned' || observed.dns.pending || observed.dns.traffic.value !== new URL(review.edge.origin).hostname) {
    return stop('The verified in-place DNS update must finish before releasing or transferring ownership.');
  }
  const { source, target } = observed;
  if (step === 'detach' && observed.status === 'attached') {
    // Persist the exact approved target before the request. A lost response can then be recovered by fresh scoped absence.
    rememberTransfer(ctx, source, target, review, true);
    const receipt = await observed.adapter.detachCustomDomain({ projectId: review.providerProjectId, environmentId: review.providerEnvironmentId,
      serviceId: review.sourceServiceId, customDomainId: review.attachmentId, domain: review.hostname });
    if (!receipt.success || (await inspect(ctx, params)).status !== 'released') return stop('The source has not confirmed release of the exact attachment. The forwarding route and recovery receipt remain in place.');
    return { success: true, message: 'The exact source attachment is gone. The target still serves the hostname. Plan again for DNS verification cleanup and ownership transfer.' };
  }
  if (step !== 'claim' || observed.status !== 'released' || observed.dns.verification.length) return stop('Confirm source absence and finish the reviewed verification-record cleanup before transferring ownership.');
  const sourceBindings = parseHostingBindings(source);
  const serviceBinding = sourceBindings.services![review.sourceService]!;
  const sourceNext = { ...source.platformBindings, domainDns: undefined, maintenance: undefined, dnsEngine: undefined, domainHandoff: undefined, domainHandoffRoute: undefined,
    services: { ...sourceBindings.services, [review.sourceService]: { ...serviceBinding, customDomains: serviceBinding.customDomains?.filter(name => name !== review.hostname) } },
    edgeDomainReleased: { hostname: review.hostname, targetId: target.id, sourceService: review.sourceService } };
  const targetNext = { ...target.platformBindings, domainHandoffIncoming: undefined, edgeDomain: review, 'dnsEngine_edge-domain': source.platformBindings.dnsEngine };
  saveBoth(ctx, source, target, sourceNext, targetNext);
  if ((await inspect(ctx, params)).status !== 'owned') return stop('The saved ownership needs public verification. Re-run the target handoff plan.');
  return { success: true, message: `${target.name} owns and serves ${review.hostname}. Remove the obsolete source hostname, DNS and maintenance intent before reviewing source retirement.` };
}

export async function applyDomainHandoff(ctx: CommandContext, params: Params & { planId: string; confirmActions: string[] }) {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { success: false, error: loaded.error, receipts: [] };
  const review = handoffReviewSchema.parse(loaded.document.handoff);
  const action = loaded.document.actions[0]!;
  const step = action.metadata!.step as HandoffStep;
  if (loaded.run.projectId !== params.project.id || loaded.run.environmentId !== review.targetId || review.projectId !== params.project.id
    || !isDeepStrictEqual(action, actionFor(review, step))) return { success: false, error: 'The saved handoff action does not match its exact project, destination or reviewed effect.', receipts: [] };
  return executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    handler: async () => {
      try { return await runStep(ctx, params, step, review); }
      catch (error) { return { success: false, status: 'blocked', message: blocked(error).blocked[0]! }; }
    } });
}
