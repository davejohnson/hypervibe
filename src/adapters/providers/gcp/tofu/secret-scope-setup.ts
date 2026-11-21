import { isDeepStrictEqual } from 'node:util';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { GCP_SECRET_SCOPE_CONTRIBUTION, type GcpSecretScopeDescriptor } from '../../../../domain/services/gcp-secret-scope.js';
import { gcpProjectResourceKey, projectIamAddress } from './gcp-setup.backend.js';

export const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';
/** Project roles a service identity receives when the shared runtime identity holds them. Storage is granted per bucket by the environment. */
export const SERVICE_IDENTITY_MIRRORED_ROLES = ['roles/cloudsql.client', 'roles/pubsub.publisher', 'roles/pubsub.subscriber'] as const;
const ACT_AS_ROLE = 'roles/iam.serviceAccountUser';
const DESCRIPTOR_FILE = `${GCP_SECRET_SCOPE_CONTRIBUTION}.tf.json`;
const DESCRIPTOR_LOCAL = 'hv_secret_scope';

export interface SecretScopeSetupInput extends GcpSecretScopeDescriptor {
  /** Google's numeric project id; Secret Manager resource names in IAM conditions use it. */
  projectNumber: string;
  deployServiceAccountEmail: string;
  /** Present when keyless CI releases are set up: CI must be able to release services that run as their own identity. */
  ciReleaseServiceAccountEmail?: string;
  /** Project roles the shared runtime identity holds; service identities mirror the listed subset. */
  runtimeProjectRoles: string[];
}

/**
 * Secret Accessor on everything except the named secrets and their versions.
 * Same expression shape as the migration copy-secret restriction (transfer-isolation.ts).
 */
export function secretExclusionCondition(projectNumber: string, secretIds: string[]) {
  const names = [...secretIds].sort().map((id) => `projects/${projectNumber}/secrets/${id}`);
  const clauses = names.map((name) => `resource.name != ${JSON.stringify(name)} && !resource.name.startsWith(${JSON.stringify(`${name}/versions/`)})`);
  const expression = '(resource.type != "secretmanager.googleapis.com/Secret" && resource.type != "secretmanager.googleapis.com/SecretVersion") || ('
    + clauses.join(' && ') + ')';
  if (expression.length > 12000) throw new Error('Too many secrets are limited to named services in this Google Cloud project for one access condition.');
  return { title: 'hv-limited-secrets', description: 'Keep this identity out of secrets limited to other services.', expression };
}

function validate(input: SecretScopeSetupInput): void {
  const suffix = `@${input.gcpProjectId}.iam.gserviceaccount.com`;
  const ids = [...input.runtimeExcludedSecretIds, ...input.identities.flatMap((identity) => identity.excludedSecretIds)];
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.gcpProjectId) || !/^[1-9][0-9]*$/.test(input.projectNumber)
    || ![input.runtimeServiceAccountEmail, input.deployServiceAccountEmail, ...(input.ciReleaseServiceAccountEmail ? [input.ciReleaseServiceAccountEmail] : [])]
      .every((email) => email.endsWith(suffix))
    || input.identities.some((identity) => !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(identity.accountId) || identity.email !== identity.accountId + suffix
      || [input.runtimeServiceAccountEmail, input.deployServiceAccountEmail, input.ciReleaseServiceAccountEmail].includes(identity.email))
    || ids.some((id) => !/^[A-Za-z0-9_-]{1,255}$/.test(id))) {
    throw new Error('The service identity setup does not match its Google Cloud project.');
  }
}

/** Addresses whose access condition this contribution owns; changing a condition replaces the grant. */
export function secretScopeConditionAddresses(configuration: EngineConfiguration | undefined): string[] {
  const descriptor = configuration && readSecretScopeDescriptor(configuration);
  if (!descriptor) return [];
  return [descriptor.runtimeServiceAccountEmail, ...descriptor.identities.map((identity) => identity.email)]
    .map((email) => projectIamAddress(`serviceAccount:${email}`, SECRET_ACCESSOR_ROLE)).sort();
}

export function buildSecretScopeConfiguration(input: SecretScopeSetupInput): EngineConfiguration {
  validate(input);
  const project = input.gcpProjectId;
  const resources: Record<string, EngineResourceMapping> = {};
  const resource: Record<string, Record<string, unknown>> = {};
  const add = (type: string, name: string, value: unknown, mapping: Partial<EngineResourceMapping> & { name: string }) => {
    (resource[type] ??= {})[name] = value;
    resources[`${type}.${name}`] = { actionId: `project-setup:${type}:${name}`, kind: 'project', ...mapping };
  };
  const accessor = (email: string, excluded: string[], dependsOn?: string[]) => {
    const member = `serviceAccount:${email}`;
    const address = projectIamAddress(member, SECRET_ACCESSOR_ROLE);
    // The shared runtime grant is also declared by base setup; identical name and action id let the two compose.
    add('google_project_iam_member', address.split('.')[1]!, {
      project, member, role: SECRET_ACCESSOR_ROLE,
      ...(excluded.length ? { condition: [secretExclusionCondition(input.projectNumber, excluded)] } : {}),
      // A changed condition replaces the grant; the new one must exist before the old one goes.
      lifecycle: { create_before_destroy: true },
      ...(dependsOn ? { depends_on: dependsOn } : {}),
    }, { name: `${member} ${SECRET_ACCESSOR_ROLE}`, requiresConfirm: true });
  };
  const mirrored = SERVICE_IDENTITY_MIRRORED_ROLES.filter((role) => input.runtimeProjectRoles.includes(role));
  for (const identity of input.identities) {
    const key = gcpProjectResourceKey(identity.accountId);
    const account = `google_service_account.${key}`;
    const member = `serviceAccount:${identity.email}`;
    add('google_service_account', key, {
      project, account_id: identity.accountId, display_name: `Hypervibe ${identity.environment}/${identity.service}`.slice(0, 100),
      description: `Runs only the ${identity.service} service of ${identity.environment}, so secrets limited to it stay with it.`,
    }, { name: `Identity for ${identity.environment}/${identity.service}`, requiresConfirm: true });
    for (const actor of [input.deployServiceAccountEmail, ...(input.ciReleaseServiceAccountEmail ? [input.ciReleaseServiceAccountEmail] : [])]) {
      const actorMember = `serviceAccount:${actor}`;
      add('google_service_account_iam_member', projectIamAddress(`${identity.email}:${actorMember}`, ACT_AS_ROLE).split('.')[1]!, {
        service_account_id: `\${${account}.name}`, member: actorMember, role: ACT_AS_ROLE,
      }, { name: `${actorMember} ${ACT_AS_ROLE} on ${identity.email}`, requiresConfirm: true });
    }
    for (const role of mirrored) {
      add('google_project_iam_member', projectIamAddress(member, role).split('.')[1]!, { project, member, role, depends_on: [account] },
        { name: `${member} ${role}`, requiresConfirm: true });
    }
    accessor(identity.email, identity.excludedSecretIds, [account]);
  }
  accessor(input.runtimeServiceAccountEmail, input.runtimeExcludedSecretIds);
  const descriptor: GcpSecretScopeDescriptor = {
    gcpProjectId: input.gcpProjectId, runtimeServiceAccountEmail: input.runtimeServiceAccountEmail,
    identities: input.identities, runtimeExcludedSecretIds: input.runtimeExcludedSecretIds,
  };
  return {
    files: {
      [DESCRIPTOR_FILE]: { locals: { [DESCRIPTOR_LOCAL]: { ...descriptor, projectNumber: input.projectNumber,
        deployServiceAccountEmail: input.deployServiceAccountEmail, runtimeProjectRoles: [...mirrored],
        ...(input.ciReleaseServiceAccountEmail ? { ciReleaseServiceAccountEmail: input.ciReleaseServiceAccountEmail } : {}) } } },
      'project-setup.tf.json': { resource },
    },
    resources,
  };
}

/** The reviewed input a saved contribution was built from; undefined unless the saved configuration is exactly what that input builds. */
export function readSecretScopeInput(configuration: EngineConfiguration): SecretScopeSetupInput | undefined {
  const locals = (configuration.files[DESCRIPTOR_FILE] as { locals?: Record<string, unknown> } | undefined)?.locals;
  const raw = locals?.[DESCRIPTOR_LOCAL] as SecretScopeSetupInput | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  try {
    return isDeepStrictEqual(buildSecretScopeConfiguration(raw), configuration) ? raw : undefined;
  } catch { return undefined; }
}

export function readSecretScopeDescriptor(configuration: EngineConfiguration): GcpSecretScopeDescriptor | undefined {
  const input = readSecretScopeInput(configuration);
  return input && { gcpProjectId: input.gcpProjectId, runtimeServiceAccountEmail: input.runtimeServiceAccountEmail,
    identities: input.identities, runtimeExcludedSecretIds: input.runtimeExcludedSecretIds };
}

interface IamPolicy { version?: number; bindings?: Array<{ role?: string; members?: string[]; condition?: Record<string, unknown> }> }

/**
 * Whether the live project policy enforces the reviewed setup: each identity has
 * exactly one Secret Accessor binding, carrying exactly the reviewed condition.
 * A second binding for the same identity would restore access outside it.
 */
export function secretScopePolicyProblems(policy: IamPolicy, input: SecretScopeSetupInput): string[] {
  const problems: string[] = [];
  const check = (email: string, excluded: string[]) => {
    const member = `serviceAccount:${email}`;
    const bindings = (policy.bindings ?? []).filter((binding) => binding.role === SECRET_ACCESSOR_ROLE && binding.members?.includes(member));
    const expected = excluded.length ? secretExclusionCondition(input.projectNumber, excluded) : undefined;
    if (bindings.length !== 1 || (expected ? policy.version !== 3 || !isDeepStrictEqual({ ...bindings[0]!.condition }, expected) : bindings[0]!.condition !== undefined)) {
      problems.push(`${email} does not hold exactly the reviewed Secret Accessor grant.`);
    }
  };
  check(input.runtimeServiceAccountEmail, input.runtimeExcludedSecretIds);
  for (const identity of input.identities) check(identity.email, identity.excludedSecretIds);
  // A broad role that reads every secret would bypass the conditions for a workload identity.
  const workloadMembers = new Set([input.runtimeServiceAccountEmail, ...input.identities.map((identity) => identity.email)].map((email) => `serviceAccount:${email}`));
  for (const binding of policy.bindings ?? []) {
    if (!['roles/owner', 'roles/secretmanager.admin'].includes(binding.role ?? '')) continue;
    for (const member of binding.members ?? []) if (workloadMembers.has(member)) problems.push(`${member} holds ${binding.role}, which reads every secret.`);
  }
  return problems.sort();
}
