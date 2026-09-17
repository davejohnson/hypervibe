import type { IServiceVolumes, ServiceVolumeTarget, ServiceVolumeObservation, ServiceVolumeComponentBinding, ServiceVolumeMutationReceipt } from '../../../domain/ports/service-volume.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';

type Json = Record<string, any>;
type Bindings = Record<string, ServiceVolumeComponentBinding>;
const COMPUTE = 'https://compute.googleapis.com/compute/v1/';
const FILE = 'https://file.googleapis.com/v1/';
const RUN = 'https://run.googleapis.com/v2/';
const USAGE = 'https://serviceusage.googleapis.com/v1/';
const SUBNET_CIDR = '10.42.0.0/26';

/** Individually authorized retained resources, never an implicit deploy helper. */
export class CloudRunServiceVolumes implements IServiceVolumes {
  constructor(private connection: () => { projectId: string; region: string }, private token: () => Promise<string>) {}

  readonly staged: NonNullable<IServiceVolumes['staged']> = {
    resolveTarget: async ({ environment, serviceName, mountPath }) => {
      const raw = environment?.platformBindings;
      const services = raw?.services as Record<string, { serviceId?: string }> | undefined;
      const serviceId = services?.[serviceName]?.serviceId;
      if (!serviceId || typeof raw?.projectId !== 'string' || typeof raw.environmentId !== 'string') return undefined;
      const cloud = this.connection();
      const boundScope = raw.providerScope as Record<string, unknown> | undefined;
      if (!boundScope || boundScope.projectId !== cloud.projectId || boundScope.region !== cloud.region) {
        throw new Error('Cloud Run filesystem requires exact retained project/region scope matching the connected cloud; restore scoped hosting bindings first.');
      }
      const project = await this.get(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(cloud.projectId)}`);
      if (project?.projectId !== cloud.projectId || !/^projects\/[0-9]+$/.test(project.name) || project.state !== 'ACTIVE') throw new Error('Cloud Run filesystem requires a verified active GCP project.');
      const scope = [cloud.projectId, raw.projectId, raw.environmentId, serviceId];
      return { projectId: raw.projectId, environmentId: raw.environmentId, serviceId, mountPath,
        instanceScope: { projectId: cloud.projectId, projectNumber: project.name.slice('projects/'.length), region: cloud.region,
          zone: `${cloud.region}-a`, serviceName, network: resourceName('files', { scope }),
          subnetwork: resourceName('files', { scope }), instanceName: resourceName('data', { scope }),
          shareName: 'data', capacityGb: '1024', tier: 'BASIC_HDD' } };
    },
    components: () => [
      { key: 'compute-api', dependsOn: [], operation: 'update', billable: false, sharedPrerequisite: true, description: 'Enable the shared Compute API prerequisite (does not provision compute).' },
      { key: 'file-api', dependsOn: [], operation: 'update', billable: false, sharedPrerequisite: true, description: 'Enable the shared Filestore API prerequisite.' },
      { key: 'network', dependsOn: ['compute-api'], operation: 'create', billable: false, description: 'Create an isolated retained filesystem VPC.' },
      { key: 'subnet', dependsOn: ['network'], operation: 'create', billable: false, description: 'Create a retained private /26 Cloud Run direct-egress subnet.' },
      { key: 'filesystem', dependsOn: ['file-api', 'network', 'subnet'], operation: 'create', billable: true, description: 'Create dedicated retained BASIC_HDD Filestore: 1024 GiB minimum provisioned capacity is billed even unused; NFS has no locking and non-root writes need share permissions.' },
      { key: 'attachment', dependsOn: ['filesystem', 'subnet'], operation: 'update', billable: false, description: 'Attach the exact NFS share and private VPC using the required second-generation Cloud Run execution environment (configuration rollout, no new image).' },
    ],
    observeComponent: (target, key, bindings) => this.observeComponent(target, key, bindings),
    applyComponent: (target, key, bindings) => this.applyComponent(target, key, bindings),
  };

  async observe(target: ServiceVolumeTarget, externalId?: string): Promise<ServiceVolumeObservation> {
    return this.observeComponent(target, 'attachment', externalId ? { attachment: { state: 'bound', externalId } } : {});
  }

  async create(_target: ServiceVolumeTarget): Promise<ServiceVolumeMutationReceipt> {
    return { success: false, mutationAttempted: false, error: 'Cloud Run filesystems require separately authorized staged components.' };
  }

  private scope(target: ServiceVolumeTarget) {
    const scope = target.instanceScope;
    const cloud = this.connection();
    if (!scope || scope.projectId !== cloud.projectId || scope.region !== cloud.region
      || scope.zone !== `${scope.region}-a` || scope.capacityGb !== '1024' || scope.tier !== 'BASIC_HDD'
      || scope.shareName !== 'data' || ![scope.projectId, scope.region, scope.zone, scope.network, scope.subnetwork, scope.instanceName, target.serviceId].every((v) => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v))) {
      throw new Error('Cloud Run filesystem target is outside the reviewed cloud scope or immutable storage class.');
    }
    return scope;
  }

  private paths(target: ServiceVolumeTarget) {
    const s = this.scope(target);
    return {
      network: `projects/${s.projectId}/global/networks/${s.network}`,
      subnet: `projects/${s.projectId}/regions/${s.region}/subnetworks/${s.subnetwork}`,
      filesystem: `projects/${s.projectId}/locations/${s.zone}/instances/${s.instanceName}`,
      attachment: `projects/${s.projectId}/locations/${s.region}/services/${target.serviceId}`,
    };
  }

  private async get(url: string): Promise<Json | null> {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCP filesystem observation failed (HTTP ${response.status}); verify API access and resource permissions.`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('GCP filesystem observation returned an invalid object.');
    return body as Json;
  }

  private normalizeComputeLink(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.replace(/^https:\/\/(?:www\.googleapis\.com|compute\.googleapis\.com)\/compute\/v1\//, '');
  }

  private async observeComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeObservation> {
    try {
      const s = this.scope(target);
      const paths = this.paths(target);
      const expected = bindings[key]?.externalId;
      if (key === 'compute-api' || key === 'file-api') {
        if (!s.projectNumber || !/^[0-9]+$/.test(s.projectNumber)) throw new Error('Missing verified numeric GCP project identity.');
        const api = key === 'compute-api' ? 'compute.googleapis.com' : 'file.googleapis.com';
        const name = `projects/${s.projectNumber}/services/${api}`;
        const service = await this.get(`${USAGE}${name}`);
        if (!service || service.name !== name || !['ENABLED', 'DISABLED'].includes(service.state)) throw new Error('GCP API state is incomplete or outside the reviewed project.');
        return service.state === 'DISABLED' ? { state: 'absent' } : { state: 'present', externalId: name, pendingDeletion: false, ready: true };
      }
      if (key === 'network' || key === 'subnet') {
        const resource = await this.get(`${COMPUTE}${paths[key]}`);
        if (!resource) return { state: 'absent' };
        if (typeof resource.id !== 'string' || !/^[0-9]+$/.test(resource.id) || this.normalizeComputeLink(resource.selfLink) !== paths[key]
          || (expected && expected !== resource.id)) throw new Error('GCP filesystem network identity changed or is incomplete.');
        if (key === 'network' && resource.autoCreateSubnetworks !== false) throw new Error('Filesystem VPC must not auto-create public-region subnets.');
        if (key === 'subnet' && (this.normalizeComputeLink(resource.network) !== paths.network || resource.ipCidrRange !== SUBNET_CIDR || resource.privateIpGoogleAccess !== true)) throw new Error('Filesystem subnet differs from its exact private network configuration.');
        return { state: 'present', externalId: resource.id, pendingDeletion: false, ready: key === 'network' || resource.state === 'READY' };
      }
      if (key === 'filesystem') {
        await this.verifyZone(target);
        const instance = await this.get(`${FILE}${paths.filesystem}`);
        if (!instance) return { state: 'absent' };
        this.assertFilesystem(target, instance, expected);
        return { state: 'present', externalId: instance.name, pendingDeletion: instance.state === 'DELETING', ready: instance.state === 'READY' };
      }
      if (key !== 'attachment') throw new Error('Unknown Cloud Run filesystem component.');
      const service = await this.get(`${RUN}${paths.attachment}`);
      if (!service || service.name !== paths.attachment) throw new Error('The exact Cloud Run filesystem consumer is missing or changed.');
      const fs = await this.get(`${FILE}${paths.filesystem}`);
      if (!fs) throw new Error('Filestore backing resource is missing; attachment cannot be verified.');
      this.assertFilesystem(target, fs, bindings.filesystem?.externalId);
      const ip = this.filesystemIp(fs);
      const template = service.template;
      if (!template || !Array.isArray(template.containers) || template.containers.length < 1) throw new Error('Cloud Run runtime template is incomplete.');
      const matching = (template.volumes ?? []).filter((v: Json) => v.name === 'hypervibe-files');
      const mounts = (template.containers[0].volumeMounts ?? []).filter((v: Json) => v.name === 'hypervibe-files' || v.mountPath === target.mountPath);
      this.assertCompatibleVpc(target, template.vpcAccess);
      if (matching.length === 0 && mounts.length === 0) return { state: 'absent' };
      if (matching.length !== 1 || mounts.length !== 1 || matching[0].nfs?.server !== ip || matching[0].nfs?.path !== '/data'
        || template.executionEnvironment !== 'EXECUTION_ENVIRONMENT_GEN2'
        || matching[0].nfs?.readOnly === true || mounts[0].name !== 'hypervibe-files' || mounts[0].mountPath !== target.mountPath
        || !template.vpcAccess || (expected && expected !== service.name)) throw new Error('Cloud Run filesystem attachment is contradictory or differs from reviewed storage.');
      return { state: 'present', externalId: service.name, pendingDeletion: false,
        ready: !service.reconciling && service.terminalCondition?.state === 'CONDITION_SUCCEEDED' };
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private assertFilesystem(target: ServiceVolumeTarget, instance: Json, expected?: string) {
    const s = this.scope(target);
    const path = this.paths(target).filesystem;
    const shares = instance.fileShares;
    const networks = instance.networks;
    if (instance.name !== path || (expected && instance.name !== expected) || instance.tier !== s.tier
      || !Array.isArray(shares) || shares.length !== 1 || shares[0].name !== s.shareName || String(shares[0].capacityGb) !== s.capacityGb
      || !Array.isArray(networks) || networks.length !== 1 || ![s.network, this.paths(target).network].includes(networks[0].network)
      || !Array.isArray(networks[0].modes) || networks[0].modes.length !== 1 || networks[0].modes[0] !== 'MODE_IPV4'
      || typeof instance.state !== 'string') throw new Error('Filestore instance identity, capacity, share or network differs from the reviewed target.');
  }

  private filesystemIp(instance: Json): string {
    const ips = instance.networks?.[0]?.ipAddresses;
    const parts = Array.isArray(ips) && ips.length === 1 && typeof ips[0] === 'string'
      && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ips[0]) ? ips[0].split('.').map(Number) : [];
    if (parts.length !== 4 || parts.some((part: number) => part > 255)
      || !(parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))) {
      throw new Error('Filestore did not report one private NFS server address.');
    }
    return ips[0];
  }

  private async verifyZone(target: ServiceVolumeTarget): Promise<void> {
    const s = this.scope(target);
    const zone = await this.get(`${COMPUTE}projects/${s.projectId}/zones/${s.zone}`);
    if (!zone || zone.name !== s.zone || zone.status !== 'UP'
      || this.normalizeComputeLink(zone.region) !== `projects/${s.projectId}/regions/${s.region}`) {
      throw new Error(`Reviewed Filestore zone ${s.zone} is unavailable or unverified in ${s.region}; no alternate zone is selected automatically.`);
    }
  }

  private assertCompatibleVpc(target: ServiceVolumeTarget, vpc: Json | undefined) {
    if (!vpc || Object.keys(vpc).length === 0) return;
    const paths = this.paths(target);
    if (vpc.connector || vpc.egress !== 'PRIVATE_RANGES_ONLY' || !Array.isArray(vpc.networkInterfaces) || vpc.networkInterfaces.length !== 1
      || this.normalizeComputeLink(vpc.networkInterfaces[0].network) !== paths.network
      || this.normalizeComputeLink(vpc.networkInterfaces[0].subnetwork) !== paths.subnet) {
      throw new Error('Existing Cloud Run VPC/cache connectivity conflicts with the dedicated filesystem network; automatic network migration is forbidden.');
    }
  }

  private async applyComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeMutationReceipt> {
    let mutationAttempted = false;
    let acknowledgedId: string | undefined;
    try {
      const s = this.scope(target);
      const paths = this.paths(target);
      const component = this.staged.components(target).find((entry) => entry.key === key);
      if (!component) throw new Error('Unknown Cloud Run filesystem component.');
      for (const dependency of component.dependsOn) {
        // API prerequisites are globally shared; ready observation proves their
        // availability without adopting or owning the provider-wide service.
        const current = await this.observeComponent(target, dependency, bindings);
        if ((!dependency.endsWith('-api') && bindings[dependency]?.state !== 'bound') || current.state !== 'present' || current.ready !== true || current.pendingDeletion) throw new Error(`Filesystem prerequisite ${dependency} is not bound and ready.`);
      }
      const before = await this.observeComponent(target, key, bindings);
      if (before.state !== 'absent') throw new Error(before.state === 'unknown' ? before.reason : 'Existing filesystem component must not be implicitly adopted or recreated.');
      let url: string; let method = 'POST'; let body: Json;
      let expectedTarget: string | undefined;
      let observedApiName: string | undefined;
      if (key === 'compute-api' || key === 'file-api') {
        const api = key === 'compute-api' ? 'compute.googleapis.com' : 'file.googleapis.com';
        expectedTarget = `projects/${s.projectNumber}/services/${api}`;
        const existing = await this.get(`${USAGE}${expectedTarget}`);
        if (existing?.name !== expectedTarget || existing.state !== 'DISABLED') throw new Error('The exact API prerequisite changed before enablement.');
        observedApiName = existing.name;
        url = `${USAGE}${expectedTarget}:enable`; body = {};
      } else if (key === 'network') {
        url = `${COMPUTE}projects/${s.projectId}/global/networks`;
        body = { name: s.network, autoCreateSubnetworks: false };
        expectedTarget = paths.network;
      } else if (key === 'subnet') {
        url = `${COMPUTE}projects/${s.projectId}/regions/${s.region}/subnetworks`;
        body = { name: s.subnetwork, network: `${COMPUTE}${paths.network}`, ipCidrRange: SUBNET_CIDR, privateIpGoogleAccess: true };
        expectedTarget = paths.subnet;
      } else if (key === 'filesystem') {
        url = `${FILE}projects/${s.projectId}/locations/${s.zone}/instances?instanceId=${s.instanceName}`;
        body = { tier: s.tier, fileShares: [{ name: s.shareName, capacityGb: s.capacityGb }], networks: [{ network: s.network, modes: ['MODE_IPV4'], connectMode: 'DIRECT_PEERING' }] };
        expectedTarget = paths.filesystem;
      } else {
        const service = await this.get(`${RUN}${paths.attachment}`);
        const fs = await this.get(`${FILE}${paths.filesystem}`);
        if (!service || service.name !== paths.attachment || !fs) throw new Error('Exact filesystem consumer/backing disappeared before attachment.');
        this.assertFilesystem(target, fs, bindings.filesystem?.externalId);
        this.assertCompatibleVpc(target, service.template?.vpcAccess);
        const template = service.template;
        if (!template || !Array.isArray(template.containers) || template.containers.length !== 1) throw new Error('Filesystem attachment currently requires one exact application container.');
        url = `${RUN}${paths.attachment}?updateMask=template.volumes,template.containers,template.vpcAccess,template.executionEnvironment`; method = 'PATCH';
        body = { name: service.name, ...(service.etag ? { etag: service.etag } : {}), template: {
          executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
          volumes: [...(template.volumes ?? []), { name: 'hypervibe-files', nfs: { server: this.filesystemIp(fs), path: '/data', readOnly: false } }],
          containers: [{ ...template.containers[0], volumeMounts: [...(template.containers[0].volumeMounts ?? []), { name: 'hypervibe-files', mountPath: target.mountPath }] }],
          vpcAccess: { networkInterfaces: [{ network: paths.network, subnetwork: paths.subnet }], egress: 'PRIVATE_RANGES_ONLY' },
        } };
        expectedTarget = paths.attachment;
      }
      const token = await this.token();
      mutationAttempted = true;
      const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GCP filesystem mutation failed (HTTP ${response.status}); retained intent requires inspection before retry.`);
      const operation = await response.json() as Json;
      if (!operation || typeof operation.name !== 'string' || operation.error) throw new Error('GCP filesystem mutation did not return a valid operation acknowledgement.');
      if (observedApiName) {
        if (!/^operations\/[A-Za-z0-9._~-]+$/.test(operation.name)) throw new Error('GCP API enablement returned an invalid operation identity.');
        acknowledgedId = observedApiName;
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await this.get(`${USAGE}${observedApiName}`);
          if (current?.name !== observedApiName) throw new Error('GCP API identity changed during enablement observation.');
          if (current.state === 'ENABLED') return { success: true, externalId: current.name, mutationAttempted };
        }
        return { success: false, externalId: acknowledgedId, mutationAttempted, error: 'API enablement acknowledged but not yet observed enabled; retained exact identity requires re-plan.' };
      }
      let externalId: string | undefined;
      if (key === 'network' || key === 'subnet') {
        if (this.normalizeComputeLink(operation.targetLink) === expectedTarget && typeof operation.targetId === 'string' && /^[0-9]+$/.test(operation.targetId)) externalId = operation.targetId;
      } else if (key === 'filesystem') {
        if (operation.metadata?.target === expectedTarget || operation.response?.name === expectedTarget) externalId = expectedTarget;
      } else {
        // Update of an exact pre-observed resource, not ownership inferred for a
        // newly created resource. Readiness still requires subsequent observation.
        externalId = expectedTarget;
      }
      if (!externalId) throw new Error('GCP mutation acknowledgement omitted the exact created resource identity.');
      return { success: true, externalId, mutationAttempted };
    } catch (error) {
      return { success: false, mutationAttempted, ...(acknowledgedId ? { externalId: acknowledgedId } : {}), error: error instanceof Error ? error.message : String(error) };
    }
  }
}
