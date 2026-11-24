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
  /**
   * The latest version is one Hypervibe has no record of: a write that Google accepted and Hypervibe never heard back
   * about. Nothing is known about what it holds, so it is never treated as a working credential.
   */
  unrecorded?: boolean;
}

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SqlTarget { connectionName: string; user: string; password: string; database: string }

export interface SharedDatabaseCloud {
  /** Every database server in the Google project. Never a partial list: anything short of the whole answer is `unknown`. */
  listServers(gcpProjectId: string): Promise<{ state: 'listed'; servers: SeenServer[] } | { state: 'unknown'; reason: string }>;
  /** Creates a built-in login on the server, or gives an existing one a new password. Undefined when done; `pending` when the server is busy with another change. */
  setServerLogin(gcpProjectId: string, instanceName: string, login: string, password: string): Promise<ActionResult | undefined>;
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
  /**
   * `review` is shown the engine's own complete plan (OpenTofu's JSON form) before it is saved, and again, read back
   * from the saved plan, before it is applied. Unless it answers true the plan is not saved, or nothing is applied.
   */
  plan(configuration: EngineConfiguration, state: EngineStateIdentity, planId: string, review: EnginePlanReview, destroy?: boolean): Promise<
    { ok: true; actions: PlanAction[]; blockers: string[]; segment: Omit<EngineActionSegment, 'addresses'> } | { ok: false; error: string }>;
  apply(state: EngineStateIdentity, planId: string, segment: EngineActionSegment, review: EnginePlanReview): Promise<EngineSegmentResult>;
}

export type EnginePlanReview = (shownPlan: unknown) => boolean;
