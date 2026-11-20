import { describe, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AwsEngineCredentialsSchema } from '../../src/adapters/providers/aws/aws-engine.adapter.js';
import { awsEngineAuthentication } from '../../src/adapters/providers/aws/tofu/aws-engine.backend.js';
import { AzureEngineCredentialsSchema } from '../../src/adapters/providers/azure/azure-engine.adapter.js';
import { AzureTokens } from '../../src/adapters/providers/azure/azure-ops.client.js';
import { getSecretStore, SecretStore } from '../../src/adapters/secrets/secret-store.js';
import { assertFixtureLifecycleConsent, readFixtureTarget } from './fixture-authorization.js';
import { ENGINE_FIXTURE_ENTRYPOINT, engineFixtureEntrypointDockerfile, engineFixtureEnvironment, engineFixtureResponseProblem, engineFixtureSiblingEnvironment, engineFixtureSiblingResponseProblem, probeDatabaseFromHere, readAwsContainerTrouble, readAwsDatabaseExposure, readAwsInventory, sampleAwsWebRelease,
  readAzureDatabaseExposure, readAzureInventory, sinceBaseline, type DatabaseExposure, type EngineFixtureCloud } from './engine-fixture.js';
import { readFixtureJournal, resourceKey, runDisposableFixture, saveFixtureJournal, type FixtureJournal, type NativeFixtureResource } from './lifecycle-live-harness.js';
import { selectLiveFixtureProfile } from './live-fixture-profiles.js';

type Json = Record<string, any>;
const selected = process.env.HYPERVIBE_LIVE_ENGINE_ENVIRONMENT?.trim();
const live = selected ? describe : describe.skip;
const cliPath = path.resolve(import.meta.dirname, '../../dist/index.js');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Selected live fixture requires ${name}. No live result can be claimed without configured test access.`);
  return value;
}

async function processOutput(executable: string, args: string[], cwd: string, dataDir: string, input?: Json): Promise<string> {
  return new Promise((resolve, reject) => {
    // The shared test setup turns off repository specs and .env discovery for synthetic projects. The fixture is a real
    // repository: Hypervibe finds the source to build through its repository spec, so those switches must not reach the CLI.
    const { HYPERVIBE_DISABLE_REPO_SPEC: _spec, HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE: _envFile, ...inherited } = process.env;
    const child = spawn(executable, args, { cwd, env: { ...inherited, HYPERVIBE_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), 75 * 60_000); // An Azure apply may run 60 minutes.
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill('SIGTERM'); else stdout += chunk; });
    child.stderr.resume(); // Provider diagnostics can echo secrets. Do not persist or print them.
    child.once('error', () => { clearTimeout(timer); reject(new Error('The fixture command could not start.')); });
    child.once('close', (code) => { clearTimeout(timer); if (code !== 0 && !stdout.trimStart().startsWith('{')) reject(new Error(`Fixture command ${args[0]} failed or was interrupted; preserve the encrypted state.`)); else resolve(stdout); });
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

/**
 * AWS and Azure testing environment with a web service, a worker and a database.
 * Every change goes through the installed CLI; the provider calls here only read.
 * Leftovers are found by comparing everything in the dedicated account region
 * (AWS) or project resource group (Azure) with what was there before the run.
 */
live('AWS and Azure engine disposable environment fixture', () => {
  it(process.env.HYPERVIBE_LIVE_CLEANUP_ONLY === '1' ? 'resumes teardown without claiming full lifecycle proof'
    : process.env.HYPERVIBE_LIVE_MODE !== 'run' ? 'shows the first plan without applying or claiming live lifecycle proof'
    : 'creates, serves, keeps the database off the internet, noops, updates and leaves nothing behind', async () => {
    const profile = selectLiveFixtureProfile(selected!);
    if (profile.path !== 'engine-environment') throw new Error(`Use ${profile.runner} for ${profile.id}.`);
    const cloud = profile.provider as EngineFixtureCloud;
    const workspace = required('HYPERVIBE_LIVE_FIXTURE_DIR');
    const dataDir = required('HYPERVIBE_LIVE_DATA_DIR');
    const projectName = required('HYPERVIBE_LIVE_PROJECT');
    const markerFile = required('HYPERVIBE_LIVE_FIXTURE_MARKER');
    const mode = process.env.HYPERVIBE_LIVE_MODE ?? 'preview';
    if (!['preview', 'run'].includes(mode)) throw new Error('HYPERVIBE_LIVE_MODE must be preview or run.');
    const cleanupOnly = process.env.HYPERVIBE_LIVE_CLEANUP_ONLY === '1';
    if (!path.isAbsolute(workspace) || !path.isAbsolute(dataDir) || workspace === dataDir) throw new Error('Use separate absolute fixture and state directories.');
    if (!existsSync(cliPath)) throw new Error('Build the installed CLI with npm run build before selecting live tests.');
    const databaseFile = path.join(dataDir, 'hypervibe.db');
    if (!existsSync(databaseFile)) throw new Error(`The dedicated ${cloud} test project must already be connected through Hypervibe in HYPERVIBE_LIVE_DATA_DIR.`);
    // Ordinary tests run with a placeholder key so they never touch a real one. A live run must use the
    // data directory's own key, here and in the CLI processes it starts.
    if (process.env.HYPERVIBE_SECRET_KEY === '00'.repeat(32)) delete process.env.HYPERVIBE_SECRET_KEY;
    const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
    const previousDataDir = process.env.HYPERVIBE_DATA_DIR;
    const interrupted = new AbortController();
    const stop = () => interrupted.abort();
    try {
      const project = db.prepare('SELECT id, git_remote_url FROM projects WHERE name = ?').get(projectName) as { id: string; git_remote_url?: string } | undefined;
      if (!project) throw new Error('The dedicated test project does not exist in HYPERVIBE_LIVE_DATA_DIR.');
      const repository = project.git_remote_url?.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '').replace(/\/$/, '') || projectName;

      // The saved deploy access, matched to the marker's exact account or subscription before any call.
      process.env.HYPERVIBE_DATA_DIR = dataDir; SecretStore.resetInstance();
      const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Json;
      const connections = (db.prepare('SELECT credentials_encrypted FROM connections WHERE provider = ? AND status = ?').all(cloud, 'verified') as Array<{ credentials_encrypted: string }>)
        .map((row) => { try { return getSecretStore().decryptObject(row.credentials_encrypted) as Json; } catch { return undefined; } });
      const aws = cloud === 'aws' ? connections.map((value) => AwsEngineCredentialsSchema.safeParse(value)).find((parsed) => parsed.success && parsed.data.accountId === marker.nativeProjectId)?.data : undefined;
      const azure = cloud === 'azure' ? connections.map((value) => AzureEngineCredentialsSchema.safeParse(value)).find((parsed) => parsed.success && parsed.data.subscriptionId === marker.nativeProjectId)?.data : undefined;
      const connection = aws ?? azure;
      if (!connection) throw new Error(`No verified Hypervibe ${cloud} connection matches the marker's account. Connect the dedicated test account through Hypervibe first.`);
      readFixtureTarget(markerFile, { profile: profile.id, project: projectName, internalProjectId: project.id, repository,
        nativeProjectId: aws?.accountId ?? azure!.subscriptionId, region: aws?.region ?? azure!.location });

      const tokens = azure ? new AzureTokens(azure) : undefined;
      const inventoryNow = async (): Promise<NativeFixtureResource[]> => {
        if (azure) return readAzureInventory(tokens!, azure.subscriptionId, azure.resourceGroup);
        const auth = await awsEngineAuthentication(aws!); // One-hour role credentials; taken fresh for each read.
        return readAwsInventory({ region: aws!.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } });
      };
      const exposure = async (created: NativeFixtureResource[]): Promise<DatabaseExposure> => {
        if (azure) {
          const servers = created.filter((resource) => resource.type === 'microsoft.dbforpostgresql/flexibleservers');
          if (servers.length !== 1) throw new Error(`The fixture should have created exactly one database server; found ${servers.length}.`);
          return readAzureDatabaseExposure(tokens!, servers[0]!.id);
        }
        const auth = await awsEngineAuthentication(aws!);
        return readAwsDatabaseExposure({ region: aws!.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } }, created);
      };

      const journalFile = path.join(workspace, 'fixture-evidence.json');
      const baselineFile = path.join(workspace, 'fixture-baseline.json');
      if (existsSync(workspace) && !existsSync(journalFile)) throw new Error('The new fixture directory must not already exist. This protects unrelated checkout contents.');
      if (cleanupOnly && !(existsSync(journalFile) && existsSync(baselineFile))) throw new Error('Cleanup-only requires the existing fixture journal and baseline.');
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const existingJournal = existsSync(journalFile) ? readFixtureJournal(journalFile) : undefined;
      // Short and never "prod" or "stag": the engines pick the cheap testing shape from the name.
      const environmentName = existingJournal?.environment ?? `fx-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const journal: FixtureJournal = existingJournal ?? { version: 1, profile: profile.id, project: projectName, environment: environmentName, phase: 'prepared', resources: [],
        checks: { created: false, noop: false, updated: false, absent: false } };
      if (journal.profile !== profile.id || journal.project !== projectName) throw new Error('The fixture journal identifies a different target.');
      const save = (value: FixtureJournal) => saveFixtureJournal(journalFile, value);
      save(journal);
      // What the account held before this fixture; written once, before the first change, and kept for cleanup.
      if (!existsSync(baselineFile)) {
        if (journal.phase !== 'prepared') throw new Error('The fixture baseline is missing after changes began; leftovers cannot be told apart from earlier resources.');
        writeFileSync(baselineFile, `${JSON.stringify((await inventoryNow()).map(resourceKey), null, 2)}\n`, { mode: 0o600 });
      }
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as string[];
      const inventory = async () => sinceBaseline(await inventoryNow(), baseline);

      const repoSpecFile = path.join(workspace, '.hypervibe', 'spec.json');
      const cli = async (command: string[], input: Json): Promise<Json> => {
        let envelope: Json;
        try { envelope = JSON.parse(await processOutput(process.execPath, [cliPath, ...command, '--input', '-', '--json'], workspace, dataDir, input)); }
        catch { throw new Error(`Hypervibe ${command.join(' ')} failed; fixture recovery state was preserved.`); }
        if (envelope.ok !== true) {
          // Hypervibe's own redacted blockers say what to fix; nothing else from the failed command is shown.
          const blocked = (envelope.error?.details?.blocked ?? []).map((entry: unknown) => String(entry).slice(0, 800)).join('\n');
          throw new Error(`Hypervibe ${command.join(' ')} did not succeed (${envelope.error?.code ?? 'unknown'}): ${String(envelope.error?.message ?? '').slice(0, 600)}${blocked ? `\n${blocked}` : ''}`);
        }
        return envelope;
      };
      if (!existsSync(path.join(workspace, '.git'))) {
        cpSync(path.join(import.meta.dirname, 'fixture-database'), workspace, { recursive: true });
        if (cloud === 'aws') {
          // AWS runs the web start-command checks, which need an image with its own entrypoint.
          writeFileSync(path.join(workspace, 'entry.sh'), ENGINE_FIXTURE_ENTRYPOINT);
          writeFileSync(path.join(workspace, 'Dockerfile'), engineFixtureEntrypointDockerfile(readFileSync(path.join(workspace, 'Dockerfile'), 'utf8')));
        }
        writeFileSync(path.join(workspace, '.gitignore'), '.hypervibe/\nnode_modules/\nfixture-evidence.json\nfixture-baseline.json\n.env*\n');
        // Hypervibe builds from the repository that holds the project's spec file. Without it a plan has no
        // source, builds no image and creates no workloads (live 2026-11-18: the release was then refused).
        const stored = db.prepare('SELECT document FROM project_specs WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(project.id) as { document: string } | undefined;
        if (!stored) throw new Error('The dedicated project has no readable desired state.');
        mkdirSync(path.join(workspace, '.hypervibe'), { recursive: true });
        writeFileSync(repoSpecFile, `${JSON.stringify(JSON.parse(stored.document), null, 2)}\n`);
        for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Hypervibe fixture'], ['config', 'user.email', 'fixture@hypervibe.invalid'],
          ...(project.git_remote_url ? [['remote', 'add', 'origin', project.git_remote_url]] : []),
          ['add', 'Dockerfile', 'package.json', 'server.mjs', '.gitignore', ...(cloud === 'aws' ? ['entry.sh'] : [])], ['commit', '-m', 'Disposable engine conformance fixture']]) {
          await processOutput('git', args, workspace, dataDir);
        }
      }

      const savedSpec = (): Json => {
        // The fixture repository's spec file is what the CLI reads and writes here.
        if (!existsSync(repoSpecFile)) throw new Error('The fixture repository has no spec file; existing environments cannot be preserved.');
        const spec = JSON.parse(readFileSync(repoSpecFile, 'utf8'));
        if (!spec.environments || spec.project !== projectName) throw new Error('The dedicated project specification is invalid.');
        return spec;
      };
      // A second, smaller environment that joins the first one's shared pieces for part of the run.
      // A different start, not a longer name: Azure and AWS cut long names short, so `<name>b` would land on the same cloud names (see the issue on shared name prefixes).
      const siblingName = environmentName.replace(/^fx-/, 'fs-');
      const region = process.env.HYPERVIBE_LIVE_REGION?.trim() || undefined;
      const inSpec = (name = environmentName) => Boolean(savedSpec().environments[name]);
      const setSpecEnvironment = async (name: string, environment: Record<string, unknown> | undefined) => {
        const original = savedSpec();
        const { [name]: _removed, ...others } = original.environments;
        await cli(['spec'], { project: projectName, replace: true, spec: { ...original,
          runtime: original.runtime ?? { kind: 'node', version: '22', installCommand: 'npm install --omit=dev' },
          environments: environment ? { ...others, [name]: environment } : others } });
      };
      // On AWS the web service starts as its image says, gains a start command, changes it and drops it again.
      const imageStart = cloud === 'aws' ? { entrypoint: true, startedWith: null } : undefined;
      const setEnvironment = (revision: 'create' | 'update' | undefined, webStart: string | null | undefined = cloud === 'aws' ? null : undefined) =>
        setSpecEnvironment(environmentName, revision ? engineFixtureEnvironment(cloud, revision, marker.region, region, webStart) : undefined);
      const plan = async (input: Json = {}, name = environmentName) => {
        const envelope = await cli(['plan'], { project: projectName, env: name, ...input });
        if (!Array.isArray(envelope.data?.actions) || (envelope.data.blocked ?? []).length) throw new Error('The fixture plan is blocked or incomplete.');
        return envelope;
      };
      const changesOf = (envelope: Json): Json[] => envelope.data.actions.filter((action: Json) => action.type !== 'noop');
      const apply = async (envelope: Json): Promise<boolean> => {
        const confirmActions = changesOf(envelope).filter((action) => action.billable || action.dataBearing || action.requiresConfirm).map((action) => action.id);
        const applied = await cli(['apply'], { project: projectName, planId: envelope.data.planId, confirmActions });
        if (!Array.isArray(applied.data?.receipts)) return false;
        const failed = applied.data.receipts.filter((receipt: Json) => !['succeeded', 'success', 'skipped_noop'].includes(receipt.status));
        // Hypervibe's own redacted reason for each step that did not finish; without it a failed run says nothing useful.
        for (const receipt of failed) process.stdout.write(`\nApply step ${receipt.step ?? receipt.action?.id ?? '?'}: ${receipt.status}. ${String(receipt.error ?? receipt.message ?? '').slice(0, 1200)}\n`);
        return failed.length === 0;
      };

      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      if (!cleanupOnly && mode === 'preview') {
        if (journal.phase !== 'prepared') throw new Error('Existing fixture resources require cleanup-only before another preview.');
        await setEnvironment('create');
        try {
          const changes = changesOf(await plan());
          process.stdout.write(`\nFirst plan for ${environmentName} on ${cloud}: ${changes.length} change(s).\n${changes.map((action) => `- ${action.type} ${action.resource?.kind} ${action.resource?.name}`).join('\n')}\nNothing was applied.\n`);
        } finally { await setEnvironment(undefined); }
        return;
      }
      if (!cleanupOnly) assertFixtureLifecycleConsent(process.env.HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE);

      const tearDown = async (name: string) => {
        // A teardown that reports leftovers is planned again, as its own message asks.
        for (let attempt = 0; attempt < 4 && inSpec(name); attempt++) {
          await apply(await plan({ scope: 'teardown', ...(cloud === 'aws' && name === environmentName ? { deleteFinalSnapshot: true } : {}) }, name));
        }
        if (inSpec(name)) throw new Error(`Teardown of ${name} did not finish within its bounded attempts.`);
      };
      const webAnswer = async (name: string, problemOf: (status: number, body: unknown) => string | undefined) => {
        // The address Hypervibe recorded for the web service when it applied. `status` on these engines reports workers only.
        const row = db.prepare('SELECT platform_bindings FROM environments WHERE project_id = ? AND name = ?').get(project.id, name) as { platform_bindings: string } | undefined;
        const bindings = row ? JSON.parse(row.platform_bindings) as Json : {};
        const url = bindings.services?.web?.url ?? bindings[cloud]?.services?.web?.url;
        if (typeof url !== 'string' || new URL(url).protocol !== 'https:') throw new Error(`Hypervibe recorded no HTTPS address for the web service of ${name}.`);
        // A new revision and the worker's first write take a few minutes to show.
        let problem: string | undefined = 'the web service did not answer';
        for (let attempt = 0; attempt < 45 && problem; attempt++) {
          if (attempt) await sleep(20_000);
          try {
            const response = await fetch(new URL('/', url), { signal: AbortSignal.timeout(30_000), redirect: 'error' });
            problem = problemOf(response.status, await response.json());
          } catch { problem = 'the web service did not answer'; }
        }
        if (problem) throw new Error(`${name} is not running as expected: ${problem}.`);
      };
      const assertUnchanged = async (name: string) => {
        if (changesOf(await plan({}, name)).length) throw new Error(`${name} has changes to make although its desired state did not change.`);
      };
      /**
       * A second environment joins the project, is used, and leaves, while the first keeps working.
       * It has no worker of its own, so a worker write showing up there would mean it was handed the first one's database.
       */
      const siblingJoinsAndLeaves = async () => {
        await setSpecEnvironment(siblingName, engineFixtureSiblingEnvironment(cloud, region));
        for (let attempt = 0; ; attempt++) {
          if (attempt === 6) throw new Error('The second environment did not converge within its bounded apply steps.');
          const envelope = await plan({}, siblingName);
          if (!changesOf(envelope).length) break;
          if (!await apply(envelope)) throw new Error('The second environment could not be applied.');
        }
        await cli(['deploy'], { project: projectName, env: siblingName, confirm: true });
        await webAnswer(siblingName, engineFixtureSiblingResponseProblem);
        // One database server or cluster still: `exposure` refuses any other count.
        if ((await exposure(await inventory())).problems.length) throw new Error('The database is exposed after a second environment joined.');
        await webAnswer(environmentName, (status, body) => engineFixtureResponseProblem(status, body, 'create'));
        await assertUnchanged(environmentName);
        await tearDown(siblingName);
        await webAnswer(environmentName, (status, body) => engineFixtureResponseProblem(status, body, 'create'));
        await assertUnchanged(environmentName);
        journal.checks.sibling = true; save(journal);
      };

      await runDisposableFixture({ journal, save, cleanupOnly, signal: interrupted.signal, driver: {
        inventory,
        replacedOnRestart: (resource) => resource.type === 'network-interface',
        observe: async (resource) => (await inventoryNow()).some((entry) => resourceKey(entry) === resourceKey(resource)) ? 'present' : 'absent',
        assertNoop: async () => {
          if (!inSpec()) return; // Teardown removed the environment from the spec; there is nothing left to plan.
          const envelope = await plan();
          if (changesOf(envelope).length) throw new Error('Unchanged fixture desired state is not a noop.');
          const applied = await cli(['apply'], { project: projectName, planId: envelope.data.planId, confirmActions: [] });
          if (!Array.isArray(applied.data?.receipts) || applied.data.receipts.some((receipt: Json) => receipt.status !== 'skipped_noop')) throw new Error('Applying a noop fixture plan did not report zero mutations.');
        },
        converge: async (revision) => {
          if (revision === 'absent') {
            if (!inSpec() && !inSpec(siblingName)) return;
            // Nothing was ever built (for example the first plan was blocked): only the spec entry needs removing.
            if (!journal.resources.length && !(await inventory()).length) { await setSpecEnvironment(siblingName, undefined); await setEnvironment(undefined); return; }
            // The sibling goes first: the shared pieces leave with the last environment.
            await tearDown(siblingName);
            await tearDown(environmentName);
            // Deletions settle after the commands return; wait a bounded time for the account to match its baseline.
            for (let wait = 0; wait < 30 && (await inventory()).length; wait++) await sleep(30_000);
            return;
          }
          // Between the first environment's checks and its update, a second one comes and goes.
          if (revision === 'update' && !journal.checks.sibling) await siblingJoinsAndLeaves();
          const settle = async () => {
          for (let attempt = 0; attempt < 8; attempt++) {
            const envelope = await plan();
            if (!changesOf(envelope).length) {
              try { await cli(['deploy'], { project: projectName, env: environmentName, confirm: true }); } catch (error) {
                // Teardown follows a failed release, so record how AWS describes the web service first.
                if (aws) {
                  const auth = await awsEngineAuthentication(aws);
                  const name = `hv-${projectName}-${environmentName}`;
                  process.stdout.write(`\n${await sampleAwsWebRelease({ region: aws.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } },
                    `arn:aws:ecs:${aws.region}:${aws.accountId}:service/${name}/${name}-web`)}\n`);
                }
                throw error;
              }
              return;
            }
            if (!await apply(envelope)) {
              // Teardown deletes the services and their logs, so read why they are not running first.
              if (aws) {
                const auth = await awsEngineAuthentication(aws);
                process.stdout.write(`\n${await readAwsContainerTrouble({ region: aws.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } }, `/hypervibe/hv-${projectName}-${environmentName}/tasks`)}\n`);
              }
              throw new Error('Fixture apply is incomplete; no dependent release is authorized.');
            }
          }
          throw new Error('Fixture convergence exceeded its bounded apply steps.');
          };
          if (revision === 'update' && cloud === 'aws' && !journal.checks.webCommand) {
            for (const word of ['gained', 'changed']) {
              await setEnvironment('create', `node server.mjs ${word}`);
              await settle();
              await webAnswer(environmentName, (status, body) => engineFixtureResponseProblem(status, body, 'create', { entrypoint: false, startedWith: word }));
            }
            journal.checks.webCommand = true; save(journal);
          }
          await setEnvironment(revision);
          await settle();
        },
        verifyRunning: async (revision) => {
          await webAnswer(environmentName, (status, body) => engineFixtureResponseProblem(status, body, revision, imageStart));
          // After the start command is dropped the image's own startup is back, and nothing is left to change.
          if (revision === 'update' && cloud === 'aws') await assertUnchanged(environmentName);
          // The app reached its database above. From this computer the same database must be closed.
          const database = await exposure(await inventory());
          if (database.problems.length) throw new Error(`The database is exposed: ${database.problems.join('; ')}.`);
          if (await probeDatabaseFromHere(database.host) !== 'closed') throw new Error('The database accepted a connection attempt from this computer.');
          journal.checks.databaseClosed = true; save(journal);
        },
      } });
    } finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      db.close(); SecretStore.resetInstance();
      if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR; else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
    }
  }, 4 * 60 * 60_000);
});
