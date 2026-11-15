import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { buildGcpPreparationConfiguration } from './gcp-setup.backend.js';

export const CI_RELEASE_ACCOUNT_ID = 'hypervibe-release';
export const CI_POOL_ID = 'hypervibe-github';
export const CI_PROVIDER_ID = 'github';
export const CI_RELEASE_PROJECT_ROLES = ['roles/run.developer', 'roles/artifactregistry.writer'] as const;
export const ciReleaseIdentity = (project: string): string => `${CI_RELEASE_ACCOUNT_ID}@${project}.iam.gserviceaccount.com`;
export const ciWorkloadIdentityProvider = (number: string): string => `projects/${number}/locations/global/workloadIdentityPools/${CI_POOL_ID}/providers/${CI_PROVIDER_ID}`;

/** Project-wide identities are reconciled once in shared engine state.
 * Contract: hashicorp/google's iam_workload_identity_pool_provider resource;
 * executable configuration is checked against the pinned provider in CI.
 */
export function buildCiReleaseConfiguration(input: {
  projectId: string; projectNumber: string; repository: string; runtimeServiceAccountEmail: string;
}): EngineConfiguration {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)
    || !/^[0-9]+$/.test(input.projectNumber)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)
    || !input.runtimeServiceAccountEmail.endsWith(`@${input.projectId}.iam.gserviceaccount.com`)) {
    throw new Error('CI releases need an exact GCP project, runtime identity, and GitHub repository.');
  }
  const resources: Record<string, EngineResourceMapping> = {};
  const resource: Record<string, Record<string, unknown>> = {};
  const add = (type: string, key: string, config: Record<string, unknown>, name: string) => {
    (resource[type] ??= {})[key] = config;
    resources[`${type}.${key}`] = { actionId: `ci-access:${key}`, kind: 'ci', name };
  };
  const account = ciReleaseIdentity(input.projectId);
  const principal = `principalSet://iam.googleapis.com/projects/${input.projectNumber}/locations/global/workloadIdentityPools/${CI_POOL_ID}/attribute.repository/${input.repository}`;
  const shared = buildGcpPreparationConfiguration({
    gcpProjectId: input.projectId, deployServiceAccountEmail: account,
    runtimeServiceAccountEmail: input.runtimeServiceAccountEmail,
    enableApis: ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com'],
    grantRoles: [...CI_RELEASE_PROJECT_ROLES], runtimeGrantRoles: [],
    runtimeServiceAccountGrantRoles: ['roles/iam.serviceAccountUser'],
  });
  const setupResources = (shared.files['project-setup.tf.json'] as { resource: Record<string, Record<string, { depends_on?: string[] }>> }).resource;
  for (const type of ['google_project_iam_member', 'google_service_account_iam_member']) {
    for (const entry of Object.values(setupResources[type] ?? {})) {
      entry.depends_on = [...(entry.depends_on ?? []), 'google_service_account.ci_release'];
    }
  }
  const dependencies = ['google_project_service.iam_googleapis_com', 'google_project_service.iamcredentials_googleapis_com', 'google_project_service.sts_googleapis_com'];
  add('google_service_account', 'ci_release', {
    project: input.projectId, account_id: CI_RELEASE_ACCOUNT_ID, display_name: 'Hypervibe CI releases (image updates only)',
    depends_on: dependencies, lifecycle: [{ prevent_destroy: true }],
  }, 'CI release identity');
  add('google_iam_workload_identity_pool', 'ci_github', {
    project: input.projectId, workload_identity_pool_id: CI_POOL_ID, display_name: 'Hypervibe GitHub Actions',
    description: 'Keyless CI releases managed by Hypervibe', depends_on: dependencies, lifecycle: [{ prevent_destroy: true }],
  }, 'GitHub identity pool');
  add('google_iam_workload_identity_pool_provider', 'ci_github', {
    project: input.projectId, workload_identity_pool_id: CI_POOL_ID, workload_identity_pool_provider_id: CI_PROVIDER_ID,
    display_name: 'GitHub Actions', oidc: [{ issuer_uri: 'https://token.actions.githubusercontent.com' }],
    attribute_mapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository', 'attribute.ref': 'assertion.ref' },
    attribute_condition: `assertion.repository == '${input.repository}'`,
    depends_on: ['google_iam_workload_identity_pool.ci_github'],
  }, `GitHub trust for ${input.repository}`);
  add('google_service_account_iam_member', 'ci_github', {
    service_account_id: `projects/${input.projectId}/serviceAccounts/${account}`, role: 'roles/iam.workloadIdentityUser', member: principal,
    depends_on: ['google_service_account.ci_release', 'google_iam_workload_identity_pool_provider.ci_github'],
  }, `GitHub release access for ${input.repository}`);
  return { files: { ...shared.files, 'ci-release.tf.json': { resource } }, resources: { ...shared.resources, ...resources } };
}
