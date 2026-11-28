import { isDeepStrictEqual } from 'node:util';
import { readGcpProject } from '../adapters/providers/gcp/gcp-data.client.js';
import { buildGcpObserverConfiguration, disableGcpObserverConfiguration, googleObserverBinding, observerKey, retainObserverRemovals, type GoogleObserver } from '../adapters/providers/gcp/tofu/gcp-observer.config.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { getGcpProjectSetupContribution, runGcpProjectSetup } from '../domain/services/gcp-project-setup.service.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { runtimeObservationIntent, runtimeObserverSchema } from '../domain/spec/runtime-observation.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { CommandContext } from './context.js';
import type { LaunchResult } from './launch.js';

interface Setup { project: Project; spec: ProjectSpec; environmentName: string; approveAccess?: string[]; browserAccess?: string; gcpSetupPlanId?: string }

export function gcpObserverNeedsRevocation(projectId: string, name: string, scope?: Record<string, unknown>) {
  if (scope?.runtimeObserver || scope?.runtimeObserverSetupPending) return true;
  const target = scope?.projectId;
  if (typeof target !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target)) return false;
  const key = observerKey(projectId, name);
  const saved = getGcpProjectSetupContribution(projectId, target, key);
  if (!saved) return false;
  const file = saved.files[key.replaceAll('_', '-') + '.tf.json'] as { resource?: { google_service_account?: Record<string, { disabled?: boolean }> } } | undefined;
  return file?.resource?.google_service_account?.[key]?.disabled !== true || scope?.runtimeObserver !== null;
}

export async function ensureGcpRuntimeObserver(ctx: CommandContext, params: Setup): Promise<LaunchResult | undefined> {
  const { project, spec, environmentName } = params;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
  const intent = runtimeObservationIntent(spec, environmentName);
  const scope = environment?.platformBindings;
  if (!intent && !scope?.projectId && !scope?.runtimeObserver) return;
  const env = spec.environments[environmentName]!;
  const gcpProject = scope?.projectId;
  if (!environment || !scope || typeof gcpProject !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProject)
    || scope.provider !== 'cloudrun' || (env.hosting.gcpProjectId && env.hosting.gcpProjectId !== gcpProject)) {
    if (!intent && !scope?.runtimeObserver) return;
    return { status: 'blocked', message: 'The observer needs the applied Google Cloud project and workload bindings. Review and apply the environment infrastructure first.' };
  }
  const key = observerKey(project.id, environmentName);
  const previous = getGcpProjectSetupContribution(project.id, gcpProject, key);
  if (!intent && !previous) {
    if (scope.runtimeObserver) return { status: 'blocked', message: 'The observer binding has no matching Google setup record. Restore the project setup state before removing access.' };
    return;
  }
  let config;
  let binding: GoogleObserver | null = null;
  let access: string[];
  let admin: string | undefined;
  if (intent) {
    const region = scope.environmentId;
    if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region) || (env.hosting.region && env.hosting.region !== region)) throw new Error('The observer region does not match the applied Cloud Run environment.');
    const resources = scope.services as Record<string, { serviceId?: string; workerPoolName?: string; jobName?: string }> | undefined;
    const services: GoogleObserver['services'] = {};
    for (const [name, service] of Object.entries(env.services)) {
      const kind = service.workloadKind ?? 'web';
      const native = resources?.[name];
      const collection = kind === 'cron' ? 'jobs' : kind === 'worker' ? 'workerPools' : 'services';
      const short = kind === 'cron' ? native?.jobName : kind === 'worker' ? native?.workerPoolName : native?.serviceId;
      if (!short || !/^[a-z][a-z0-9-]{0,62}$/.test(short)) throw new Error('The runtime observer requires an applied Cloud Run workload identity for ' + name + '.');
      services[name] = { workloadKind: kind, region, serviceId: `projects/${gcpProject}/locations/${region}/${collection}/${short}` };
    }
    const github = getGitHubAdapter(intent.repository);
    if ('error' in github) throw new Error(github.error);
    const [owner, repo] = intent.repository.split('/');
    const repository = await github.adapter.getRepository(owner!, repo!);
    if (repository.full_name !== intent.repository || !Number.isSafeInteger(repository.id) || repository.id! <= 0 || repository.default_branch !== intent.branch) {
      throw new Error('GitHub must verify the observer’s repository ID, exact repository name and current default branch before access is granted.');
    }
    admin = await getDefaultAdminAccessToken();
    const response = await readGcpProject(admin, gcpProject);
    const target = response.ok && await response.json() as { name?: string; projectId?: string; state?: string };
    if (!target || target.projectId !== gcpProject || target.state !== 'ACTIVE' || !/^projects\/[1-9]\d*$/.test(target.name ?? '')) throw new Error('Google could not verify the exact active project for the observer.');
    binding = googleObserverBinding({ key, project: gcpProject, number: target.name!.slice(9), intent, environmentId: environment.id, services });
    runtimeObserverSchema.parse(binding);
    config = buildGcpObserverConfiguration(binding, key, String(repository.id));
    access = [
      `Only ${intent.repository}/.github/workflows/hypervibe-observe-${environmentName}.yml on refs/heads/${intent.branch} in GitHub repository ${repository.id} can mint ${binding.gcp.serviceAccount}, on a hosted first-attempt schedule or manual run.`,
      `Grant logging.logEntries.list across ${gcpProject}. Google grants this read at project scope. The collector queries only the bound workloads and can read non-private project logs.`,
      ...Object.values(services).filter(s => s.workloadKind === 'cron').map(s => 'Grant run.executions.list on ' + s.serviceId + '.'),
      `Create the native monitoring dashboard and alert policies. The collector runs every ${env.runtimeObservation?.intervalMinutes ?? 5} minutes on GitHub-hosted runners. Provider monitoring operations may incur charges.`,
      ...(env.runtimeObservation?.hostedReview ? ['Send redacted findings and terminal job results to the hosted daily review for this repository and environment.'] : []),
    ];
  } else {
    config = disableGcpObserverConfiguration(previous!, key);
    access = ['Revoke impersonation and all observer log and execution grants. Disable the dedicated identity, pool and provider. Remove the observer dashboard and alert policies. Keep disabled identity names available for reactivation.'];
  }
  const allowDestroyAddresses = retainObserverRemovals(config, previous);
  if (!intent && scope.runtimeObserver === null && !scope.runtimeObserverSetupPending && isDeepStrictEqual(config, previous)) return;
  const browser = params.browserAccess === 'runtime-observer' && Boolean(params.gcpSetupPlanId);
  const confirm = browser || Boolean(params.approveAccess?.includes('runtime-observer'));
  if (confirm && !params.gcpSetupPlanId) return { status: 'blocked', message: 'Confirm runtime monitoring with the gcpSetupPlanId from its saved access preview.' };
  const token = admin ?? await getDefaultAdminAccessToken();
  // The setup manifest is written before native apply. A failed reactivation must still be revocable even if the
  // last published binding was null. Record the in-flight operation without changing the exported identity.
  if (confirm && scope.runtimeObserver === null) ctx.repos.environments.updatePlatformBindings(environment.id, { runtimeObserverSetupPending: true });
  const result = await runGcpProjectSetup({ projectId: project.id, projectName: project.name, gcpProjectId: gcpProject,
    contribution: { id: key, configuration: config }, auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token }, redact: [token] },
    runtimeObservationAccess: access, allowDestroyAddresses, confirm,
    ...(confirm && { gcpSetupPlanId: params.gcpSetupPlanId, requireBrowserApproval: browser }) });
  if (!result.success) return { status: 'blocked', message: result.error ?? 'Google runtime observer setup did not complete.' };
  if (!confirm && !(result.actions?.every(action => action.type === 'noop') && isDeepStrictEqual(previous, config))) return {
    status: 'needs_access', accessId: 'runtime-observer', access: access.join(' '), grants: { gcpProjectId: gcpProject, access, planId: result.planId, htmlPath: result.htmlPath, actions: result.actions },
    confirmationHint: `Review the observer setup. Approve runtime-observer with gcpSetupPlanId ${result.planId}.`,
  };
  if (confirm || scope.runtimeObserverSetupPending || !isDeepStrictEqual(scope.runtimeObserver, binding)) ctx.repos.environments.updatePlatformBindings(environment.id, { runtimeObserver: binding, runtimeObserverSetupPending: false });
  return;
}
