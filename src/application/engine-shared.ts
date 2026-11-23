import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { requiresActionConfirmation, type PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import type { InfrastructurePlanResult } from './infrastructure-engine.js';

/** Helpers every cloud engine uses. Add shared engine behavior here, not to one cloud's module. */

/** A spec patch removing an environment, including from the secrets that target it (a secret targeting only it goes too). */
export function specWithoutEnvironment(spec: ProjectSpec, environmentName: string): Record<string, unknown> {
  const secrets = Object.fromEntries(Object.entries(spec.secrets)
    .filter(([, secret]) => (secret.environments as string[] | undefined)?.includes(environmentName))
    .map(([key, secret]) => {
      const remaining = (secret.environments as string[]).filter((name) => name !== environmentName);
      return [key, remaining.length ? { environments: remaining } : null];
    }));
  // A setting that names the removed environment as the project's main one would fail validation; without it the default applies.
  const main = (['devops', 'github'] as const).filter((key) => spec[key]?.canonicalEnvironment === environmentName)
    .map((key) => [key, { canonicalEnvironment: null }]);
  return { environments: { [environmentName]: null }, ...(Object.keys(secrets).length ? { secrets } : {}), ...Object.fromEntries(main) };
}

export function describeFixedWorkerCountChanges(actions: PlanAction[], environment: EnvironmentSpec, countField: string): void {
  for (const action of actions) {
    const worker = environment.services[action.resource.name];
    if (action.type === 'update' && worker?.workloadKind === 'worker' && !worker.onDemand
      && action.diff?.some(change => change.field === countField)) {
      const effect = worker.workerPaused ? 'pause this worker by setting its instance count to zero' : 'run one instance of this worker';
      action.reason = `Hypervibe will ${effect}. ${action.reason}`;
    }
  }
}

/** Plan scope shared by every engine's infrastructure and release plans. */
export const ENGINE_PLAN_SCOPE = 'infrastructure-engine';

/** The pinned OpenTofu engine with Hypervibe's state cipher and private plugin cache. */
export async function openTofuEngine(options: { timeoutMs?: number } = {}): Promise<OpenTofuEngine | { blocked: string }> {
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { blocked: binary.error };
  return new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
}

/** A plan stops on missing outside keys with the one command that collects them all. */
export function missingOutsideKeysMessage(environmentName: string, keys: string[]): string {
  return `${environmentName} needs ${keys.length === 1 ? 'a key' : `${keys.length} keys`} Hypervibe cannot create: ${keys.join(', ')}. `
    + `Run hv_secrets action="collect" env="${environmentName}" to add ${keys.length === 1 ? 'it' : 'them all'} on one local page (hv_launch does this itself), then plan again.`;
}

/**
 * Plans an environment's secrets the same way on every cloud. Outside keys must
 * already have a value, because Hypervibe never invents them; generated keys get a
 * create action when absent. An unknown read blocks the plan: it is never treated
 * as absence.
 */
export async function planEngineSecrets(params: {
  environmentName: string;
  generated: string[];
  outside: string[];
  /** Outside keys the spec declares required: false. Without a value they never block; they are returned in unset so workloads leave them out. */
  optional?: string[];
  observe: (key: string) => Promise<'present' | 'absent' | { unknown: string }>;
  action: (key: string, stored: boolean) => PlanAction;
}): Promise<{ actions: PlanAction[]; unset?: string[] } | { blocked: string[]; missingOutsideKeys?: string[] }> {
  const missing: string[] = [];
  const unset: string[] = [];
  for (const key of params.outside) {
    const observed = await params.observe(key);
    if (typeof observed === 'object') return { blocked: [observed.unknown] };
    if (observed === 'absent') (params.optional?.includes(key) ? unset : missing).push(key);
  }
  if (missing.length) return { blocked: [missingOutsideKeysMessage(params.environmentName, missing)], missingOutsideKeys: missing };
  const actions: PlanAction[] = [];
  for (const key of params.generated) {
    const observed = await params.observe(key);
    if (typeof observed === 'object') return { blocked: [observed.unknown] };
    actions.push(params.action(key, observed === 'present'));
  }
  return { actions, ...(unset.length ? { unset } : {}) };
}

/**
 * Saves a reviewed engine plan and returns what the caller shows. Actions that
 * are billable, data-bearing or flagged need exact confirmation; a teardown
 * confirms every action.
 */
export function recordEnginePlan(params: {
  projectId: string; environmentId: string; environmentName: string; specRevision: number;
  actions: PlanAction[]; warnings: string[];
  /** Engine-specific plan identity: plan id, state, and the cloud's own target. */
  engine: Record<string, unknown>;
  confirm?: 'consequential' | 'all';
}): InfrastructurePlanResult {
  const { environmentName, specRevision, actions, warnings } = params;
  const confirmActions = (params.confirm === 'all' ? actions : actions.filter(requiresActionConfirmation)).map(action => action.id);
  const runRepo = new RunRepository();
  const run = runRepo.create({ projectId: params.projectId, environmentId: params.environmentId, type: 'plan', plan: {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName, specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings, engine: params.engine, reviewConfirmActions: confirmActions,
  } as unknown as Record<string, unknown> });
  runRepo.updateStatus(run.id, 'succeeded');
  return {
    planRunId: run.id, environmentName, specRevision, actions, warnings,
    confirmActions,
  };
}
