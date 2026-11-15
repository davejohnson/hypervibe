import { createHash } from 'node:crypto';
import type { EngineConfiguration, EngineResourceMapping, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { gcpEngineBackend } from './gcp-engine.backend.js';
import { buildArtifactRegistryConfiguration } from './gcp-project.backend.js';
import { CLOUD_RUN_BUILD_IDENTITY_PROJECT_ROLES, CLOUD_RUN_BUILD_IDENTITY_SELF_ROLES, CLOUD_RUN_RUNTIME_BASE_ROLES,
  CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT_ACCESS_ROLES, getCloudPrepareProfile } from '../../../../domain/services/cloud-prepare.js';

/** Pinned archive and extracted-package hashes from the signed OpenTofu registry release.
 * Provenance: test/provider-contracts/gcp/project-setup/google-beta.lock.hcl. */
export const gcpSetupBackend: InfrastructureEngineBackend = {
  ...gcpEngineBackend,
  providerRequirements: { ...gcpEngineBackend.providerRequirements, 'google-beta': {
    source: 'hashicorp/google-beta', version: '8.9.0', lockHashes: [
      'h1:2pKYBnGJQnzANgJsBDiHscR8LVbmuYr9rBQPKODBrOk=',
      'h1:5kLQaxtDnE3oUW7oEw9BissBysD7fwSzIIufTGpOs54=',
      'h1:7hurRidp1Ih8McWyIivlShFHNbrMsET3srrmhY/vJok=',
      'h1:EoUwDunHtDrfxVk4kigB2Oa90zwZHUKqJNvvQmpPI3w=',
      'h1:GO197uB4+enBEWRe/0bfsMG7uKE4AoBCRnqr4EYOFm4=',
      'h1:O0l9e86evZPKLiB2bh5XWp5noHPeclbyei1RwnQPqdU=',
      'h1:ZgrsZ4gWZsNI0NtbhxVHM9oODshEk1FZotWcdJ9GwXk=',
      'h1:Zvgm0hgiPGPLxhXdUMBguZy6GqzVRuoX5Sx4WqBdPSw=',
      'h1:f72GOKLh61wdW+HtjrqprhD1ZTJm3S4SApIAGP/DGfI=',
      'h1:gpwX+xKNJC/+PolFyAisT/Ww4kPyCqPjY/K8KvrwVtk=',
      'h1:jGy9s6rU0m8MQST7HD3akuhQN0Vel3O/UhA+SKId6wY=',
      'h1:mN0P4QEF2P9HBNwHPUKplKzO/aGaddVyzXBo7QprTrY=',
      'h1:wuYGRv18FWNBD0jR0oyG1Uk2YKcmS5s0gQa5egEhgiQ=',
      'h1:y+rk90IwiRLYpemA1vzSxgRKPzqY35euLSZv0u2WifQ=',
      'h1:zR3vtV6F1keHmGRHYmiIOeb0Z1OUmz5B7icqt7DLTb4=',
      'zh:38f372243f1312809cd57d025cc60056e8ef0d71f87fd5f0d989bf9a8fcd2c35',
      'zh:83c5ca12335ae057806672bbdd7a3c3d9afb8c4306698f73a7a3e7c952eac16c',
      'zh:8751ab5a787fe650bc8c71e9cb369b60e2516ff7b8724c3777c12dddddde680c',
      'zh:876d148a78df4b21ed56d7d9ab30d35b0d67c05a7484889d4fefd21af94db16f',
      'zh:94683a056998f1394ddca86efcb266e730d3b007a39faef6b4ebab82a18b8b2f',
      'zh:b36ccb28a816756d9ff2bf2cad1aafc68412f8267ed070f68721ba8aaea9879f',
      'zh:c0ad10fbcfaf4845c98ffb5f6ee6b3bce4d0f52de89db4f6c0728c3c706e3325',
      'zh:cc8502b99a2d27b4def34a4030301a72f04e69c2710b22b5c477be7879f3c7a3',
      'zh:ccdc1230960beea5e6aeb8492995003715a6f25bda68b409b734e679d5136cd9',
      'zh:d7e88f8a7ba8e5e14d45ea1f5e632e9e4586f90013b4978188e845261bc0df45',
      'zh:e8ca7c03fb8f6be25ffb33bedb297edd4d6f088531aec6f8fd8f0bec887a37e0',
      'zh:eba02ec0fa7195889f6b22237ec33e64ddf6edfb03f35079e71f8896c9b46182',
      'zh:f0b0807336756342e2ae23fca5e55de6c135e171c7510017dc66d1ea1fb037d6',
      'zh:fa97cca189b8308d9318e8a6b33611cc52ecef851cf3b562ff89ee96cb40d0e8',
      'zh:fdce4e70d747e76d9ee3e857f30a13057bc70134696ff58faa83261a49f08977',
    ],
  } },
};
export interface GcpPreparationInput {
  gcpProjectId: string;
  region?: string;
  deployServiceAccountEmail: string;
  runtimeServiceAccountEmail?: string;
  enableApis: string[];
  grantRoles: string[];
  runtimeGrantRoles: string[];
  runtimeServiceAccountGrantRoles: string[];
  runtimeSelfGrantRoles?: string[];
  buildIdentityGrantRoles?: string[];
  buildSourceBucket?: { name: string; role: string; expiresAfterDays: number };
}
export function gcpProjectResourceKey(value: string): string { return value.replace(/[^a-zA-Z0-9_]/g, '_'); }
function iamKey(identity: string, role: string): string { return `grant_${createHash('sha256').update(`${identity}:${role}`).digest('hex').slice(0, 20)}`; }
export function projectIamAddress(member: string, role: string): string { return `google_project_iam_member.${iamKey(member, role)}`; }
export function defaultGcpPreparationInput(projectId: string, deployEmail: string, runtimeEmail: string): GcpPreparationInput {
  const profile = getCloudPrepareProfile('cloudrun')!;
  const excluded = new Set<string>([...CLOUD_RUN_RUNTIME_BASE_ROLES, ...CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT_ACCESS_ROLES]);
  return { gcpProjectId: projectId, deployServiceAccountEmail: deployEmail, runtimeServiceAccountEmail: runtimeEmail,
    enableApis: [...profile.requiredApis, 'storage.googleapis.com'],
    grantRoles: [...profile.requiredRoles.filter((role) => !excluded.has(role)), ...CLOUD_RUN_BUILD_IDENTITY_PROJECT_ROLES],
    runtimeGrantRoles: [...CLOUD_RUN_RUNTIME_BASE_ROLES],
    runtimeServiceAccountGrantRoles: [...CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT_ACCESS_ROLES],
    buildIdentityGrantRoles: [...CLOUD_RUN_BUILD_IDENTITY_SELF_ROLES],
    buildSourceBucket: { name: `${projectId}-hv-build-source`, role: 'roles/storage.objectAdmin', expiresAfterDays: 14 } };
}

export function buildGcpPreparationConfiguration(input: GcpPreparationInput, bootstrap = false): EngineConfiguration {
  const resources: Record<string, EngineResourceMapping> = {};
  const resource: Record<string, Record<string, unknown>> = {};
  const add = (type: string, name: string, value: unknown, label: string, kind: EngineResourceMapping['kind'] = 'project') => {
    (resource[type] ??= {})[name] = value;
    resources[`${type}.${name}`] = { actionId: `project-setup:${type}:${name}`, kind, name: label };
  };
  const project = input.gcpProjectId;
  const apiDependencies: string[] = [];
  for (const api of new Set([...input.enableApis, ...(input.buildSourceBucket ? ['storage.googleapis.com'] : [])])) {
    const name = gcpProjectResourceKey(api);
    const address = `google_project_service.${name}`;
    apiDependencies.push(address);
    add('google_project_service', name, { project, service: api, disable_on_destroy: false,
      ...(bootstrap ? { depends_on: ['google_project.hypervibe'] } : {}) }, `Enable ${api}`);
    if (api === 'workflows.googleapis.com') add('google_project_service_identity', name, {
      provider: 'google-beta', project, service: api, depends_on: [address],
    }, `Create ${api} service identity`);
  }
  const deployMember = `serviceAccount:${input.deployServiceAccountEmail}`;
  const runtimeMember = input.runtimeServiceAccountEmail ? `serviceAccount:${input.runtimeServiceAccountEmail}` : undefined;
  const identityDependencies = bootstrap ? ['google_service_account.deploy', 'google_service_account.runtime'] : [];
  const iamDependencies = [...apiDependencies, ...identityDependencies];
  for (const [member, roles] of [[deployMember, input.grantRoles], [runtimeMember, input.runtimeGrantRoles]] as const) {
    if (!member) continue;
    for (const role of new Set(roles)) add('google_project_iam_member', iamKey(member, role), {
      project, member, role, depends_on: iamDependencies,
    }, `${member} ${role}`);
  }
  const serviceAccountGrants = [
    [input.runtimeServiceAccountEmail, deployMember, input.runtimeServiceAccountGrantRoles],
    [input.runtimeServiceAccountEmail, runtimeMember, input.runtimeSelfGrantRoles ?? []],
    [input.deployServiceAccountEmail, deployMember, input.buildIdentityGrantRoles ?? []],
  ] as const;
  for (const [account, member, roles] of serviceAccountGrants) {
    if (!account || !member) continue;
    for (const role of new Set(roles)) add('google_service_account_iam_member', iamKey(`${account}:${member}`, role), {
      service_account_id: `projects/${input.gcpProjectId}/serviceAccounts/${account}`, member, role, depends_on: iamDependencies,
    }, `${member} ${role} on ${account}`);
  }
  if (input.buildSourceBucket) {
    add('google_storage_bucket', 'build_source', { project, name: input.buildSourceBucket.name, location: 'US',
      uniform_bucket_level_access: true, public_access_prevention: 'enforced', force_destroy: false,
      labels: { 'managed-by': 'hypervibe' }, lifecycle: { prevent_destroy: true },
      lifecycle_rule: [{ action: { type: 'Delete' }, condition: { age: input.buildSourceBucket.expiresAfterDays } }],
      depends_on: apiDependencies }, 'Private build source bucket', 'storage');
    add('google_storage_bucket_iam_member', 'build_source', { bucket: '${google_storage_bucket.build_source.name}',
      role: input.buildSourceBucket.role, member: deployMember, depends_on: identityDependencies }, 'Build source access', 'storage');
  }
  const configuration: EngineConfiguration = { files: {
    'provider.tf.json': { provider: { google: [{ project: input.gcpProjectId }], 'google-beta': [{ project: input.gcpProjectId }] } },
    'project-setup.tf.json': { resource },
  }, resources };
  if (input.buildSourceBucket) {
    const registry = buildArtifactRegistryConfiguration({ projectId: input.gcpProjectId, region: input.region ?? 'us-central1' });
    for (const document of Object.values(registry.files)) {
      const repo = (document as { resource: { google_artifact_registry_repository: Record<string, Record<string, unknown>> } }).resource.google_artifact_registry_repository;
      for (const value of Object.values(repo)) { value.project = project; value.depends_on = apiDependencies; }
    }
    Object.assign(configuration.files, registry.files);
    Object.assign(configuration.resources, registry.resources);
  }
  return configuration;
}

export function buildGcpBootstrapConfiguration(input: {
  projectId: string; billingAccountName: string; deployServiceAccountEmail: string; runtimeServiceAccountEmail: string; region?: string;
}): EngineConfiguration {
  const prep = defaultGcpPreparationInput(input.projectId, input.deployServiceAccountEmail, input.runtimeServiceAccountEmail);
  prep.enableApis.push('iam.googleapis.com');
  prep.region = input.region;
  const configuration = buildGcpPreparationConfiguration(prep, true);
  configuration.files['bootstrap.tf.json'] = { resource: {
    google_project: { hypervibe: { project_id: input.projectId, name: 'Hypervibe', billing_account: input.billingAccountName.replace(/^billingAccounts\//, ''),
      auto_create_network: true, deletion_policy: 'PREVENT', lifecycle: { prevent_destroy: true } } },
    google_service_account: Object.fromEntries([['deploy', input.deployServiceAccountEmail, 'Hypervibe deploy'], ['runtime', input.runtimeServiceAccountEmail, 'Hypervibe runtime']].map(([name, email, displayName]) => [name!, {
      project: input.projectId, account_id: email!.split('@')[0], display_name: displayName,
      lifecycle: { prevent_destroy: true }, depends_on: ['google_project_service.iam_googleapis_com'],
    }])),
  } };
  for (const [address, name] of [['google_project.hypervibe', 'Google project, billing and default network'], ['google_service_account.deploy', 'Deployment identity'], ['google_service_account.runtime', 'Runtime identity']]) {
    configuration.resources[address!] = { actionId: `project-setup:${address}`, kind: 'project', name: name!, billable: address === 'google_project.hypervibe' };
  }
  return configuration;
}
