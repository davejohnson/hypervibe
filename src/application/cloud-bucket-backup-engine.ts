import { randomUUID } from 'node:crypto';
import { configurationDigest } from '../adapters/engine/opentofu/workspace.js';
import { parseEnginePlan } from '../adapters/engine/opentofu/plan-mapping.js';
import { bucketBackupDescriptorSchema } from '../domain/plan/bucket-backup-plan.contract.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { engineSegmentOf, engineStateKey, type EngineAuthentication, type EngineConfiguration,
  type EngineStateIdentity, type InfrastructureEngineBackend } from '../domain/ports/infrastructure-engine.port.js';
import type { EngineApplyOutcome, EngineApplyParams, EnginePlanOutcome, EnginePlanParams } from './cloud-engines.js';
import type { CommandContext } from './context.js';
import { openTofuEngine, recordEnginePlan } from './engine-shared.js';

type Cloud = 'aws' | 'azure' | 'gcp';
interface PreparedBucketBackup {
  environmentId: string;
  backend: InfrastructureEngineBackend;
  auth: EngineAuthentication;
  state: EngineStateIdentity;
  configuration: EngineConfiguration;
  source: string;
  archive: string;
  /** Digest of the independently verified native source, destination and placement. */
  scopeFingerprint: string;
  /** Provider-specific identities, grants and other details of the reviewed setup. */
  reviewNotes?: string;
  reviewPlan?: (raw: unknown) => boolean;
  /** Recheck provider identities and record a possible partial setup before applying the approved segment. */
  beforeApply?: () => Promise<boolean>;
  verifyApplied?: () => Promise<boolean>;
}
export type PrepareBucketBackup = (ctx: CommandContext, params: Omit<EnginePlanParams, 'specRevision'> & {
  storageName: string;
}) => Promise<PreparedBucketBackup | { blocked: string }>;

function selectedStorage(spec: EnginePlanParams['spec'], environmentName: string): string[] {
  return Object.entries(spec.environments[environmentName]?.storage ?? {})
    .filter(([, storage]) => storage.automatedBackups === true).map(([name]) => name).sort();
}

function descriptor(storageName: string, planId: string, target: PreparedBucketBackup) {
  return { storageName, planId, state: target.state, source: target.source, archive: target.archive,
    configurationDigest: configurationDigest(target.configuration), scopeFingerprint: target.scopeFingerprint };
}

function authorizedState(target: PreparedBucketBackup, projectId: string, provider: Cloud): boolean {
  return target.backend.provider === provider && target.state.provider === provider && target.state.projectId === projectId &&
    target.state.partition === 'environment' && target.state.environmentId !== target.environmentId && target.source !== target.archive;
}

/** Check each address before grouping into user actions. Grouping alone can
 * hide a destructive or unowned change alongside another member of the group. */
function readReviewedChanges(target: PreparedBucketBackup, raw: unknown, displayed?: PlanAction[]): boolean {
  if (target.reviewPlan && !target.reviewPlan(raw)) return false;
  const parsed = parseEnginePlan(JSON.stringify(raw));
  const { resources } = target.configuration;
  const addresses = new Set(parsed.changes.map(change => change.address));
  if (parsed.unsupported.length || addresses.size !== parsed.changes.length || Object.keys(resources).length !== addresses.size ||
    parsed.changes.some(change => !resources[change.address] || !['noop', 'create', 'update'].includes(change.action))) return false;
  if (!displayed) return true;
  return displayed.every(action => {
    const changes = parsed.changes.filter(change => resources[change.address]!.actionId === action.id && change.action !== 'noop');
    const actual = changes.map(change => change.address).sort();
    const reviewed = [...(engineSegmentOf(action)?.addresses ?? [])].sort();
    const expectedType = changes.some(change => change.action === 'create') ? 'create' : changes.length ? 'update' : 'noop';
    return action.type === expectedType && JSON.stringify(actual) === JSON.stringify(reviewed);
  });
}

/** An independent state per source means removing intent never plans deletion of an existing recovery set. */
export async function planCloudBucketBackups(ctx: CommandContext, params: EnginePlanParams, provider: Cloud,
  prepare: PrepareBucketBackup): Promise<EnginePlanOutcome> {
  const sources = selectedStorage(params.spec, params.environmentName);
  if (!sources.length) return { blocked: ['Choose at least one source with storage.<name>.automatedBackups: true.'] };
  const engine = await openTofuEngine();
  if ('blocked' in engine) return { blocked: [engine.blocked] };
  const actions: PlanAction[] = [];
  const programs = [];
  const states = new Set<string>();
  let environmentId: string | undefined;
  for (const storageName of sources) {
    const target = await prepare(ctx, { ...params, storageName });
    if ('blocked' in target) return { blocked: [target.blocked] };
    const stateKey = engineStateKey(target.state);
    if (!authorizedState(target, params.project.id, provider) || states.has(stateKey) || (environmentId && environmentId !== target.environmentId)) {
      return { blocked: ['The daily file backup does not have its own verified environment state.'] };
    }
    states.add(stateKey);
    environmentId = target.environmentId;
    const planId = randomUUID();
    const planned = await engine.plan({ ...target, planId, verifyPlannedChanges: raw => readReviewedChanges(target, raw) });
    if (!planned.ok) return { blocked: [planned.error] };
    if (planned.blockers.length) return { blocked: planned.blockers };
    if (planned.unmanagedDeletes.length || planned.actions.some(action => action.type === 'destroy' || action.type === 'replace')) {
      return { blocked: ['The file backup plan would remove or replace existing resources. Preserve the archive and review its ownership.'] };
    }
    programs.push(descriptor(storageName, planId, target));
    for (const action of planned.actions) {
      actions.push({ ...action, ...(action.type !== 'noop' ? { requiresConfirm: true } : {}),
        reason: action.reason + ' Daily file backup from ' + target.source + ' to ' + target.archive +
          '. Keeps seven completed daily copies. Storage, requests and scheduled execution can incur charges.'
          + (target.reviewNotes ? ' ' + target.reviewNotes : '') });
    }
  }
  const bucketBackup = bucketBackupDescriptorSchema.parse({ provider, programs });
  return recordEnginePlan({ projectId: params.project.id, environmentId: environmentId!, environmentName: params.environmentName,
    specRevision: params.specRevision, scope: 'bucket-backups', actions, warnings: [], engine: { bucketBackup } });
}

export async function applyCloudBucketBackups(ctx: CommandContext, params: EngineApplyParams, provider: Cloud,
  prepare: PrepareBucketBackup): Promise<EngineApplyOutcome> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  const { document, run } = loaded;
  const reviewed = bucketBackupDescriptorSchema.safeParse((document.engine as { bucketBackup?: unknown } | undefined)?.bucketBackup);
  const changed = { kind: 'blocked' as const, reason: 'The reviewed file backup scope or configuration has changed. Run hv_plan again.' };
  if (run.projectId !== params.project.id || document.scope !== 'bucket-backups' || !reviewed.success ||
    reviewed.data.provider !== provider || document.specRevision !== params.specRevision) return changed;
  const selected = selectedStorage(params.spec, document.environmentName);
  if (JSON.stringify(selected) !== JSON.stringify(reviewed.data.programs.map(row => row.storageName).sort())) return changed;
  const confirmed = new Set(params.confirmActions);
  if (document.actions.some(action => action.type !== 'noop' && !confirmed.has(action.id))) {
    return { kind: 'blocked', reason: 'Confirm every changing file backup action in the reviewed plan before applying it.' };
  }
  const engine = await openTofuEngine();
  if ('blocked' in engine) return { kind: 'blocked', reason: engine.blocked };
  const targets = new Map<string, PreparedBucketBackup>();
  for (const program of reviewed.data.programs) {
    const target = await prepare(ctx, { ...params, environmentName: document.environmentName, storageName: program.storageName });
    if ('blocked' in target) return { kind: 'blocked', reason: target.blocked };
    if (!authorizedState(target, params.project.id, provider) || run.environmentId !== target.environmentId ||
      target.source !== program.source || target.archive !== program.archive || target.scopeFingerprint !== program.scopeFingerprint ||
      engineStateKey(target.state) !== engineStateKey(program.state) || configurationDigest(target.configuration) !== program.configurationDigest) return changed;
    const expected = new Map(Object.values(target.configuration.resources).map(mapping => [mapping.actionId, mapping]));
    const displayed = document.actions.filter(action => action.id.split(':')[1] === program.storageName);
    if (!displayed.length || displayed.length !== expected.size || displayed.some(action => {
      const mapping = expected.get(action.id);
      return !mapping || action.resource.provider !== provider || mapping.kind !== action.resource.kind || mapping.name !== action.resource.name ||
        (action.type === 'create' && mapping.billable && action.billable !== true);
    })) return changed;
    targets.set('opentofu:' + program.planId, target);
  }
  const result = await executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision,
    confirmActions: params.confirmActions,
    handler: async () => ({ success: false, message: 'File backups require an exact saved engine plan.' }),
    segmentHandler: async (segment, members) => {
      const target = targets.get(segment.id);
      const addresses = [...new Set(members.flatMap(member => engineSegmentOf(member)?.addresses ?? []))];
      const refused = () => ({ outcomes: Object.fromEntries(addresses.map(address => [address, 'not_started' as const])),
        diagnostics: ['The saved file backup plan does not match the reviewed resources.'] });
      if (!target || segment.configurationDigest !== configurationDigest(target.configuration) ||
        members.some(member => engineSegmentOf(member)?.addresses.some(address => target.configuration.resources[address]?.actionId !== member.id))) return refused();
      if (target.beforeApply && !await target.beforeApply().catch(() => false)) return refused();
      return engine.apply({ backend: target.backend, auth: target.auth, state: target.state, planId: segment.id.slice('opentofu:'.length),
        segment: { ...segment, addresses }, approvedAddresses: addresses, verifySavedPlan: raw =>
          readReviewedChanges(target, raw, document.actions.filter(action => action.id.split(':')[1] === members[0]?.id.split(':')[1])) });
    } });
  if (result.success) {
    for (const target of targets.values()) {
      if (target.verifyApplied && !await target.verifyApplied().catch(() => false)) {
        return { kind: 'executed', envName: document.environmentName, result: { ...result, success: false,
          error: 'The scheduled file backup could not be verified after apply. Review its current state before retrying.' } };
      }
    }
  }
  return { kind: 'executed', envName: document.environmentName, result };
}
