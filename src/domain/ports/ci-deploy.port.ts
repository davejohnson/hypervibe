import type { ApiReleaseSpec } from '../spec/spec.schema.js';
import type { ProjectRuntime } from '../spec/project-runtime.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentSourceAuthorizationV1 } from './cloud-deployment.port.js';

/** Stable nonsecret broker binding. Approval is resolved server-side to avoid a workflow/policy hash cycle. */
export interface CloudDeploymentCiAccessV1 {
  origin: string;
  projectId: string;
  connectionId: string;
  environment: string;
  sourceBranch: string;
  connection: CloudDeploymentConnectionV1;
  sourceAuthorization?: CloudDeploymentSourceAuthorizationV1;
}

export type BranchDeployProvider = string;
export type BranchDeployEnvironmentKind = 'development' | 'test' | 'staging' | 'production' | 'custom';

export interface BranchDeployReleaseResource {
  logicalName: string;
  workloadKind: 'web' | 'worker' | 'cron';
  providerResourceType: 'service' | 'job';
  providerResourceId: string;
}

/** Exact reviewed runtime configuration for one provider-bound workload. */
export interface BranchDeployRuntimeResource extends BranchDeployReleaseResource {
  instanceBounds?: { min: number; max: number };
  /** Provider-confirmed lifetime identity, retained independently of bootstrap state. */
  providerResourceUid?: string;
  startCommand: string | null;
  healthCheckPath: string | null;
}

export interface BranchDeployReleaseTarget {
  scope: {
    providerProjectId?: string;
    providerEnvironmentId?: string;
    providerRegion?: string;
    providerScope?: Record<string, string>;
  };
  bindingsFingerprint: string;
  resources: BranchDeployReleaseResource[];
}

export interface BranchDeployTarget {
  deploymentAccess?: CloudDeploymentCiAccessV1;
  /** Provider-validated nonsecret access descriptor from its reviewed local lifecycle. */
  nativeAuthentication?: Record<string, unknown>;
  /** First rollout uses committed nonsecret settings and the reviewed local
   * preparation journal. Collected values remain immutable provider references. */
  preparedRuntime?: {
    envVars: Record<string, string>;
    preparation: import('./hosting-prepared.port.js').PreparedHostingMarker;
  };
  environmentName: string;
  api?: ApiReleaseSpec;
  kind: BranchDeployEnvironmentKind;
  branch: string;
  autoDeployOnPush: boolean;
  promoteFromEnvironment?: string;
  /** Accepted source branch whose workflow commits may produce promotion evidence. */
  promoteFromBranch?: string;
  /** Reusable workflow receiving commit_sha and opt-in package-read access. */
  promotionTests?: { workflow: string; packageReadToken?: boolean };
  /** Hosting provider used to derive the exact managed source workflow identity. */
  promoteFromProvider?: string;
  /** Exact source service set required in downloaded promotion evidence. */
  promoteFromServiceNames?: string[];
  /** Stable reviewed source program required in promotion evidence. */
  promoteFromProgramFingerprint?: string;
  /** Exact source binding contract required in promotion evidence. */
  promoteFromReleaseTarget?: BranchDeployReleaseTarget;
  /** Stable reviewed deployment program written into this target's release evidence. */
  programFingerprint?: string;
  /** Full environment contract required before this target may deploy. */
  deploymentContractFingerprint?: string;
  /** Exact current provider scope and logical-to-provider workload bindings. */
  releaseTarget?: BranchDeployReleaseTarget;
  serviceNames: string[];
  providerProjectId?: string;
  providerEnvironmentId?: string;
  /** Provider-native non-secret scope for identity checks in generated CI. */
  providerScope?: Record<string, string>;
  /** Non-secret desired hosting placement from the environment spec. */
  providerRegion?: string;
  providerServiceIds: string[];
  /** Provider-observed image locations retained in hosting service bindings. */
  providerImageUris?: string[];
  providerJobNames?: string[];
  /** Exact per-workload runtime behavior applied atomically with a CI image release. */
  runtimeResources?: BranchDeployRuntimeResource[];
  /** Pre-rollout commands and the bound runtime service whose config they inherit. */
  releaseCommands?: Array<{
    serviceName: string;
    providerServiceId?: string;
    /** Exact release job created and bound by reviewed provider apply. */
    jobName?: string;
    command: string;
  }>;
  needsServiceNames?: boolean;
  needsJobNames?: boolean;
  /** One unambiguous reviewed CMD for generated images; absent when services disagree. */
  containerStartCommand?: string;
  /** Effective project runtime for Hypervibe-generated build tooling. */
  runtime?: ProjectRuntime;
}

export interface BranchDeployWorkflow {
  template: string;
  templateName: string;
  branch: string;
  autoDeployOnPush: boolean;
  promoteFromEnvironment?: string;
  environment: string;
  path: string;
  content: string;
  companionFiles?: Array<{ path: string; content: string }>;
  review: {
    title: string;
    summary: string;
    details: string[];
    mergeEffect: string;
  };
  requiredSecrets: string[];
  requiredVariables: string[];
  /** Whether rollback can restore provider-verifiable immutable image evidence. */
  supportsImmutableRollback: boolean;
}

export interface BranchDeployStepResult {
  steps: string;
  requiredSecrets: string[];
  requiredVariables: string[];
  /** Exact immutable image expression persisted after a verified deployment. */
  releaseImageUri?: string;
  permissions?: string;
  displayName?: string;
  reviewDetails?: string[];
}

export interface CiWorkflowDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  summary: string;
  evidence: string;
  next: string[];
}

export interface ProviderCiDeployMetadata {
  displayName: string;
  /** A registered provider owns parsing and exact-scope validation of this binding. */
  boundAuthentication?: {
    bindingKey: string;
    parse(value: unknown, context: { environment: string; branch: string; providerProjectId?: string; repository?: string | null }): Record<string, unknown>;
  };
  /** Explicit emitted identity protocol; absence cannot fall back to copied cloud credentials. */
  transientDeployment?: 'github-oidc-broker-v1';
  /** Opt-in migration of accepted GitHub workflow inputs for this provider only. */
  rendererRevision?: number;
  requiredSecrets: string[];
  secretCredentialKeys?: Record<string, string>;
  requiresGitHubPackagePull?: boolean;
  buildGitHubActionsSteps: (target: BranchDeployTarget) => BranchDeployStepResult;
  /** Provider-neutral recipe consumed by non-GitHub CI renderers. */
  buildPortableRecipe?: (target: BranchDeployTarget) => PortableCiDeployRecipe;
  /** Static runner trust requirements used before provider bindings are available. */
  portableRunnerCapabilities?: Array<'linux-amd64' | 'docker-privileged'>;
  diagnoseWorkflowLog?: (text: string) => CiWorkflowDiagnostic[];
}

export type PortableCiValueSource =
  | { kind: 'connection'; provider: string; credentialKey: string }
  | { kind: 'literal'; value: string };

export interface PortableCiValue {
  name: string;
  source: PortableCiValueSource;
  secret: boolean;
  /** Encoding applied before the value crosses the CI variable boundary. */
  transform?: 'base64';
}

export interface PortableCiDeployRecipe {
  version: 1;
  provider: string;
  kind: 'container' | 'repository';
  runnerCapabilities: Array<'linux-amd64' | 'docker-privileged'>;
  values: PortableCiValue[];
  runtime: {
    path: string;
    content: string;
    npmPackages?: string[];
  };
  /** Safe CMD used only to build an image whose provider release installs exact per-resource commands. */
  containerBuildStartCommand?: string;
  /** Provider-owned release identities that portable CI must preserve and verify. */
  releaseEvidence?: {
    providerResources: string[];
    requiresImmutableImage: boolean;
  };
}
