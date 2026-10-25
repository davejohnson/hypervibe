import type { PlanAction } from '../plan/plan.types.js';
import type { SecretDestination } from './secret-destination.port.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentSessionRequestV1, CloudDeploymentSessionV1, CloudDeploymentTopologyV1,
  CloudDeploymentReleaseTargetV1, CloudDeploymentReleaseTargetRequestV1 } from './cloud-deployment.port.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

/** Reviewed roster, not a claim of live compatibility. */
export const CLOUD_INSTALLATION_PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type CloudInstallationProvider = typeof CLOUD_INSTALLATION_PROVIDERS[number];
export type CloudInstallationStage = 'scope-preparation' | 'collection' | 'deployment';
export const CLOUD_INSTALLATION_SECRET_PROVIDERS = { aws: 'aws-secrets', azure: 'azure-key-vault', gcp: 'gcp-secret-manager' } as const;

export interface CloudInstallationHostIdentity {
  kind: 'gcp-service-account';
  projectId: string;
  projectNumber: string;
  serviceAccountEmail: string;
  subject: string;
  issuer: 'https://accounts.google.com';
}
export interface CloudInstallationIntent {
  schemaVersion: 1;
  installationId: string;
  customerId: string;
  appId: string;
  environment: string;
  source: { repository: string; branch: string; revision: string; specDigest: string };
  provider: CloudInstallationProvider;
  /** Omitted historical records retain collection purpose and their original digest. */
  purpose?: 'collection' | 'deployment';
  /** Exact committed hosting topology and immutable runtime references, separately reviewed. */
  deployment?: CloudDeploymentTopologyV1;
  mode: 'connect' | 'migrate' | 'disconnect';
  /** Omitted on historical collection records; scope preparation never authorizes writers. */
  stage?: CloudInstallationStage;
  /** Immutable predecessor, separately reviewed before the collection installation. */
  scopePreparation?: { installationId: string; planDigest: string };
  /** Provider's strict schema; only nonsecret native scope identifiers. */
  nativeScope: Record<string, string>;
  hostIdentity: CloudInstallationHostIdentity;
  /** Collection keys; deployment installation requires the explicit empty list. */
  keys: string[];
  /** Reviewed existing destinations; migration replaces writer authorization, never native values or references. */
  migrationTargets?: Array<{ key: string; destination: SecretDestination }>;
  /** Exact previously verified resources for a separate disconnect review. */
  installed?: CloudInstallationEvidence[];
}
export interface CloudInstallationAction extends PlanAction {
  resource: PlanAction['resource'] & { provider: CloudInstallationProvider };
  metadata: {
    operation: string;
    category: 'scope' | 'identity' | 'trust' | 'secret-container' | 'verification';
    execution: 'api' | 'external';
    /** Provider parses this with a strict native schema before use or persistence. */
    native: Record<string, unknown>;
  };
}
export interface CloudInstallationReview {
  /** Native children of an atomic installation (for example a CloudFormation stack). */
  resources?: Array<{ kind: string; name: string; scope: string }>;
  permissions: Array<{ principal: string; scope: string; actions: string[]; purpose: 'writer' | 'installation-verification' | 'hosted-trust-removal' | 'deployment-provision' | 'deployment-release' | 'runtime-reader' }>;
  costs: Array<{ resource: string; description: string; pricingUrl: string }>;
  warnings: string[];
}
export interface CloudInstallationEvidence {
  /** Exact native IDs, including immutable lifetime IDs where the provider has them. */
  resources: Array<{ kind: string; id: string; identity: Record<string, string> }>;
  /** Native operation identity and ownership correlation, never provider response bodies. */
  native: Record<string, unknown>;
}
export const CLOUD_INSTALLATION_REASONS = ['provider_error', 'insufficient_permissions', 'identity_mismatch',
  'ownership_mismatch', 'create_ownership_unverified', 'not_converged', 'not_installed', 'authorization_expired',
  'authorization_revoked', 'timeout', 'cancelled', 'confirmation_required', 'retry_confirmation_required', 'billing_assignment_unverified'] as const;
export type CloudInstallationReason = typeof CLOUD_INSTALLATION_REASONS[number];
/** Closed provider outcome; raw native exception messages never cross the hosted boundary. */
export class CloudInstallationBoundaryError extends Error {
  constructor(readonly reason: CloudInstallationReason) { super(reason); this.name = 'CloudInstallationBoundaryError'; }
}
export type CloudInstallationObservation =
  | { state: 'satisfied'; evidence: CloudInstallationEvidence }
  | { state: 'action-required' }
  | { state: 'pending' | 'unknown' | 'conflict' | 'rejected'; reason: CloudInstallationReason };
export type CloudInstallationMutation =
  | { state: 'acknowledged'; evidence?: CloudInstallationEvidence }
  | { state: 'rejected' | 'uncertain'; reason: CloudInstallationReason }
  | { state: 'external'; url: string };

/** Transient callbacks are never included in durable records or command results. */
export interface CloudInstallationAuthentication {
  administrator?: { getAccessToken(scope: string, signal: AbortSignal): Promise<string> };
  host: {
    verifyIdentity(signal: AbortSignal): Promise<CloudInstallationHostIdentity>;
    getIdToken(audience: string, signal: AbortSignal): Promise<string>;
    getAccessToken(signal: AbortSignal): Promise<string>;
  };
}
export interface CloudInstallationAttempt {
  id: string;
  actionId: string;
  status: 'attempted' | 'acknowledged' | 'pending' | 'uncertain' | 'rejected' | 'succeeded';
  startedAt: string;
  updatedAt: string;
  evidence?: CloudInstallationEvidence;
  externalUrl?: string;
  reason?: CloudInstallationReason;
}
export interface CloudInstallationProviderContext {
  intent: CloudInstallationIntent;
  authentication: CloudInstallationAuthentication;
  signal: AbortSignal;
  /** Verified exact predecessor identities; name/tag matches cannot replace these. */
  completed: Readonly<Record<string, CloudInstallationEvidence>>;
  /** Durable attempts in this operation, including later cleanup whose response was lost. */
  attempts?: readonly CloudInstallationAttempt[];
  /** Call after prerequisite reads immediately before a native write or external install-link handoff. */
  beforeMutation(): Promise<void>;
}
export interface CloudInstallationScopeDiscovery {
  state: 'complete' | 'partial' | 'unknown';
  scopes: Array<{ nativeScope: Record<string, string>; label: string; stage?: CloudInstallationStage }>;
  /** Discovery/sign-in never proves permission to install. */
  authority: 'not-verified';
  cursor?: string;
}
export interface CloudInstallationDriver {
  readonly provider: CloudInstallationProvider;
  /** Explicit separate installation capability; collection support never implies deployment authority. */
  deployment?: {
    hostingProvider: string;
    connection(record: CloudInstallationRecord): CloudDeploymentConnectionV1;
    /** Derives the reviewed subset from the exact source; cannot change customer/app/source/scope. */
    prepareIntent?(spec: ProjectSpec, intent: CloudInstallationIntent): CloudDeploymentTopologyV1;
    /** Provider must verify immutable native principal and reviewed trust before every issuance. */
    issueSession?(input: CloudDeploymentSessionRequestV1): Promise<CloudDeploymentSessionV1>;
    /** Read-only source comparison; throws when current placement requires a new administrator review. */
    assertSourcePlacement?(spec: ProjectSpec, connection: CloudDeploymentConnectionV1): void;
    /** Native read-only lifetime/ownership checks; names in committed bindings never authorize adoption. */
    verifyReleaseTargets?(input: CloudDeploymentReleaseTargetRequestV1): Promise<CloudDeploymentReleaseTargetV1[]>;
    /** Closed provider-native identifier, scope and lifetime grammar. */
    parseReleaseTargets?(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentReleaseTargetV1[];
  };
  /** Optional provider-owned scope preparation; absence is explicitly unsupported. */
  readonly scopePreparation?: {
    resolvedScope(record: CloudInstallationRecord): Record<string, string>;
    /** A prepared project may require one more reviewed billing scope before collection. */
    continuationStage?(record: CloudInstallationRecord): CloudInstallationStage;
    /** Native ownership/billing selected after bootstrap must be shown in the next review. */
    reviewResources(record: CloudInstallationRecord): NonNullable<CloudInstallationReview['resources']>;
    /** Exact partial installation trust only; null proves that this stage installed no trust. */
    disconnectionIntent?(record: CloudInstallationRecord, installationId: string): CloudInstallationIntent | null;
  };
  /** All three parsers must reject unknown fields and credential/value payloads. */
  parseScope(value: unknown): Record<string, string>;
  parseAction(value: unknown, intent: CloudInstallationIntent): CloudInstallationAction;
  parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence;
  /** Optional bounded native discovery; the host separately authorizes the app's setup session. */
  discoverScopes?(context: { authentication: CloudInstallationAuthentication; signal: AbortSignal; cursor?: string;
    sourceScope?: Pick<CloudInstallationIntent, 'customerId' | 'appId' | 'environment' | 'installationId'>;
    migrationTargets?: CloudInstallationIntent['migrationTargets'] }): Promise<CloudInstallationScopeDiscovery>;
  plan(context: CloudInstallationProviderContext): Promise<{ actions: CloudInstallationAction[]; review: CloudInstallationReview;
    /** Digest-bound provider prerequisite; confirmations cannot authorize any action in a blocked plan. */
    blockedReason?: CloudInstallationReason }>;
  /** Read-only. 'action-required' is legal only before an attempt exists. */
  inspect(context: CloudInstallationProviderContext & { action: CloudInstallationAction }): Promise<CloudInstallationObservation>;
  /** Exactly one reviewed action; no automatic write retries or unrelated prerequisites. */
  mutate(context: CloudInstallationProviderContext & { action: CloudInstallationAction; attempt: CloudInstallationAttempt }): Promise<CloudInstallationMutation>;
  /** Read-only, correlating the exact retained attempt. Absence alone never proves no effect. */
  recover(context: CloudInstallationProviderContext & { action: CloudInstallationAction; attempt: CloudInstallationAttempt }): Promise<CloudInstallationObservation>;
  /** Pure projection of verified native evidence; no credentials and no provider calls. */
  connections(record: CloudInstallationRecord): CloudInstallationConnection[];
}
export interface CloudInstallationConnection {
  key: string;
  destination: SecretDestination;
  /** Provider's strict keyless authorization identifiers, never credential material. */
  writerAuthorization: Record<string, string>;
}
export interface CloudInstallationRecord {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  intent: CloudInstallationIntent;
  plan: { digest: string; actions: CloudInstallationAction[]; review: CloudInstallationReview; blockedReason?: CloudInstallationReason };
  status: 'review-required' | 'pending' | 'blocked' | 'scope-ready' | 'ready' | 'disconnected';
  attempts: CloudInstallationAttempt[];
  completed: Record<string, CloudInstallationEvidence>;
  reason?: CloudInstallationReason;
}
export interface CloudInstallationStore {
  read(installationId: string): Promise<CloudInstallationRecord | null>;
  /** Atomic create/update. False is a conflict; never continue provider writes. */
  compareAndSwap(installationId: string, expectedRevision: number | null, next: CloudInstallationRecord): Promise<boolean>;
}
export interface CloudInstallationContext {
  driver: CloudInstallationDriver;
  store: CloudInstallationStore;
  authentication: CloudInstallationAuthentication;
  /** Revalidate app membership/source/setup approval immediately before every provider call. */
  authorize(input: { intent: CloudInstallationIntent; phase: 'plan' | 'inspect' | 'mutate' | 'recover'; planDigest?: string; actionId?: string }): Promise<boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface CloudInstallationApplyInput extends CloudInstallationContext {
  installationId: string;
  planDigest: string;
  confirmActions: string[];
  /** A rejected attempt needs a new exact confirmation; uncertain attempts cannot be retried. */
  retryActions?: Array<{ actionId: string; attemptId: string }>;
}
