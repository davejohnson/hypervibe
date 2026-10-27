import type { PlanAction } from '../plan/plan.types.js';
import type { SecretDestination } from './secret-destination.port.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentPreparedResourcesV1, CloudDeploymentSessionRequestV1, CloudDeploymentSessionV1, CloudDeploymentTopologyV1,
  CloudDeploymentReleaseTargetV1, CloudDeploymentReleaseTargetRequestV1 } from './cloud-deployment.port.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

/** Reviewed roster, not a claim of live compatibility. */
export const CLOUD_INSTALLATION_PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type CloudInstallationProvider = typeof CLOUD_INSTALLATION_PROVIDERS[number];
/** Registration identities do not expand the hosted cloud roster. */
export const OPERATOR_APPLICATION_PROVIDERS = ['microsoft-entra', 'github-app', 'google-oauth', 'google-recaptcha'] as const;
export type OperatorApplicationProvider = typeof OPERATOR_APPLICATION_PROVIDERS[number];
export type CloudInstallationExecutableProvider = CloudInstallationProvider | OperatorApplicationProvider;
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
  mode: 'connect' | 'connect-existing' | 'migrate' | 'disconnect';
  /** Omitted on historical collection records; scope preparation never authorizes writers. */
  stage?: CloudInstallationStage;
  /** Immutable predecessor, separately reviewed before the collection installation. */
  scopePreparation?: { installationId: string; planDigest: string };
  /** Provider's strict schema; only nonsecret native scope identifiers. */
  nativeScope: Record<string, string>;
  hostIdentity: CloudInstallationHostIdentity;
  /** Collection keys; deployment installation requires the explicit empty list. */
  keys: string[];
  /** Reviewed existing destinations. connect-existing authorizes the first hosted writer; migrate replaces an authorized old writer. Neither changes native values or references. */
  migrationTargets?: Array<{ key: string; destination: SecretDestination }>;
  /** Exact previously verified resources for a separate disconnect review. */
  installed?: CloudInstallationEvidence[];
}
/** Local desired-state authority is not hosted federation or a source-code release. */
export interface LocalCloudScopePreparationIntent extends Omit<CloudInstallationIntent,
  'source' | 'hostIdentity' | 'purpose' | 'deployment' | 'mode' | 'stage' | 'scopePreparation' | 'keys' | 'migrationTargets' | 'installed'> {
  execution: { kind: 'local-administrator'; authentication: 'google-user-adc' };
  hostingProvider: string;
  source: { kind: 'local-spec'; repository: string; specRevision: number; specDigest: string };
  mode: 'connect';
  stage: 'scope-preparation';
  keys: [];
  hostIdentity?: never;
  purpose?: never;
  deployment?: never;
  scopePreparation?: never;
  /** Immutable local predecessor; never hosted federation authority. */
  predecessor?: { installationId: string; planDigest: string };
  selection?: Record<string, string>;
  migrationTargets?: never;
  installed?: never;
}
/** Operator release assets are a separate local actor, never hosted setup authority. */
export interface OperatorArtifactIntent extends Omit<LocalCloudScopePreparationIntent, 'execution' | 'hostingProvider'> {
  execution: { kind: 'operator-artifact-publisher'; authentication: 'aws-session' | 'google-user-adc' };
  artifactProvider: string;
  artifacts: string[];
}
export interface OperatorArtifactAuthentication {
  kind: 'operator-artifact-publisher';
  awsSession?: { getCredentials(signal: AbortSignal): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }> };
  administrator?: { getAccessToken(scope: string, signal: AbortSignal): Promise<string> };
}
export interface OperatorArtifactCapability {
  schemaVersion: 1;
  parseDeclaration(nativeScope: unknown, artifacts: string[], bindings: Record<string, unknown>): Record<string, string>;
  parseRecord(value: unknown): CloudInstallationRecord<OperatorArtifactIntent>;
  /** Local-only preparation binds exact tested artifact bytes before cloud review. */
  prepare?(nativeScope: Record<string, string>, artifacts: string[], source: OperatorArtifactIntent['source']): Promise<Record<string, string>>;
  create(nativeScope: Record<string, string>, signal?: AbortSignal): Promise<{ driver: CloudInstallationDriver<OperatorArtifactIntent>; authentication: OperatorArtifactAuthentication }>;
  nextScope(record: CloudInstallationRecord<OperatorArtifactIntent>): Record<string, string> | null;
  refreshScope?(record: CloudInstallationRecord<OperatorArtifactIntent>, declaration: Record<string, string>, artifacts: string[]): Record<string, string>;
  receipts(record: CloudInstallationRecord<OperatorArtifactIntent>): Array<Record<string, string>>;
}
export interface OperatorApplicationIntent extends Omit<LocalCloudScopePreparationIntent, 'execution' | 'hostingProvider' | 'provider'> {
  outputs?: import('./operator-output.port.js').OperatorOutputSelection;
  execution: { kind: 'operator-application'; authentication: 'local-operator' };
  provider: OperatorApplicationProvider;
  applicationProvider: OperatorApplicationProvider;
}
/** Callbacks are transient; native authority must be verified by each driver. */
export interface OperatorApplicationAuthentication {
  kind: 'operator-application';
  administrator?: { getAccessToken(scope: string, signal: AbortSignal): Promise<string> };
}
export type CloudInstallationExecutableIntent = CloudInstallationIntent | LocalCloudScopePreparationIntent | OperatorArtifactIntent | OperatorApplicationIntent;
export interface LocalCloudScopePreparationAuthentication {
  kind: 'local-administrator';
  administrator: { getAccessToken(scope: string, signal: AbortSignal): Promise<string> };
}
export type CloudInstallationAuthenticationFor<I extends CloudInstallationExecutableIntent> =
  I extends LocalCloudScopePreparationIntent ? LocalCloudScopePreparationAuthentication
    : I extends OperatorArtifactIntent ? OperatorArtifactAuthentication
      : I extends OperatorApplicationIntent ? OperatorApplicationAuthentication : CloudInstallationAuthentication;
export interface LocalCloudScopePreparationCapability {
  schemaVersion: 1;
  parseScope(value: unknown): Record<string, string>;
  parseRecord(value: unknown): CloudInstallationRecord<LocalCloudScopePreparationIntent>;
  continuation?: {
    parseSelection(value: unknown, placement?: { region?: string }): Record<string, string>;
    /** Explicit trust removal may preserve an existing hosting binding. */
    permitsBoundCleanup?(nativeScope: Record<string, string>): boolean;
    /** Historical reviews remain readable; false requires a new review before any fresh write. */
    isReviewCurrent?(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>): boolean;
    nextScope(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, selection: Record<string, string>): Record<string, string> | null;
    /** Only these absent nonsecret fields may be restored from verified history. */
    repairableProviderScopeFields?: readonly string[];
    /** Exact historical ancestors that must be freshly observed for binding, including after trust removal. */
    bindingPrerequisiteIds?(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, history: CloudInstallationRecord<LocalCloudScopePreparationIntent>[]): string[];
    binding(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, placement: { region?: string }, history?: CloudInstallationRecord<LocalCloudScopePreparationIntent>[]): { platformBindings: Record<string, unknown>; connections: Array<{ provider: string; config: Record<string, string> }>; removeBindings?: Array<{ key: string; expectedValue: unknown }> };
  };
  create(nativeScope: Record<string, string>, signal?: AbortSignal): Promise<{ driver: CloudInstallationDriver<LocalCloudScopePreparationIntent>;
    authentication: LocalCloudScopePreparationAuthentication }>;
}
export interface CloudInstallationAction extends PlanAction {
  resource: PlanAction['resource'] & { provider: CloudInstallationExecutableProvider };
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
export interface CloudInstallationProviderContext<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> {
  intent: I;
  authentication: CloudInstallationAuthenticationFor<I>;
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
export interface CloudInstallationDriver<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> {
  /** Local allocation or explicitly registered, predecessor-bound continuation. */
  readonly localScopePreparation?: { hostingProvider: string; continuation?: true; preparation?: 'holding-v1' };
  readonly artifactPublication?: { providerName: string; authentication: OperatorArtifactIntent['execution']['authentication'] };
  readonly operatorApplication?: { providerName: OperatorApplicationProvider };
  readonly provider: I['provider'];
  /** Explicit separate installation capability; collection support never implies deployment authority. */
  deployment?: {
    hostingProvider: string;
    connection(record: CloudInstallationRecord): CloudDeploymentConnectionV1;
    parsePreparedResources?(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentPreparedResourcesV1;
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
    resolvedScope(record: CloudInstallationRecord<I>): Record<string, string>;
    /** A prepared project may require one more reviewed billing scope before collection. */
    continuationStage?(record: CloudInstallationRecord): CloudInstallationStage;
    /** Native ownership/billing selected after bootstrap must be shown in the next review. */
    reviewResources(record: CloudInstallationRecord<I>): NonNullable<CloudInstallationReview['resources']>;
    /** Exact partial installation trust only; null proves that this stage installed no trust. */
    disconnectionIntent?(record: CloudInstallationRecord<I>, installationId: string): I | null;
  };
  /** All three parsers must reject unknown fields and credential/value payloads. */
  parseScope(value: unknown): Record<string, string>;
  parseAction(value: unknown, intent: I): CloudInstallationAction;
  parseEvidence(value: unknown, intent: I): CloudInstallationEvidence;
  /** Optional bounded native discovery; the host separately authorizes the app's setup session. */
  discoverScopes?(context: { authentication: CloudInstallationAuthentication; signal: AbortSignal; cursor?: string;
    sourceScope?: Pick<CloudInstallationIntent, 'customerId' | 'appId' | 'environment' | 'installationId'>;
    migrationTargets?: CloudInstallationIntent['migrationTargets'] }): Promise<CloudInstallationScopeDiscovery>;
  plan(context: CloudInstallationProviderContext<I>): Promise<{ actions: CloudInstallationAction[]; review: CloudInstallationReview;
    /** Digest-bound provider prerequisite; confirmations cannot authorize any action in a blocked plan. */
    blockedReason?: CloudInstallationReason }>;
  /** Read-only. 'action-required' is legal only before an attempt exists. */
  inspect(context: CloudInstallationProviderContext<I> & { action: CloudInstallationAction }): Promise<CloudInstallationObservation>;
  /** Exactly one reviewed action; no automatic write retries or unrelated prerequisites. */
  mutate(context: CloudInstallationProviderContext<I> & { action: CloudInstallationAction; attempt: CloudInstallationAttempt }): Promise<CloudInstallationMutation>;
  /** Read-only, correlating the exact retained attempt. Absence alone never proves no effect. */
  recover(context: CloudInstallationProviderContext<I> & { action: CloudInstallationAction; attempt: CloudInstallationAttempt }): Promise<CloudInstallationObservation>;
  /** Pure projection of verified native evidence; no credentials and no provider calls. */
  connections(record: CloudInstallationRecord<I>): CloudInstallationConnection[];
}
export interface CloudInstallationConnection {
  key: string;
  destination: SecretDestination;
  /** Provider's strict keyless authorization identifiers, never credential material. */
  writerAuthorization: Record<string, string>;
}
export interface CloudInstallationRecord<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  intent: I;
  plan: { digest: string; actions: CloudInstallationAction[]; review: CloudInstallationReview; blockedReason?: CloudInstallationReason };
  status: 'review-required' | 'pending' | 'blocked' | 'scope-ready' | 'ready' | 'disconnected';
  attempts: CloudInstallationAttempt[];
  completed: Record<string, CloudInstallationEvidence>;
  reason?: CloudInstallationReason;
}
export interface CloudInstallationStore<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> {
  read(installationId: string): Promise<CloudInstallationRecord<I> | null>;
  /** Atomic create/update. False is a conflict; never continue provider writes. */
  compareAndSwap(installationId: string, expectedRevision: number | null, next: CloudInstallationRecord<I>): Promise<boolean>;
}
export interface CloudInstallationContext<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> {
  driver: CloudInstallationDriver<I>;
  store: CloudInstallationStore<I>;
  authentication: CloudInstallationAuthenticationFor<I>;
  /** Revalidate app membership/source/setup approval immediately before every provider call. */
  authorize(input: { intent: I; phase: 'plan' | 'inspect' | 'mutate' | 'recover'; planDigest?: string; actionId?: string }): Promise<boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface CloudInstallationApplyInput<I extends CloudInstallationExecutableIntent = CloudInstallationIntent> extends CloudInstallationContext<I> {
  installationId: string;
  planDigest: string;
  confirmActions: string[];
  /** Local continuation adapter executes only this exact current outer action. */
  onlyActionId?: string;
  /** A rejected attempt needs a new exact confirmation; uncertain attempts cannot be retried. */
  retryActions?: Array<{ actionId: string; attemptId: string }>;
}
