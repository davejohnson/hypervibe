import { isDeepStrictEqual } from 'node:util';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { parseEnvironmentMaintenanceBinding } from '../domain/services/environment-maintenance.service.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import type { EngineBinding } from './infrastructure-engine.js';
import type { Project } from '../domain/entities/project.entity.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { commonEngineProblems, isEngineManaged } from '../domain/services/infrastructure-engine-selection.js';
import { MAINTENANCE_OPERATIONS } from '../domain/services/maintenance-plan.service.js';
import { dnsHostnameSchema } from '../domain/spec/dns.schema.js';
import { environmentSpecSchema, type EnvironmentSpec, type ProjectSpec } from '../domain/spec/spec.schema.js';

function protectionProblems(source: EnvironmentSpec, target: EnvironmentSpec, targetName: string) {
  const problems: string[] = [];
  // Probe only the inherited guarantee. Independent target settings have their
  // own normal deploy gates and cannot answer whether this guarantee works.
  const defaults = environmentSpecSchema.parse({ hosting: target.hosting });
  const unsupported = (requirements: Pick<Partial<EnvironmentSpec>, 'backups' | 'deploy'>) => isEngineManaged(target)
    && commonEngineProblems({ ...defaults, ...requirements }).length > 0;
  if (source.backups?.mode === 'daily') {
    if (unsupported({ backups: source.backups })) {
      problems.push(`The engine for ${targetName} cannot provide the source's managed daily backups and restore checks.`);
    } else if (target.backups?.mode !== 'daily') {
      problems.push(`${targetName} needs the source's managed daily backup policy.`);
    }
  }
  const staging = source.deploy?.promoteFrom;
  if (staging) {
    const tests = source.deploy?.promotionTests;
    if (unsupported({ deploy: { strategy: 'branch', promoteFrom: staging, promotionTests: tests } })) {
      problems.push(`The engine for ${targetName} cannot enforce promotion of the verified release from ${staging}${tests ? ' and its required test workflow' : ''}.`);
    } else if (target.deploy?.promoteFrom !== staging || tests && target.deploy.promotionTests?.workflow !== tests.workflow) {
      problems.push(`${targetName} needs verified release promotion from ${staging}${tests ? ' with the same required test workflow' : ''}.`);
    }
  }
  return problems;
}

export interface FinalCopyReceipt {
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  domain: string;
  targetService: string;
  pauseFingerprint: string;
  copyAttemptId: string;
  copiedAt: string;
  dataFingerprint: string;
}

export function finalCopyReceipt(source: Environment, target: Environment, domain: string, targetService: string,
  pauseFingerprint: string | undefined): FinalCopyReceipt | undefined {
  const migration = (target.platformBindings.engine as EngineBinding | undefined)?.migration;
  if (!pauseFingerprint || migration?.from !== source.name || migration.copyAttempt?.status !== 'complete' || !migration.copiedAt) return undefined;
  return { sourceEnvironmentId: source.id, targetEnvironmentId: target.id, domain, targetService, pauseFingerprint,
    copyAttemptId: migration.copyAttempt.id, copiedAt: migration.copiedAt,
    dataFingerprint: canonicalJsonSha256({ database: migration.database, storage: migration.storage ?? [] }) };
}

function observedPause(source: Environment, spec: EnvironmentSpec, domain: string, actions: PlanAction[]): string | undefined {
  const binding = parseEnvironmentMaintenanceBinding(source);
  if (binding?.mode !== 'application' || binding.state !== 'active' || !binding.updatedAt
    || !binding.edge || binding.edge.hostname !== domain || binding.edge.origin || binding.pendingEdge) return undefined;
  const paused = actions.filter(action => action.verified && action.type === 'noop' && action.resource.kind === 'maintenance');
  if (!paused.some(action => action.id === `maintenance:${source.name}:edge`
    && action.metadata?.operation === MAINTENANCE_OPERATIONS.edgeEnable && action.metadata.hostname === domain)) return undefined;
  for (const [name, service] of Object.entries(spec.services)) {
    const snapshot = binding.workloads?.[name];
    if (!snapshot || snapshot.workloadKind !== service.workloadKind || !paused.some(action =>
      action.id === `maintenance:${source.name}:workload:${name}` && action.metadata?.operation === MAINTENANCE_OPERATIONS.workloadSuspend
      && action.metadata.serviceId === snapshot.serviceId && action.metadata.workloadKind === service.workloadKind)) return undefined;
  }
  return canonicalJsonSha256({ source: source.id, updatedAt: binding.updatedAt, edge: binding.edge, workloads: binding.workloads ?? {} });
}

export async function migrationCutoverReadiness(project: Project, environment: Environment, source: EnvironmentSpec,
  to: string, target: EnvironmentSpec, web: string | undefined): Promise<{
    domain?: string; problems: string[]; alreadyForwarding: boolean; pauseFingerprint?: string;
  }> {
  const from = environment.name;
  const problems = protectionProblems(source, target, to);
  const hostname = dnsHostnameSchema.safeParse(source.domain);
  if (!hostname.success) {
    problems.unshift(`${from} needs its existing public hostname declared as a complete custom domain before cutover.`);
    return { problems, alreadyForwarding: false };
  }
  const domain = hostname.data;
  if (!web) problems.push(`${to} needs one public web service to receive ${domain}.`);
  if (web && !environmentSpecSchema.safeParse({ ...source, domainTarget: { environment: to, service: web },
    maintenance: { enabled: true, mode: 'application', page: 'off' } }).success) {
    problems.push(`The existing domain ${domain} needs the Cloudflare-proxied routing configuration required by application maintenance.`);
  }
  const routingRequested = source.maintenance?.page === 'off' && source.domainTarget?.environment === to;
  // An unapplied routing request resembles a completed cutover in the spec. Even
  // when protection is missing, observe the route before giving recovery advice.
  if (problems.length && !routingRequested) return { domain, problems, alreadyForwarding: false };
  const plan = await new PlanService().plan(project, from, { scope: 'full' });
  if ('error' in plan) {
    problems.push(`The source plan could not verify traffic for ${domain}. ${plan.error}`);
    return { domain, problems, alreadyForwarding: false };
  }
  const verified = plan.actions.filter(action => action.verified && dnsHostnameSchema.safeParse(action.resource.name).data === domain);
  const route = verified.find(action => action.id === `maintenance:${from}:traffic`
    && action.metadata?.operation === MAINTENANCE_OPERATIONS.edgeRoute
    && action.metadata.targetEnvironment === to && action.metadata.targetService === web);
  const alreadyForwarding = routingRequested && route?.type === 'noop';
  if (alreadyForwarding && !plan.actions.some(action => action.id === `maintenance:${from}:verify`
    && action.verified && action.type === 'noop' && action.metadata?.operation === MAINTENANCE_OPERATIONS.verifyEnter)) {
    problems.push(`The complete source maintenance boundary for ${from} still needs verification.`);
  }
  const domainReady = verified.some(action => action.resource.kind === 'domain'
    && action.resource.provider === source.hosting.provider && action.type === 'noop');
  // While entering or resuming application maintenance the full planner replaces
  // its ordinary domain action with the scoped, provider-observed edge action.
  const edgeReady = source.maintenance?.enabled && source.maintenance.mode === 'application' && verified.some(action =>
    action.id === `maintenance:${from}:edge` && action.metadata?.operation === MAINTENANCE_OPERATIONS.edgeEnable
    && dnsHostnameSchema.safeParse(action.metadata.hostname).data === domain);
  if (!alreadyForwarding && !edgeReady && !domainReady) problems.push(`The full source plan must verify the existing domain ${domain} before cutover.`);
  if (routingRequested && !route) problems.push(`The source plan could not verify the requested traffic route from ${domain} to ${to}.`);
  return { domain, problems, alreadyForwarding, pauseFingerprint: observedPause(environment, source, domain, plan.actions) };
}

export const targetWriteRecovery = 'Preserve writes accepted on the target when recovering service. The retained source contains the earlier copy.';

/** Observe a possible live route before offering a refresh, preparing the
 * target, or interpreting a missing, interrupted, or pre-cutover copy receipt. */
export async function protectForwardingTarget(project: Project, spec: ProjectSpec, source: Environment, destination: Environment | null,
  to: string, options: { cutover?: boolean; verifyOnly?: boolean }): Promise<
    { status: 'blocked'; message: string } | { status: 'cut_over'; domain: string; target: string; message: string } | undefined
  > {
  const from = source.name;
  const other = Object.entries(spec.environments).find(([name, environment]) => name !== from && environment.domainTarget?.environment === to);
  if (other) return { status: 'blocked', message: `${other[0]} has a traffic route configured to ${to}. Verify that live route before operating on the target. ${targetWriteRecovery}` };
  const origin = spec.environments[from]!;
  const declared = origin.domainTarget?.environment === to;
  const migration = (destination?.platformBindings.engine as EngineBinding | undefined)?.migration;
  const edge = parseEnvironmentMaintenanceBinding(source);
  // A removed desired route can still be active or need reconciliation on
  // the provider. A genuinely new environment can still be rehearsed.
  const unresolvedRoute = destination && (!origin.domainTarget || migration?.from === from) && (edge?.edge?.origin || edge?.pendingEdge?.origin);
  if (!declared && !unresolvedRoute) return undefined;
  const target = spec.environments[to];
  if (!declared || !destination || !target || !options.cutover) {
    if (options.verifyOnly && !options.cutover && declared && migration?.copiedAt && migration.copyAttempt?.status === 'complete') return undefined;
    return { status: 'blocked', message: `Traffic from ${from} may already reach ${to}. Inspect the current route before using this target for another copy. ${targetWriteRecovery}` };
  }
  const web = origin.domainTarget!.service;
  const inspected = await migrationCutoverReadiness(project, source, origin, to, target, web);
  if (inspected.domain && inspected.alreadyForwarding) return { status: 'cut_over', domain: inspected.domain, target: to,
    message: [`${inspected.domain} already forwards to ${to}.`, ...inspected.problems, targetWriteRecovery].join(' ') };
  if (inspected.problems.length) return { status: 'blocked', message: [...inspected.problems, targetWriteRecovery].join(' ') };
  const receipt = inspected.domain && finalCopyReceipt(source, destination, inspected.domain, web, inspected.pauseFingerprint);
  if (!receipt || !isDeepStrictEqual(receipt, migration?.finalCopy)) return { status: 'blocked',
    message: `Traffic to ${to} needs a verified final copy made during the current source pause. Keep the source paused and reconcile the current route. ${targetWriteRecovery}` };
  return undefined;
}
