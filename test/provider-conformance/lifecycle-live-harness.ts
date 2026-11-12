import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface NativeFixtureResource {
  provider: string;
  type: string;
  id: string;
  /** Engine address or provider-qualified inventory key, never a display name. */
  address: string;
}

export interface FixtureJournal {
  version: 1;
  profile: string;
  project: string;
  environment: string;
  phase: 'prepared' | 'creating' | 'running' | 'updating' | 'cleaning' | 'cleaned' | 'cleanup-required';
  resources: NativeFixtureResource[];
  checks: { created: boolean; noop: boolean; updated: boolean; absent: boolean };
}

export interface LifecycleFixtureDriver {
  /** Fresh complete provider/engine inventory; errors must throw, never return []. */
  inventory(): Promise<NativeFixtureResource[]>;
  /** All mutations are installed Hypervibe spec/plan/apply/release commands. */
  converge(revision: 'create' | 'update' | 'absent'): Promise<void>;
  assertNoop(): Promise<void>;
  /** Require exact fixture JSON body, revision, and a provider-ready workload. */
  verifyRunning(revision: 'create' | 'update'): Promise<void>;
  /** Read the exact saved native identity; state/binding disappearance is insufficient. */
  observe(resource: NativeFixtureResource): Promise<'present' | 'absent' | 'unknown'>;
}

export function resourceKey(resource: NativeFixtureResource): string {
  if (![resource.provider, resource.type, resource.id, resource.address].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Fixture inventory contains an incomplete native identity.');
  }
  return `${resource.provider}:${resource.type}:${resource.id}`;
}

export function readFixtureJournal(file: string): FixtureJournal {
  const result = JSON.parse(readFileSync(file, 'utf8')) as FixtureJournal;
  if (result.version !== 1 || !result.profile || !result.project || !result.environment || !Array.isArray(result.resources)
    || !result.checks || !['prepared', 'creating', 'running', 'updating', 'cleaning', 'cleaned', 'cleanup-required'].includes(result.phase)) {
    throw new Error('The fixture journal is invalid; preserve it for recovery.');
  }
  result.resources.forEach(resourceKey);
  return result;
}

export function saveFixtureJournal(file: string, journal: FixtureJournal): void {
  // Only an explicit projection can cross the evidence/output boundary.
  const safe: FixtureJournal = { version: 1, profile: journal.profile, project: journal.project, environment: journal.environment,
    phase: journal.phase, checks: journal.checks,
    resources: journal.resources.map(({ provider, type, id, address }) => ({ provider, type, id, address })) };
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Shared acceptance boundary, injected only at commands and provider transport in offline tests. */
export async function runDisposableFixture(params: {
  journal: FixtureJournal;
  save(journal: FixtureJournal): void;
  driver: LifecycleFixtureDriver;
  cleanupOnly?: boolean;
  signal?: AbortSignal;
}): Promise<FixtureJournal> {
  const { journal, driver, save } = params;
  if (!params.cleanupOnly && journal.phase !== 'prepared') {
    throw new Error('A previous fixture may still exist. Resume with cleanup-only before starting another run.');
  }
  const persist = () => save(journal);
  const remember = async () => {
    const current = await driver.inventory();
    const byIdentity = new Map(journal.resources.map((resource) => [resourceKey(resource), resource]));
    for (const resource of current) byIdentity.set(resourceKey(resource), resource);
    journal.resources = [...byIdentity.values()];
    persist();
  };
  const interrupted = () => {
    if (params.signal?.aborted) throw new Error('Fixture interrupted; cleanup is required.');
  };
  let primaryFailure: unknown;
  try {
    if (!params.cleanupOnly) {
      const baseline = await driver.inventory();
      if (baseline.length) throw new Error('The dedicated fixture environment is not empty; existing resources are not authorized for this test.');
      interrupted();
      journal.phase = 'creating';
      persist(); // Crash recovery is durable before the first provider mutation.
      try { await driver.converge('create'); } finally { await remember(); }
      if (!journal.resources.length) throw new Error('Apply produced no exact native resource inventory.');
      interrupted();
      await driver.verifyRunning('create');
      journal.checks.created = true;
      journal.phase = 'running';
      persist();
      await driver.assertNoop();
      journal.checks.noop = true;
      persist();
      interrupted();
      const identities = new Set(journal.resources.map(resourceKey));
      journal.phase = 'updating';
      persist();
      try { await driver.converge('update'); } finally { await remember(); }
      if (journal.resources.some((resource) => !identities.has(resourceKey(resource)))) {
        throw new Error('The update created a new native resource instead of updating the fixture.');
      }
      interrupted();
      await driver.verifyRunning('update');
      await driver.assertNoop();
      journal.checks.updated = true;
      persist();
    }
  } catch (error) {
    primaryFailure = error;
  }
  // A failed empty-environment preflight must never clean up someone else's resources.
  if (journal.phase === 'prepared' && !params.cleanupOnly) throw primaryFailure;
  try {
    await remember(); // Persist every observed exact id BEFORE changing desired state.
    journal.phase = 'cleaning';
    persist();
    await driver.converge('absent');
    for (const resource of journal.resources) {
      if (await driver.observe(resource) !== 'absent') {
        throw new Error(`Native absence was not confirmed for ${resource.address} (${resource.id}).`);
      }
    }
    if ((await driver.inventory()).length) throw new Error('The fixture inventory still contains native resources after teardown.');
    await driver.assertNoop();
    journal.checks.absent = true;
    journal.phase = 'cleaned';
    persist();
  } catch {
    journal.phase = 'cleanup-required';
    persist();
    throw new Error('Fixture cleanup is unverified. Preserve the journal, workspace and encrypted Hypervibe state; run cleanup-only with the same profile and credentials.');
  }
  if (primaryFailure) throw primaryFailure;
  return journal;
}

export function assertFixtureHttpResponse(status: number, value: unknown, revision: string): void {
  const body = value as { service?: string; revision?: string } | null;
  if (status !== 200 || body?.service !== 'hypervibe-provider-conformance' || body.revision !== revision) {
    throw new Error(`The fixture did not serve the expected ${revision} application revision.`);
  }
}
