import { isDeepStrictEqual } from 'node:util';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { buildGcpPreparationConfiguration } from './gcp-setup.backend.js';

import { assertEngineCiIntent } from '../../../../domain/spec/engine-ci.js';

export interface GcpCiReleaseScope { environmentName: string; branch: string; autoDeploy: boolean; promotionSource?: string; policySha?: string }

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
  projectId: string; projectNumber: string; repository: string; repositoryId: string; releases: GcpCiReleaseScope[]; runtimeServiceAccountEmail: string;
}): EngineConfiguration {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)
    || !/^[0-9]+$/.test(input.projectNumber)
    || !/^[1-9][0-9]*$/.test(input.repositoryId) || !input.releases.length
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
  const scopes = input.releases.map(release => {
    assertEngineCiIntent({ ...release, repository: input.repository });
    const ref = `refs/heads/${release.branch}`;
    const workflow = `${input.repository}/.github/workflows/hypervibe-release-${release.environmentName}.yml@${ref}`;
    const events = release.autoDeploy ? "(assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')" : "assertion.event_name == 'workflow_dispatch'";
    if (release.promotionSource && (!/^[A-Za-z0-9_-]+$/.test(release.promotionSource) || release.autoDeploy || !/^[a-f0-9]{40}$/.test(release.policySha ?? ''))) {
      throw new Error('Protected CI access requires the exact published reusable workflow commit.');
    }
    const reusable = `${input.repository}/.github/workflows/hypervibe-promote-${release.environmentName}.yml@${release.policySha}`;
    const promotion = release.promotionSource ? ` && assertion.job_workflow_ref == '${reusable}' && assertion.job_workflow_sha == '${release.policySha}'` : '';
    return `(assertion.environment == '${release.environmentName}' && assertion.ref == '${ref}' && assertion.workflow_ref == '${workflow}' && ${events}${promotion})`;
  });
  const condition = `assertion.repository_id == '${input.repositoryId}' && assertion.repository == '${input.repository}' && (${scopes.join(' || ')})`;
  if (condition.length > 4096) throw new Error('The exact GitHub workflow restrictions exceed the Google identity provider condition limit.');
  const principal = `principalSet://iam.googleapis.com/projects/${input.projectNumber}/locations/global/workloadIdentityPools/${CI_POOL_ID}/attribute.repository_id/${input.repositoryId}`;
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
    attribute_mapping: { 'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id' },
    attribute_condition: condition,
    depends_on: ['google_iam_workload_identity_pool.ci_github'],
  }, `GitHub trust for ${input.repository}`);
  add('google_service_account_iam_member', 'ci_github', {
    service_account_id: `projects/${input.projectId}/serviceAccounts/${account}`, role: 'roles/iam.workloadIdentityUser', member: principal,
    depends_on: ['google_service_account.ci_release', 'google_iam_workload_identity_pool_provider.ci_github'],
  }, `GitHub release access for ${input.repository}`);
  return { files: { ...shared.files, 'ci-release.tf.json': { resource } }, resources: { ...shared.resources, ...resources } };
}

/** Public repository bindings cannot establish that Google accepted this policy. Check the private provider state. */
export function appliedCiPromotionPolicy(state: unknown, configuration: EngineConfiguration, provider: string): boolean {
  type Policy = { name?: string; project?: string; disabled?: boolean; attribute_condition?: string; attribute_mapping?: unknown;
    oidc?: Array<{ issuer_uri?: string; allowed_audiences?: string[]; jwks_json?: string }> };
  type Row = { mode?: string; type?: string; address?: string; tainted?: boolean; values?: Policy };
  const type = 'google_iam_workload_identity_pool_provider';
  const rows = (state as { values?: { root_module?: { resources?: Row[] } } })?.values?.root_module?.resources;
  const matches = rows?.filter(row => row.mode === 'managed' && row.type === type && row.address === type + '.ci_github' && !row.tainted);
  const live = matches?.length === 1 && matches[0]?.values;
  const desired = (configuration.files['ci-release.tf.json'] as { resource?: Record<string, Record<string, Policy>> })?.resource?.[type]?.ci_github;
  return !!desired?.attribute_condition && !!live && live.name === provider && live.project === desired.project && !live.disabled
    && live.attribute_condition === desired.attribute_condition && isDeepStrictEqual(live.attribute_mapping, desired.attribute_mapping)
    && live.oidc?.length === 1 && live.oidc[0]?.issuer_uri === 'https://token.actions.githubusercontent.com'
    && !live.oidc[0].allowed_audiences?.length && !live.oidc[0].jwks_json;
}
