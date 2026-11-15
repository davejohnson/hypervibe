import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getDb } from '../../adapters/db/sqlite.adapter.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import { parseHostingBindings, hostingServiceCreateRecoverySchema } from '../ports/hosting.port.js';
import { serviceInstanceIntentSchema, serviceInstanceIntentsSchema, serviceInstanceRecoveryReviewSchema, type IServiceInstances, type ServiceInstanceIntent } from '../ports/service-instance.port.js';
import { adapterFactory } from './adapter.factory.js';
import { SpecStore } from '../spec/spec.store.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { serviceInstanceHistory, serviceInstanceIntentFingerprint, serviceInstanceRecoveryReview } from './service-instance-recovery.js';

export const serviceInstanceActionSchema = serviceInstanceIntentSchema.extend({
  operation: z.enum(['serviceInstanceCreate', 'serviceInstanceFinalize', 'serviceInstanceFinalizeRecovery']),
  recoveryReview: serviceInstanceRecoveryReviewSchema.optional(),
}).strict().refine(value => (value.operation === 'serviceInstanceFinalizeRecovery') === Boolean(value.recoveryReview)
  && (!value.recoveryApproval || value.operation === 'serviceInstanceFinalizeRecovery' && value.completed === true
    && value.recoveryApproval.archiveId === value.recoveryReview?.archiveId
    && value.recoveryApproval.activeMarkerSha256 === value.recoveryReview?.activeMarkerSha256));
function pending(environment: Environment): Record<string, ServiceInstanceIntent> {
  return serviceInstanceIntentsSchema.parse(environment.platformBindings.serviceInstanceCreates ?? {});
}
function priorRecovery(environment: Environment, name: string, target: ServiceInstanceIntent['target'], provider: string): { marker: unknown; digest: string } | undefined {
  const raw = parseHostingBindings(environment).serviceCreateRecovery?.[name];
  if (raw === undefined) return undefined;
  const marker = hostingServiceCreateRecoverySchema.parse(raw);
  if (marker.provider !== provider || marker.state !== 'unresolved' || marker.serviceId || marker.resourceName !== name
    || Object.keys(marker.providerScope).length !== 2 || marker.providerScope.projectId !== target.projectId
    || marker.providerScope.environmentId !== target.environmentId) throw new Error('incompatible_prior_attempt');
  return { marker: raw, digest: canonicalJsonSha256(raw) };
}
function core(intent: ServiceInstanceIntent): ServiceInstanceIntent {
  const { completed: _completed, ...value } = intent;
  return value;
}
function bindingFingerprint(source: Environment, serviceName: string): string {
  const bindings = parseHostingBindings(source);
  return canonicalJsonSha256({ localProjectId: source.projectId, localEnvironmentId: source.id,
    provider: bindings.provider, projectId: bindings.projectId, environmentId: bindings.environmentId,
    serviceId: bindings.services?.[serviceName]?.serviceId });
}
export function isServiceInstanceAction(action: PlanAction): boolean {
  const parsed = serviceInstanceActionSchema.safeParse(action.metadata);
  return parsed.success && action.resource.kind === 'service' && action.resource.provider === parsed.data.provider
    && action.id === `service:${action.resource.name}` && action.requiresConfirm === true
    && (parsed.data.operation === 'serviceInstanceCreate' ? action.type === 'create' : action.type === 'update');
}

/** Refine an existing service action; provider-native parents never come from names. */
export async function planServiceInstances(params: {
  project: Project; environment: Environment | null; actions: PlanAction[];
}): Promise<void> {
  const { project, environment, actions } = params;
  if (!environment) return;
  let retained: Record<string, ServiceInstanceIntent>;
  try { retained = pending(environment); }
  catch {
    for (const action of actions.filter(action => action.resource.kind === 'service')) { action.verified = false; action.metadata = { blockedReason: 'service_instance_intent_invalid' }; action.reason = 'Retained service instance intent is malformed; no resource mutation is authorized.'; }
    return;
  }
  for (const [name, intent] of Object.entries(retained)) {
    if (!actions.some(action => action.id === `service:${name}`)) actions.unshift({ id:`service:${name}`, type:'update',
      resource:{kind:'service',name,provider:intent.provider}, verified:false,requiresConfirm:true,
      reason:'Retained instance creation cannot be abandoned by removing its desired service.',
      metadata:{...intent,operation:'serviceInstanceFinalize',blockedReason:'service_instance_desired_removed'} });
  }
  const relevant = actions.filter(action => action.resource.kind === 'service' && action.id === `service:${action.resource.name}`
    && (!parseHostingBindings(environment).services?.[action.resource.name]?.serviceId || retained[action.resource.name]) && action.type !== 'destroy');
  if (!relevant.length) return;
  const result = await adapterFactory.getProviderAdapter(relevant[0].resource.provider, project);
  const driver = result.adapter?.serviceInstances;
  if (!driver) {
    if (Object.keys(retained).length) for (const action of relevant) {
      action.verified = false; action.metadata = { blockedReason: 'service_instance_driver_unavailable' };
      action.reason = 'The provider cannot reconcile retained service instance creation.';
    }
    return;
  }
  const siblings = new EnvironmentRepository().findByProjectId(project.id).filter(source => source.id !== environment.id);
  for (const action of relevant) {
    if (action.metadata?.blockedReason === 'service_instance_desired_removed') continue;
    const previous = retained[action.resource.name];
    if (previous) { action.type='update'; action.metadata={...previous,operation:'serviceInstanceFinalize'}; action.requiresConfirm=true; }
    const block = (code: string, reason: string) => { action.verified = false; action.reason = reason; action.metadata = { ...action.metadata, blockedReason: code }; };
    const rawPrior = parseHostingBindings(environment).serviceCreateRecovery?.[action.resource.name];
    if (!previous && !rawPrior && (action.type !== 'create' || action.metadata?.operation || action.metadata?.blockedReason)) continue;
    const candidates = siblings.flatMap(source => {
      const target = driver.resolveTarget(source, environment, action.resource.name);
      return target ? [{ source, target }] : [];
    });
    if (!previous && candidates.length === 0) continue; // Ordinary provider creation is unchanged.
    const parentIds = new Set(candidates.map(candidate=>canonicalJsonSha256({projectId:candidate.target.projectId,serviceId:candidate.target.serviceId,environmentId:candidate.target.environmentId})));
    if (parentIds.size !== 1) { block('service_instance_parent_ambiguous', 'One exact accepted parent service identity is required; names cannot authorize attachment.'); continue; }
    const { source, target } = candidates.find(candidate=>candidate.source.id===previous?.sourceEnvironmentLocalId)
      ?? candidates.sort((a,b)=>a.source.id.localeCompare(b.source.id))[0];
    let prior: ReturnType<typeof priorRecovery>;
    try { prior = priorRecovery(environment, action.resource.name, target, action.resource.provider); }
    catch { block('service_instance_prior_attempt_conflict','An incompatible earlier create attempt must remain blocked.'); continue; }
    const sourceBindingSha256 = bindingFingerprint(source, action.resource.name);
    if (previous && (previous.provider !== action.resource.provider || previous.sourceEnvironmentLocalId !== source.id
      || previous.sourceBindingSha256 !== sourceBindingSha256 || canonicalJsonSha256(previous.target) !== canonicalJsonSha256(target))) {
      block('service_instance_parent_changed', 'Retained instance creation belongs to a different parent or environment; no retry is authorized.'); continue;
    }
    let recoveryReview: z.infer<typeof serviceInstanceRecoveryReviewSchema> | undefined;
    try {
      if (previous && prior) {
        if (previous.completed || previous.recoveryApproval) throw new Error('new_recovery_after_completion');
        recoveryReview = serviceInstanceRecoveryReview(serviceInstanceHistory(environment.platformBindings.serviceInstanceCreateHistory), previous, action.resource.name, prior.digest);
      } else if (previous?.recoveryApproval) {
        if (!previous.completed) throw new Error('incomplete_recovery_receipt');
        recoveryReview = serviceInstanceRecoveryReviewSchema.parse({archiveId:previous.recoveryApproval.archiveId,activeMarkerSha256:previous.recoveryApproval.activeMarkerSha256});
        const receipts = serviceInstanceHistory(environment.platformBindings.serviceInstanceCreateHistory).filter(entry =>
          entry.record.disposition === 'operator-confirmed-unresolved-rearchive'
          && entry.record.serviceName === action.resource.name
          && canonicalJsonSha256(entry.record.target) === canonicalJsonSha256(target)
          && canonicalJsonSha256(entry.record.approval) === canonicalJsonSha256(previous.recoveryApproval));
        if (receipts.length !== 1 || previous.recoveryApproval.intentSha256 !== serviceInstanceIntentFingerprint(previous)) throw new Error('recovery_receipt_unverified');
      }
    } catch { block('service_instance_recovery_conflict', 'An active or completed recovery lacks exact private scope and approval evidence; ordinary finalization is blocked.'); continue; }
    if (previous && !previous.workflowId) { block('service_instance_acknowledgement_missing', 'The instance create acknowledgement was lost. Retained intent requires explicit recovery; no automatic retry or adoption.'); continue; }
    const live = await driver.observe(target, previous?.workflowId);
    if (live.state === 'unknown' || previous && live.state !== 'empty'
      || !previous && live.state !== 'absent' || previous && live.fingerprint !== previous.nativeFingerprint) {
      block('service_instance_state_unverified', previous
        ? 'Retained instance creation requires verified empty target and unchanged parent evidence; automatic retry is blocked.'
        : 'The target instance, native parent, or staged state cannot be proved safe for empty instance creation.'); continue;
    }
    const intent: ServiceInstanceIntent = { version: 1, provider: action.resource.provider, target,
      sourceEnvironmentLocalId: source.id, sourceBindingSha256, nativeFingerprint: live.fingerprint,
      ...(previous?.workflowId ? { workflowId: previous.workflowId } : {}),
      ...(previous?.priorCreateRecoverySha256 || prior ? { priorCreateRecoverySha256:previous?.priorCreateRecoverySha256 ?? prior!.digest } : {}),
      ...(previous?.completed ? {completed:true as const} : {}),
      ...(previous?.recoveryApproval ? {recoveryApproval:previous.recoveryApproval} : {}) };
    action.type = previous ? 'update' : 'create';
    action.verified = true; action.requiresConfirm = true;
    action.billable = !previous;
    action.reason = previous ? `Record the verified empty ${action.resource.name} instance in this environment; no provider mutation`
      : `Create only this environment's empty ${action.resource.name} instance under accepted service ${target.serviceId}; preserve other environments`;
    if (prior) action.reason += '. Preserve the earlier global create attempt as unresolved private history; this operation does not prove its outcome or authorize retry or cleanup';
    if (recoveryReview) action.reason = previous?.completed
      ? 'Finish exporting the exact approved instance recovery receipt; no provider mutation or additional archival'
      : 'With exact confirmation, preserve the CURRENT unresolved create marker as a new private uncertain-origin receipt and record the verified empty instance; no provider mutation, historical outcome claim, retry or cleanup';
    action.metadata = { operation: recoveryReview ? 'serviceInstanceFinalizeRecovery' : previous ? 'serviceInstanceFinalize' : 'serviceInstanceCreate',
      ...intent, ...(recoveryReview ? {recoveryReview} : {}) };
    // This operation creates no workload or database wiring. The inherited
    // ordinary-bootstrap database-create edge belongs to a later fresh plan.
    // Preserve namespace and every other safety prerequisite.
    action.dependsOn = action.dependsOn?.filter(id => !actions.some(dependency =>
      dependency.id === id && dependency.resource.kind === 'database' && dependency.type === 'create'
      && dependency.metadata?.operation === undefined));
  }
}

export async function applyServiceInstanceAction(params: {
  project: Project; environment: Environment; action: PlanAction;
  driver: IServiceInstances; confirmedActionIds: ReadonlySet<string>; specRevision: number; planId: string;
}): Promise<{ success: boolean; status?: 'blocked'; message: string }> {
  const { project, environment, action, driver } = params;
  const block = (message: string) => ({ success: false, status: 'blocked' as const, message });
  if (!isServiceInstanceAction(action) || !params.confirmedActionIds.has(action.id)) return block('Exact service instance action confirmation is required.');
  const { operation, recoveryReview, ...intent } = serviceInstanceActionSchema.parse(action.metadata);
  let retainedIntent = intent;
  const repo = new EnvironmentRepository();
  const persist = (current: Environment, bindings: Record<string, unknown>) => {
    if (!repo.replacePlatformBindingsIfUnchanged(current, bindings)) throw new Error('concurrent_binding_change');
  };
  const initialEnvironment = repo.findById(environment.id)!;
  const initialPending = pending(initialEnvironment)[action.resource.name];
  const approval = recoveryReview ? intent.recoveryApproval ?? { ...recoveryReview, planId:params.planId,
    actionId:action.id, intentSha256:serviceInstanceIntentFingerprint(intent) } : undefined;
  const matchingReceipt = (current: Environment) => {
    if (!approval || approval.intentSha256 !== serviceInstanceIntentFingerprint(intent)) return false;
    const records = serviceInstanceHistory(current.platformBindings.serviceInstanceCreateHistory).filter(entry =>
      entry.record.disposition === 'operator-confirmed-unresolved-rearchive'
      && entry.record.serviceName === action.resource.name
      && canonicalJsonSha256(entry.record.target) === canonicalJsonSha256(intent.target)
      && canonicalJsonSha256(entry.record.approval) === canonicalJsonSha256(approval));
    return records.length === 1;
  };
  let settledReplay = false;
  try { settledReplay = !initialPending && operation === 'serviceInstanceFinalizeRecovery' && matchingReceipt(initialEnvironment); }
  catch { return block('Private instance recovery approval could not be verified.'); }
  const withoutCompletion = (value: ServiceInstanceIntent) => {
    const { completed: _done, workflowId: _workflow, recoveryApproval: _approval, ...base } = value; return base;
  };
  const exportOnly = initialPending?.completed === true
    && canonicalJsonSha256(withoutCompletion(initialPending)) === canonicalJsonSha256(withoutCompletion(intent));
  if (exportOnly) retainedIntent = initialPending;
  if (operation !== 'serviceInstanceFinalizeRecovery' && initialPending?.recoveryApproval) return block('Ordinary finalization cannot reuse a recovery approval.');
  if (operation === 'serviceInstanceFinalizeRecovery' && (exportOnly || settledReplay)) {
    try {
      if (!matchingReceipt(initialEnvironment) || exportOnly && canonicalJsonSha256(initialPending.recoveryApproval) !== canonicalJsonSha256(approval))
        return block('Exact committed recovery approval is required.');
    } catch { return block('Private instance recovery approval could not be verified.'); }
  }
  const check = (expectedPending: boolean, reviewedRecovery = false) => {
    if (new SpecStore().getForInspection(project)?.revision !== params.specRevision) throw new Error('desired_state_changed');
    const current = repo.findById(environment.id), source = repo.findById(intent.sourceEnvironmentLocalId);
    if (!current || !source || current.projectId !== project.id || source.projectId !== project.id
      || bindingFingerprint(source, action.resource.name) !== intent.sourceBindingSha256
      || canonicalJsonSha256(driver.resolveTarget(source, current, action.resource.name)) !== canonicalJsonSha256(intent.target)) throw new Error('authority_changed');
    const retained = pending(current);
    if (expectedPending ? !retained[action.resource.name] || canonicalJsonSha256(core(retained[action.resource.name])) !== canonicalJsonSha256(core(retainedIntent))
      : retained[action.resource.name] !== undefined) throw new Error('intent_changed');
    const bound = parseHostingBindings(current).services?.[action.resource.name]?.serviceId;
    if (bound && !((retained[action.resource.name]?.completed || settledReplay) && bound === intent.target.serviceId)) throw new Error('bound_identity_changed');
    if (retained[action.resource.name]?.recoveryApproval && !matchingReceipt(current)) throw new Error('recovery_receipt_changed');
    const prior = priorRecovery(current, action.resource.name, intent.target, intent.provider);
    if (settledReplay) {
      if (prior || bound !== intent.target.serviceId || !matchingReceipt(current)) throw new Error('recovery_receipt_changed');
    } else if (reviewedRecovery) {
      if (!prior || !recoveryReview || !approval || retained[action.resource.name]?.completed) throw new Error('reviewed_recovery_missing');
      const fresh = serviceInstanceRecoveryReview(serviceInstanceHistory(current.platformBindings.serviceInstanceCreateHistory), retainedIntent, action.resource.name, prior.digest);
      if (canonicalJsonSha256(fresh) !== canonicalJsonSha256(recoveryReview)) throw new Error('reviewed_recovery_changed');
    } else if (expectedPending ? prior !== undefined : prior?.digest !== intent.priorCreateRecoverySha256) throw new Error('prior_attempt_changed');
    return { current, retained };
  };
  const finalize = () => getDb().transaction(() => {
    if (operation === 'serviceInstanceFinalizeRecovery' && !exportOnly) {
      const {current} = check(true, true);
      const prior = priorRecovery(current, action.resource.name, intent.target, intent.provider)!;
      const recoveries = {...parseHostingBindings(current).serviceCreateRecovery};
      delete recoveries[action.resource.name];
      const history = serviceInstanceHistory(current.platformBindings.serviceInstanceCreateHistory);
      persist(current, {...current.platformBindings, serviceCreateRecovery:recoveries,
        serviceInstanceCreateHistory:[...history.map(({record: _record, ...entry})=>entry), {id:randomUUID(),digest:prior.digest,
          recordEncrypted:getSecretStore().encryptObject({marker:prior.marker,target:intent.target,serviceName:action.resource.name,
            disposition:'operator-confirmed-unresolved-rearchive',approval})}]});
    }
    const { current, retained } = check(true);
    retainedIntent = { ...retainedIntent, completed:true, ...(approval ? {recoveryApproval:approval} : {}) };
    persist(current, { ...current.platformBindings, serviceInstanceCreates: { ...retained, [action.resource.name]:retainedIntent },
      services: { ...parseHostingBindings(current).services, [action.resource.name]: { serviceId: intent.target.serviceId } } });
  }).immediate();
  const exportAndFinish = () => {
    // Committed SQLite evidence survives a filesystem export failure. Export
    // omits completed intents, so clearing this local marker needs no second export.
    repo.syncRepoBindingsForId(environment.id);
    getDb().transaction(() => {
      const { current, retained } = check(true);
      if (!retained[action.resource.name]?.completed) throw new Error('not_completed');
      delete retained[action.resource.name];
      persist(current, { ...current.platformBindings, serviceInstanceCreates:retained });
    }).immediate();
  };
  try {
    check(!settledReplay && (exportOnly || operation !== 'serviceInstanceCreate'), operation === 'serviceInstanceFinalizeRecovery' && !exportOnly && !settledReplay);
    if (operation !== 'serviceInstanceCreate' && !intent.workflowId || operation === 'serviceInstanceCreate' && intent.workflowId) return block('Instance action has inconsistent workflow evidence.');
    const live = await driver.observe(intent.target, retainedIntent.workflowId);
    if (live.state === 'unknown' || live.fingerprint !== intent.nativeFingerprint
      || live.state !== (exportOnly || operation !== 'serviceInstanceCreate' ? 'empty' : 'absent')) return block('Fresh native instance evidence differs from the reviewed plan.');
    if (settledReplay) {
      check(false);
      repo.syncRepoBindingsForId(environment.id);
      check(false);
      return {success:true,message:'Exact approved instance recovery was already committed; export refreshed without provider mutations.'};
    }
    if (exportOnly || operation !== 'serviceInstanceCreate') {
      finalize();
      exportAndFinish();
      return { success: true, message: 'Verified empty environment instance recorded without provider mutations.' };
    }
    const receipt = await driver.create(intent.target, intent.nativeFingerprint, () => {
      getDb().transaction(() => {
        const { current, retained } = check(false);
        const bindings = { ...current.platformBindings, serviceInstanceCreates: { ...retained, [action.resource.name]: intent } };
        if (intent.priorCreateRecoverySha256) {
          const prior = priorRecovery(current, action.resource.name, intent.target, intent.provider)!;
          const history = current.platformBindings.serviceInstanceCreateHistory ?? [];
          if (!Array.isArray(history)) throw new Error('history_invalid');
          const recoveries = { ...parseHostingBindings(current).serviceCreateRecovery };
          delete recoveries[action.resource.name];
          Object.assign(bindings, { serviceCreateRecovery:recoveries, serviceInstanceCreateHistory:[...history, {
            id:randomUUID(), digest:prior.digest,
            recordEncrypted:getSecretStore().encryptObject({ marker:prior.marker, target:intent.target,
              disposition:'unresolved-not-retried', serviceName:action.resource.name }),
          }] });
        }
        persist(current, bindings);
      }).immediate();
    }, workflowId => {
      getDb().transaction(() => {
        // Save the acknowledgement even if desired state or source authority
        // changed in flight. It grants no finalization or further write authority.
        const current = repo.findById(environment.id);
        if (!current) throw new Error('environment_missing');
        const retained = pending(current);
        if (canonicalJsonSha256(retained[action.resource.name]) !== canonicalJsonSha256(intent)) throw new Error('intent_changed');
        retainedIntent = serviceInstanceIntentSchema.parse({ ...intent, workflowId });
        persist(current, { ...current.platformBindings, serviceInstanceCreates: { ...retained, [action.resource.name]: retainedIntent } });
      }).immediate();
    });
    if (!receipt.success) return block(receipt.mutationAttempted
      ? 'Instance creation remains pending. Re-plan for observation-only reconciliation; no automatic create, deploy or cleanup will run.'
      : 'Instance creation stopped before dispatch because its scope or authority changed.');
    const verified = await driver.observe(intent.target, retainedIntent.workflowId);
    if (verified.state !== 'empty' || verified.fingerprint !== intent.nativeFingerprint) return block('Instance post-verification failed; creation intent remains retained.');
    finalize();
    exportAndFinish();
    return { success: true, message: 'Empty target instance verified and bound. Source, credentials, storage and application deployment remain separate actions.' };
  } catch { return block('Instance state or local authority could not be verified. Retained intent is preserved; no automatic compensation is authorized.'); }
}
