import type {
  EngineAuthentication,
  EngineConfiguration,
  EngineResourceMapping,
  InfrastructureEngineBackend,
} from '../../../../domain/ports/infrastructure-engine.port.js';

/**
 * GCP half of the OpenTofu engine integration. Everything Google-specific
 * (provider pin, credential env, Cloud Run shape, Secret Manager references)
 * lives here; the shared engine never sees it.
 *
 * Source: https://github.com/opentofu/terraform-provider-google/releases/tag/v8.9.0
 */
export const GOOGLE_PROVIDER_VERSION = '8.9.0';

/**
 * Exact lock hashes produced by `tofu providers lock` for darwin/linux on
 * arm64/amd64. `zh:` entries match the upstream SHA256SUMS archive checksums.
 */
const GOOGLE_PROVIDER_LOCK_HASHES = [
  'h1:BQXx6yc7LPhe6c6RdMAQNsnP5Rcg2QDCm4mAK34cZnI=',
  'h1:Ha7iJ5vQpcptAWCEXB/gzkIkhKDw2ZKxPVqQ3LO9yBs=',
  'h1:LXF4Jsm9aks8FjVTPcBn/ubc2N0X9qN7iyFuSE88Ua0=',
  'h1:Lb8ddQwOczEEPHg+aTSMVSq4cckeB+nXhXbPxLPOtwM=',
  'h1:MUiXp+AnOthO7PGMuqsJCOWen7ifB5VR9YHSOWTVwJk=',
  'h1:N5YxSJfDhYzXTKtjqAO+JpIlU8Gom8VO5wnB3M8AVqg=',
  'h1:NFex8eCfhLW2HU+A0B/z5F8XgppYx7Q6HeqO+oFZ0QI=',
  'h1:Tz/OS7RfwTBamW3VbeU/sFPcIv+jWCNG6f+CWHjFAfk=',
  'h1:dXM5HpwSNgO2aElNKq5bbzsTmE5UN9e3UyJugfJGK08=',
  'h1:dvIlDJPUBTrYcCJrvYwJ1wQE9e44iUBQQse6JvPNisM=',
  'h1:fl/pmRnYqfB0zyTYrHYS43DG6RIzVQoXhME9VPMsVW8=',
  'h1:g0mAfBrYFNBz4fJTbji4Q5YhkkKTdir3HFcM2SMZQxQ=',
  'h1:hXPTLeH+6VHBIC4TDB7apqCpjXJKm6anceZnkPSnRNk=',
  'h1:jxOSQzax3ZoIEcFu4ypm9k6laHMdIKh57Ulkgqu2KC8=',
  'h1:xhlO0mek9DQDI4BeoZKZ1GxLPUD5jgHPEb+iCTIe4LI=',
  'zh:04e7e1d351e84fbb86a50b27e8a0c4b9fb0b658c430d8bad48255332ec76ae27',
  'zh:0d2421475ee0ef57d118e271ee7114f4514fdb4449686bd3d280a32b8a9b759b',
  'zh:2effe13ef3c5c3f7ada295381a392cb0d027790d8015bd5d77e754d8141673a0',
  'zh:58495c9ed94db942bf90222a80c28472e72e05368d0ca5b1cb5d08c6754bbe25',
  'zh:5d259af76dafa4bab3cd5828113bffece3be381d8823188678617947c24e4894',
  'zh:7c2ed6a9e0d63fec024359331b7baae359016572e1328e63b9ef50469ade53a7',
  'zh:8899ded4b859f66fbde51f177d98a27a1a1bd3f663a3574536bf88588393eeaf',
  'zh:930de4f007b0c411a9679a34270e9538b3a037834092a659e875b89390da2953',
  'zh:aea26e80845f3d42a39f30e676c4d9aada913bf4a72336adff45fe15c73350e8',
  'zh:cc4f83e4cedc15e7ba69921aca72df0c66f543fd1688923828787cb08792a6ae',
  'zh:d43111794dd3f7103285a438f20a2c9f4888460ad86525d0d9e52b75ed934f66',
  'zh:d58c54d425a5b33ba5b7ce9ecf46e13a111f2702b12195af1d79f65490d99ba4',
  'zh:ed89123c75b4c65c59cdfa0dd16435eb25dd7f02a87e8971ac543782c0f69986',
  'zh:f47fadbca8129565bf0844279f0a49941888c1e016f55c37ffbb667ee764e88d',
  'zh:f4c7f54f29597788faa2cb53d5ea3b74ad79882e2d1a7267ef90fbb7f216c39a',
];

/** Reference to a Secret Manager secret; never a value. */
export interface GcpSecretReference {
  /** Secret Manager secret id (short name) in the target project. */
  secretId: string;
  /** Pinned numeric version, or `latest` only when rotation-by-restart is intended. */
  version: string;
}

export interface GcpCloudRunServiceInput {
  /** Logical spec name, e.g. `web`. */
  logicalName: string;
  /** Physical Cloud Run name, resolved by Hypervibe's naming/binding rules. */
  resourceName: string;
  workload: 'web' | 'worker';
  /**
   * Immutable image for first creation. After creation the image is owned by
   * the release path (CI or hv_deploy) and ignored by infrastructure plans.
   */
  initialImage: string;
  runtimeServiceAccountEmail: string;
  port?: number;
  cpu?: string;
  memory?: string;
  minInstances?: number;
  maxInstances?: number;
  command?: string[];
  args?: string[];
  /** Non-secret runtime configuration only. */
  env?: Record<string, string>;
  /** Runtime secrets wired by reference through Secret Manager. */
  secretEnv?: Record<string, GcpSecretReference>;
  /** Grant allUsers run.invoker. Organization policy may forbid this. */
  public: boolean;
  healthCheckPath?: string;
}

export interface GcpCloudRunEngineInput {
  projectId: string;
  region: string;
  services: GcpCloudRunServiceInput[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);

function engineKey(logicalName: string): string {
  const key = logicalName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`Service name ${logicalName} cannot be used as an engine address.`);
  return key;
}

function assertImmutableImage(image: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('Cloud Run images managed by the engine must be pinned by digest (image@sha256:...).');
  }
}

function serviceResource(input: GcpCloudRunEngineInput, service: GcpCloudRunServiceInput): Record<string, unknown> {
  assertImmutableImage(service.initialImage);
  if (!service.runtimeServiceAccountEmail.endsWith(`@${input.projectId}.iam.gserviceaccount.com`)) {
    throw new Error(`Runtime identity for ${service.logicalName} must belong to project ${input.projectId}.`);
  }
  const plain = Object.entries(service.env ?? {});
  const secret = Object.entries(service.secretEnv ?? {});
  for (const [name] of [...plain, ...secret]) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) throw new Error(`Environment variable ${name} cannot be managed for ${service.logicalName}.`);
  }
  const duplicate = plain.find(([name]) => name in (service.secretEnv ?? {}));
  if (duplicate) throw new Error(`Environment variable ${duplicate[0]} is declared both as a value and as a secret.`);

  const env = [
    ...plain.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })),
    ...secret.sort(([a], [b]) => a.localeCompare(b)).map(([name, ref]) => {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(ref.secretId) || !/^(latest|[1-9][0-9]*)$/.test(ref.version)) {
        throw new Error(`Secret reference for ${name} is invalid.`);
      }
      return { name, value_source: [{ secret_key_ref: [{ secret: ref.secretId, version: ref.version }] }] };
    }),
  ];
  const isWorker = service.workload === 'worker';
  const container: Record<string, unknown> = {
    image: service.initialImage,
    ...(service.command ? { command: service.command } : {}),
    ...(service.args ? { args: service.args } : {}),
    ...(isWorker ? {} : { ports: [{ container_port: service.port ?? 8080 }] }),
    resources: [{
      limits: { cpu: service.cpu ?? '1', memory: service.memory ?? '512Mi' },
      cpu_idle: !isWorker,
    }],
    ...(env.length ? { env } : {}),
    ...(!isWorker && service.healthCheckPath ? {
      startup_probe: [{ http_get: [{ path: service.healthCheckPath }], failure_threshold: 10, period_seconds: 3 }],
    } : {}),
  };
  return {
    name: service.resourceName,
    project: input.projectId,
    location: input.region,
    ingress: isWorker ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL',
    // Hypervibe's approval gate governs deletion; provider-side protection would block approved teardown.
    deletion_protection: false,
    labels: { 'managed-by': 'hypervibe', 'hv-service': engineKey(service.logicalName).replace(/_/g, '-') },
    template: [{
      service_account: service.runtimeServiceAccountEmail,
      scaling: [{
        min_instance_count: service.minInstances ?? (isWorker ? 1 : 0),
        ...(service.maxInstances !== undefined ? { max_instance_count: service.maxInstances } : {}),
      }],
      containers: [container],
    }],
    lifecycle: [{
      // Narrow release ownership: only the running image (and the client
      // markers gcloud/CI stamp on deploy) belong to the release writer.
      // Every other template field remains engine-managed, so infrastructure
      // changes keep the currently deployed image instead of rolling back.
      ignore_changes: ['template[0].containers[0].image', 'client', 'client_version'],
    }],
  };
}

export function buildCloudRunConfiguration(input: GcpCloudRunEngineInput): EngineConfiguration {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)) throw new Error('GCP project id is invalid.');
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(input.region)) throw new Error('GCP region is invalid.');
  const services: Record<string, unknown> = {};
  const iam: Record<string, unknown> = {};
  const resources: Record<string, EngineResourceMapping> = {};
  const seen = new Set<string>();
  for (const service of input.services) {
    const key = engineKey(service.logicalName);
    if (seen.has(key)) throw new Error(`Duplicate engine address for service ${service.logicalName}.`);
    seen.add(key);
    services[key] = serviceResource(input, service);
    const mapping: EngineResourceMapping = {
      actionId: `service:${service.logicalName}`, kind: 'service', name: service.logicalName, billable: true,
    };
    resources[`google_cloud_run_v2_service.${key}`] = mapping;
    if (service.public && service.workload === 'web') {
      iam[`${key}_public`] = {
        project: input.projectId,
        location: input.region,
        name: `\${google_cloud_run_v2_service.${key}.name}`,
        role: 'roles/run.invoker',
        member: 'allUsers',
      };
      resources[`google_cloud_run_v2_service_iam_member.${key}_public`] = mapping;
    }
  }
  return {
    files: {
      'provider.tf.json': { provider: { google: [{ project: input.projectId, region: input.region }] } },
      'cloudrun.tf.json': {
        resource: {
          ...(Object.keys(services).length ? { google_cloud_run_v2_service: services } : {}),
          ...(Object.keys(iam).length ? { google_cloud_run_v2_service_iam_member: iam } : {}),
        },
      },
    },
    resources,
  };
}

/** Builds engine process credentials from a saved GCP connection. */
export function gcpEngineAuthentication(connection: { projectId: string; credentials: string }): EngineAuthentication {
  let parsed: { type?: string; private_key?: string; client_email?: string };
  try {
    parsed = JSON.parse(connection.credentials);
  } catch {
    throw new Error('The GCP connection credential is not valid JSON.');
  }
  if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
    throw new Error('The GCP connection must hold a Hypervibe-generated deployment service account.');
  }
  return {
    env: { GOOGLE_CREDENTIALS: connection.credentials, GOOGLE_PROJECT: connection.projectId },
    redact: [connection.credentials, parsed.private_key],
  };
}

export const gcpEngineBackend: InfrastructureEngineBackend<GcpCloudRunEngineInput> = {
  provider: 'gcp',
  engine: 'opentofu',
  capabilities: ['hosting'],
  providerRequirements: {
    google: { source: 'hashicorp/google', version: GOOGLE_PROVIDER_VERSION, lockHashes: GOOGLE_PROVIDER_LOCK_HASHES },
  },
  buildConfiguration: buildCloudRunConfiguration,
  buildAuthenticationProbe: ({ projectId }) => ({
    files: {
      'provider.tf.json': { provider: { google: [{ project: projectId }] } },
      'probe.tf.json': {
        data: {
          google_client_openid_userinfo: { identity: {} },
          google_project: { target: { project_id: projectId } },
        },
        output: {
          identity: { value: '${data.google_client_openid_userinfo.identity.email}' },
          project_id: { value: '${data.google_project.target.project_id}' },
          project_number: { value: '${data.google_project.target.number}' },
        },
      },
    },
    resources: {},
  }),
};
