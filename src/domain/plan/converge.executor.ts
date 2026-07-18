import { createHash } from 'crypto';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import type { Run, RunReceipt } from '../entities/run.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from './plan.types.js';
import type { DelegatedSecretInputRequirement } from '../services/delegated-secret.service.js';

/**
 * Converge executor: applies a previously persisted plan (terraform
 * `plan -out` style). hv_plan stores its actions as a run of type 'plan';
 * hv_apply hands the planId here, and we reject stale plans instead of
 * applying against a world that has moved.
 */

/** Document stored in runs.plan for type 'plan' runs. */
export interface PlanRunDocument {
  kind: 'hv_plan';
  environmentName: string;
  specRevision: number;
  /** Fingerprint of observed state at plan time; null when provider is unobservable. */
  observedFingerprint: string | null;
  actions: PlanAction[];
  unmanaged?: Array<{ kind: string; name: string; detail?: string }>;
  warnings?: string[];
  /** A plan with unresolved delegated inputs is inspectable but not executable. */
  inputRequired?: DelegatedSecretInputRequirement[];
  /**
   * One-off deploy overrides frozen into the plan (hv_plan services=/envVars=,
   * used by hv_deploy). envVar values are SecretStore-encrypted because
   * hv_runs returns this document verbatim; only the keys are readable.
   */
  overrides?: {
    services?: string[];
    envFilePath?: string;
    envFileKeys?: string[];
    envFileVarsEncrypted?: string;
    envVarKeys?: string[];
    envVarsEncrypted?: string;
    delegatedSecretKeys?: string[];
    delegatedSecretVarsEncrypted?: string;
  };
}

export interface ActionResult {
  success: boolean;
  status?: 'pending' | 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}

export type ActionHandler = (action: PlanAction) => Promise<ActionResult>;

export interface ConvergeParams {
  planRunId: string;
  /** Action ids (requiresConfirm) the caller explicitly confirmed. */
  confirmActions?: string[];
  /** Legacy alias for confirm-gated destroys; kept for backwards compatibility. */
  confirmDestroy?: string[];
  /** Latest spec revision for the project (from SpecStore). */
  currentSpecRevision: number;
  /**
   * Fingerprint of a fresh observation taken just before apply.
   * Pass null when the provider is unobservable; undefined skips the check.
   */
  freshObservedFingerprint?: string | null;
  /** Executes a single non-noop action. */
  handler: ActionHandler;
  /** Maximum plan age before it must be regenerated. Default 24h. */
  maxPlanAgeMs?: number;
}

export type ActionReceiptStatus =
  | 'succeeded'
  | 'failed'
  | 'pending'
  | 'blocked'
  | 'skipped_noop'
  | 'skipped_requires_confirm'
  | 'aborted';

export interface ActionReceipt {
  actionId: string;
  status: ActionReceiptStatus;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ConvergeResult {
  success: boolean;
  applyRunId?: string;
  error?: string;
  receipts: ActionReceipt[];
}

const DEFAULT_MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Stable fingerprint of observed state, ignoring volatile fields
 * (observedAt, warnings) so two observations of an unchanged world match.
 */
export function fingerprintObservedState(observed: ObservedState): string {
  const essence = {
    provider: observed.provider,
    projectExists: observed.projectExists,
    projectId: observed.projectId ?? null,
    environmentId: observed.environmentId ?? null,
    services: [...observed.services]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        externalId: s.externalId,
        workloadKind: s.workloadKind,
        customDomains: [...s.customDomains].sort(),
        config: s.config,
        source: s.source ?? null,
        envVarHashes: Object.fromEntries(Object.entries(s.envVarHashes).sort(([a], [b]) => a.localeCompare(b))),
      })),
    databases: [...observed.databases]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((d) => ({ provider: d.provider, engine: d.engine, externalId: d.externalId })),
    storage: [...(observed.storage ?? [])]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((item) => ({
        provider: item.provider,
        kind: item.kind,
        externalId: item.externalId,
        name: item.name,
        region: item.region ?? null,
        status: item.status,
        objectCount: item.objectCount ?? null,
        sizeBytes: item.sizeBytes ?? null,
      })),
  };
  return createHash('sha256').update(JSON.stringify(essence), 'utf8').digest('hex');
}

/** Topological order by dependsOn; throws on cycles or unknown dependencies. */
export function orderActions(actions: PlanAction[]): PlanAction[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const ordered: PlanAction[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (action: PlanAction) => {
    const mark = state.get(action.id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`Dependency cycle involving "${action.id}"`);
    }
    state.set(action.id, 'visiting');
    for (const dep of action.dependsOn ?? []) {
      const target = byId.get(dep);
      if (target) visit(target);
    }
    state.set(action.id, 'done');
    ordered.push(action);
  };

  for (const action of actions) visit(action);
  return ordered;
}

export class ConvergeExecutor {
  constructor(private runRepo = new RunRepository()) {}

  loadPlan(planRunId: string): { run: Run; document: PlanRunDocument } | { error: string } {
    const run = this.runRepo.findById(planRunId);
    if (!run) return { error: `Plan ${planRunId} not found. Run hv_plan first.` };
    const document = run.plan as unknown as PlanRunDocument;
    if (document?.kind !== 'hv_plan' || !Array.isArray(document.actions)) {
      return { error: `Run ${planRunId} is not an hv_plan run.` };
    }
    return { run, document };
  }

  async execute(params: ConvergeParams): Promise<ConvergeResult> {
    const loaded = this.loadPlan(params.planRunId);
    if ('error' in loaded) {
      return { success: false, error: loaded.error, receipts: [] };
    }
    const { run: planRun, document } = loaded;

    // --- staleness checks (terraform plan -out handshake) ---
    const maxAge = params.maxPlanAgeMs ?? DEFAULT_MAX_PLAN_AGE_MS;
    if (Date.now() - planRun.createdAt.getTime() > maxAge) {
      return {
        success: false,
        error: `Plan ${params.planRunId} is older than ${Math.round(maxAge / 3600000)}h. Re-run hv_plan.`,
        receipts: [],
      };
    }
    if (document.specRevision !== params.currentSpecRevision) {
      return {
        success: false,
        error: `Spec has changed since this plan (plan revision ${document.specRevision}, current ${params.currentSpecRevision}). Re-run hv_plan.`,
        receipts: [],
      };
    }
    if (params.freshObservedFingerprint !== undefined
      && document.observedFingerprint !== null
      && params.freshObservedFingerprint !== null
      && params.freshObservedFingerprint !== document.observedFingerprint) {
      return {
        success: false,
        error: 'Live infrastructure changed since this plan was created. Re-run hv_plan.',
        receipts: [],
      };
    }

    // Reject double-apply of the same plan.
    const priorApply = this.runRepo
      .findByEnvironmentId(planRun.environmentId, 50)
      .find((r) => r.type === 'apply'
        && (r.plan as Record<string, unknown>)?.planRunId === params.planRunId
        && r.status === 'succeeded');
    if (priorApply) {
      return {
        success: false,
        error: `Plan ${params.planRunId} was already applied (run ${priorApply.id}). Re-run hv_plan.`,
        receipts: [],
      };
    }

    const confirmed = new Set([...(params.confirmActions ?? []), ...(params.confirmDestroy ?? [])]);
    let ordered: PlanAction[];
    try {
      ordered = orderActions(document.actions);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), receipts: [] };
    }

    const applyRun = this.runRepo.create({
      projectId: planRun.projectId,
      environmentId: planRun.environmentId,
      type: 'apply',
      plan: { planRunId: params.planRunId, environmentName: document.environmentName, specRevision: document.specRevision },
    });
    this.runRepo.updateStatus(applyRun.id, 'running');

    const receipts: ActionReceipt[] = [];
    const completed = new Set<string>();
    let failed = false;
    let pending = false;
    let blocked = false;
    let firstError: string | undefined;

    for (const action of ordered) {
      if (failed) {
        receipts.push({ actionId: action.id, status: 'aborted', message: 'Skipped after earlier failure' });
        continue;
      }
      if (action.type === 'noop') {
        receipts.push({ actionId: action.id, status: 'skipped_noop' });
        completed.add(action.id);
        continue;
      }
      if (action.requiresConfirm && !confirmed.has(action.id)) {
        receipts.push({
          actionId: action.id,
          status: 'skipped_requires_confirm',
          message: `Requires explicit confirmation: pass confirmActions: ["${action.id}"]`,
        });
        continue;
      }
      // A dependency that was skipped (not completed) blocks dependents.
      const unmetDep = (action.dependsOn ?? []).find(
        (dep) => ordered.some((a) => a.id === dep) && !completed.has(dep)
      );
      if (unmetDep) {
        receipts.push({
          actionId: action.id,
          status: 'aborted',
          message: `Dependency "${unmetDep}" did not complete`,
        });
        continue;
      }

      const recordReceipt = (status: ActionReceiptStatus, message?: string, error?: string, data?: Record<string, unknown>) => {
        receipts.push({ actionId: action.id, status, message, error, data });
        this.runRepo.addReceipt(applyRun.id, {
          step: action.id,
          status: status === 'succeeded'
            ? 'success'
            : status === 'failed'
              ? 'failure'
              : status === 'pending'
                ? 'pending'
                : status === 'blocked'
                  ? 'blocked'
                  : 'skipped',
          error,
          result: message || data ? { ...(message ? { message } : {}), ...(data ?? {}) } : undefined,
          timestamp: new Date().toISOString(),
        } as RunReceipt);
      };

      try {
        const result = await params.handler(action);
        if (result.status === 'pending') {
          pending = true;
          recordReceipt('pending', result.message, result.error, result.data);
        } else if (result.status === 'blocked') {
          blocked = true;
          recordReceipt('blocked', result.message, result.error, result.data);
        } else if (result.success) {
          completed.add(action.id);
          recordReceipt('succeeded', result.message, undefined, result.data);
        } else {
          failed = true;
          firstError = result.error ?? result.message;
          recordReceipt('failed', result.message, result.error, result.data);
        }
      } catch (error) {
        failed = true;
        firstError = error instanceof Error ? error.message : String(error);
        recordReceipt('failed', undefined, firstError);
      }
    }

    const runStatus = failed ? 'failed' : blocked ? 'blocked' : pending ? 'pending' : 'succeeded';
    this.runRepo.updateStatus(applyRun.id, runStatus, firstError);
    return {
      success: !failed && !pending && !blocked,
      applyRunId: applyRun.id,
      ...(firstError ? { error: firstError } : {}),
      receipts,
    };
  }
}
