/**
 * Cloud-neutral contract between Hypervibe's plan/apply lifecycle and a
 * declarative infrastructure engine (currently OpenTofu).
 *
 * Hypervibe keeps the decisions: desired spec, approvals, secret ownership,
 * redaction and operation history. The engine computes and executes resource
 * changes for the capabilities a provider has assigned to it. Each cloud
 * supplies its own configuration, authentication and resource mapping through
 * an {@link InfrastructureEngineBackend}; nothing in this file may depend on a
 * specific cloud.
 */
import type { PlanAction, PlanActionType, PlanResourceKind } from '../plan/plan.types.js';
import type { ProviderLifecycleCapability } from '../registry/provider.registry.js';

/**
 * Durable identity of one engine state. Derived from Hypervibe identities,
 * never from temporary directories or Git branches, so that losing a working
 * directory cannot orphan or recreate resources.
 */
export interface EngineStateIdentity {
  provider: string;
  projectId: string;
  environmentId: string;
  /**
   * State partition. `environment` holds only environment-owned resources;
   * project-wide identities, billing, shared IAM and bootstrap resources must
   * live in a separately owned partition and never in several environments.
   */
  partition: 'environment' | 'project-shared';
}

export function engineStateKey(identity: EngineStateIdentity): string {
  for (const part of [identity.provider, identity.projectId, identity.environmentId]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(part)) {
      throw new Error('Engine state identity contains an unsupported character; refusing to derive a state path.');
    }
  }
  return [identity.provider, identity.projectId, identity.environmentId, identity.partition].join('/');
}

/** Engine actions as reported by the engine's machine-readable plan. */
export type EngineChangeAction = 'create' | 'update' | 'replace' | 'delete' | 'noop' | 'read';

export interface EngineResourceChange {
  /** Engine address, e.g. `google_cloud_run_v2_service.web`. */
  address: string;
  /** Engine resource type, e.g. `google_cloud_run_v2_service`. */
  type: string;
  action: EngineChangeAction;
  /** Top-level attribute paths whose planned values differ (never values). */
  changedAttributes: string[];
  /** True when the engine marked any planned attribute as sensitive. */
  hasSensitiveValues: boolean;
}

/** Hypervibe meaning of one engine resource address. */
export interface EngineResourceMapping {
  actionId: string;
  kind: PlanResourceKind;
  name: string;
  /** Data-bearing resources require explicit confirmation before delete/replace. */
  dataBearing?: boolean;
  /** Creating or replacing this resource can charge the provider account. */
  billable?: boolean;
}

/** Files of one generated engine configuration. Values must not include secrets. */
export interface EngineConfiguration {
  /** Relative file name -> JSON-serializable configuration document. */
  files: Record<string, unknown>;
  /** Every engine address this configuration may legitimately change. */
  resources: Record<string, EngineResourceMapping>;
}

/** Process environment for the engine plus the exact secret values to redact. */
export interface EngineAuthentication {
  env: Record<string, string>;
  /** Exact secret values that must be scrubbed from every engine output. */
  redact: string[];
}

export interface EngineProviderRequirement {
  /** Registry source, e.g. `hashicorp/google`. */
  source: string;
  /** Exact pinned version; ranges are rejected so deployments never upgrade silently. */
  version: string;
  /** Exact `h1:`/`zh:` hashes written into the dependency lock file for every supported platform. */
  lockHashes: string[];
}

/**
 * Provider-owned half of the engine integration. One backend per cloud;
 * shared runner, state, encryption, approval and receipt handling stay generic.
 */
export interface InfrastructureEngineBackend<TInput = unknown> {
  provider: string;
  engine: 'opentofu';
  /** Lifecycle capabilities whose resource changes this backend owns. */
  capabilities: readonly ProviderLifecycleCapability[];
  providerRequirements: Record<string, EngineProviderRequirement>;
  /** Pure function of approved, non-secret inputs. */
  buildConfiguration(input: TInput): EngineConfiguration;
  /** Read-only configuration proving identity and target scope. */
  buildAuthenticationProbe(input: { projectId: string }): EngineConfiguration;
}

export interface EngineActionSegment {
  /** Stable id shared by every PlanAction executed by one saved engine plan. */
  id: string;
  engine: 'opentofu';
  /** sha256 of the encrypted saved-plan artifact reviewed with this plan. */
  planDigest: string;
  /** sha256 of the generated configuration files. */
  configurationDigest: string;
  engineVersion: string;
  providerVersions: Record<string, string>;
  /** Engine addresses this PlanAction authorizes. */
  addresses: string[];
}

export function engineSegmentOf(action: PlanAction): EngineActionSegment | undefined {
  const raw = action.metadata?.engineSegment;
  if (!raw || typeof raw !== 'object') return undefined;
  const segment = raw as Partial<EngineActionSegment>;
  if (
    typeof segment.id !== 'string'
    || segment.engine !== 'opentofu'
    || typeof segment.planDigest !== 'string'
    || !Array.isArray(segment.addresses)
  ) {
    return undefined;
  }
  return raw as EngineActionSegment;
}

/** Per-address outcome of executing a saved engine plan. */
export type EngineAddressOutcome = 'succeeded' | 'failed' | 'unknown' | 'not_started';

export interface EngineSegmentResult {
  outcomes: Record<string, EngineAddressOutcome>;
  /** Sanitized diagnostics; never contains supplied secret values. */
  diagnostics: string[];
}

export const ENGINE_ACTION_TYPE: Record<Exclude<EngineChangeAction, 'read'>, PlanActionType> = {
  create: 'create',
  update: 'update',
  replace: 'replace',
  delete: 'destroy',
  noop: 'noop',
};
