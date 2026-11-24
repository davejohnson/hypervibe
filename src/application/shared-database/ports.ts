import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import type { EngineActionSegment, EngineConfiguration, EngineSegmentResult, EngineStateIdentity } from '../../domain/ports/infrastructure-engine.port.js';

/**
 * What the shared database module needs from outside itself. Tests replace
 * these with fakes over a local PostgreSQL; `google.ts` is the real thing.
 */
export type Seen<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };

export interface SeenServer {
  instanceName: string;
  region: string;
  /** Accepting connections now. */
  runnable: boolean;
  /** Google itself refuses to delete it while this is on. */
  deletionProtection: boolean;
  labels: Record<string, string>;
}

export interface SeenConnectionSecret {
  /** Ownership labels plus what Hypervibe recorded about the latest version. */
  labels: Record<string, string>;
  hasEnabledVersion: boolean;
  latestVersion?: string;
}

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SqlTarget { connectionName: string; user: string; password: string; database: string }

export interface SharedDatabaseCloud {
  /** Every database server in the Google project. Never a partial list: anything short of the whole answer is `unknown`. */
  listServers(gcpProjectId: string): Promise<{ state: 'listed'; servers: SeenServer[] } | { state: 'unknown'; reason: string }>;
  /** Creates a built-in login on the server, or gives an existing one a new password. Undefined when done. */
  setServerLogin(gcpProjectId: string, instanceName: string, login: string, password: string): Promise<ActionResult | undefined>;
  readAdministratorSecret(gcpProjectId: string, secretId: string): Promise<Seen<{ labels: Record<string, string>; value?: string }>>;
  /** Undefined when stored. */
  writeAdministratorSecret(gcpProjectId: string, secretId: string, value: string): Promise<ActionResult | undefined>;
  /** The environment's own connection secret (DATABASE_URL). */
  observeConnectionSecret(gcpProjectId: string, secretId: string): Promise<Seen<SeenConnectionSecret>>;
  /** Stores a new version with what Hypervibe records about it. Undefined when stored. */
  publishConnectionSecret(gcpProjectId: string, secretId: string, labels: Record<string, string>, value: string): Promise<ActionResult | undefined>;
  /** Replaces what is recorded about an existing version. False when it could not be recorded. */
  relabelConnectionSecret(gcpProjectId: string, secretId: string, version: string, labels: Record<string, string>): boolean;
  /** Opens one SQL session, runs `work`, and always closes it. */
  withSession<T>(target: SqlTarget, work: (session: SqlSession) => Promise<T>): Promise<T>;
}

/** The lifecycle engine, already bound to the caller's credentials. The module supplies its own configuration and state. */
export interface SharedDatabaseEngine {
  plan(configuration: EngineConfiguration, state: EngineStateIdentity, planId: string, destroy?: boolean): Promise<
    { ok: true; actions: PlanAction[]; blockers: string[]; segment: Omit<EngineActionSegment, 'addresses'> } | { ok: false; error: string }>;
  apply(state: EngineStateIdentity, planId: string, segment: EngineActionSegment): Promise<EngineSegmentResult>;
}
