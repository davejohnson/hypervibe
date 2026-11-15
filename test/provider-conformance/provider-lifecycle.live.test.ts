import { describe, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertFixtureContinuation, assertFixtureLifecycleConsent, fixturePreview, readFixtureTarget, verifiedGcpFixtureCredentials, type FixturePreview } from './fixture-authorization.js';
import Database from 'better-sqlite3';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { gcpEngineBackend } from '../../src/adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { ensureEngineBinary } from '../../src/adapters/engine/opentofu/install.js';
import { runTofu } from '../../src/adapters/engine/opentofu/runner.js';
import { encryptionEnvironment, engineStatePaths, loadOrCreateStatePassphrase, materializeWorkingDirectory } from '../../src/adapters/engine/opentofu/workspace.js';
import { getSecretStore, SecretStore } from '../../src/adapters/secrets/secret-store.js';
import { assertFixtureHttpResponse, readFixtureJournal, resourceKey, runDisposableFixture, saveFixtureJournal, type FixtureJournal, type NativeFixtureResource } from './lifecycle-live-harness.js';
import { observeGcpFixtureResource, plannedGcpServiceIdentities, projectGcpFixtureState, gcpFixtureConfigurationScope, assertGcpFixtureContinuationScope, assertGcpFixtureInventoryScope, type GcpFixtureResourceScope } from './fixture-native-inventory.js';
import { selectLiveFixtureProfile } from './live-fixture-profiles.js';

type Json = Record<string, any>;
const selected = process.env.HYPERVIBE_LIVE_PROFILE?.trim() || process.env.HYPERVIBE_LIVE_HOSTING?.trim() || process.env.HYPERVIBE_LIVE_DATABASE?.trim() || process.env.HYPERVIBE_LIVE_CACHE?.trim();
const live = selected ? describe : describe.skip;
const cliPath = path.resolve(import.meta.dirname, '../../dist/index.js');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Selected live fixture requires ${name}. No live result can be claimed without configured test access.`);
  return value;
}

async function processOutput(executable: string, args: string[], cwd: string, dataDir: string, input?: Json): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, HYPERVIBE_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000);
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill('SIGTERM'); else stdout += chunk; });
    child.stderr.resume(); // Provider diagnostics can echo secrets. Do not persist or print them.
    child.once('error', () => { clearTimeout(timer); reject(new Error('The fixture command could not start.')); });
    child.once('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Fixture command ${args[0]} failed or was interrupted; preserve the encrypted state.`)); else resolve(stdout); });
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

/** Installed CLI; no provider writes or engine apply commands occur in this harness. */
live('GCP engine disposable environment fixture', () => {
  it(process.env.HYPERVIBE_LIVE_CLEANUP_ONLY === '1' ? 'resumes exact native cleanup without claiming full lifecycle proof'
    : process.env.HYPERVIBE_LIVE_MODE !== 'run' ? 'saves a preview without applying or claiming live lifecycle proof'
    : 'creates, serves exact revisions, noops, updates, and proves every native resource absent', async () => {
    const profile = selectLiveFixtureProfile(selected === 'cloudrun' ? 'gcp-engine' : selected!);
    if (profile.path !== 'engine') throw new Error(`Use ${profile.runner} through its documented managed fixture command for ${profile.id}.`);
    const workspace = required('HYPERVIBE_LIVE_FIXTURE_DIR');
    const dataDir = required('HYPERVIBE_LIVE_DATA_DIR');
    const projectName = required('HYPERVIBE_LIVE_PROJECT');
    const markerFile = required('HYPERVIBE_LIVE_FIXTURE_MARKER');
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    const gcpProjectId = process.env.HYPERVIBE_TEST_GCP_PROJECT_ID?.trim() || marker.nativeProjectId;
    const region = process.env.HYPERVIBE_TEST_GCP_REGION?.trim() || marker.region;
    const runtimeServiceAccountEmail = marker.runtimeServiceAccountEmail;
    if (![gcpProjectId, region, runtimeServiceAccountEmail].every((value) => typeof value === 'string' && value)) throw new Error('The GCP fixture marker must specify its exact native project, region and runtime service account.');
    if (!path.isAbsolute(workspace) || !path.isAbsolute(dataDir) || workspace === dataDir) {
      throw new Error('Use separate absolute fixture/state directories and an explicitly marked dedicated test project.');
    }
    if (!existsSync(cliPath)) throw new Error('Build the installed CLI with npm run build before selecting live tests.');
    const databaseFile = path.join(dataDir, 'hypervibe.db');
    if (!existsSync(databaseFile)) throw new Error('The dedicated GCP test project must already be prepared through Hypervibe in HYPERVIBE_LIVE_DATA_DIR.');
    const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
    const project = db.prepare('SELECT id, git_remote_url FROM projects WHERE name = ?').get(projectName) as { id: string; git_remote_url?: string } | undefined;
    if (!project?.git_remote_url || !/github\.com[/:][^/]+\/[^/]+/.test(project.git_remote_url)) { db.close(); throw new Error('The prepared test project needs its dedicated repository identity and verified scoped Cloud Run connection.'); }
    const repository = project.git_remote_url.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '').replace(/\/$/, '');
    readFixtureTarget(markerFile, { profile: profile.id, project: projectName, internalProjectId: project.id, nativeProjectId: gcpProjectId, repository, region, runtimeServiceAccountEmail });
    const journalFile = path.join(workspace, 'fixture-evidence.json');
    const previewFile = path.join(workspace, 'fixture-plan.json');
    const mode = process.env.HYPERVIBE_LIVE_MODE ?? 'preview';
    if (!['preview', 'run'].includes(mode)) throw new Error('HYPERVIBE_LIVE_MODE must be preview or run.');
    const cleanupOnly = process.env.HYPERVIBE_LIVE_CLEANUP_ONLY === '1';
    if (existsSync(workspace) && !existsSync(journalFile)) { db.close(); throw new Error('The new fixture directory must not already exist. This protects unrelated checkout contents.'); }
    if (cleanupOnly && !existsSync(journalFile)) { db.close(); throw new Error('Cleanup-only requires the existing fixture journal.'); }
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const existingJournal = existsSync(journalFile) ? readFixtureJournal(journalFile) : undefined;
    const environmentName = existingJournal?.environment ?? `fixture-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const journal: FixtureJournal = existingJournal ?? {
      version: 1, profile: profile.id, project: projectName, environment: environmentName, phase: 'prepared', resources: [],
      checks: { created: false, noop: false, updated: false, absent: false },
    };
    if (journal.profile !== profile.id || journal.project !== projectName || journal.environment !== environmentName) { db.close(); throw new Error('The fixture journal identifies a different target.'); }
    const save = (value: FixtureJournal) => saveFixtureJournal(journalFile, value);
    save(journal);
    const cli = async (command: string[], input: Json): Promise<Json> => {
      let envelope: Json;
      try { envelope = JSON.parse(await processOutput(process.execPath, [cliPath, ...command, '--input', '-', '--json'], workspace, dataDir, input)); }
      catch { throw new Error(`Hypervibe ${command.join(' ')} failed; fixture recovery state was preserved.`); }
      if (envelope.ok !== true) throw new Error(`Hypervibe ${command.join(' ')} did not succeed (${envelope.error?.code ?? 'unknown'}).`);
      return envelope;
    };
    if (!existsSync(path.join(workspace, '.git'))) {
      cpSync(path.join(import.meta.dirname, 'fixture'), workspace, { recursive: true });
      writeFileSync(path.join(workspace, '.gitignore'), '.hypervibe/\nfixture-evidence.json\nfixture-plan.json\n.credentials.json\n');
      for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Hypervibe fixture'], ['config', 'user.email', 'fixture@hypervibe.invalid'], ['remote', 'add', 'origin', project.git_remote_url], ['add', 'Dockerfile', 'package.json', 'server.mjs', '.gitignore'], ['commit', '-m', 'Disposable provider conformance fixture']]) {
        await processOutput('git', args, workspace, dataDir);
      }
    }
    const connection = db.prepare('SELECT provider, scope, status, credentials_encrypted FROM connections WHERE provider = ? AND scope = ?').get('cloudrun', repository);
    const priorCredentialDataDir = process.env.HYPERVIBE_DATA_DIR;
    let credentials: ReturnType<typeof verifiedGcpFixtureCredentials>;
    process.env.HYPERVIBE_DATA_DIR = dataDir; SecretStore.resetInstance();
    try {
      credentials = verifiedGcpFixtureCredentials(connection, { repository, nativeProjectId: gcpProjectId, runtimeServiceAccountEmail }, (encrypted) => getSecretStore().decryptObject(encrypted));
    } finally {
      SecretStore.resetInstance();
      if (priorCredentialDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR; else process.env.HYPERVIBE_DATA_DIR = priorCredentialDataDir;
    }
    const adapter = new CloudRunAdapter(); await adapter.connect(credentials); adapter.configureTarget({ region });
    const previousDataDir = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir; SecretStore.resetInstance();
    const environment = () => db.prepare('SELECT id FROM environments WHERE project_id = ? AND name = ?').get(project.id, environmentName) as { id: string } | undefined;
    const paths = () => { const env = environment(); return env ? engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: env.id, partition: 'environment' }, dataDir) : undefined; };
    const inventory = async (): Promise<NativeFixtureResource[]> => {
      const statePaths = paths();
      let recorded: NativeFixtureResource[] = [];
      if (statePaths && existsSync(statePaths.statePath)) {
        const installed = await ensureEngineBinary();
        if (!installed.ok) throw new Error('The pinned engine is unavailable for safe fixture-state inspection.');
        const passphrase = loadOrCreateStatePassphrase(statePaths, getSecretStore());
        const directory = materializeWorkingDirectory({ parent: path.join(dataDir, 'fixture-inspection'), configuration: { files: {}, resources: {} }, requirements: gcpEngineBackend.providerRequirements, statePath: statePaths.statePath });
        try {
          const env = { ...encryptionEnvironment(passphrase), TF_PLUGIN_CACHE_DIR: path.join(dataDir, 'engine', 'plugins') };
          for (const command of [{ kind: 'init' } as const, { kind: 'show-state' } as const]) {
            const result = await runTofu(command, { binary: installed.binary, workingDirectory: directory, env, redact: [passphrase, credentials.credentials], timeoutMs: 120_000 });
            if (result.exitCode !== 0) throw new Error('Encrypted fixture state is unreadable; absence is unknown.');
            if (command.kind === 'show-state') recorded = projectGcpFixtureState(JSON.parse(result.stdout));
          }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      } else if (journal.phase !== 'prepared' && !journal.resources.length) {
        throw new Error('Attempted apply has no readable state or reviewed exact candidate identities.');
      }
      assertGcpFixtureInventoryScope([...journal.resources, ...recorded], initialScope);
      const candidates = new Map([...journal.resources, ...recorded].map((resource) => [resourceKey(resource), resource]));
      const present: NativeFixtureResource[] = [];
      for (const resource of candidates.values()) {
        const state = await observeGcpFixtureResource(resource, await adapter.engineAccessToken(), { projectId: gcpProjectId, region });
        if (state === 'unknown') throw new Error('Provider-native fixture inventory is unknown.');
        if (state === 'present') present.push(resource);
      }
      return present;
    };
    const plan = async () => {
      const envelope = await cli(['plan'], { project: projectName, env: environmentName });
      if (!Array.isArray(envelope.data?.actions) || (envelope.data.blocked ?? []).length) throw new Error('The fixture plan is blocked or incomplete.');
      if (envelope.data.actions.some((action: Json) => action.type !== 'noop' && ['project', 'environment'].includes(action.resource?.kind))) throw new Error('Fixture platform setup must already exist; this run cannot create or delete shared project resources.');
      return envelope;
    };
    const configurationForPlan = (envelope: Json): Json => {
      const statePaths = paths();
      const persisted = db.prepare('SELECT plan FROM runs WHERE id = ?').get(envelope.data.planId) as { plan: string } | undefined;
      const enginePlanId = persisted && JSON.parse(persisted.plan).engine?.planId;
      if (typeof enginePlanId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(enginePlanId)) throw new Error('The reviewed plan has no engine artifact identity.');
      const configurationFile = statePaths && path.join(statePaths.plans, `${enginePlanId}.config.json`);
      if (!configurationFile || !existsSync(configurationFile)) throw new Error('The reviewed engine configuration is unavailable; no apply was authorized.');
      return JSON.parse(readFileSync(configurationFile, 'utf8'));
    };
    const assertNoop = async () => {
      const envelope = await plan();
      if (envelope.data.actions.some((action: Json) => action.type !== 'noop')) throw new Error('Unchanged fixture desired state is not a noop.');
      const applied = await cli(['apply'], { project: projectName, planId: envelope.data.planId, confirmActions: [] });
      if (!Array.isArray(applied.data?.receipts) || applied.data.receipts.some((receipt: Json) => receipt.status !== 'skipped_noop')) throw new Error('Applying a noop fixture plan did not report zero mutations.');
    };
    const setDesiredSpec = async (revision: 'create' | 'update' | 'absent') => {
      const savedSpec = db.prepare('SELECT document FROM project_specs WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(project.id) as { document: string } | undefined;
      if (!savedSpec) throw new Error('The prepared project has no readable desired state; existing environments cannot be preserved.');
      const original = JSON.parse(savedSpec.document);
      if (!original.environments || original.project !== projectName) throw new Error('The prepared project specification is invalid.');
      await cli(['spec', 'set'], { project: projectName, replace: true, spec: { ...original,
        runtime: original.runtime ?? { kind: 'node', version: '22', installCommand: 'npm install --omit=dev' },
        environments: { ...original.environments, [environmentName]: { hosting: { provider: 'cloudrun', region },
          services: revision === 'absent' ? {} : { web: { workloadKind: 'web', startCommand: 'node server.mjs', healthCheckPath: '/health', public: true } },
          email: { enabled: false }, envVars: revision === 'absent' ? {} : { CONFORMANCE_APP_REVISION: revision }, deploy: { strategy: 'manual' } } } } });
    };
    const remember = async () => {
      const resources = new Map(journal.resources.map((resource) => [resourceKey(resource), resource]));
      for (const resource of await inventory()) resources.set(resourceKey(resource), resource);
      journal.resources = [...resources.values()]; save(journal);
    };
    let firstPlan: Json | undefined;
    let initialScope: GcpFixtureResourceScope[] = [];
    const interrupted = new AbortController();
    const stop = () => interrupted.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      if (!cleanupOnly && mode === 'preview') {
        if (journal.phase !== 'prepared') throw new Error('Existing fixture resources require cleanup-only before another preview.');
        if ((await inventory()).length) throw new Error('The dedicated fixture environment is not empty.');
        await setDesiredSpec('create');
        const envelope = await plan();
        const preview = fixturePreview(envelope, { profile: profile.id, project: projectName, environment: environmentName });
        preview.engineResources = gcpFixtureConfigurationScope(configurationForPlan(envelope), gcpProjectId, region);
        assertGcpFixtureContinuationScope({ initial: preview.engineResources, current: preview.engineResources, actions: envelope.data.actions, stage: 'create', recordedAddresses: [] });
        writeFileSync(previewFile, `${JSON.stringify(preview, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`\nFixture preview saved: ${previewFile}\nPlan: ${preview.planId}\nNo provider apply or release was executed.\n`);
        return;
      }
      if (!existsSync(previewFile)) throw new Error('The original fixture preview is required to bound both continuation and cleanup.');
      const preview = JSON.parse(readFileSync(previewFile, 'utf8')) as FixturePreview;
      if (preview.profile !== profile.id || preview.project !== projectName || preview.environment !== environmentName || !Array.isArray(preview.engineResources)) throw new Error('The fixture has no matching frozen native resource scope.');
      initialScope = preview.engineResources;
      if (!cleanupOnly) {
        assertFixtureLifecycleConsent(process.env.HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE);
        assertFixtureContinuation(preview, { profile: profile.id, project: projectName, environment: environmentName }, process.env.HYPERVIBE_LIVE_APPROVED_PLAN_ID);
        const persisted = db.prepare('SELECT plan FROM runs WHERE id = ?').get(preview.planId) as { plan: string } | undefined;
        if (!persisted) throw new Error('The exact approved fixture plan is no longer available.');
        firstPlan = { data: { ...JSON.parse(persisted.plan), planId: preview.planId } };
      }
      await runDisposableFixture({ journal, save, cleanupOnly, signal: interrupted.signal, driver: {
        inventory, assertNoop,
        observe: async (resource) => observeGcpFixtureResource(resource, await adapter.engineAccessToken(), { projectId: gcpProjectId, region }),
        converge: async (revision) => {
          if (!(revision === 'create' && firstPlan)) await setDesiredSpec(revision);
          for (let attempt = 0; attempt < 8; attempt++) {
            const envelope = firstPlan ?? await plan();
            firstPlan = undefined;
            const changes = envelope.data.actions.filter((action: Json) => action.type !== 'noop');
            const configuration = configurationForPlan(envelope);
            assertGcpFixtureContinuationScope({ initial: initialScope,
              current: gcpFixtureConfigurationScope(configuration, gcpProjectId, region), actions: envelope.data.actions,
              stage: revision, recordedAddresses: journal.resources.map((resource) => resource.address) });
            if (!changes.length) { if (revision !== 'absent') await cli(['deploy'], { project: projectName, env: environmentName, confirm: true }); return; }
            const candidates = plannedGcpServiceIdentities(configuration, gcpProjectId, region);
            const known = new Map(journal.resources.map((resource) => [resourceKey(resource), resource]));
            for (const candidate of candidates) {
              if (!known.has(resourceKey(candidate)) && await observeGcpFixtureResource(candidate, await adapter.engineAccessToken(), { projectId: gcpProjectId, region }) !== 'absent') throw new Error('A fixture candidate is not provider-confirmed absent before first creation.');
              known.set(resourceKey(candidate), candidate);
            }
            journal.resources = [...known.values()]; save(journal);
            let applied: Json;
            try { applied = await cli(['apply'], { project: projectName, planId: envelope.data.planId, confirmActions: changes.filter((action: Json) => action.billable || action.dataBearing || action.requiresConfirm).map((action: Json) => action.id) }); }
            finally { await remember(); } // Capture safe exact ids even after a partial/failed apply.
            if (!Array.isArray(applied.data?.receipts) || applied.data.receipts.some((receipt: Json) => !['succeeded', 'skipped_noop'].includes(receipt.status))) throw new Error('Fixture apply is incomplete; no dependent release is authorized.');
          }
          throw new Error('Fixture convergence exceeded its bounded apply steps.');
        },
        verifyRunning: async (revision) => {
          const status = await cli(['status'], { project: projectName, env: environmentName });
          const service = (status.data.services ?? []).find((entry: Json) => entry.name === 'web');
          if (service?.status !== 'running' || typeof service.url !== 'string' || new URL(service.url).protocol !== 'https:') throw new Error('The fixture does not have a provider-ready HTTPS endpoint.');
          const response = await fetch(new URL('/', service.url), { signal: AbortSignal.timeout(30_000), redirect: 'error' });
          assertFixtureHttpResponse(response.status, await response.json(), revision);
        },
      } });
    } finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      db.close(); SecretStore.resetInstance();
      if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR; else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
    }
  }, 60 * 60_000);
});
