import type { Service } from '../entities/service.entity.js';
import type { Component } from '../entities/component.entity.js';

export type PlanActionType = 'create' | 'update' | 'replace' | 'destroy' | 'noop';

export type PlanResourceKind = 'project' | 'environment' | 'service' | 'database' | 'storage' | 'domain' | 'ci' | 'repo' | 'ios' | 'queue' | 'secret';

export interface PlanFieldDiff {
  /** Field name; env vars appear as "env:KEY" with no values. */
  field: string;
  from?: string;
  to?: string;
}

export interface PlanAction {
  /** Stable id, e.g. "service:web", "database:postgres". */
  id: string;
  type: PlanActionType;
  resource: {
    kind: PlanResourceKind;
    name: string;
    provider: string;
  };
  /** False when derived from local state only (provider not observable). */
  verified: boolean;
  reason: string;
  diff?: PlanFieldDiff[];
  /** Destroying this resource loses data (databases). */
  dataBearing?: boolean;
  /** Creating/updating this resource can charge the provider account. */
  billable?: boolean;
  /** Action is skipped by apply unless explicitly confirmed. */
  requiresConfirm?: boolean;
  /** Ids of actions that must complete first. */
  dependsOn?: string[];
  /** Provider/action-specific non-secret context shown in plans and persisted with the plan. */
  metadata?: Record<string, unknown>;
}

/** Local (SQLite) view of an environment, input to the diff. */
export interface LocalSnapshot {
  projectExists: boolean;
  environmentExists: boolean;
  services: Service[];
  components: Component[];
  bindings?: {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId?: string; url?: string; customDomains?: string[] }>;
    /** Bindings of the hosting provider abandoned by a provider switch; drives confirm-gated teardown. */
    previousHosting?: {
      provider?: string;
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
    storage?: Record<string, { provider?: string; externalId?: string; region?: string }>;
  };
}

export interface DiffResult {
  actions: PlanAction[];
  /** Live resources absent from the spec with no local binding proving Hypervibe ownership. */
  unmanaged: Array<{ kind: PlanResourceKind | 'envVar'; name: string; detail?: string }>;
  warnings: string[];
}
