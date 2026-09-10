import type {
  BranchDeployRuntimeResource,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';

export const CLOUD_RUN_PROVIDER_COMMAND_IMAGE_ENTRYPOINT =
  'echo "Hypervibe applies the runtime command during Cloud Run release." >&2; exit 1';

/** Resolve the exact provider-bound runtime contract, with a legacy fallback for hand-built targets. */
export function reviewedCloudRunRuntimeResources(target: BranchDeployTarget): BranchDeployRuntimeResource[] {
  if (target.runtimeResources) return target.runtimeResources;
  const resources = target.releaseTarget?.resources ?? [
    ...target.providerServiceIds.map((providerResourceId, index) => ({
      logicalName: target.serviceNames[index] ?? providerResourceId,
      workloadKind: 'web' as const,
      providerResourceType: 'service' as const,
      providerResourceId,
    })),
    ...(target.providerJobNames ?? []).map((providerResourceId, index) => ({
      logicalName: target.serviceNames[target.providerServiceIds.length + index] ?? providerResourceId,
      workloadKind: 'cron' as const,
      providerResourceType: 'job' as const,
      providerResourceId,
    })),
  ];
  return resources.map((resource) => ({
    ...resource,
    startCommand: target.containerStartCommand ?? null,
    healthCheckPath: null,
  }));
}

export function cloudRunContainerBuildStartCommand(target: BranchDeployTarget): string | undefined {
  if (target.containerStartCommand) return target.containerStartCommand;
  const resources = reviewedCloudRunRuntimeResources(target);
  return resources.length > 0 && resources.every((resource) => resource.startCommand)
    ? CLOUD_RUN_PROVIDER_COMMAND_IMAGE_ENTRYPOINT
    : undefined;
}

/** Shared provider-API runtime used by GitHub and portable CI Cloud Run deploys. */
export function buildCloudRunReleaseRuntime(): string {
  return `function cloudRunReleaseReadiness(resource) {
  if (!resource) return { ready: false };
  const condition = resource.terminalCondition || (resource.conditions || []).find((entry) => entry.type === 'Ready');
  const state = condition?.state || condition?.status;
  const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
  const failed = state === 'CONDITION_FAILED' || state === 'False';
  const generationsMatch = !resource.generation || !resource.observedGeneration || String(resource.generation) === String(resource.observedGeneration);
  if (succeeded && generationsMatch && resource.reconciling !== true) return { ready: true };
  if (failed && resource.reconciling !== true) return { ready: false, error: (condition?.reason ? condition.reason + ': ' : '') + (condition?.message || 'Ready condition failed') };
  return { ready: false };
}

function cloudRunReleaseExecutionStatus(execution) {
  const completion = String(execution?.completionStatus || '').toLowerCase();
  if (completion.includes('succeed')) return 'completed';
  if (completion.includes('fail') || completion.includes('cancel') || completion.includes('timeout')) return 'failed';
  const readiness = cloudRunReleaseReadiness(execution);
  if (readiness.ready) return 'completed';
  if (readiness.error) return 'failed';
  return 'running';
}

function cloudRunReleaseComparable(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(cloudRunReleaseComparable);
    return normalized.every((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string')
      ? normalized.sort((left, right) => left.name.localeCompare(right.name))
      : normalized;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, cloudRunReleaseComparable(value[key])]));
}

function cloudRunReleaseSame(left, right) {
  return JSON.stringify(cloudRunReleaseComparable(left)) === JSON.stringify(cloudRunReleaseComparable(right));
}

function cloudRunReleaseSameList(left, right) {
  const normalizedLeft = Array.isArray(left) && left.length === 0 ? undefined : left;
  const normalizedRight = Array.isArray(right) && right.length === 0 ? undefined : right;
  return cloudRunReleaseSame(normalizedLeft, normalizedRight);
}

function cloudRunRuntimeResourcesFromBase64(encoded, serviceNames, jobNames) {
  if (typeof encoded !== 'string' || !encoded) throw new Error('Cloud Run runtime resources are required');
  let resources;
  try { resources = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('Cloud Run runtime resources are invalid'); }
  if (!Array.isArray(resources)) throw new Error('Cloud Run runtime resources are invalid');
  const expected = new Map([
    ...serviceNames.map((name) => [name, 'service']),
    ...jobNames.map((name) => [name, 'job']),
  ]);
  if (resources.length !== expected.size) throw new Error('Cloud Run runtime resources do not match the reviewed provider bindings');
  const seen = new Set();
  for (const resource of resources) {
    const keys = Object.keys(resource || {}).sort().join(',');
    if (keys !== 'healthCheckPath,logicalName,providerResourceId,providerResourceType,startCommand,workloadKind'
        || typeof resource.logicalName !== 'string' || !resource.logicalName.trim()
        || typeof resource.providerResourceId !== 'string' || !resource.providerResourceId.trim()
        || !['web', 'worker', 'cron'].includes(resource.workloadKind)
        || !['service', 'job'].includes(resource.providerResourceType)
        || expected.get(resource.providerResourceId) !== resource.providerResourceType
        || (resource.providerResourceType === 'job') !== (resource.workloadKind === 'cron')
        || seen.has(resource.providerResourceType + ':' + resource.providerResourceId)
        || !(resource.startCommand === null || (typeof resource.startCommand === 'string' && resource.startCommand.trim()))
        || !(resource.healthCheckPath === null || (typeof resource.healthCheckPath === 'string' && /^\\/[\\x21-\\x7e]*$/.test(resource.healthCheckPath)))
        || (resource.workloadKind === 'cron' && resource.healthCheckPath !== null)
        || (resource.workloadKind === 'cron' && resource.startCommand === null)) {
      throw new Error('Cloud Run runtime resources do not match the reviewed provider bindings');
    }
    seen.add(resource.providerResourceType + ':' + resource.providerResourceId);
  }
  return resources;
}

function cloudRunRuntimeResource(resources, providerResourceType, providerResourceId) {
  const resource = resources.find((entry) => entry.providerResourceType === providerResourceType && entry.providerResourceId === providerResourceId);
  if (!resource) throw new Error('Cloud Run runtime resource ' + providerResourceType + ':' + providerResourceId + ' is not reviewed');
  return resource;
}

function cloudRunContainerWithRuntime(container, image, resource) {
  const configured = { ...(container || {}), image };
  delete configured.command;
  delete configured.args;
  delete configured.startupProbe;
  delete configured.livenessProbe;
  if (resource.startCommand !== null) {
    configured.command = ['/bin/sh'];
    configured.args = ['-lc', resource.startCommand];
  }
  if (resource.healthCheckPath !== null) {
    configured.startupProbe = { httpGet: { path: resource.healthCheckPath } };
  }
  return configured;
}

function cloudRunRuntimeMismatch(container, resource) {
  const expectedCommand = resource.startCommand === null ? undefined : ['/bin/sh'];
  const expectedArgs = resource.startCommand === null ? undefined : ['-lc', resource.startCommand];
  if (!cloudRunReleaseSameList(container?.command, expectedCommand)
      || !cloudRunReleaseSameList(container?.args, expectedArgs)) return 'container command';
  const startupPath = container?.startupProbe?.httpGet?.path || null;
  const livenessPath = container?.livenessProbe?.httpGet?.path || null;
  if (startupPath !== resource.healthCheckPath || livenessPath !== null) return 'health probe';
  return null;
}

function cloudRunReleaseJobMismatch(job, expectedName, expectedTask) {
  if (job?.name !== expectedName) return 'resource identity';
  const actualTask = job?.template?.template;
  const expectedContainer = expectedTask?.containers?.[0];
  const actualContainer = actualTask?.containers?.[0];
  if (!actualTask || !expectedContainer || !actualContainer) return 'task container';
  for (const field of ['image', 'command', 'args']) {
    if (!cloudRunReleaseSame(actualContainer[field], expectedContainer[field])) return 'container ' + field;
  }
  for (const field of ['env', 'volumeMounts']) {
    if (!cloudRunReleaseSameList(actualContainer[field], expectedContainer[field])) return 'container ' + field;
  }
  if (actualContainer.resources?.cpuIdle !== undefined) return 'container resources.cpuIdle';
  if (!cloudRunReleaseSame(actualContainer.resources?.limits, expectedContainer.resources?.limits)) return 'container resource limits';
  if (!cloudRunReleaseSameList(actualTask.volumes, expectedTask.volumes)) return 'task volumes';
  for (const field of ['serviceAccount', 'vpcAccess', 'maxRetries', 'timeout']) {
    if (!cloudRunReleaseSame(actualTask[field], expectedTask[field])) return 'task ' + field;
  }
  return null;
}

async function cloudRunReleaseResponse(response, description) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(description + ' returned non-JSON: ' + text); }
  if (!response.ok) throw new Error(description + ' failed: ' + response.status + ' ' + text);
  return payload;
}

async function runCloudRunReleaseCommands(params) {
  if (!Array.isArray(params.releases)) throw new Error('Cloud Run release commands are invalid');
  for (const release of params.releases) {
    if (!release || typeof release.command !== 'string' || !release.command.trim()
        || typeof release.providerServiceId !== 'string' || !release.providerServiceId.trim()
        || typeof release.jobName !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(release.jobName)
        || !/^[0-9a-f]{64}$/.test(release.commandHash || '')) {
      throw new Error('Every Cloud Run release command requires a bound runtime service');
    }
    const serviceName = release.providerServiceId.trim();
    const serviceUrl = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(params.projectId) + '/locations/' + encodeURIComponent(params.region) + '/services/' + encodeURIComponent(serviceName);
    const service = await params.getJson(serviceUrl, { headers: params.authHeaders }, 'Cloud Run release source lookup for ' + serviceName);
    const expectedServiceName = 'projects/' + params.projectId + '/locations/' + params.region + '/services/' + serviceName;
    if (service.name !== expectedServiceName) throw new Error('Cloud Run returned a different release source service identity');
    const sourceTemplate = service.template || {};
    const sourceContainer = sourceTemplate.containers?.[0] || service?.spec?.template?.spec?.containers?.[0] || {};
    const resources = sourceContainer.resources && typeof sourceContainer.resources === 'object'
      ? { ...sourceContainer.resources }
      : undefined;
    if (resources) delete resources.cpuIdle;
    const container = {
      image: params.imageUri,
      command: ['/bin/sh'],
      args: ['-lc', release.command],
      ...(Array.isArray(sourceContainer.env) ? { env: sourceContainer.env } : {}),
      ...(resources && Object.keys(resources).length > 0 ? { resources } : {}),
      ...(Array.isArray(sourceContainer.volumeMounts) && sourceContainer.volumeMounts.length > 0
        ? { volumeMounts: sourceContainer.volumeMounts }
        : {}),
    };
    const task = {
      containers: [container],
      ...(Array.isArray(sourceTemplate.volumes) && sourceTemplate.volumes.length > 0
        ? { volumes: sourceTemplate.volumes }
        : {}),
      ...(sourceTemplate.serviceAccount || sourceTemplate.serviceAccountName
        ? { serviceAccount: sourceTemplate.serviceAccount || sourceTemplate.serviceAccountName }
        : {}),
      ...(sourceTemplate.vpcAccess ? { vpcAccess: sourceTemplate.vpcAccess } : {}),
      maxRetries: 1,
      timeout: '3600s',
    };
    const jobSpec = { template: { template: task } };
    const jobName = release.jobName;
    const jobsUrl = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(params.projectId) + '/locations/' + encodeURIComponent(params.region) + '/jobs';
    const jobUrl = jobsUrl + '/' + encodeURIComponent(jobName);
    const observedResponse = await fetch(jobUrl, { headers: params.authHeaders });
    if (observedResponse.status === 404) {
      throw new Error('Cloud Run reviewed release job ' + jobName + ' is missing; run Hypervibe plan and apply before CI deployment');
    }
    await cloudRunReleaseResponse(observedResponse, 'Cloud Run release job lookup for ' + jobName);
    const mutationResponse = await fetch(jobUrl, {
      method: 'PATCH', headers: params.headers, body: JSON.stringify(jobSpec),
    });
    const mutation = await cloudRunReleaseResponse(mutationResponse, 'Cloud Run release job configuration for ' + jobName);
    const operationPrefix = 'projects/' + params.projectId + '/locations/' + params.region + '/operations/';
    if (!mutation?.name?.startsWith(operationPrefix) || mutation.name.length <= operationPrefix.length) {
      throw new Error('Cloud Run release job ' + jobName + ' configuration returned a different operation identity');
    }
    await params.waitOperation(mutation, 'release job ' + jobName + ' configuration');

    let readyJob;
    for (let attempt = 0; attempt < 120; attempt++) {
      readyJob = await params.getJson(jobUrl, { headers: params.authHeaders }, 'Cloud Run release job readiness for ' + jobName);
      const readiness = cloudRunReleaseReadiness(readyJob);
      if (readiness.ready) {
        const mismatch = cloudRunReleaseJobMismatch(
          readyJob,
          'projects/' + params.projectId + '/locations/' + params.region + '/jobs/' + jobName,
          jobSpec.template.template
        );
        if (mismatch) throw new Error('Cloud Run release job ' + jobName + ' did not converge to the exact candidate ' + mismatch);
        break;
      }
      if (readiness.error) throw new Error('Cloud Run release job ' + jobName + ' is not ready: ' + readiness.error);
      if (attempt === 119) throw new Error('Cloud Run release job ' + jobName + ' was not ready before timeout');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const runOperation = await params.getJson(jobUrl + ':run', {
      method: 'POST', headers: params.headers, body: JSON.stringify({}),
    }, 'Cloud Run release job run for ' + jobName);
    if (!runOperation?.name?.startsWith(operationPrefix) || runOperation.name.length <= operationPrefix.length) {
      throw new Error('Cloud Run release job ' + jobName + ' returned a different operation identity');
    }
    const completedRun = await params.waitOperation(runOperation, 'release job ' + jobName + ' run');
    let execution = completedRun?.response;
    const executionPrefix = 'projects/' + params.projectId + '/locations/' + params.region + '/jobs/' + jobName + '/executions/';
    if (!execution?.name?.startsWith(executionPrefix) || execution.name.length <= executionPrefix.length) {
      throw new Error('Cloud Run release job ' + jobName + ' returned a different execution identity');
    }
    const exactExecutionName = execution.name;
    let status = cloudRunReleaseExecutionStatus(execution);
    for (let attempt = 0; status === 'running' && attempt < 300; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      execution = await params.getJson(
        'https://run.googleapis.com/v2/' + exactExecutionName,
        { headers: params.authHeaders },
        'Cloud Run release execution readiness for ' + jobName
      );
      if (execution.name !== exactExecutionName) {
        throw new Error('Cloud Run release execution lookup returned a different execution identity for ' + jobName);
      }
      status = cloudRunReleaseExecutionStatus(execution);
    }
    if (status !== 'completed') {
      throw new Error('Cloud Run release execution ' + execution.name + ' ended with status ' + status);
    }
  }
}
`;
}
