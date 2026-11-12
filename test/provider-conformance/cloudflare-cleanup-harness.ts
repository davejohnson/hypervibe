import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ILoadBalancerAdapter } from '../../src/domain/ports/load-balancer.port.js';
import { safeLoadBalancerBinding } from './infrastructure-live-harness.js';

type ResourceKind = 'monitor' | 'pool' | 'load-balancer';
type Observation = 'present' | 'absent' | 'unknown';
export interface CloudflareFixtureResource {
  kind: ResourceKind;
  id: string;
  accountId: string;
  zoneId: string;
}
export interface CloudflareCleanupJournal {
  version: 1;
  profile: 'cloudflare-load-balancer';
  project: string;
  environment: string;
  hostname: string;
  phase: 'prepared' | 'creating' | 'running' | 'updating' | 'cleaning' | 'cleaned' | 'cleanup-required';
  resources: CloudflareFixtureResource[];
  /** A failed or interrupted create without a new durable id remains unknown. */
  pendingCreates: Array<{ kind: ResourceKind; priorIds: string[] }>;
  observations: Record<string, Observation>;
}
type ReadAdapter = Pick<ILoadBalancerAdapter, 'getMonitor' | 'getPool' | 'getLoadBalancer'>;
const kinds: ResourceKind[] = ['monitor', 'pool', 'load-balancer'];
function segment(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value); }
export function cloudflareFixtureKey(resource: CloudflareFixtureResource): string {
  if (!kinds.includes(resource.kind) || ![resource.id, resource.accountId, resource.zoneId].every(segment)) {
    throw new Error('The Cloudflare fixture contains an incomplete native identity; preserve its journal.');
  }
  return `${resource.kind}:${resource.kind === 'load-balancer' ? resource.zoneId : resource.accountId}:${resource.id}`;
}
export function newCloudflareCleanupJournal(project: string, environment: string, hostname: string): CloudflareCleanupJournal {
  if (!/^hv-conformance-cloudflare-[a-z0-9-]+$/.test(project) || environment !== 'conformance'
    || !/^hv-conformance-[a-z0-9-]+\.[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('Cloudflare conformance requires its own isolated fixture project and hostname.');
  }
  return { version: 1, profile: 'cloudflare-load-balancer', project, environment, hostname,
    phase: 'prepared', resources: [], pendingCreates: [], observations: {} };
}
export function saveCloudflareCleanupJournal(file: string, journal: CloudflareCleanupJournal): void {
  // Project only exact non-secret identities; raw credentials/provider responses never persist.
  const safe: CloudflareCleanupJournal = { version: 1, profile: 'cloudflare-load-balancer', project: journal.project,
    environment: journal.environment, hostname: journal.hostname, phase: journal.phase,
    resources: journal.resources.map(({ kind, id, accountId, zoneId }) => ({ kind, id, accountId, zoneId })),
    pendingCreates: journal.pendingCreates.map(({ kind, priorIds }) => ({ kind, priorIds: [...priorIds] })),
    observations: Object.fromEntries(journal.resources.map((resource) => cloudflareFixtureKey(resource))
      .filter((key) => ['present', 'absent', 'unknown'].includes(journal.observations[key] ?? ''))
      .map((key) => [key, journal.observations[key]!])) };
  safe.resources.forEach(cloudflareFixtureKey);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
export function readCloudflareCleanupJournal(file: string, expected: Pick<CloudflareCleanupJournal, 'project' | 'environment' | 'hostname'>): CloudflareCleanupJournal {
  const journal = JSON.parse(readFileSync(file, 'utf8')) as CloudflareCleanupJournal;
  if (journal.version !== 1 || journal.profile !== 'cloudflare-load-balancer' || journal.project !== expected.project
    || journal.environment !== expected.environment || journal.hostname !== expected.hostname
    || !['prepared', 'creating', 'running', 'updating', 'cleaning', 'cleaned', 'cleanup-required'].includes(journal.phase)
    || !Array.isArray(journal.resources) || !Array.isArray(journal.pendingCreates) || !journal.observations
    || journal.pendingCreates.some((entry) => !kinds.includes(entry.kind) || !Array.isArray(entry.priorIds) || !entry.priorIds.every(segment))) {
    throw new Error('Cloudflare cleanup journal does not match this dedicated fixture; preserve state and inspect it.');
  }
  journal.resources.forEach(cloudflareFixtureKey);
  return journal;
}
/** Binding is the existing safe projection from Hypervibe's durable environment state. */
export function rememberCloudflareBinding(journal: CloudflareCleanupJournal, rawBinding: unknown): void {
  if (rawBinding === null) return; // Never forget saved ids when apply clears local bindings.
  if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) throw new Error('The Cloudflare fixture binding is unreadable.');
  const binding = rawBinding as Record<string, unknown>;
  if (binding.provider !== 'cloudflare' || binding.hostname !== journal.hostname || !segment(binding.accountId) || !segment(binding.zoneId)) {
    throw new Error('Cloudflare fixture binding scope or ownership is unknown; preserve state.');
  }
  const remembered = new Map(journal.resources.map((resource) => [cloudflareFixtureKey(resource), resource]));
  for (const [kind, field] of [['monitor', 'monitorId'], ['pool', 'poolId'], ['load-balancer', 'loadBalancerId']] as const) {
    if (binding[field] === undefined) continue;
    if (!segment(binding[field])) throw new Error('Cloudflare fixture binding has an invalid native id.');
    const resource: CloudflareFixtureResource = { kind, id: binding[field], accountId: binding.accountId, zoneId: binding.zoneId };
    remembered.set(cloudflareFixtureKey(resource), resource);
    journal.pendingCreates = journal.pendingCreates.filter((entry) => entry.kind !== kind || entry.priorIds.includes(resource.id));
  }
  journal.resources = [...remembered.values()];
}
export function beginCloudflareApply(journal: CloudflareCleanupJournal, actions: Array<{ type?: string; metadata?: Record<string, unknown> }>): void {
  if (!actions.length) return;
  const operations: Record<string, ResourceKind> = { loadBalancerMonitorEnsure: 'monitor', loadBalancerPoolEnsure: 'pool', loadBalancerEnsure: 'load-balancer' };
  for (const action of actions) {
    const kind = typeof action.metadata?.operation === 'string' ? operations[action.metadata.operation] : undefined;
    if (action.type !== 'create' || !kind) continue;
    if (!journal.pendingCreates.some((entry) => entry.kind === kind)) journal.pendingCreates.push({ kind,
      priorIds: journal.resources.filter((resource) => resource.kind === kind).map((resource) => resource.id) });
  }
  if (journal.phase !== 'cleaning') journal.phase = journal.pendingCreates.length ? 'creating' : 'updating';
}

/** Both snapshots are read-only; SQLite remains available if CLI output/repo export failed. */
export async function captureCloudflareFixtureInventory(params: {
  journal: CloudflareCleanupJournal; databaseFile: string; bindingsFile: string;
  save(journal: CloudflareCleanupJournal): void;
}): Promise<void> {
  const { journal, save } = params;
  if (existsSync(params.databaseFile)) {
    const database = new Database(params.databaseFile, { readonly: true, fileMustExist: true });
    try {
      const row = database.prepare(`SELECT environments.platform_bindings FROM environments
        JOIN projects ON projects.id = environments.project_id
        WHERE projects.name = ? AND environments.name = ?`).get(journal.project, journal.environment) as { platform_bindings: string } | undefined;
      if (row) rememberCloudflareBinding(journal, safeLoadBalancerBinding({ environments: {
        [journal.environment]: { platformBindings: JSON.parse(row.platform_bindings) },
      } }, journal.environment));
      save(journal);
    } finally { database.close(); }
  }
  if (existsSync(params.bindingsFile)) {
    rememberCloudflareBinding(journal, safeLoadBalancerBinding(JSON.parse(readFileSync(params.bindingsFile, 'utf8')), journal.environment));
  }
  save(journal);
}
/** Reads only exact native identities; neither empty plans nor missing bindings prove absence. */
export async function verifyCloudflareFixtureAbsent(journal: CloudflareCleanupJournal, adapter: ReadAdapter,
  save: (journal: CloudflareCleanupJournal) => void): Promise<void> {
  journal.phase = 'cleaning';
  save(journal);
  let incomplete = journal.pendingCreates.length > 0;
  for (const resource of journal.resources) {
    let observed: Observation = 'unknown';
    try {
      const result = resource.kind === 'monitor' ? await adapter.getMonitor(resource.accountId, resource.id)
        : resource.kind === 'pool' ? await adapter.getPool(resource.accountId, resource.id)
          : await adapter.getLoadBalancer(resource.zoneId, resource.id);
      observed = result === null ? 'absent' : result.id === resource.id ? 'present' : 'unknown';
    } catch { /* 403, timeouts, malformed responses and transport errors remain unknown. */ }
    journal.observations[cloudflareFixtureKey(resource)] = observed;
    incomplete ||= observed !== 'absent';
    save(journal);
  }
  journal.phase = incomplete ? 'cleanup-required' : 'cleaned';
  save(journal);
  if (incomplete) throw new Error('Cloudflare fixture deletion is not fully confirmed by the provider. Preserve the journal and Hypervibe state for retry.');
}

/** Capture identities even when the installed Hypervibe apply throws or returns failure. */
export async function applyWithCloudflareInventory<T>(params: {
  journal: CloudflareCleanupJournal; save(journal: CloudflareCleanupJournal): void;
  actions: Array<{ type?: string; metadata?: Record<string, unknown> }>;
  capture(): Promise<void>; apply(): Promise<T>;
}): Promise<T> {
  await params.capture();
  beginCloudflareApply(params.journal, params.actions);
  params.save(params.journal); // Crash evidence is durable before starting a mutation.
  try { return await params.apply(); }
  catch (error) { params.journal.phase = 'cleanup-required'; params.save(params.journal); throw error; }
  finally {
    try { await params.capture(); }
    catch { params.journal.phase = 'cleanup-required'; params.save(params.journal);
      throw new Error('The Cloudflare apply inventory could not be captured. Preserve the fixture workspace and Hypervibe state.'); }
  }
}
