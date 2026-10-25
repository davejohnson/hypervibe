import { createHash } from 'node:crypto';

/** Reviewed inactive container configuration, shared by create and first release. */
export function gcpHoldingServiceConfiguration(image: string, email: string, publicAccess: boolean) {
  return {
    ingress: publicAccess ? 'INGRESS_TRAFFIC_ALL' : 'INGRESS_TRAFFIC_INTERNAL_ONLY', invokerIamDisabled: false,
    template: {
      serviceAccount: email, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 }, timeout: '300s', maxInstanceRequestConcurrency: 1,
      containers: [{ image, ports: [{ containerPort: 8080 }],
        resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true, startupCpuBoost: false },
        startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }],
    },
  };
}

/** Self-contained so the exact interpretation can also run in emitted CI.
 * Server-generated fields stay outside the fingerprint. Native implicit scalar
 * and empty repeated defaults are normalized; identity/readiness never default.
 */
export function gcpObservedHoldingConfiguration(resource: unknown, expected: {
  id: string; lifetimeId?: string; image: string; serviceAccountEmail: string; publicAccess: boolean;
}) {
  const fail = (): never => { throw new Error('The exact prepared Google workload could not be verified.'); };
  const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail();
  const empty = (value: unknown) => value === undefined || Array.isArray(value) && value.length === 0;
  const noFields = (value: unknown) => value === undefined || value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length;
  const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  const r = object(resource), template = object(r.template), containers = template.containers;
  if (r.name !== expected.id || typeof r.uid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.uid)
    || expected.lifetimeId && r.uid !== expected.lifetimeId || typeof r.etag !== 'string' || !r.etag
    || typeof r.generation !== 'string' || !/^[1-9]\d*$/.test(r.generation) || r.observedGeneration !== r.generation
    || r.reconciling !== undefined && r.reconciling !== false || r.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
    || typeof r.latestCreatedRevision !== 'string' || !r.latestCreatedRevision.startsWith(`${expected.id}/revisions/`)
    || r.latestReadyRevision !== r.latestCreatedRevision || r.invokerIamDisabled !== undefined && r.invokerIamDisabled !== false
    || r.ingress !== (expected.publicAccess ? 'INGRESS_TRAFFIC_ALL' : 'INGRESS_TRAFFIC_INTERNAL_ONLY')
    || !noFields(r.scaling) || !empty(r.customAudiences) || !empty(r.iapEnabled === false ? undefined : r.iapEnabled)
    || !Array.isArray(containers) || containers.length !== 1 || !empty(template.volumes) || !noFields(template.vpcAccess)
    || template.serviceAccount !== expected.serviceAccountEmail || template.executionEnvironment !== 'EXECUTION_ENVIRONMENT_GEN2'
    || template.timeout !== '300s' || template.maxInstanceRequestConcurrency !== 1
    || (template.sessionAffinity ?? false) !== false || (template.healthCheckDisabled ?? false) !== false
    || !keys(template, ['serviceAccount', 'executionEnvironment', 'scaling', 'timeout', 'maxInstanceRequestConcurrency', 'containers',
      'volumes', 'vpcAccess', 'labels', 'annotations', 'revision', 'sessionAffinity', 'healthCheckDisabled']) || !noFields(template.annotations)) fail();
  const scaling = object(template.scaling), container = object(containers[0]), resources = object(container.resources);
  const limits = object(resources.limits), probe = object(container.startupProbe), socket = object(probe.tcpSocket);
  if (!keys(scaling, ['minInstanceCount', 'maxInstanceCount']) || (scaling.minInstanceCount ?? 0) !== 0 || scaling.maxInstanceCount !== 1
    || container.image !== expected.image || !empty(container.env) || !empty(container.command) || !empty(container.args)
    || !empty(container.volumeMounts) || !empty(container.dependsOn) || container.livenessProbe !== undefined
    || !keys(container, ['name', 'image', 'ports', 'resources', 'startupProbe', 'env', 'command', 'args', 'volumeMounts', 'dependsOn'])
    || !keys(resources, ['limits', 'cpuIdle', 'startupCpuBoost']) || !keys(limits, ['cpu', 'memory'])
    || limits.cpu !== '1' || limits.memory !== '512Mi' || resources.cpuIdle !== true || (resources.startupCpuBoost ?? false) !== false
    || !Array.isArray(container.ports) || container.ports.length !== 1 || container.ports[0].containerPort !== 8080
    || !keys(object(container.ports[0]), ['name', 'containerPort']) || container.ports[0].name && container.ports[0].name !== 'http1'
    || !keys(probe, ['tcpSocket', 'periodSeconds', 'timeoutSeconds', 'failureThreshold', 'initialDelaySeconds'])
    || !keys(socket, ['port']) || socket.port !== 8080 || probe.periodSeconds !== 240 || probe.timeoutSeconds !== 240
    || probe.failureThreshold !== 1 || (probe.initialDelaySeconds ?? 0) !== 0) fail();
  if (!empty(r.traffic) && (!Array.isArray(r.traffic) || r.traffic.length !== 1 || r.traffic[0].percent !== 100
    || r.traffic[0].type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' || r.traffic[0].revision || r.traffic[0].tag)) fail();
  // Keep this literal identical to the creator; contract tests pin that equality.
  return { ingress: r.ingress as string, invokerIamDisabled: false,
    template: { serviceAccount: expected.serviceAccountEmail, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 }, timeout: '300s', maxInstanceRequestConcurrency: 1,
      containers: [{ image: expected.image, ports: [{ containerPort: 8080 }],
        resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true, startupCpuBoost: false },
        startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] } };
}

export function gcpHoldingConfigurationDigest(configuration: ReturnType<typeof gcpHoldingServiceConfiguration>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
