export type BranchDeployProvider = string;
export type BranchDeployEnvironmentKind = 'staging' | 'production';

export interface BranchDeployTarget {
  environmentName: string;
  kind: BranchDeployEnvironmentKind;
  branch: string;
  serviceNames: string[];
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerJobNames?: string[];
  needsServiceNames?: boolean;
  needsJobNames?: boolean;
  webStartCommand?: string;
}

export interface BranchDeployWorkflow {
  template: string;
  templateName: string;
  branch: string;
  environment: string;
  path: string;
  content: string;
  requiredSecrets: string[];
  requiredVariables: string[];
}

export interface BranchDeployStepResult {
  steps: string;
  requiredSecrets: string[];
  requiredVariables: string[];
  permissions?: string;
  displayName?: string;
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
  diagnoseWorkflowLog?: (text: string) => CiWorkflowDiagnostic[];
}
