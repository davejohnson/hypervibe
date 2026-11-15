import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureEngineBinary, enginePluginCacheDir } from '../../adapters/engine/opentofu/install.js';
import { OpenTofuEngine, type EnginePlanResult } from '../../adapters/engine/opentofu/engine.js';
import { engineStatePaths, ensureEngineStateDirectories } from '../../adapters/engine/opentofu/workspace.js';
import { gcpSetupBackend } from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { EngineAuthentication, EngineConfiguration, EngineStateIdentity } from '../ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../ports/infrastructure-engine.port.js';
import type { PlanAction } from '../plan/plan.types.js';

export interface GcpProjectSetupContribution { id: string; configuration: EngineConfiguration }
export interface GcpProjectSetupParams {
  projectId: string;
  gcpProjectId: string;
  auth: EngineAuthentication;
  /** Stable, non-secret identity of the account granting this access. */
  authenticationScope?: string;
  contribution: GcpProjectSetupContribution;
  confirm?: boolean;
  dataDir?: string;
  /** Explicitly reviewed removals/imports; never inferred from engine output. */
  allowDestroyAddresses?: string[];
  allowImportAddresses?: string[];
  /** Fresh provider observations proved these resources exist; creation cannot repair missing state. */
  existingResourceAddresses?: string[];
}
export interface GcpProjectSetupResult {
  success: boolean;
  mode: 'preview' | 'confirm';
  planId?: string;
  actions?: PlanAction[];
  error?: string;
}
interface SetupManifest { contributions: Record<string, EngineConfiguration> }
interface SetupPreview {
  planId: string; baseline: string; intent: string; planned: EnginePlanResult;
  manifest: SetupManifest; configuration: EngineConfiguration;
}
export interface GcpProjectSetupDependencies {
  engine: Pick<OpenTofuEngine, 'plan' | 'apply'>;
}
export function hasGcpProjectSetup(projectId: string, gcpProjectId: string, dataDir?: string): boolean {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return fs.existsSync(path.join(paths.root, 'setup-manifest.json'));
}
export function getGcpProjectSetupContribution(projectId: string, gcpProjectId: string, id: string, dataDir?: string): EngineConfiguration | undefined {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return readJson<SetupManifest>(path.join(paths.root, 'setup-manifest.json'), { contributions: {} }).contributions[id];
}
export function getGcpProjectSetupContributions(projectId: string, gcpProjectId: string, dataDir?: string): Record<string, EngineConfiguration> {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return readJson<SetupManifest>(path.join(paths.root, 'setup-manifest.json'), { contributions: {} }).contributions;
}
function digest(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : entry;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function mergeValue(left: unknown, right: unknown, location: string): unknown {
  if (left === undefined || digest(left) === digest(right)) return right;
  if (location.endsWith('.depends_on') && Array.isArray(left) && Array.isArray(right)) return [...new Set([...left, ...right])].sort();
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const result = { ...left } as Record<string, unknown>;
    for (const [key, value] of Object.entries(right)) result[key] = mergeValue(result[key], value, `${location}.${key}`);
    return result;
  }
  throw new Error(`Project setup contributions disagree at ${location}; preview an explicit shared configuration change.`);
}
/** Compose all retained project ownership before planning any new access. */
export function composeGcpProjectConfiguration(contributions: Record<string, EngineConfiguration>): EngineConfiguration {
  const merged: EngineConfiguration = { files: {}, resources: {}, imports: {} };
  for (const configuration of Object.values(contributions)) {
    for (const [file, document] of Object.entries(configuration.files)) {
      merged.files[file] = mergeValue(merged.files[file], document, file);
    }
    for (const [address, mapping] of Object.entries(configuration.resources)) {
      merged.resources[address] = mergeValue(merged.resources[address], mapping, address) as typeof mapping;
    }
    Object.assign(merged.imports!, configuration.imports ?? {});
  }
  if (Object.keys(merged.imports!).length) merged.files['setup-imports.tf.json'] = {
    import: Object.entries(merged.imports!).map(([to, id]) => ({ to, id })),
  };
  return merged;
}

/**
 * One durable, encrypted OpenTofu state owns all setup for a Google project.
 * Preview persists the complete saved plan. Confirmation never re-plans or
 * extends approval to drift in a previously approved contribution.
 */
export async function runGcpProjectSetup(params: GcpProjectSetupParams, overrides?: GcpProjectSetupDependencies): Promise<GcpProjectSetupResult> {
  const mode = params.confirm ? 'confirm' : 'preview';
  const fail = (error: string): GcpProjectSetupResult => ({ success: false, mode, error });
  const state: EngineStateIdentity = { provider: 'gcp', projectId: params.projectId, environmentId: params.gcpProjectId, partition: 'project-shared' };
  const paths = engineStatePaths(state, params.dataDir);
  ensureEngineStateDirectories(paths);
  // SQLite's OS-backed exclusive lock is released if this process exits. An
  // abandoned marker file can never permanently block setup. The engine still
  // takes its own native state lock while planning/applying.
  const lockFile = path.join(paths.root, 'setup-lock.sqlite');
  let lock: Database.Database | undefined;
  try {
    fs.closeSync(fs.openSync(lockFile, 'a', 0o600));
    lock = new Database(lockFile, { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
    lock.exec('CREATE TABLE IF NOT EXISTS setup_mutex (id INTEGER PRIMARY KEY)');
  } catch (error) {
    lock?.close();
    const busy = (error as { code?: string }).code === 'SQLITE_BUSY';
    return fail(busy ? 'Another project setup is running. Wait for it to finish, then preview again.'
      : 'The project setup lock could not be verified. Restore the local setup-lock.sqlite file before retrying.');
  }
  try {
    const manifestFile = path.join(paths.root, 'setup-manifest.json');
    const existing = readJson<SetupManifest>(manifestFile, { contributions: {} });
    const manifest = { contributions: { ...existing.contributions, [params.contribution.id]: params.contribution.configuration } };
    const configuration = composeGcpProjectConfiguration(manifest.contributions);
    // Retain deleted address mappings, so a specifically approved removal is representable.
    const previous = existing.contributions[params.contribution.id];
    Object.assign(configuration.resources, previous?.resources, params.contribution.configuration.resources);
    const intent = digest({ gcpProjectId: params.gcpProjectId, contribution: params.contribution,
      authenticationScope: params.authenticationScope ?? 'google-project-admin',
      destroy: params.allowDestroyAddresses ?? [], imports: params.allowImportAddresses ?? [], existing: params.existingResourceAddresses ?? [] });
    const previewFile = path.join(paths.plans, `setup-${intent}.json`);
    let saved: SetupPreview;
    if (params.confirm) {
      const preview = readJson<SetupPreview | undefined>(previewFile, undefined);
      if (!preview) return fail('Preview this exact Google Cloud setup before confirming it. No infrastructure was changed.');
      if (preview.intent !== intent || preview.baseline !== digest(existing) || digest(preview.configuration) !== digest(configuration)) {
        return fail('Google Cloud setup changed since preview. Preview the current setup again before confirming.');
      }
      saved = preview;
    } else {
      saved = { planId: `setup-${randomUUID()}`, intent, baseline: digest(existing), manifest, configuration, planned: undefined as unknown as EnginePlanResult };
    }
    let engine = overrides?.engine;
    if (!engine) {
      const binary = await ensureEngineBinary();
      if (!binary.ok) return fail(binary.error);
      engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), dataDir: params.dataDir });
    }
    if (!params.confirm) {
      const planned = await engine.plan({ backend: gcpSetupBackend, configuration, auth: params.auth, state, planId: saved.planId });
      if (!planned.ok) return fail(planned.error);
      const allowed = new Set([...Object.keys(params.contribution.configuration.resources), ...Object.keys(previous?.resources ?? {})]);
      const destroy = new Set(params.allowDestroyAddresses ?? []);
      const imports = new Set(params.allowImportAddresses ?? []);
      const observedPresent = new Set(params.existingResourceAddresses ?? []);
      const unexpected = planned.actions.filter((action) => action.type !== 'noop').find((action) => {
        const addresses = engineSegmentOf(action)?.addresses ?? [];
        return addresses.some((address) => !allowed.has(address)) || action.type === 'replace'
          || (action.type === 'create' && addresses.some((address) => observedPresent.has(address)))
          || (action.type === 'destroy' && addresses.some((address) => !destroy.has(address)))
          || (action.metadata?.engineAdopt === true && addresses.some((address) => !imports.has(address)));
      });
      if (planned.blockers.length || unexpected) return fail(planned.blockers.join(' ') || 'The setup plan changes resources outside this approval. Review the affected project setup separately.');
      saved.planned = planned;
      writeJson(previewFile, saved);
      return { success: true, mode, planId: saved.planId, actions: planned.actions };
    }
    const addresses = saved.planned.actions.filter((action) => action.type !== 'noop').flatMap((action) => engineSegmentOf(action)?.addresses ?? []);
    if (addresses.length > 0) {
      // Keep approved intent after a partial apply so retry cannot orphan completed resources.
      writeJson(manifestFile, saved.manifest);
      const applied = await engine.apply({ backend: gcpSetupBackend, auth: params.auth, state, planId: saved.planId,
        segment: { ...saved.planned.segment, addresses }, approvedAddresses: addresses });
      if (addresses.some((address) => applied.outcomes[address] !== 'succeeded')) {
        return fail(applied.diagnostics.join(' ') || 'Project setup has not converged. Preview again to inspect the remaining work.');
      }
    } else writeJson(manifestFile, saved.manifest);
    fs.unlinkSync(previewFile);
    return { success: true, mode, planId: saved.planId, actions: saved.planned.actions };
  } catch (error) {
    // Engine errors are already sanitized. Do not echo arbitrary admin input/configuration.
    let message = error instanceof Error ? error.message : 'Project setup failed.';
    for (const secret of params.auth.redact) if (secret) message = message.split(secret).join('[REDACTED]');
    return fail(message);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
}
