import { isDeepStrictEqual } from 'node:util';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { parseEnvironmentMaintenanceBinding } from '../domain/services/environment-maintenance.service.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import type { EngineBinding } from './infrastructure-engine.js';
import type { Project } from '../domain/entities/project.entity.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { resolveEnvironmentBackupPolicy } from '../domain/services/backup-policy.service.js';
import { commonEngineProblems, isEngineManaged } from '../domain/services/infrastructure-engine-selection.js';
import { MAINTENANCE_OPERATIONS } from '../domain/services/maintenance-plan.service.js';
import { dnsHostnameSchema } from '../domain/spec/dns.schema.js';
import { environmentSpecSchema, type EnvironmentSpec, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { observeMigrationDatabaseBackups } from './migration-database-backups.js';
import { observeCloudBucketBackup } from './cloud-bucket-backups.js';
import type { BackupResource } from '../domain/services/backup-policy.service.js';
import { gcpDatabaseLocation } from './gcp-database-location.js';
import { observeEnginePromotion } from './engine-promotion.js';
import { createCommandContext } from './context.js';
import { SpecStore } from '../domain/spec/spec.store.js';

export interface CutoverBackupReview { id: string; notice: string }

interface CutoverReadiness {
  domain?: string;
  problems: string[];
  alreadyForwarding: boolean;
  pauseFingerprint?: string;
  backupReview?: CutoverBackupReview;
}

async function coveredBuckets(project: Project, destination: Environment, target: EnvironmentSpec, resources: BackupResource[]) {
  const covered = new Map<string, { name: string; source: string; archive: string }>();
  const migration = (destination.platformBindings.engine as EngineBinding | undefined)?.migration;
  for (const resource of resources) {
    if (resource.kind !== 'storage' || resource.retained || resource.bindingState !== 'bound'
      || !target.storage?.[resource.name]?.automatedBackups) continue;
    const proof = await observeCloudBucketBackup(project, destination, target, resource.name);
    const receipt = migration?.storage?.find(item => item.name === resource.name && item.match && item.downloadVerifiedFor);
    const since = receipt?.firstVerifiedAt ?? migration?.copiedAt;
    if (proof && receipt && since && Date.parse(proof.startedAt ?? proof.latestAt) >= Date.parse(since)) {
      covered.set(resource.name, { name: resource.name, source: proof.source, archive: proof.archive });
    }
  }
  return covered;
}

async function cutoverProtection(project: Project, origin: Environment, source: EnvironmentSpec, destination: Environment,
  target: EnvironmentSpec, web: string | undefined) {
  const problems: string[] = [];
  let backupReview: CutoverBackupReview | undefined;
  const targetName = destination.name;
  // Probe only the inherited guarantee. Independent target settings have their
  // own normal deploy gates and cannot answer whether this guarantee works.
  const defaults = environmentSpecSchema.parse({ hosting: target.hosting });
  const unsupported = (requirements: Pick<Partial<EnvironmentSpec>, 'backups' | 'deploy'>) => isEngineManaged(target)
    && commonEngineProblems({ ...defaults, ...requirements }).length > 0;
  const nativeDatabaseBackups = !!source.database && target.database?.automatedBackups === true;
  const verifiedNativeBackups = nativeDatabaseBackups && await observeMigrationDatabaseBackups(project, destination, target);
  if (nativeDatabaseBackups && !verifiedNativeBackups) {
    problems.push(`Hypervibe could not confirm automated backups on the PostgreSQL database in ${targetName}. Check the target database plan and cloud connection before cutover.`);
  } else if (source.database?.automatedBackups && !nativeDatabaseBackups) {
    problems.push(`Set database.automatedBackups to true on ${targetName} to keep the source database's automated backups.`);
  }
  if (source.backups?.mode === 'daily') {
    if (unsupported({ backups: source.backups })) {
      const components = new ComponentRepository().findByEnvironmentId(origin.id);
      const policy = resolveEnvironmentBackupPolicy(source, origin, components);
      const buckets = await coveredBuckets(project, destination, target, policy.resources);
      const uncovered = policy.resources.filter(resource => resource.retained || (resource.kind !== 'database'
        && (resource.kind !== 'storage' || !buckets.has(resource.name))));
      if (uncovered.length) {
        const names = uncovered.map(resource => resource.kind === 'database' ? 'a retained database'
          : `${resource.kind === 'storage' ? 'bucket' : 'volume'} ${resource.name}`);
        const files = uncovered.some(resource => resource.kind === 'storage' && !resource.retained);
        problems.push(`The daily backup policy on ${origin.name} also covers ${[...new Set(names)].join(', ')}. ${targetName} needs verified recovery coverage for them before cutover.`
          + (files ? ' For each application bucket, set automatedBackups to true on the target and review hv_plan scope="backups". A daily backup must complete after the files are copied to the target.' : ''));
      } else if ((source.database ? !nativeDatabaseBackups : !buckets.size) || target.backups?.mode === 'daily') {
        const next = source.database && target.database && target.backups?.mode !== 'daily'
          ? ` To use the cloud's own PostgreSQL backups, set database.automatedBackups to true on ${targetName} and review its infrastructure plan.` : '';
        problems.push(`The engine for ${targetName} cannot provide the source's managed daily backups and restore checks.${next}`);
      } else if (!source.database || verifiedNativeBackups) {
        const notice = [
          verifiedNativeBackups && `Google Cloud backs up PostgreSQL in ${targetName}. Moving traffic there gives up Hypervibe's independent database copies and restore tests.`,
          buckets.size && `Daily backups cover ${[...buckets.keys()].join(', ')} in separate Google Cloud storage. Each copy can be recovered on its own. Keep the Railway archive for its earlier recovery points.`,
        ].filter(Boolean).join(' ');
        const bindings = destination.platformBindings;
        const database = gcpDatabaseLocation(typeof bindings.projectId === 'string' ? bindings.projectId : '', bindings.engine as EngineBinding | undefined);
        backupReview = { notice, id: canonicalJsonSha256({ notice, source: origin.id, destination: destination.id, domain: source.domain,
          service: web, policy: source.backups, resources: policy.resources, database, region: bindings.environmentId,
          ...(buckets.size && { buckets: [...buckets.values()] }) }) };
      }
    } else if (target.backups?.mode !== 'daily') {
      problems.push(`${targetName} needs the source's managed daily backup policy.`);
    }
  }
  const staging = source.deploy?.promoteFrom;
  if (staging) {
    const tests = source.deploy?.promotionTests;
    if (unsupported({ deploy: { strategy: 'branch', trigger: 'ci', autoDeploy: false, promoteFrom: staging, promotionTests: tests } })) {
      problems.push(`The engine for ${targetName} cannot enforce promotion of the verified release from ${staging}${tests ? ' and its required test workflow' : ''}.`);
    } else if (target.deploy?.promoteFrom !== staging || tests && target.deploy.promotionTests?.workflow !== tests.workflow) {
      problems.push(`${targetName} needs verified release promotion from ${staging}${tests ? ' with the same required test workflow' : ''}.`);
    } else if (isEngineManaged(target)) {
      const spec = new SpecStore().getForInspection(project)?.spec;
      const promotion = spec && await observeEnginePromotion(createCommandContext(), project, spec, destination);
      if (!promotion || 'blocked' in promotion) problems.push(promotion?.blocked ?? `The engine could not verify release promotion from ${staging}.`);
    }
  }
  return { problems, backupReview };
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
  /** Present only if the user accepted the reviewed change in database recovery. */
  backupReviewId?: string;
}

export function finalCopyReceipt(source: Environment, target: Environment, domain: string, targetService: string,
  pauseFingerprint: string | undefined, backupReviewId?: string): FinalCopyReceipt | undefined {
  const migration = (target.platformBindings.engine as EngineBinding | undefined)?.migration;
  if (!pauseFingerprint || migration?.from !== source.name || migration.copyAttempt?.status !== 'complete' || !migration.copiedAt) return undefined;
  return { sourceEnvironmentId: source.id, targetEnvironmentId: target.id, domain, targetService, pauseFingerprint,
    copyAttemptId: migration.copyAttempt.id, copiedAt: migration.copiedAt, ...(backupReviewId && { backupReviewId }),
    dataFingerprint: canonicalJsonSha256({ database: migration.database, storage: migration.storage ?? [] }) };
}

export function verifiedFinalCopy(source: Environment, target: Environment, domain: string, web: string, pauseFingerprint?: string) {
  const saved = (target.platformBindings.engine as EngineBinding | undefined)?.migration?.finalCopy;
  return saved && isDeepStrictEqual(saved, finalCopyReceipt(source, target, domain, web, pauseFingerprint, saved.backupReviewId))
    ? saved : undefined;
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
  destination: Environment, target: EnvironmentSpec, web: string | undefined): Promise<CutoverReadiness> {
  const from = environment.name;
  const to = destination.name;
  const { problems, backupReview } = await cutoverProtection(project, environment, source, destination, target, web);
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
  return { domain, problems, alreadyForwarding, pauseFingerprint: observedPause(environment, source, domain, plan.actions), backupReview };
}

export const targetWriteRecovery = 'Preserve writes accepted on the target when recovering service. The retained source contains the earlier copy.';

export function forwardedCutover(observed: CutoverReadiness, destination: Environment, justMoved = false) {
  if (!observed.domain || !observed.alreadyForwarding) return undefined;
  const reviewed = (destination.platformBindings.engine as EngineBinding | undefined)?.migration?.finalCopy?.backupReviewId;
  const notice = observed.backupReview && observed.backupReview.id !== reviewed ? [observed.backupReview.notice] : [];
  return { status: 'cut_over' as const, domain: observed.domain, target: destination.name, message: [
    `${observed.domain} ${justMoved ? 'now' : 'already'} forwards to ${destination.name}.`, ...observed.problems, ...notice, targetWriteRecovery,
  ].join(' ') };
}

export function reviewCutover(from: string, to: string, domain: string, web: string, backups?: CutoverBackupReview, copySteps?: string[]) {
  return { status: 'needs_cutover_approval' as const, domain, ...(backups && { backupReviewId: backups.id }),
    steps: [...(backups ? [backups.notice] : []), ...(copySteps ?? []),
      `Send ${domain} to ${to} (${web}). ${from} stays paused with its data. ${targetWriteRecovery}`],
    message: copySteps ? `${domain} is unavailable from the pause until the traffic move, including time for the final copy, verification, and any outstanding approvals.`
      : `${from} is paused. Its final copy has been verified. Review the changed backup protection before moving traffic.` };
}

/** Observe a possible live route before offering a refresh, preparing the
 * target, or interpreting a missing, interrupted, or pre-cutover copy receipt. */
export async function protectForwardingTarget(project: Project, spec: ProjectSpec, source: Environment, destination: Environment | null,
  to: string, options: { cutover?: boolean; verifyOnly?: boolean; confirmCutover?: boolean; backupReviewId?: string }): Promise<
    { status: 'blocked'; message: string } | { status: 'cut_over'; domain: string; target: string; message: string } | ReturnType<typeof reviewCutover> | undefined
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
  const inspected = await migrationCutoverReadiness(project, source, origin, destination, target, web);
  const forwarded = forwardedCutover(inspected, destination);
  if (forwarded) return forwarded;
  if (inspected.problems.length) return { status: 'blocked', message: [...inspected.problems, targetWriteRecovery].join(' ') };
  const receipt = inspected.domain && verifiedFinalCopy(source, destination, inspected.domain, web, inspected.pauseFingerprint);
  if (!receipt || !inspected.domain) return { status: 'blocked',
    message: `Traffic to ${to} needs a verified final copy made during the current source pause. Keep the source paused and reconcile the current route. ${targetWriteRecovery}` };
  if (inspected.backupReview && inspected.backupReview.id !== receipt.backupReviewId
    && !(options.confirmCutover && options.backupReviewId === inspected.backupReview.id)) {
    return reviewCutover(from, to, inspected.domain, web, inspected.backupReview);
  }
  return undefined;
}
