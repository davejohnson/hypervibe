import type { ProjectRuntime } from '../spec/project-runtime.js';

export type BranchDeployProvider = string;
export type BranchDeployEnvironmentKind = 'development' | 'test' | 'staging' | 'production' | 'custom';

export interface BranchDeployTarget {
  environmentName: string;
  kind: BranchDeployEnvironmentKind;
  branch: string;
  autoDeployOnPush: boolean;
  promoteFromEnvironment?: string;
  serviceNames: string[];
  providerProjectId?: string;
  providerEnvironmentId?: string;
  /** Non-secret desired hosting placement from the environment spec. */
  providerRegion?: string;
  providerServiceIds: string[];
  /** Provider-observed image locations retained in hosting service bindings. */
  providerImageUris?: string[];
  providerJobNames?: string[];
  needsServiceNames?: boolean;
  needsJobNames?: boolean;
  webStartCommand?: string;
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
}

export interface BranchDeployStepResult {
  steps: string;
  requiredSecrets: string[];
  requiredVariables: string[];
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
}
