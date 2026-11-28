import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import fs from 'node:fs';
import path from 'node:path';
import { engineStatePaths } from '../adapters/engine/opentofu/workspace.js';
import type { EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { storageEngineKey } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { awsKey } from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { requiresActionConfirmation, type PlanAction } from '../domain/plan/plan.types.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { removeReleaseWorkflow } from './infrastructure-engine-ci.js';
import { localRepositoryFor } from './local-repository.js';
import type { InfrastructurePlanResult } from './infrastructure-engine.js';

/** Helpers every cloud engine uses. Add shared engine behavior here, not to one cloud's module. */

export function retainedFileBackupWarning(state: EngineStateIdentity, spec: EnvironmentSpec): string[] {
  const projectRoot = path.dirname(path.dirname(engineStatePaths(state).root));
  const statePrefix = state.environmentId + '-bk-';
  const retained = fs.existsSync(projectRoot) && fs.readdirSync(projectRoot, { withFileTypes: true }).some(entry =>
    entry.isDirectory() && entry.name.startsWith(statePrefix) && fs.existsSync(path.join(projectRoot, entry.name, 'environment', 'terraform.tfstate')));
  if (!retained && !Object.values(spec.storage ?? {}).some(bucket => bucket.automatedBackups)) return [];
  return ['This teardown keeps any daily file backup archive and its separate scheduled job. Archive storage and daily job attempts can continue to incur charges after the source is removed.'];
}

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

/**
 * The last step of every cloud's teardown: removes the environment from the spec, so the next plan does not recreate
 * it, and deletes its release workflow from the local repository. Returns a sentence about the workflow, or ''.
 */
export function forgetTornDownEnvironment(project: Project, spec: ProjectSpec, environmentName: string): string {
  const saved = new SpecStore().merge(project, specWithoutEnvironment(spec, environmentName));
  let root: string | undefined;
  // The same check launch makes before writing the workflow: this checkout must be the project's own repository.
  try { root = localRepositoryFor(project, saved?.source); } catch {
    return ` Hypervibe could not confirm this folder is the project's repository, so it did not look for ${environmentName}'s release workflow. Delete .github/workflows/hypervibe-release-${environmentName}.yml from the project's repository if it exists.`;
  }
  return root ? removeReleaseWorkflow(root, environmentName) : '';
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

/** Plain-language review text for storage auto-tiering. Costs are described, never quoted: the clouds change their rates. */
export const storageAutoTieringNotes = {
  gcp: {
    onExisting: 'Hypervibe will turn on automatic storage tiering (Google Cloud Storage Autoclass) for this existing bucket in place: the bucket and its files are not recreated, moved or deleted.',
    onNew: 'This bucket uses automatic storage tiering (Google Cloud Storage Autoclass).',
    effect: 'Files of 128 KiB or more that are not read for 30 days move to cheaper Nearline storage and return to Standard storage when read; smaller files stay in Standard. '
      + 'Files stay instantly readable, and Google charges no retrieval or early-deletion fees while tiering is on. '
      + 'In exchange Google charges a monthly Autoclass management fee, and a one-time enablement charge when tiering is turned on for a bucket that already holds files. '
      + 'Versioning and the 30-day cleanup of replaced files are unchanged.',
    off: 'Hypervibe will turn off automatic storage tiering (Autoclass) for this bucket. Nothing is deleted or moved: each file stays in the storage class it has now. '
      + 'Files left in Nearline are then billed at Google\'s ordinary Nearline rates, which add a fee for reading them and for deleting them within 30 days. '
      + 'The management fee stops, and tiering cannot be turned back on for one day.',
  },
  aws: {
    on: 'Automatic storage tiering: files of 128 KB or more in this bucket move to S3 Intelligent-Tiering, which shifts each file to cheaper tiers after 30 and 90 days without being read, and back when it is read. '
      + 'Files stay instantly readable and AWS charges no retrieval fee. In exchange AWS charges a small monthly monitoring fee for each file, and a one-time request charge to move existing files. '
      + 'Smaller files stay as they are. The bucket and its files are not recreated or deleted.',
    off: 'Hypervibe will stop moving files to S3 Intelligent-Tiering. Files already moved stay there, instantly readable and still charged the monitoring fee, until they are replaced or deleted. Nothing is deleted or moved back.',
  },
} as const;

/**
 * Explains, on the storage action that changes it, what turning auto-tiering on or off does and costs, and
 * makes that action need its own approval. Plans that leave tiering alone are untouched, and a replacement
 * is never described as a tiering change.
 */
export function describeStorageAutoTieringChanges(actions: PlanAction[], environment: EnvironmentSpec, cloud: 'gcp' | 'aws'): void {
  for (const action of actions) {
    const storage = action.resource.kind === 'storage' ? environment.storage?.[action.resource.name] : undefined;
    if (!storage || action.type === 'noop' || action.type === 'replace') continue;
    const changing: string[] = (action.metadata?.engineSegment as { addresses?: string[] } | undefined)?.addresses ?? [];
    const fields = (action.diff ?? []).map(change => change.field);
    let note: string | undefined;
    if (cloud === 'gcp') {
      const address = `google_storage_bucket.${storageEngineKey(action.resource.name)}`;
      if (fields.some(field => field.startsWith('google_storage_bucket.autoclass'))) {
        note = storage.autoTiering ? `${storageAutoTieringNotes.gcp.onExisting} ${storageAutoTieringNotes.gcp.effect}` : storageAutoTieringNotes.gcp.off;
      } else if (storage.autoTiering && changing.includes(address) && !fields.some(field => field.startsWith('google_storage_bucket.'))) {
        // The bucket itself is created or adopted with the setting.
        note = `${storageAutoTieringNotes.gcp.onNew} ${storageAutoTieringNotes.gcp.effect}`;
      }
    } else {
      const key = awsKey(action.resource.name);
      const lifecycle = `aws_s3_bucket_lifecycle_configuration.${key}`;
      const ruleChanged = fields.some(field => field.startsWith('aws_s3_bucket_lifecycle_configuration.rule.0.transition'));
      // Without a field list the bucket's one lifecycle configuration is itself created or deleted.
      const whole = changing.includes(lifecycle) && !fields.some(field => field.startsWith('aws_s3_bucket_lifecycle_configuration.'));
      if (storage.autoTiering && (ruleChanged || (whole && action.type !== 'destroy'))) note = storageAutoTieringNotes.aws.on;
      // A configuration deleted while versioning stays as it was existed only for tiering.
      else if (!storage.autoTiering && (ruleChanged || (whole && action.type === 'destroy' && !storage.versioning
        && !changing.includes(`aws_s3_bucket_versioning.${key}`) && !changing.includes(`aws_s3_bucket.${key}`)))) note = storageAutoTieringNotes.aws.off;
    }
    if (!note) continue;
    action.reason = `${note} ${action.reason}`;
    // Tiering changes what the cloud bills for these files, so turning it on or off is approved by itself.
    action.requiresConfirm = true;
    if (storage.autoTiering) action.billable = true;
  }
}

/** Plan scope shared by every engine's infrastructure and release plans. */
export const ENGINE_PLAN_SCOPE = 'infrastructure-engine';

/** The pinned OpenTofu engine with Hypervibe's state cipher and private plugin cache. */
export async function openTofuEngine(options: { timeoutMs?: number } = {}): Promise<OpenTofuEngine | { blocked: string }> {
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { blocked: binary.error };
  return new OpenTofuEngine({ appliedDeclarations: (state, scope, addresses) => new RunRepository().appliedEngineDeclarations(state, scope, addresses),
    binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
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
  scope?: 'bucket-backups';
  confirm?: 'consequential' | 'all';
}): InfrastructurePlanResult {
  const { environmentName, specRevision, actions, warnings } = params;
  const confirmActions = (params.confirm === 'all' ? actions : actions.filter(requiresActionConfirmation)).map(action => action.id);
  const runRepo = new RunRepository();
  const run = runRepo.create({ projectId: params.projectId, environmentId: params.environmentId, type: 'plan', plan: {
    kind: 'hv_plan', scope: params.scope ?? ENGINE_PLAN_SCOPE, environmentName, specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings, engine: params.engine, reviewConfirmActions: confirmActions,
  } as unknown as Record<string, unknown> });
  runRepo.updateStatus(run.id, 'succeeded');
  return {
    planRunId: run.id, environmentName, specRevision, actions, warnings,
    confirmActions,
  };
}
