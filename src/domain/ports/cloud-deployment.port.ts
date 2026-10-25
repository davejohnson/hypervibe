import type { CloudInstallationAuthentication, CloudInstallationHostIdentity, CloudInstallationIntent, CloudInstallationProvider } from './cloud-installation.port.js';
import type { RuntimeSecretReference } from './secret-destination.port.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

export interface CloudDeploymentTopologyV1 {
  hostingProvider: string;
  region: string;
  preparation?: { kind: 'holding-workloads'; image: string };
  workloads: Array<{ name: string; kind: 'web' | 'worker' | 'cron'; public?: boolean; runtimeSecrets: Array<{ key: string; reference: RuntimeSecretReference }> }>;
}

export type CloudDeploymentCapability = 'provision' | 'release';
export type CloudDeploymentPrincipalV1 =
  | { kind: 'aws-role'; accountId: string; roleArn: string; roleId: string; audience: string }
  | { kind: 'gcp-service-account'; projectId: string; projectNumber: string; serviceAccountEmail: string; serviceAccountUniqueId: string }
  | { kind: 'azure-managed-identity'; tenantId: string; subscriptionId: string; clientId: string; principalId: string; identityResourceId: string };
export interface CloudDeploymentRuntimeIdentityV1 {
  workload: string;
  installationId: string;
  /** Stable ownership digest; provider independently verifies its native representation. */
  owner: string;
  principal: Exclude<CloudDeploymentPrincipalV1, { kind: 'aws-role' }>
    | { kind: 'aws-role'; purpose: 'task' | 'execution' | 'infrastructure'; accountId: string; roleArn: string; roleId: string };
}
export interface CloudDeploymentPreparedResourcesV1 {
  schemaVersion: 1;
  project: { id: string; lifetimeId: string; parentId?: string };
  registry: { id: string; lifetimeId: string; owner: string };
  /** Provider verifies exact referenced container coverage and immutable lifetime. Never secret values. */
  secretTargets?: Array<{ id: string; lifetimeId: string }>;
  workloads: Array<{ workload: string; kind: 'service' | 'job'; id: string; lifetimeId: string; owner: string;
    holding: { image: string; configurationDigest: string; revision?: string; generation?: string; principal: Exclude<CloudDeploymentPrincipalV1, { kind: 'aws-role' }>
      | Omit<Extract<CloudDeploymentPrincipalV1, { kind: 'aws-role' }>, 'audience'> } }>;
}
export interface CloudDeploymentConnectionV1 {
  schemaVersion: 1;
  purpose: 'deployment';
  installationId: string;
  planDigest: string;
  customerId: string;
  appId: string;
  environment: string;
  source: CloudInstallationIntent['source'];
  provider: CloudInstallationProvider;
  hostingProvider: string;
  deployment: CloudDeploymentTopologyV1;
  nativeScope: Record<string, string>;
  hostIdentity: CloudInstallationHostIdentity;
  principals: Record<CloudDeploymentCapability, CloudDeploymentPrincipalV1>;
  runtimeIdentities: CloudDeploymentRuntimeIdentityV1[];
  /** Native preparation is identity evidence, never application/runtime convergence. */
  preparedResources?: CloudDeploymentPreparedResourcesV1;
}
/** Separately owner-approved source authority; never part of the immutable native receipt. */
export interface CloudDeploymentSourceAuthorizationV1 {
  schemaVersion: 1;
  id: string;
  connectionDigest: string;
  previousDigest: string;
  from: CloudInstallationIntent['source'];
  source: CloudInstallationIntent['source'];
  digest: string;
}
export interface CloudDeploymentConnectionContractV1 {
  provider: CloudInstallationProvider;
  hostingProvider: string;
  /** Provider-owned closed native identifier schema; never accepts value-bearing arbitrary fields. */
  parseScope(value: unknown): Record<string, string>;
  /** Required for prepared receipts; verifies provider-native paths, placement and lifetime grammar. */
  parsePreparedResources?(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentPreparedResourcesV1;
}
export type CloudDeploymentAuthenticationV1 =
  | { kind: 'aws-sts'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'aws-role' }>;
    getCredentials(signal: AbortSignal): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> }
  | { kind: 'gcp-impersonation'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'gcp-service-account' }>;
    /** Fixed provider-owned cloud-platform OAuth scope. */
    getAccessToken(signal: AbortSignal): Promise<{ token: string; expiresAt: string }> }
  | { kind: 'azure-federation'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'azure-managed-identity' }>;
    /** Provider maps closed target names to official resource scopes. */
    getAccessToken(target: 'resource-manager' | 'container-registry', signal: AbortSignal): Promise<{ token: string; expiresAt: string }> };
export interface CloudDeploymentAdapterInputV1 {
  connection: CloudDeploymentConnectionV1;
  sourceAuthorization?: CloudDeploymentSourceAuthorizationV1;
  capability: CloudDeploymentCapability;
  /** Transient callbacks and results must never enter local persistence, plans or command output. */
  authentication: CloudDeploymentAuthenticationV1;
}
export interface CloudDeploymentAdapterCapabilityV1 extends CloudDeploymentConnectionContractV1 {
  /** Must verify provider-native caller or issuance evidence against the persisted immutable principal before use. */
  createAdapter(input: CloudDeploymentAdapterInputV1): unknown | Promise<unknown>;
}

/** Sensitive transport-only result. Never persist, log, or expose through command envelopes. */
export type CloudDeploymentSessionV1 =
  | { kind: 'aws-sts'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'aws-role' }>; accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }
  | { kind: 'gcp-impersonation'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'gcp-service-account' }>; token: string; expiresAt: string }
  | { kind: 'azure-federation'; principal: Extract<CloudDeploymentPrincipalV1, { kind: 'azure-managed-identity' }>; target: 'resource-manager' | 'container-registry'; token: string; expiresAt: string };
export interface CloudDeploymentSessionRequestV1 {
  connection: CloudDeploymentConnectionV1;
  capability: CloudDeploymentCapability;
  target?: 'resource-manager' | 'container-registry';
  host: CloudInstallationAuthentication['host'];
  signal: AbortSignal;
  /** Fresh app/source/device or native CI authorization, after native reads and immediately before issuance. */
  beforeIssue(): Promise<void>;
}

export interface CloudDeploymentReleaseTargetV1 {
  workload: string;
  kind: 'service' | 'job';
  service: { id: string; lifetimeId: string };
  registry: { id: string; lifetimeId: string };
}
export interface CloudDeploymentReleaseTargetsV1 {
  schemaVersion: 1;
  installationId: string;
  provider: CloudInstallationProvider;
  hostingProvider: string;
  customerId: string;
  appId: string;
  environment: string;
  source: CloudInstallationIntent['source'];
  targets: CloudDeploymentReleaseTargetV1[];
}
export interface CloudDeploymentReleaseTargetRequestV1 {
  connection: CloudDeploymentConnectionV1;
  spec: ProjectSpec;
  /** Exact committed binding bytes already decoded by the authorized host; never proof by themselves. */
  bindings: unknown;
  source: CloudInstallationIntent['source'];
  host: CloudInstallationAuthentication['host'];
  signal: AbortSignal;
  /** Private verification credentials still require current authorization. No infrastructure writes are allowed. */
  beforeIssue(): Promise<void>;
}
