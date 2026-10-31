import { createHash } from 'node:crypto';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { RuntimeSecretReference } from '../../../domain/ports/secret-destination.port.js';
import { preparedHostingMarkerSchema, type PreparedHostingDescriptor } from '../../../domain/ports/hosting-prepared.port.js';
import { gcpHoldingConfigurationDigest, gcpObservedHoldingConfiguration } from './gcp-prepared-hosting.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import type { BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';

export interface GcpPreparedApplicationInput {
  workloadKind: 'web' | 'worker';
  publicAccess: boolean;
  serviceAccountEmail: string;
  envVars: Record<string, string>;
  secretVersionRefs: Record<string, RuntimeSecretReference>;
  startCommand: string | null;
  healthCheckPath: string | null;
  instanceBounds?: { min: number; max: number };
}

/** Same native socket volume used by ordinary and prepared Cloud Run releases. */
export function cloudRunCloudSqlVolumeConfig(connectionNames: string[] | undefined) {
  if(!connectionNames?.length)return undefined;
  return {volume:{name:'cloudsql',cloudSqlInstance:{instances:connectionNames}},volumeMount:{name:'cloudsql',mountPath:'/cloudsql'}};
}

/** Self-contained native renderer shared with the emitted first release. All
 * values come from the committed nonsecret spec; credentials stay references.
 * Explicit defaults match Cloud Run's published RevisionScaling/Container API.
 */
export function gcpPreparedApplicationConfiguration(input: GcpPreparedApplicationInput) {
  const fail = (): never => { throw new Error('The reviewed first Google application configuration is unavailable.'); };
  const port = Number(input.envVars.PORT ?? '8080'), cpu = input.envVars.CPU ?? '1', memory = input.envVars.MEMORY ?? '512Mi';
  if (!['web', 'worker'].includes(input.workloadKind) || typeof input.publicAccess !== 'boolean'
    || !/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(input.serviceAccountEmail)
    || !Number.isInteger(port) || port < 1 || port > 65535 || !['1', '2', '4', '8'].includes(cpu)
    || !/^[1-9]\d*(?:Mi|Gi)$/.test(memory)
    || input.startCommand !== null && (typeof input.startCommand !== 'string' || !input.startCommand.trim())
    || input.healthCheckPath !== null && (typeof input.healthCheckPath !== 'string' || !/^\/[\x21-\x7e]*$/.test(input.healthCheckPath))) fail();
  const env: Array<{ name: string; value?: string; valueSource?: { secretKeyRef: { secret: string; version: string } } }> = [];
  for (const [name, value] of Object.entries(input.envVars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || Object.hasOwn(input.secretVersionRefs, name)) fail();
    // Cloud Run supplies PORT itself; it is container configuration, not a
    // user-defined environment assignment accepted by the native API.
    if (name !== 'PORT') env.push({ name, value });
  }
  for (const [name, reference] of Object.entries(input.secretVersionRefs)) {
    const d = reference.destination;
    if (d.provider !== 'gcp-secret-manager') return fail();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || !/^[1-9]\d+$/.test(d.projectNumber) || !/^[A-Za-z0-9_-]+$/.test(d.secretId) || !/^[1-9]\d*$/.test(reference.version)) fail();
    env.push({ name, valueSource: { secretKeyRef: { secret: `projects/${d.projectNumber}/secrets/${d.secretId}`, version: reference.version } } });
  }
  env.sort((a, b) => a.name.localeCompare(b.name));
  const worker = input.workloadKind === 'worker';
  const bounds = input.instanceBounds;
  if (bounds && (!Number.isSafeInteger(bounds.min) || !Number.isSafeInteger(bounds.max)
    || bounds.min < (worker ? 1 : 0) || bounds.max < 1 || bounds.min > bounds.max)) fail();
  const rawSql=input.envVars.CLOUD_SQL_CONNECTION_NAME??input.envVars.INSTANCE_CONNECTION_NAME;
  const sqlNames=rawSql===undefined?[]:[...new Set(rawSql.split(',').map(value=>value.trim()))];
  const sqlProject=input.serviceAccountEmail.split('@')[1].replace('.iam.gserviceaccount.com','');
  if(sqlNames.length>100||sqlNames.some(value=>!new RegExp(`^${sqlProject}:[a-z]+(?:-[a-z0-9]+)+:[a-z][a-z0-9-]*$`).test(value)))fail();
  const cloudSql=cloudRunCloudSqlVolumeConfig(sqlNames);
  return {
    ingress: !worker && input.publicAccess ? 'INGRESS_TRAFFIC_ALL' : 'INGRESS_TRAFFIC_INTERNAL_ONLY', invokerIamDisabled: false,
    ...(bounds ? { scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: bounds.min, maxInstanceCount: bounds.max } } : {}),
    template: { serviceAccount: input.serviceAccountEmail, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      scaling: { minInstanceCount: worker ? 1 : 0, maxInstanceCount: 100 }, timeout: '300s', maxInstanceRequestConcurrency: 80,
      ...(cloudSql?{volumes:[cloudSql.volume]}:{}),
      containers: [{ ports: [{ containerPort: port }], env,...(cloudSql?{volumeMounts:[cloudSql.volumeMount]}:{}),
        ...(input.startCommand ? { command: ['/bin/sh'], args: ['-lc', input.startCommand] } : {}),
        resources: { limits: { cpu, memory }, cpuIdle: !worker, startupCpuBoost: false },
        startupProbe: input.healthCheckPath
          ? { httpGet: { path: input.healthCheckPath, port }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 }
          : { tcpSocket: { port }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] },
  };
}
export type GcpPreparedApplicationConfiguration = ReturnType<typeof gcpPreparedApplicationConfiguration>;
export function gcpPreparedApplicationDigest(configuration: GcpPreparedApplicationConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

/** Normalize only published protobuf defaults, retaining strict runtime fields.
 * Also emitted into CI; successful native metadata never leaves the function.
 */
export function gcpObservedPreparedApplicationConfiguration(resource: unknown): GcpPreparedApplicationConfiguration {
  const fail = (): never => { throw new Error('The first Google application configuration could not be verified.'); };
  const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : fail();
  const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
  const empty = (v: unknown) => v === undefined || Array.isArray(v) && v.length === 0;
  const noFields = (v: unknown) => v === undefined || v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
  const r = object(resource), t = object(r.template), containers = t.containers;
  let serviceScaling: { scalingMode: string; minInstanceCount: number; maxInstanceCount: number } | undefined;
  if (!noFields(r.scaling)) {
    const s = object(r.scaling), min = s.minInstanceCount ?? 0, max = s.maxInstanceCount;
    if (!keys(s, ['scalingMode', 'minInstanceCount', 'maxInstanceCount'])
      || s.scalingMode !== undefined && !['', 'SCALING_MODE_UNSPECIFIED', 'AUTOMATIC'].includes(s.scalingMode)
      || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < 1 || min > max) fail();
    serviceScaling = { scalingMode: 'AUTOMATIC', minInstanceCount: min, maxInstanceCount: max };
  }
  if (typeof r.name !== 'string' || !/^projects\/[^/]+\/locations\/[^/]+\/services\/[^/]+$/.test(r.name)
    || typeof r.generation !== 'string' || !/^[1-9]\d*$/.test(r.generation) || r.observedGeneration !== r.generation
    || r.reconciling !== undefined && r.reconciling !== false || r.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
    || typeof r.latestCreatedRevision !== 'string' || !r.latestCreatedRevision.startsWith(`${r.name}/revisions/`)
    || !/^[a-z][a-z0-9-]+$/.test(r.latestCreatedRevision.slice(`${r.name}/revisions/`.length))
    || r.latestReadyRevision !== r.latestCreatedRevision
    || !['INGRESS_TRAFFIC_ALL', 'INGRESS_TRAFFIC_INTERNAL_ONLY'].includes(r.ingress)
    || r.invokerIamDisabled !== undefined && r.invokerIamDisabled !== false
    || !empty(r.customAudiences) || r.iapEnabled !== undefined && r.iapEnabled !== false
    || !Array.isArray(containers) || containers.length !== 1 || !noFields(t.vpcAccess)
    || t.sessionAffinity !== undefined && t.sessionAffinity !== false || t.healthCheckDisabled !== undefined && t.healthCheckDisabled !== false
    || t.gpuZonalRedundancyDisabled !== undefined && t.gpuZonalRedundancyDisabled !== false
    || t.executionEnvironment !== 'EXECUTION_ENVIRONMENT_GEN2' || t.timeout !== '300s' || t.maxInstanceRequestConcurrency !== 80
    || typeof t.serviceAccount !== 'string' || !keys(t, ['serviceAccount', 'executionEnvironment', 'scaling', 'timeout',
      'maxInstanceRequestConcurrency', 'containers', 'volumes', 'vpcAccess', 'labels', 'annotations', 'revision',
      'sessionAffinity', 'healthCheckDisabled', 'gpuZonalRedundancyDisabled']) || !noFields(t.annotations)) fail();
  if (!empty(r.traffic)) {
    if (!Array.isArray(r.traffic) || r.traffic.length !== 1) fail();
    const traffic = object(r.traffic[0]);
    if (!keys(traffic, ['type', 'percent', 'revision', 'tag']) || traffic.percent !== 100
      || traffic.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' || traffic.revision || traffic.tag) fail();
  }
  if (!empty(r.trafficStatuses)) {
    if (!Array.isArray(r.trafficStatuses) || r.trafficStatuses.length !== 1) fail();
    const traffic = object(r.trafficStatuses[0]);
    if (!keys(traffic, ['type', 'percent', 'revision', 'tag', 'uri']) || traffic.percent !== 100
      || traffic.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' || traffic.tag
      || traffic.revision !== r.latestReadyRevision && traffic.revision !== r.latestReadyRevision.split('/').at(-1)) fail();
  }
  const c = object(containers[0]), scaling = object(t.scaling), resources = object(c.resources), limits = object(resources.limits);
  if (!keys(c, ['name', 'image', 'ports', 'env', 'command', 'args', 'resources', 'startupProbe', 'volumeMounts', 'dependsOn'])
    || !empty(c.dependsOn) || !Array.isArray(c.ports) || c.ports.length !== 1
    || !keys(object(c.ports[0]), ['name', 'containerPort']) || c.ports[0].name && c.ports[0].name !== 'http1'
    || !keys(scaling, ['minInstanceCount', 'maxInstanceCount']) || ![0, 1].includes(scaling.minInstanceCount ?? 0) || scaling.maxInstanceCount !== 100
    || !keys(resources, ['limits', 'cpuIdle', 'startupCpuBoost']) || !keys(limits, ['cpu', 'memory'])
    || resources.cpuIdle !== undefined && typeof resources.cpuIdle !== 'boolean' || (resources.startupCpuBoost ?? false) !== false) fail();
  const port = c.ports[0].containerPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(c.env ?? [])) fail();
  const seen = new Set<string>();
  for (const raw of c.env ?? []) {
    const e = object(raw);
    if (typeof e.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || seen.has(e.name) || !keys(e, ['name', 'value', 'valueSource'])) fail();
    seen.add(e.name);
    if (e.valueSource !== undefined) {
      const source = object(e.valueSource), ref = object(source.secretKeyRef);
      const id = typeof ref.secret === 'string' && /^projects\/([1-9]\d+)\/secrets\/([A-Za-z0-9_-]+)$/.exec(ref.secret);
      if (!keys(source, ['secretKeyRef']) || !keys(ref, ['secret', 'version']) || !id || e.value !== undefined || !/^[1-9]\d*$/.test(ref.version)) fail();
    } else {
      if (e.value !== undefined && typeof e.value !== 'string') fail();
    }
  }
  let startCommand: string | null = null;
  if (!empty(c.command) || !empty(c.args)) {
    if (JSON.stringify(c.command) !== '["/bin/sh"]' || !Array.isArray(c.args) || c.args.length !== 2 || c.args[0] !== '-lc' || typeof c.args[1] !== 'string') fail();
    startCommand = c.args[1];
  }
  const probe = object(c.startupProbe);
  if (!keys(probe, ['tcpSocket', 'httpGet', 'periodSeconds', 'timeoutSeconds', 'failureThreshold', 'initialDelaySeconds']) || (probe.initialDelaySeconds ?? 0) !== 0) fail();
  const http = probe.httpGet === undefined ? undefined : object(probe.httpGet);
  const healthCheckPath = http === undefined ? null : http.path === undefined || http.path === '' ? '/' : http.path;
  if (healthCheckPath !== null) {
    if (typeof healthCheckPath !== 'string' || !/^\/[\x21-\x7e]*$/.test(healthCheckPath)
      || probe.tcpSocket !== undefined || !keys(object(probe.httpGet), ['path', 'port', 'httpHeaders']) || !empty(probe.httpGet.httpHeaders)
      || (probe.httpGet.port ?? port) !== port || (probe.periodSeconds ?? 10) !== 10 || (probe.timeoutSeconds ?? 1) !== 1 || (probe.failureThreshold ?? 3) !== 3) fail();
  } else if (!keys(object(probe.tcpSocket), ['port']) || (probe.tcpSocket.port ?? port) !== port
    || probe.periodSeconds !== 240 || probe.timeoutSeconds !== 240 || probe.failureThreshold !== 1) fail();
  const worker = (scaling.minInstanceCount ?? 0) === 1;
  if (worker && serviceScaling && serviceScaling.minInstanceCount < 1) fail();
  if ((resources.cpuIdle ?? false) !== !worker || worker && r.ingress !== 'INGRESS_TRAFFIC_INTERNAL_ONLY') fail();
  // Recreate the renderer's field order without changing the actual env set.
  const env = (c.env ?? []).map((raw: any) => raw.valueSource
    ? { name: raw.name, valueSource: { secretKeyRef: { secret: raw.valueSource.secretKeyRef.secret, version: raw.valueSource.secretKeyRef.version } } }
    : { name: raw.name, value: raw.value ?? '' }).sort((a: any, b: any) => a.name.localeCompare(b.name));
  let cloudSql:ReturnType<typeof cloudRunCloudSqlVolumeConfig>;
  if(!empty(t.volumes)||!empty(c.volumeMounts)){
    if(!Array.isArray(t.volumes)||t.volumes.length!==1||!Array.isArray(c.volumeMounts)||c.volumeMounts.length!==1)fail();
    const volume=object(t.volumes[0]),mount=object(c.volumeMounts[0]),sql=object(volume.cloudSqlInstance),instances=sql.instances;
    const sqlProject=String(t.serviceAccount).split('@')[1]?.replace('.iam.gserviceaccount.com','');
    if(!keys(volume,['name','cloudSqlInstance'])||volume.name!=='cloudsql'||!keys(sql,['instances'])
      ||!Array.isArray(instances)||!instances.length||instances.length>100||new Set(instances).size!==instances.length
      ||instances.some(value=>typeof value!=='string'||!new RegExp(`^${sqlProject}:[a-z]+(?:-[a-z0-9]+)+:[a-z][a-z0-9-]*$`).test(value))
      ||!keys(mount,['name','mountPath'])||mount.name!=='cloudsql'||mount.mountPath!=='/cloudsql')fail();
    cloudSql=cloudRunCloudSqlVolumeConfig(instances);
  }
  return { ingress: r.ingress, invokerIamDisabled: false,
    ...(serviceScaling ? { scaling: serviceScaling } : {}),
    template: { serviceAccount: t.serviceAccount, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      scaling: { minInstanceCount: worker ? 1 : 0, maxInstanceCount: 100 }, timeout: '300s', maxInstanceRequestConcurrency: 80,
      ...(cloudSql?{volumes:[cloudSql.volume]}:{}),
      containers: [{ ports: [{ containerPort: port }], env,...(cloudSql?{volumeMounts:[cloudSql.volumeMount]}:{}),
        ...(startCommand ? { command: ['/bin/sh'], args: ['-lc', startCommand] } : {}),
        resources: { limits: { cpu: limits.cpu, memory: limits.memory }, cpuIdle: !worker, startupCpuBoost: false },
        startupProbe: healthCheckPath
          ? { httpGet: { path: healthCheckPath, port }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 }
          : { tcpSocket: { port }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] } };
}

/** Only the saved explicit metadata action authorizes holding -> final identity.
 * Already transitioned workloads use ordinary preserved-runtime update rules.
 */
export function gcpPreparedHoldingTransition(connection: CloudDeploymentConnectionV1 | PreparedHostingDescriptor, environment: Environment, workload: string, native: any) {
  const prepared = connection.preparedResources?.workloads.find(item => item.workload === workload);
  if (!prepared) return null;
  const final = connection.runtimeIdentities.find(item => item.workload === workload)?.principal;
  if (final?.kind !== 'gcp-service-account' || prepared.holding.principal.kind !== 'gcp-service-account') throw new Error('Prepared Google identity is unavailable.');
  if (native?.template?.serviceAccount === final.serviceAccountEmail && native?.template?.containers?.[0]?.image !== prepared.holding.image) return null;
  const boundImage = parseHostingBindings(environment).services?.[workload]?.imageUri;
  if (boundImage && boundImage !== prepared.holding.image) throw new Error('A completed Google first release cannot be rearmed.');
  const marker = preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting);
  if (marker.installationId !== connection.installationId || marker.planDigest !== connection.planDigest
    || marker.receiptDigest !== ('receiptDigest' in connection ? connection.receiptDigest : canonicalJsonSha256(connection))
    || !marker.pendingFirstRelease.includes(workload) || !marker.firstReleaseConfigurationDigests?.[workload]) throw new Error('Prepared Google rollout authority is unavailable.');
  if (native.generation !== prepared.holding.generation || native.latestReadyRevision !== prepared.holding.revision)
    throw new Error('The original prepared Google revision changed.');
  const configuration = gcpObservedHoldingConfiguration(native, { id: prepared.id, lifetimeId: prepared.lifetimeId,
    image: prepared.holding.image, serviceAccountEmail: prepared.holding.principal.serviceAccountEmail,
    publicAccess: connection.deployment.workloads.find(item => item.name === workload)?.public === true });
  if (gcpHoldingConfigurationDigest(configuration) !== prepared.holding.configurationDigest) throw new Error('Prepared Google holding configuration changed.');
  return { prepared, principal: final, configurationDigest: marker.firstReleaseConfigurationDigests[workload],
    deploymentId: native.latestReadyRevision as string, etag: native.etag as string };
}

/** Generated only for installer-prepared connections; legacy programs retain
 * their original bytes. The workflow carries no collected plaintext values. */
export function buildGcpPreparedReleaseRuntime(target: BranchDeployTarget): string {
  const connection = target.deploymentAccess?.connection;
  if (!connection?.preparedResources) return '';
  const marker = preparedHostingMarkerSchema.parse(target.preparedRuntime?.preparation);
  if (marker.installationId !== connection.installationId || marker.planDigest !== connection.planDigest
    || marker.receiptDigest !== canonicalJsonSha256(connection)) throw new Error('The reviewed Google preparation is unavailable for CI.');
  const entries = connection.preparedResources.workloads.map(prepared => {
    const workload = connection.deployment.workloads.find(item => item.name === prepared.workload);
    const runtime = connection.runtimeIdentities.find(item => item.workload === prepared.workload)?.principal;
    const desired = target.runtimeResources?.find(item => item.logicalName === prepared.workload);
    if (!workload || workload.kind === 'cron' || prepared.kind !== 'service' || runtime?.kind !== 'gcp-service-account'
      || prepared.holding.principal.kind !== 'gcp-service-account' || !desired || desired.providerResourceUid !== prepared.lifetimeId
      || desired.providerResourceId !== prepared.id.split('/').at(-1)) throw new Error('The reviewed Google first release target is incomplete.');
    const pending = marker.pendingFirstRelease.includes(prepared.workload);
    const configuration = pending ? gcpPreparedApplicationConfiguration({ workloadKind: workload.kind, publicAccess: workload.public === true,
      serviceAccountEmail: runtime.serviceAccountEmail, envVars: target.preparedRuntime!.envVars,
      secretVersionRefs: Object.fromEntries(workload.runtimeSecrets.map(item => [item.key, item.reference])),
      startCommand: desired.startCommand, healthCheckPath: desired.healthCheckPath, instanceBounds: desired.instanceBounds }) : null;
    const configurationDigest = marker.firstReleaseConfigurationDigests?.[prepared.workload];
    if (pending && (!configuration || gcpPreparedApplicationDigest(configuration) !== configurationDigest)) throw new Error('The first Google runtime configuration needs a reviewed preparation plan.');
    return { prepared, publicAccess: workload.public === true, runtimeEmail: runtime.serviceAccountEmail, pending,
      configuration, ...(configurationDigest ? { configurationDigest } : {}) };
  });
  return `${cloudRunCloudSqlVolumeConfig.toString()}
${gcpObservedHoldingConfiguration.toString()}
${gcpObservedPreparedApplicationConfiguration.toString()}
const hvPreparedReleases = ${JSON.stringify(entries)};
const hvPreparedDigest = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
function hvPreparedService(current, runtimeResource) {
  const entry = hvPreparedReleases.find(item => item.prepared.workload === runtimeResource.logicalName);
  if (!entry || entry.prepared.id !== current.name || entry.prepared.lifetimeId !== current.uid) throw new Error('Prepared Google workload identity changed.');
  if (current.template?.serviceAccount === entry.runtimeEmail && current.template?.containers?.[0]?.image !== entry.prepared.holding.image) return null;
  if (!entry.pending || !entry.configuration || process.env.DEPLOY_OPERATION === 'rollback') throw new Error('The first Google release is not authorized.');
  if (current.generation !== entry.prepared.holding.generation || current.latestReadyRevision !== entry.prepared.holding.revision) throw new Error('The original prepared Google revision changed.');
  const holding = gcpObservedHoldingConfiguration(current, { id: entry.prepared.id, lifetimeId: entry.prepared.lifetimeId,
    image: entry.prepared.holding.image, serviceAccountEmail: entry.prepared.holding.principal.serviceAccountEmail, publicAccess: entry.publicAccess });
  if (hvPreparedDigest(holding) !== entry.prepared.holding.configurationDigest
    || !/^[^\\s@]+@sha256:[a-f0-9]{64}$/.test(process.env.IMAGE_URI || '') || process.env.IMAGE_URI === entry.prepared.holding.image) throw new Error('The first Google release configuration changed.');
  return entry;
}
`;
}
