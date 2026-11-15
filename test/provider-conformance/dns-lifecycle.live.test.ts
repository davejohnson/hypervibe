import { describe, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createCommandContext } from '../../src/application/context.js';
import { readDnsOwnedRecords } from '../../src/application/dns-engine.js';
import { SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../src/adapters/secrets/secret-store.js';
import { resolveDnsConnection } from '../../src/adapters/dns-observation/connections.js';
import { dnsName, txtContent } from '../../src/adapters/dns-observation/http-observer.js';
import type { DnsObservedRecord } from '../../src/domain/ports/dns.port.js';
import { parseGitHubRepoFromRemote } from '../../src/lib/git-remote.js';
import { assertFixtureContinuation, assertFixtureLifecycleConsent, fixturePreview, type FixturePreview } from './fixture-authorization.js';
import { assertFixtureHttpResponse, readFixtureJournal, runDisposableFixture, saveFixtureJournal, type FixtureJournal } from './lifecycle-live-harness.js';
import { assertDnsFixtureActions, assertDnsFixtureTarget, assertDnsFixtureValues, assertDnsPreservedRecords, dnsFixtureInventory,
  assertDnsProofPreserved, dnsFixtureCleanupState, dnsFixtureProofBaseline,
  dnsFixtureMarkerSchema, dnsFixtureZone, readDnsFixtureRecords, readDnsPreservedRecords, type SafeDnsOwnedRecord } from './dns-lifecycle-harness.js';

type Json = Record<string, any>;
const selected = process.env.HYPERVIBE_LIVE_DNS_PROFILE?.trim();
const live = selected ? describe : describe.skip;
const cliPath = path.resolve(import.meta.dirname, '../../dist/index.js');
function required(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`DNS fixture requires ${name}; no live support can be claimed without prepared dedicated access.`); return value;
}

async function cli(command: string[], input: Json, directory: string, dataDir: string): Promise<Json> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command, '--input', '-', '--json'], { cwd: directory,
      env: { ...process.env, HYPERVIBE_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill('SIGTERM'); else output += chunk; });
    child.stderr.resume(); // Never persist possibly credential-bearing provider diagnostics.
    child.once('error', () => { clearTimeout(timer); reject(new Error('The installed Hypervibe command could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      try { const envelope = JSON.parse(output); if (code !== 0 || envelope.ok !== true) throw new Error(); resolve(envelope); }
      catch { reject(new Error(`Hypervibe ${command.join(' ')} failed; preserve fixture state for recovery.`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function assertPublicDns(records: DnsObservedRecord[]): Promise<void> {
  const types = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, CAA: 257, MX: 15 };
  const groups = new Map<string, DnsObservedRecord>();
  for (const record of records) {
    const key = `${dnsName(record.name)}|${record.type}`; const existing = groups.get(key);
    groups.set(key, { ...record, values: [...new Set([...(existing?.values ?? []), ...record.values])] });
  }
  for (const record of groups.values()) {
    const hostname = dnsName(record.name);
    const url = new URL('https://dns.google/resolve'); url.search = new URLSearchParams({ name: hostname, type: String(types[record.type]), edns_client_subnet: '0.0.0.0/0' }).toString();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Public DNS could not be read.');
    const data = await response.json() as Json;
    if (data.Status !== 0 || data.TC !== false || data.Question?.length !== 1 || dnsName(data.Question[0].name) !== hostname
      || data.Question[0].type !== types[record.type] || !Array.isArray(data.Answer)) throw new Error('Public DNS evidence is incomplete.');
    const answers = data.Answer.filter((answer: Json) => dnsName(answer.name) === hostname && answer.type === types[record.type]);
    const normalize = (value: string) => record.type === 'TXT' ? value : value.toLowerCase().replace(/\.$/, '');
    const publicValues = answers.map((answer: Json) => normalize(record.type === 'TXT' ? txtContent(answer.data) : String(answer.data))).sort();
    if (!isDeepStrictEqual([...record.values].map(normalize).sort(), publicValues)) throw new Error('Public DNS does not match the exact provider-native fixture values.');
  }
}

/** Opt-in only. All mutations are installed Hypervibe spec/plan/apply commands. */
live('Disposable DNS lifecycle on a prepared app', () => {
  it('previews or runs the exact authorized DNS create/update/noop/teardown fixture', async () => {
    const dataDir = required('HYPERVIBE_LIVE_DATA_DIR'); const directory = required('HYPERVIBE_LIVE_DNS_FIXTURE_DIR');
    const marker = dnsFixtureMarkerSchema.parse(JSON.parse(readFileSync(required('HYPERVIBE_LIVE_DNS_FIXTURE_MARKER'), 'utf8')));
    if (marker.profile !== selected || !path.isAbsolute(dataDir) || !path.isAbsolute(directory) || dataDir === directory)
      throw new Error('Select one matching DNS profile and separate absolute fixture/state directories.');
    if (!existsSync(cliPath) || !existsSync(path.join(dataDir, 'hypervibe.db'))) throw new Error('Build Hypervibe and prepare its dedicated fixture app, scoped connections and encrypted state first.');
    const mode = process.env.HYPERVIBE_LIVE_MODE ?? 'preview'; const cleanupOnly = process.env.HYPERVIBE_LIVE_CLEANUP_ONLY === '1';
    if (!['preview', 'run'].includes(mode)) throw new Error('The DNS fixture mode must be preview or run.');
    const journalFile = path.join(directory, 'dns-fixture-evidence.json'); const previewFile = path.join(directory, 'dns-fixture-plan.json');
    const baselineFile = path.join(directory, 'dns-fixture-baseline.encrypted');
    if (existsSync(directory) && !existsSync(journalFile)) throw new Error('Use a new fixture directory; unrelated checkout contents are not a disposable fixture.');
    if (cleanupOnly && !existsSync(journalFile)) throw new Error('Cleanup-only needs the existing exact fixture journal.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const previousDataDir = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir; SqliteAdapter.resetInstance(); SecretStore.resetInstance();
    try {
      const db = SqliteAdapter.getInstance(path.join(dataDir, 'hypervibe.db')).getDb(); const context = createCommandContext();
      const project = context.repos.projects.findById(marker.internalProjectId); const environment = context.repos.environments.findById(marker.internalEnvironmentId);
      if (!project || !environment || environment.projectId !== project.id) throw new Error('The prepared DNS fixture app or environment is missing.');
      assertDnsFixtureTarget(marker, { profile: selected!, project: project.name, internalProjectId: project.id, environment: environment.name,
        internalEnvironmentId: environment.id, repository: parseGitHubRepoFromRemote(project.gitRemoteUrl) ?? '' });
      const connected = await resolveDnsConnection({ context, zone: dnsFixtureZone(marker), scopeHints: [marker.repository], connectionScope: marker.dns.connectionScope });
      if ('blocked' in connected) throw new Error(connected.blocked);
      const observedZone = await connected.observer.observeZone();
      if (observedZone.status !== 'present' || observedZone.value.visibility !== 'public') throw new Error('The exact DNS zone is not confirmed public and accessible.');
      const getSpec = (): Json => {
        const row = db.prepare('SELECT document FROM project_specs WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(project.id) as { document: string } | undefined;
        if (!row) throw new Error('The prepared project specification is unavailable.'); return JSON.parse(row.document);
      };
      const journal: FixtureJournal = existsSync(journalFile) ? readFixtureJournal(journalFile) : { version: 1, profile: marker.profile,
        project: project.name, environment: environment.name, phase: 'prepared', resources: [], checks: { created: false, noop: false, updated: false, absent: false } };
      if (journal.profile !== marker.profile || journal.project !== project.name || journal.environment !== environment.name) throw new Error('The DNS journal identifies a different fixture.');
      const save = (value: FixtureJournal) => saveFixtureJournal(journalFile, value); save(journal);
      if (!existsSync(baselineFile)) {
        if (journal.phase !== 'prepared' || cleanupOnly) throw new Error('The original encrypted fixture baseline is missing.');
        const original = getSpec(); const originalEnvironment = original.environments?.[environment.name];
        if (!originalEnvironment || originalEnvironment.domain || originalEnvironment.dns || environment.platformBindings.dnsEngine)
          throw new Error('The prepared environment already owns custom-domain or DNS state; use a dedicated empty domain fixture.');
        const proof = dnsFixtureProofBaseline(await readDnsFixtureRecords(connected.observer, marker), marker);
        const baseline = { marker, originalEnvironment, zoneNativeId: observedZone.value.providerNativeId,
          proof, preserved: await readDnsPreservedRecords(connected.observer, marker) };
        writeFileSync(baselineFile, context.secretStore.encryptObject(baseline), { mode: 0o600 });
      }
      const baseline = context.secretStore.decryptObject<{ marker: unknown; originalEnvironment: Json; zoneNativeId?: string; proof: DnsObservedRecord[]; preserved: DnsObservedRecord[] }>(readFileSync(baselineFile, 'utf8'));
      if (!isDeepStrictEqual(baseline.marker, marker) || baseline.zoneNativeId !== observedZone.value.providerNativeId || !Array.isArray(baseline.proof)) throw new Error('The DNS fixture marker, proof baseline or native zone identity changed since preview.');
      const freshEnvironment = () => { const value = context.repos.environments.findById(environment.id); if (!value) throw new Error('The retained fixture environment disappeared.'); return value; };
      const owned = (): SafeDnsOwnedRecord[] => readDnsOwnedRecords(context, freshEnvironment()) as SafeDnsOwnedRecord[];
      const preserve = async (final = false) => {
        assertDnsPreservedRecords(baseline.preserved, await readDnsPreservedRecords(connected.observer, marker));
        assertDnsProofPreserved(baseline.proof, await readDnsFixtureRecords(connected.observer, marker), owned(), marker, final);
      };
      await preserve();
      const inventory = async () => {
        const observed = await readDnsFixtureRecords(connected.observer, marker); const recorded = owned();
        if (observed.some(record => !recorded.some(item => item.nativeId === record.nativeId) && !journal.resources.some(item => item.id === record.nativeId)
          && !baseline.proof.some(item => item.nativeId === record.nativeId)))
          throw new Error('A live fixture record lacks exact saved ownership; preserve state and reconcile before cleanup.');
        return dnsFixtureInventory(recorded.filter(record => observed.some(item => item.nativeId === record.nativeId)), marker);
      };
      const setDesired = async (revision: 'create' | 'update' | 'absent') => {
        const current = getSpec(); const environmentSpec = current.environments?.[environment.name];
        if (!environmentSpec) throw new Error('The prepared environment specification disappeared.');
        const { domain: _domain, dns: _dns, domainProxy: _proxy, ...retained } = environmentSpec;
        const { domain: _baseDomain, dns: _baseDns, domainProxy: _baseProxy, ...originalRetained } = baseline.originalEnvironment;
        if (!isDeepStrictEqual(retained, originalRetained)) throw new Error('The retained app configuration changed during the DNS fixture; stop before changing desired state.');
        const desired = revision === 'absent' ? baseline.originalEnvironment : { ...baseline.originalEnvironment, domain: marker.hostname, domainProxy: false,
          dns: { ...marker.dns, ttl: revision === 'create' ? 300 : 600 } };
        await cli(['spec', 'set'], { project: project.name, replace: true, spec: { ...current, environments: { ...current.environments, [environment.name]: desired } } }, directory, dataDir);
      };
      const plan = async (stage: 'create' | 'update' | 'absent') => {
        const result = await cli(['plan'], { project: project.name, env: environment.name }, directory, dataDir);
        fixturePreview(result, { profile: marker.profile, project: project.name, environment: environment.name });
        assertDnsFixtureActions(result.data.actions, marker, stage); return result;
      };
      const target = { profile: marker.profile, project: project.name, environment: environment.name };
      if (mode === 'preview' && !cleanupOnly) {
        if (journal.phase !== 'prepared' || (await inventory()).length) throw new Error('Preview requires an empty prepared DNS fixture.');
        await setDesired('create'); const result = await plan('create'); const preview = fixturePreview(result, target);
        writeFileSync(previewFile, `${JSON.stringify(preview, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`\nDNS fixture preview saved: ${previewFile}\nPlan: ${preview.planId}\nNo provider apply was executed.\n`); return;
      }
      if (!existsSync(previewFile)) throw new Error('The original DNS preview is required for lifecycle continuation or cleanup.');
      const preview = JSON.parse(readFileSync(previewFile, 'utf8')) as FixturePreview;
      assertFixtureLifecycleConsent(process.env.HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE);
      assertFixtureContinuation(preview, target, process.env.HYPERVIBE_LIVE_APPROVED_PLAN_ID);
      let firstPlan: Json | undefined;
      if (!cleanupOnly) {
        const row = db.prepare('SELECT plan FROM runs WHERE id = ?').get(preview.planId) as { plan: string } | undefined;
        if (!row) throw new Error('The exact approved saved DNS plan is no longer available.'); firstPlan = { data: { ...JSON.parse(row.plan), planId: preview.planId } };
      }
      let stage: 'create' | 'update' | 'absent' = cleanupOnly ? 'absent' : 'create';
      const assertNoop = async () => {
        const result = await plan(stage); if (result.data.actions.some((action: Json) => action.type !== 'noop')) throw new Error('The unchanged DNS fixture did not produce a noop plan.');
        const applied = await cli(['apply'], { project: project.name, planId: result.data.planId, confirmActions: [] }, directory, dataDir);
        if (!Array.isArray(applied.data?.receipts) || applied.data.receipts.some((receipt: Json) => receipt.status !== 'skipped_noop')) throw new Error('Applying the DNS noop did not confirm zero mutations.');
        await preserve(stage === 'absent');
      };
      const retainedResources = baseline.proof.filter(record => marker.dns.adoptRecords?.some(selected => selected.id === record.nativeId))
        .map(record => ({ provider: marker.dns.provider, type: record.type, id: record.nativeId }));
      await runDisposableFixture({ journal, save, cleanupOnly, retainedResources, driver: {
        inventory, assertNoop,
        observe: async resource => {
          try { return dnsFixtureCleanupState(resource, await readDnsFixtureRecords(connected.observer, marker), baseline.proof); }
          catch { return 'unknown'; }
        },
        converge: async revision => {
          stage = revision;
          if (!(revision === 'create' && firstPlan)) await setDesired(revision);
          for (let attempt = 0; attempt < 8; attempt++) {
            const result = firstPlan ?? await plan(revision); firstPlan = undefined;
            assertDnsFixtureActions(result.data.actions, marker, revision);
            const changes = result.data.actions.filter((action: Json) => action.type !== 'noop');
            if (!changes.length) { await preserve(); return; }
            const applied = await cli(['apply'], { project: project.name, planId: result.data.planId,
              confirmActions: changes.filter((action: Json) => action.billable || action.dataBearing || action.requiresConfirm).map((action: Json) => action.id) }, directory, dataDir);
            if (!Array.isArray(applied.data?.receipts) || applied.data.receipts.some((receipt: Json) => !['succeeded', 'skipped_noop'].includes(receipt.status)))
              throw new Error('DNS apply is incomplete; dependent fixture work is stopped.');
            await preserve();
          }
          throw new Error('DNS fixture convergence exceeded its bounded plan/apply steps.');
        },
        verifyRunning: async revision => {
          const records = await readDnsFixtureRecords(connected.observer, marker);
          assertDnsFixtureValues(owned(), records, revision === 'create' ? 300 : 600, baseline.proof);
          await assertPublicDns(records);
          const response = await fetch(`https://${marker.hostname}/`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
          assertFixtureHttpResponse(response.status, await response.json(), marker.expectedRevision); await preserve();
        },
      } });
      await preserve(true);
      process.stdout.write(`\nDNS fixture ${marker.profile} ${cleanupOnly ? 'cleanup verified; lifecycle proof not claimed' : 'completed with new records absent and original shared-zone values retained'}.\n`);
    } finally {
      SqliteAdapter.resetInstance(); SecretStore.resetInstance();
      if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR; else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
    }
  }, 90 * 60_000);
});
