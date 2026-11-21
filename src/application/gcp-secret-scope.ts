import { isDeepStrictEqual } from 'node:util';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import { getCloudPreparation } from '../domain/services/cloud-prepare.js';
import { getGcpProjectSetupContribution, getGcpRuntimeIsolation, runGcpProjectSetup } from '../domain/services/gcp-project-setup.service.js';
import {
  GCP_SECRET_SCOPE_CONTRIBUTION, gcpScopedSecrets, gcpScopedServices, gcpSecretScopeDescriptor, gcpSecretScopeProblems, gcpUnlockedSecrets,
  type GcpSecretScopeEnvironment,
} from '../domain/services/gcp-secret-scope.js';
import {
  buildSecretScopeConfiguration, readSecretScopeInput, secretScopeConditionAddresses, SERVICE_IDENTITY_MIRRORED_ROLES,
  type SecretScopeSetupInput,
} from '../adapters/providers/gcp/tofu/secret-scope-setup.js';
import { observeSecretScope, readAppliedWorkloads, readVerifiedSecretScope, recordVerifiedSecretScope } from '../adapters/providers/gcp/secret-scope-state.js';
import { ciReleaseIdentity } from '../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import { readGcpProject } from '../adapters/providers/gcp/gcp-data.client.js';

/** The release command's workload record; not a legal service name. */
export const RELEASE_WORKLOAD = '@release';

export function secretScopePrepareCall(project: Project, environmentName: string): string {
  return `hv_connections project=${JSON.stringify(project.name)} provider="cloudrun" action="prepare" environment=${JSON.stringify(environmentName)} secretScopeAccess="lifecycle"`;
}

type Repos = Pick<CommandContext, 'repos'>;

/** Cloud Run environments of this spec that live in one Google Cloud project, with local evidence of what their workloads hold. */
export function gcpSecretScopeEnvironments(ctx: Repos, project: Project, spec: ProjectSpec, gcpProjectId: string, selected?: string): GcpSecretScopeEnvironment[] {
  const defaultProjectId = getCloudPreparation(project, 'cloudrun')?.gcpProjectId;
  return Object.entries(spec.environments)
    .filter(([name, environment]) => environment.hosting.provider === 'cloudrun'
      && (name === selected || (environment.hosting.gcpProjectId ?? defaultProjectId) === gcpProjectId))
    .map(([name]) => {
      const environment = ctx.repos.environments.findByProjectAndName(project.id, name);
      const bindings = (environment?.platformBindings ?? {}) as { services?: Record<string, unknown>; engine?: { releaseJob?: string } };
      return {
        name,
        boundWorkloads: [...Object.keys(bindings.services ?? {}), ...(bindings.engine?.releaseJob ? [RELEASE_WORKLOAD] : [])].sort(),
        applied: environment ? readAppliedWorkloads(project.id, environment.id) : {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The setup this spec and this local evidence call for; the project number comes from Google or from the verified record. */
export function expectedSecretScopeInput(ctx: Repos, project: Project, spec: ProjectSpec, target: {
  gcpProjectId: string; projectNumber: string; runtimeServiceAccountEmail: string; deployServiceAccountEmail: string;
  environmentProjectId?: string; selectedEnvironment?: string;
}): SecretScopeSetupInput {
  const saved = getGcpProjectSetupContribution(project.id, target.gcpProjectId, GCP_SECRET_SCOPE_CONTRIBUTION);
  const retained = saved ? readSecretScopeInput(saved)?.identities : undefined;
  if (saved && !retained) throw new Error('The saved service identity setup does not match what Hypervibe builds. Review the project setup before continuing.');
  const descriptor = gcpSecretScopeDescriptor({
    spec, gcpProjectId: target.gcpProjectId, runtimeServiceAccountEmail: target.runtimeServiceAccountEmail,
    environments: gcpSecretScopeEnvironments(ctx, project, spec, target.gcpProjectId, target.selectedEnvironment), retained,
  });
  const runtimeRoles = getCloudPreparation(project, 'cloudrun', target.environmentProjectId)?.runtimeRequiredRoles ?? [];
  return {
    ...descriptor, projectNumber: target.projectNumber, deployServiceAccountEmail: target.deployServiceAccountEmail,
    runtimeProjectRoles: SERVICE_IDENTITY_MIRRORED_ROLES.filter((role) => runtimeRoles.includes(role)),
    ...(getGcpProjectSetupContribution(project.id, target.gcpProjectId, 'ci-release') ? { ciReleaseServiceAccountEmail: ciReleaseIdentity(target.gcpProjectId) } : {}),
  };
}

export interface GcpSecretScopeGate {
  /** False when this Google Cloud project has no limited secret and never had service identity setup: nothing changes. */
  active: boolean;
  blocked?: string;
  /** Service -> the identity it runs as. Services not listed run as the shared runtime identity. */
  identities: Record<string, string>;
  warnings: string[];
}

/**
 * Decides whether an environment may be planned with limited secrets.
 *
 * Planning stops unless the setup that was applied and verified is exactly the
 * setup this spec and the recorded workload state call for. That one comparison
 * covers a missing identity, a secret still readable by the shared identity
 * after services stopped holding it, and a lock that would deny a service a
 * secret the plan is about to give it.
 */
export function gcpSecretScopeGate(ctx: Repos, project: Project, spec: ProjectSpec, environmentName: string, context: {
  gcpProjectId: string; runtimeServiceAccountEmail: string; runtimeSecretGrantOrigins?: Record<string, unknown>;
}): GcpSecretScopeGate {
  const inactive: GcpSecretScopeGate = { active: false, identities: {}, warnings: [] };
  const environmentProjectId = spec.environments[environmentName]?.hosting.gcpProjectId;
  let verified: SecretScopeSetupInput | undefined;
  try {
    verified = readVerifiedSecretScope(project.id, context.gcpProjectId);
    const environments = gcpSecretScopeEnvironments(ctx, project, spec, context.gcpProjectId, environmentName);
    const anyLimited = environments.some((environment) => Object.keys(gcpScopedSecrets(spec, environment.name)).length > 0);
    if (!anyLimited && !verified && !getGcpProjectSetupContribution(project.id, context.gcpProjectId, GCP_SECRET_SCOPE_CONTRIBUTION)) return inactive;
  } catch (error) {
    return { ...inactive, active: true, blocked: error instanceof Error ? error.message : String(error) };
  }
  const stop = (blocked: string): GcpSecretScopeGate => ({ active: true, blocked, identities: {}, warnings: [] });
  const problems = gcpSecretScopeProblems(spec, environmentName);
  if (problems.length) return stop(problems.join(' '));
  const limited = gcpScopedSecrets(spec, environmentName);
  if (Object.keys(limited).length && Object.keys(context.runtimeSecretGrantOrigins ?? {}).length) {
    return stop(`${environmentName} still has per-secret grants for the shared runtime identity from gcpRuntimeSecretGrants. Apply their removal before limiting a secret to named services: remove "services" from ${Object.keys(limited).join(', ')}, run hv_plan and hv_apply, then add it back.`);
  }
  if (getGcpRuntimeIsolation(project.id, context.gcpProjectId, context.runtimeServiceAccountEmail)) {
    return stop('This Google Cloud project carries a migration copy restriction on the shared runtime identity. Secrets limited to named services cannot be combined with it yet.');
  }
  const next = `Run ${secretScopePrepareCall(project, environmentName)} to preview the Google Cloud access change, then confirm it. It needs a Google Cloud administrator sign-in.`;
  const deployServiceAccountEmail = getCloudPreparation(project, 'cloudrun', environmentProjectId)?.deployServiceAccountEmail;
  if (!deployServiceAccountEmail) return stop('Google Cloud setup for this project has no recorded deployment identity. Run hv_connections provider="cloudrun" action="prepare" first.');
  if (!verified) {
    return stop(`Secrets limited to named services need their own service identities in Google Cloud project ${context.gcpProjectId}, and no verified setup exists yet. ${next}`);
  }
  // A confirmed setup saves its intent before applying. If that apply stopped part-way or its result was
  // never verified, the saved setup is ahead of the verification and live access is unknown.
  const saved = getGcpProjectSetupContribution(project.id, context.gcpProjectId, GCP_SECRET_SCOPE_CONTRIBUTION);
  if (!saved || !isDeepStrictEqual(saved, buildSecretScopeConfiguration(verified))) {
    return stop(`The last Google Cloud access change for secrets limited to named services was not verified, so their limits are not treated as enforced. ${next}`);
  }
  let expected: SecretScopeSetupInput;
  try {
    expected = expectedSecretScopeInput(ctx, project, spec, { gcpProjectId: context.gcpProjectId, projectNumber: verified.projectNumber,
      runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, deployServiceAccountEmail, environmentProjectId, selectedEnvironment: environmentName });
  } catch (error) {
    return stop(error instanceof Error ? error.message : String(error));
  }
  if (!isDeepStrictEqual(buildSecretScopeConfiguration(expected), buildSecretScopeConfiguration(verified))) {
    const missing = expected.identities.filter((identity) => !verified!.identities.some((known) => known.email === identity.email));
    const lock = expected.runtimeExcludedSecretIds.filter((id) => !verified!.runtimeExcludedSecretIds.includes(id));
    const reason = missing.length ? `${missing.map((identity) => `${identity.environment}/${identity.service}`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no service identity yet.`
      : lock.length ? `${lock.join(', ')} ${lock.length === 1 ? 'is' : 'are'} no longer held by other services, but the shared runtime identity can still read ${lock.length === 1 ? 'it' : 'them'} through Secret Manager. The limit is not in force until that access is removed.`
        : 'The verified Google Cloud access no longer matches the secrets limited to named services (their services, the workloads that hold them, or the project setup changed).';
    return stop(`${reason} ${next}`);
  }
  const scoped = new Set(gcpScopedServices(spec, environmentName));
  const identities = Object.fromEntries(verified.identities
    .filter((identity) => identity.environment === environmentName && scoped.has(identity.service))
    .map((identity) => [identity.service, identity.email] as const));
  const unlocked = gcpUnlockedSecrets(spec, environmentName, verified);
  const locked = Object.keys(limited).filter((key) => !unlocked.includes(key));
  return { active: true, identities, warnings: [
    ...(locked.length ? [`Limited to named services and enforced in Google Cloud: ${locked.map((key) => `${key} (${limited[key]!.join(', ')})`).join('; ')}. Other services of ${environmentName} cannot read ${locked.length === 1 ? 'it' : 'them'} with their runtime identity.`] : []),
    ...(unlocked.length ? [`NOT YET ENFORCED: ${unlocked.map((key) => `${key} (${limited[key]!.join(', ')})`).join('; ')}. Services that held ${unlocked.length === 1 ? 'this secret' : 'these secrets'} can still read ${unlocked.length === 1 ? 'it' : 'them'} through Secret Manager until this plan is applied and the Google Cloud access change is confirmed. After hv_apply: ${secretScopePrepareCall(project, environmentName)}. Further plans stay blocked until then.`] : []),
  ] };
}

/** Previews or confirms the service identities and Secret Accessor conditions for one Google Cloud project. */
export async function prepareGcpSecretScope(ctx: Repos, params: {
  project: Project; spec: ProjectSpec; environmentName: string; gcpProjectId: string; adminToken: () => Promise<string>; confirm?: boolean;
  /** Test seams: Google's project number, the setup engine and the live reads after apply. */
  dependencies?: {
    projectNumber?: (token: string) => Promise<string | undefined>;
    setup?: typeof runGcpProjectSetup;
    observe?: (token: string, input: SecretScopeSetupInput) => Promise<string[]>;
  };
}): Promise<Record<string, unknown> & { success: boolean }> {
  const { project, spec, environmentName, gcpProjectId } = params;
  const environment = spec.environments[environmentName];
  if (!environment || environment.hosting.provider !== 'cloudrun') return { success: false, error: `Environment ${environmentName} is not hosted on Cloud Run.` };
  const environmentProjectId = environment.hosting.gcpProjectId;
  const preparation = getCloudPreparation(project, 'cloudrun', environmentProjectId);
  if (!preparation?.runtimeServiceAccountEmail || !preparation.deployServiceAccountEmail || preparation.gcpProjectId !== gcpProjectId) {
    return { success: false, error: `Google Cloud project ${gcpProjectId} has no completed base setup with a separate runtime identity. Run hv_connections provider="cloudrun" action="prepare" first.` };
  }
  const runtimeServiceAccountEmail = preparation.runtimeServiceAccountEmail;
  if (getGcpRuntimeIsolation(project.id, gcpProjectId, runtimeServiceAccountEmail)) {
    return { success: false, error: 'This Google Cloud project carries a migration copy restriction on the shared runtime identity. Secrets limited to named services cannot be combined with it yet.' };
  }
  const environments = gcpSecretScopeEnvironments(ctx, project, spec, gcpProjectId, environmentName);
  const problems = environments.flatMap((entry) => gcpSecretScopeProblems(spec, entry.name));
  if (problems.length) return { success: false, error: problems.join(' ') };
  try {
    const token = await params.adminToken();
    const projectNumber = await (params.dependencies?.projectNumber ?? ((value: string) => readProjectNumber(value, gcpProjectId)))(token);
    if (!projectNumber) return { success: false, error: 'The Google Cloud project identity could not be verified.' };
    const input = expectedSecretScopeInput(ctx, project, spec, { gcpProjectId, projectNumber,
      runtimeServiceAccountEmail, deployServiceAccountEmail: preparation.deployServiceAccountEmail, environmentProjectId, selectedEnvironment: environmentName });
    const previous = getGcpProjectSetupContribution(project.id, gcpProjectId, GCP_SECRET_SCOPE_CONTRIBUTION);
    if (!input.identities.length && !previous) {
      return { success: false, error: `No secret is limited to named services in Google Cloud project ${gcpProjectId}; there is nothing to set up.` };
    }
    const configuration = buildSecretScopeConfiguration(input);
    const summary = {
      gcpProjectId,
      serviceIdentities: input.identities.map((identity) => ({ environment: identity.environment, service: identity.service, identity: identity.email,
        cannotRead: identity.excludedSecretIds })),
      sharedRuntimeIdentity: { identity: runtimeServiceAccountEmail, cannotRead: input.runtimeExcludedSecretIds },
      notYetEnforced: environments.flatMap((entry) => gcpUnlockedSecrets(spec, entry.name, input).map((key) => `${entry.name}: ${key}`)),
    };
    const setup = await (params.dependencies?.setup ?? runGcpProjectSetup)({ projectId: project.id, projectName: project.name, gcpProjectId,
      auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: gcpProjectId }, redact: [token] },
      contribution: { id: GCP_SECRET_SCOPE_CONTRIBUTION, configuration }, confirm: params.confirm,
      allowReplaceAddresses: [...new Set([...secretScopeConditionAddresses(previous), ...secretScopeConditionAddresses(configuration)])].sort() });
    if (!setup.success) return { ...setup, summary };
    if (!params.confirm) {
      return { ...setup, summary, requiresConfirmation: true,
        message: 'Review these exact Google Cloud identity and Secret Manager access changes, then confirm the saved preview.' };
    }
    const unverified = await (params.dependencies?.observe ?? observeSecretScope)(token, input);
    if (unverified.length) {
      return { success: false, summary, error: `The Google Cloud access change was applied but could not be verified: ${unverified.join(' ')} Limited secrets are not treated as enforced. Preview the setup again.` };
    }
    recordVerifiedSecretScope(project.id, input);
    return { ...setup, success: true, summary,
      message: summary.notYetEnforced.length
        ? `Service identities are ready. Not yet enforced: ${summary.notYetEnforced.join(', ')}. Run hv_plan and hv_apply for ${environmentName}, then run this preparation again to remove the shared identity's access.`
        : 'Service identities are ready and every limited secret is closed to the identities of other services.',
      nextSteps: ['hv_plan, then hv_apply', ...(summary.notYetEnforced.length ? [secretScopePrepareCall(project, environmentName)] : [])] };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Service identity setup failed.' };
  }
}

async function readProjectNumber(token: string, gcpProjectId: string): Promise<string | undefined> {
  const response = await readGcpProject(token, gcpProjectId);
  if (!response.ok) return undefined;
  const body = await response.json() as { name?: string; projectId?: string; state?: string };
  return /^projects\/[1-9][0-9]*$/.test(body.name ?? '') && body.projectId === gcpProjectId && body.state === 'ACTIVE'
    ? body.name!.slice('projects/'.length) : undefined;
}
