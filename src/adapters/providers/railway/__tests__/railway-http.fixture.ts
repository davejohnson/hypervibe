import { readFileSync } from 'node:fs';
import { buildSchema, execute, GraphQLError, parse, validate } from 'graphql';
import { expect, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

export const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
export const projectId = 'project-contract';
export const productionId = 'environment-production';
export const stagingId = 'environment-staging';
export const postgresTemplate = JSON.parse(readFileSync('test/provider-contracts/railway/postgres-template.recorded.json', 'utf8')).data.template;

type Instance = {
  id: string; serviceId: string; environmentId: string; deletedAt: string | null;
  numReplicas: number | null;
  activeDeployments?: Array<{ id: string }>;
  latestDeployment?: { id: string; status: string };
  source: { image?: string }; domains: { serviceDomains: Array<{ domain: string }>; customDomains: [] };
};
type ProviderService = { id: string; name: string; instances: Map<string, Instance>; templateId?: string; templateServiceId?: string };
type BucketConfig = Record<string, { region: string; isCreated?: boolean; isDeleted?: boolean }>;
type EnvironmentConfig = { buckets?: BucketConfig; services?: Record<string, { deploy?: unknown }> };
const connection = (nodes: unknown[], more = false, cursor: string | null = null) => ({
  edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: more, endCursor: cursor },
});
const limitedConnection = (nodes: unknown[], { first }: { first?: number }) => {
  const count = first ?? nodes.length;
  return connection(nodes.slice(0, count), nodes.length > count, nodes.length > count ? String(count) : null);
};

// Only the documented same-service examples needed by these contracts. This
// deliberately does not purport to implement Railway's complete template DSL.
function renderVariables(raw: Record<string, string>): Record<string, string> {
  const resolve = (value: string, seen: Set<string>): string => value.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (token, key: string) =>
    !seen.has(key) && raw[key] !== undefined ? resolve(raw[key], new Set([...seen, key])) : token);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolve(value, new Set([key]))]));
}

/** Synthetic provider state, executed by the official schema, not a recorded live lifecycle. */
export async function railwayHttpFixture(options: {
  projectTokenScope?: { projectId: string; environmentId: string };
  environmentProjectId?: string;
  stagingExists?: boolean; projectExists?: boolean; pageSize?: number; dropCreateResponse?: boolean;
  bucketDelayMs?: number; omitBucketFlags?: boolean;
  volumeDelayMs?: number; dropVolumeCreateResponse?: boolean; volumeCreateResponseId?: string;
  dropBackupCreateResponse?: boolean; backupWorkflowId?: string | null;
  dropScheduleUpdateResponse?: boolean; ignoreScheduleUpdate?: boolean;
  dropVariableResponse?: boolean;
  variableMutationEnvironments?: string[];
  dropTemplateDeployResponse?: boolean;
  templateWithoutVolume?: boolean;
  templateWorkflowStatus?: 'Complete' | 'Running' | 'Error' | 'NotFound';
  /** Synthetic reference interpolation, per the official variable API examples. */
  renderVariableReferences?: boolean;
  responseOverride?: (request: { query: string; variables: Record<string, any> }) => Response | undefined;
} = {}) {
  let projectExists = options.projectExists !== false;
  const services = new Map<string, ProviderService>();
  const buckets = new Map([['bucket-documents', { id: 'bucket-documents', name: 'documents', projectId }]]);
  const environments = new Map<string, { id: string; name: string; config: EnvironmentConfig; unmergedChangesCount?: number }>([
    [productionId, { id: productionId, name: 'production', config: { buckets: { 'bucket-documents': { region: 'iad', isCreated: true, isDeleted: false } } } }],
  ]);
  if (options.stagingExists !== false) environments.set(stagingId, { id: stagingId, name: 'staging', config: {} });
  const volumes = new Map<string, Record<string, unknown>>();
  const volumeReadyAt = new Map<string, number>();
  // Reconstructed from pinned official VolumeInstanceBackup / WorkflowResult,
  // and CLI database/pitr.rs backup_create/list. These are synthetic responses.
  const backups = new Map<string, Array<Record<string, unknown>>>();
  const backupWorkflows = new Map<string, { status: string; error: string | null }>();
  // Official CLI pitr.rs:1678-1797 replaces selected kinds, preserving existing
  // backups. Native daily/weekly/monthly retention is fixed by Railway docs.
  const backupSchedules = new Map<string, Array<Record<string, unknown>>>();
  let nextVolumeId = 0;
  const variables = new Map<string, Record<string, string>>();
  // Official documented `${{ Service.KEY }}` references. Synthetic values are
  // resolved from independently held service/environment state, never requests.
  const resolvedVariables = (serviceId: string, environmentId: string, seen = new Set<string>()): Record<string, string> => {
    const identity = `${serviceId}/${environmentId}`;
    if (seen.has(identity)) throw new Error('Synthetic reference cycle');
    const raw = variables.get(identity) ?? {};
    const cross = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key,
      value.replace(/\$\{\{\s*([^{}.]+)\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (token, name: string, source: string) => {
        const matches = [...services.values()].filter(service => service.name === name.trim() && service.instances.has(environmentId));
        return matches.length === 1 ? resolvedVariables(matches[0].id, environmentId, new Set([...seen, identity]))[source] ?? token : token;
      })]));
    return renderVariables(cross);
  };
  // Snapshot evidence is deliberately separate from mutable service variables.
  const deployments = new Map<string, { id: string; projectId: string; environmentId: string; serviceId: string; snapshotId: string;
    status?: string; deploymentStopped?: boolean; instances?: Array<{ id: string; status: string }> }>();
  const deploymentSnapshots = new Map<string, { id: string; variables: unknown }>();
  const mutations: Array<{ field: string; args: Record<string, any> }> = [];
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  const contractErrors: string[] = [];
  const pendingBuckets: Array<{ environmentId: string; bucketId: string; value: BucketConfig[string]; readyAt: number }> = [];

  function completeBucketPatches() {
    for (let index = pendingBuckets.length - 1; index >= 0; index--) {
      const patch = pendingBuckets[index];
      if (Date.now() < patch.readyAt) continue;
      const environment = environments.get(patch.environmentId)!;
      environment.config.buckets ??= {};
      environment.config.buckets[patch.bucketId] = patch.value;
      pendingBuckets.splice(index, 1);
    }
  }

  function addService(id: string, name: string, environmentId: string) {
    const service: ProviderService = { id, name, instances: new Map<string, Instance>() };
    service.instances.set(environmentId, {
      id: `instance-${id}-${environmentId}`, serviceId: id, environmentId, deletedAt: null, numReplicas: 1, activeDeployments: [],
      source: {}, domains: { serviceDomains: [], customDomains: [] },
    });
    services.set(id, service);
    // Independently modeled from the pinned official CLI's EnvironmentConfig
    // services map and optional DeployConfig fields, not a request echo.
    const config = environments.get(environmentId)!.config;
    config.services ??= {};
    config.services[id] = { deploy: {} };
    return service;
  }
  for (const name of ['postgres-db', 'redis-db', 'web']) addService(`production-${name}`, name, productionId);

  function addVolume(serviceId: string | null, environmentId: string, mountPath: string,
    overrides: Record<string, unknown> = {}) {
    const id = `volume-${++nextVolumeId}`;
    const instance = {
      id: `instance-${id}`, serviceId, environmentId, mountPath,
      deletedAt: null, isPendingDeletion: false, volume: { id, projectId }, ...overrides,
    };
    volumes.set(id, instance);
    return { id, instance };
  }

  function serviceNode(service: ProviderService) {
    return {
      id: service.id, name: service.name, projectId, deletedAt: null, repoTriggers: connection([]),
      templateId: service.templateId ?? null, templateServiceId: service.templateServiceId ?? null,
      serviceInstances: ({ after, first }: { after?: string; first?: number }) => {
        const instances = [...service.instances.values()];
        const start = after ? Number(after) : 0;
        const end = start + Math.min(first ?? 100, options.pageSize ?? 100);
        const more = end < instances.length;
        return connection(instances.slice(start, end), more, more ? String(end) : null);
      },
    };
  }

  const root: Record<string, (args: any) => unknown> = {
    template: ({ code }) => {
      expect(code).toBe('postgres');
      return structuredClone(postgresTemplate);
    },
    templateDeployV2: ({ input }) => {
      expect(input).toMatchObject({ projectId, environmentId: stagingId, templateId: postgresTemplate.id });
      // Public template is recorded independently. Resulting resources and
      // resolved credentials below are synthetic, not a request echo or a live deployment.
      const service = addService('staging-Postgres', 'Postgres', stagingId);
      service.templateId = postgresTemplate.id;
      service.templateServiceId = Object.keys(postgresTemplate.serializedConfig.services)[0];
      service.instances.get(stagingId)!.source = { image: 'ghcr.io/railwayapp-templates/postgres-ssl:18' };
      variables.set(`${service.id}/${stagingId}`, {
        PGDATA: '/var/lib/postgresql/data/pgdata',
        POSTGRES_USER: 'postgres', POSTGRES_DB: 'railway', POSTGRES_PASSWORD: 'synthetic-provider-generated-password',
        PGUSER: '${{ POSTGRES_USER }}', PGDATABASE: '${{POSTGRES_DB}}', PGPASSWORD: '${{POSTGRES_PASSWORD}}',
        PGHOST: '${{RAILWAY_PRIVATE_DOMAIN}}', PGPORT: '5432',
        DATABASE_URL: 'postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}',
        RAILWAY_PRIVATE_DOMAIN: 'postgres.railway.internal',
      });
      if (!options.templateWithoutVolume) addVolume(service.id, stagingId, '/var/lib/postgresql/data');
      backupWorkflows.set('template-workflow', { status: options.templateWorkflowStatus ?? 'Complete', error: null });
      return { projectId, workflowId: 'template-workflow' };
    },
    volumeInstanceBackupScheduleList: ({ volumeInstanceId }) => {
      expect([...volumes.values()].some((volume) => volume.id === volumeInstanceId)).toBe(true);
      return backupSchedules.get(volumeInstanceId) ?? [];
    },
    volumeInstanceBackupScheduleUpdate: ({ volumeInstanceId, kinds }) => {
      const volume = [...volumes.values()].find((candidate) => candidate.id === volumeInstanceId);
      expect(volume?.environmentId).toBe(stagingId);
      mutations.push({ field: 'volumeInstanceBackupScheduleUpdate', args: { volumeInstanceId, kinds } });
      if (!options.ignoreScheduleUpdate) {
        const existing = backupSchedules.get(volumeInstanceId) ?? [];
        const native = {
          DAILY: { cron: '0 3 * * *', retentionSeconds: 6 * 86400 },
          WEEKLY: { cron: '0 3 * * 0', retentionSeconds: 27 * 86400 },
          MONTHLY: { cron: '0 3 1 * *', retentionSeconds: 89 * 86400 },
        };
        backupSchedules.set(volumeInstanceId, kinds.map((kind: keyof typeof native) =>
          existing.find((schedule) => schedule.kind === kind) ?? {
            id: `schedule-${kind}`, name: kind, kind, createdAt: '2026-09-30T06:00:00.000Z', ...native[kind],
          }));
      }
      return true;
    },
    volumeInstanceBackupList: ({ volumeInstanceId }) => {
      expect([...volumes.values()].some((volume) => volume.id === volumeInstanceId)).toBe(true);
      return backups.get(volumeInstanceId) ?? [];
    },
    volumeInstanceBackupCreate: ({ volumeInstanceId, name }) => {
      const volume = [...volumes.values()].find((candidate) => candidate.id === volumeInstanceId);
      expect(volume?.environmentId).toBe(stagingId);
      const records = backups.get(volumeInstanceId) ?? [];
      records.push({ id: `backup-${records.length + 1}`, externalId: `snapshot-${records.length + 1}`,
        name: name ?? null, createdAt: '2026-09-30T06:00:00.000Z', expiresAt: null,
        usedMB: null, referencedMB: 8, volumeInstanceSizeMB: 1024 });
      backups.set(volumeInstanceId, records);
      const workflowId = options.backupWorkflowId === undefined ? 'backup-workflow' : options.backupWorkflowId;
      if (workflowId) backupWorkflows.set(workflowId, { status: 'Running', error: null });
      mutations.push({ field: 'volumeInstanceBackupCreate', args: { volumeInstanceId, name } });
      return { workflowId };
    },
    workflowStatus: ({ workflowId }) => backupWorkflows.get(workflowId) ?? { status: 'NotFound', error: null },
    // ProjectToken.projectId/environmentId are non-null identities in the pinned SDL.
    projectToken: () => options.projectTokenScope,
    projects: () => connection(projectExists ? [{
      id: projectId, name: 'contract-project',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] : []),
    projectCreate: ({ input }) => {
      expect(input).toMatchObject({ name: 'contract-project', workspaceId: 'workspace-contract' });
      projectExists = true;
      return { id: projectId, name: input.name };
    },
    project: ({ id }) => {
      expect(id).toBe(projectId);
      expect(projectExists).toBe(true);
      return {
        id: projectId, name: 'contract-project',
        environments: (args: { first?: number }) => limitedConnection([...environments.values()].map((env) => ({ unmergedChangesCount: 0, ...env })), args),
        services: ({ first, after }: { first?: number; after?: string }) => {
          const nodes = [...services.values()].map(serviceNode);
          const start = after ? Number(after) : 0;
          const end = start + Math.min(first ?? nodes.length, first ? options.pageSize ?? nodes.length : nodes.length);
          return connection(nodes.slice(start, end), end < nodes.length, end < nodes.length ? String(end) : null);
        },
        buckets: (args: { first?: number }) => limitedConnection([...buckets.values()], args), plugins: connection([]),
      };
    },
    environment: ({ id }) => ({
      ...environments.get(id), projectId: options.environmentProjectId ?? projectId, deletedAt: null,
      serviceInstances: ({ first, after }: { first?: number; after?: string }) => {
        const nodes = [...services.values()].flatMap(service => [...service.instances.values()]
          .filter(instance => instance.environmentId === id).map(instance => ({ ...instance, service: serviceNode(service) })));
        const start = after ? Number(after) : 0, end = start + Math.min(first ?? 100, options.pageSize ?? 100);
        return connection(nodes.slice(start, end), end < nodes.length, end < nodes.length ? String(end) : null);
      },
      volumeInstances: ({ after }: { after?: string }) => {
        const visible = [...volumes.entries()]
          .filter(([volumeId, volume]) => volume.environmentId === id
            && Date.now() >= (volumeReadyAt.get(volumeId) ?? 0))
          .map(([, volume]) => volume);
        const start = after ? Number(after) : 0;
        const end = start + (options.pageSize ?? 100);
        return connection(visible.slice(start, end), end < visible.length,
          end < visible.length ? String(end) : null);
      },
    }),
    service: ({ id }) => services.has(id) ? serviceNode(services.get(id)!) : null,
    serviceInstance: ({ serviceId, environmentId }) => {
      const instance = services.get(serviceId)?.instances.get(environmentId);
      if (!instance) {
        // Error semantics observed in run c8ac543a-c31e-4c86-8fde-956c5fd676ee.
        // The envelope is reconstructed; this is not a raw HTTP recording.
        throw new GraphQLError('ServiceInstance not found', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
      }
      return instance;
    },
    variables: ({ serviceId, environmentId, unrendered }) => {
      const raw = variables.get(`${serviceId}/${environmentId}`) ?? {};
      return options.renderVariableReferences && !unrendered ? resolvedVariables(serviceId, environmentId) : raw;
    },
    variablesForServiceDeployment: ({ serviceId, environmentId }) =>
      options.renderVariableReferences ? resolvedVariables(serviceId, environmentId)
        : renderVariables(variables.get(`${serviceId}/${environmentId}`) ?? {}),
    deployment: ({ id }) => deployments.get(id) ?? [...services.values()].flatMap(service => [...service.instances.values()]
      .filter(instance => instance.latestDeployment?.id === id).map(instance => ({ id, projectId, environmentId: instance.environmentId, serviceId: service.id, snapshotId: null })))[0],
    deploymentSnapshot: ({ deploymentId }) => deploymentSnapshots.get(deploymentId) ?? null,
    environmentCreate: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      const environment = { id: stagingId, name: input.name, config: {} };
      environments.set(stagingId, environment);
      return environment;
    },
    serviceCreate: ({ input }) => {
      expect(input).toMatchObject({ projectId, environmentId: stagingId });
      const service = addService(`staging-${input.name}`, input.name, input.environmentId);
      service.instances.get(stagingId)!.source = input.source ?? {};
      return serviceNode(service);
    },
    variableCollectionUpsert: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      expect(services.get(input.serviceId)?.instances.has(input.environmentId)).toBe(true);
      // Railway documents additive upsert unless replace:true is selected.
      // EnvironmentVariables is opaque in the schema; these semantics come
      // from https://docs.railway.com/integrations/api/manage-variables.
      const key = `${input.serviceId}/${input.environmentId}`;
      variables.set(key, { ...(input.replace ? {} : variables.get(key)), ...input.variables });
      return true;
    },
    serviceInstanceUpdate: ({ serviceId, environmentId, input }) => {
      expect(services.get(serviceId)?.instances.has(environmentId)).toBe(true);
      expect(Object.keys(input)).toEqual(['registryCredentials']);
      expect(Object.keys(input.registryCredentials).sort()).toEqual(['password', 'username']);
      // The independent contract allows a credential-only patch. The fixture
      // keeps image, source, variables and deployment state unchanged.
      return true;
    },
    volumeCreate: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      expect(services.get(input.serviceId)?.instances.has(input.environmentId)).toBe(true);
      const { id } = addVolume(input.serviceId, input.environmentId, input.mountPath);
      volumeReadyAt.set(id, Date.now() + (options.volumeDelayMs ?? 0));
      return { id: options.volumeCreateResponseId ?? id };
    },
    volumeDelete: ({ volumeId }) => {
      const volume = volumes.get(volumeId);
      if (volume) {
        expect(volume.environmentId).toBe(stagingId);
        volumes.delete(volumeId);
      }
      return true;
    },
    serviceInstanceRedeploy: ({ serviceId, environmentId }) => {
      expect(services.get(serviceId)?.instances.has(environmentId)).toBe(true);
      return true;
    },
    serviceDelete: ({ id, environmentId }) => {
      services.get(id)!.instances.get(environmentId)!.deletedAt = '2026-09-12T00:00:00Z';
      return true;
    },
    serviceDomainCreate: ({ input }) => {
      const domain = { domain: 'contract-web.up.railway.app' };
      services.get(input.serviceId)!.instances.get(input.environmentId)!.domains.serviceDomains.push(domain);
      return domain;
    },
    bucketCreate: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      const bucket = { id: `bucket-${input.name}`, name: input.name, projectId };
      expect(buckets.has(bucket.id)).toBe(false);
      buckets.set(bucket.id, bucket);
      return bucket;
    },
    bucketInstanceDetails: ({ bucketId, environmentId }) => {
      const instance = environments.get(environmentId)?.config.buckets?.[bucketId];
      expect(instance?.region).toBeTruthy();
      expect(instance?.isDeleted).not.toBe(true);
      return { objectCount: environmentId === productionId ? 7 : 0, sizeBytes: environmentId === productionId ? 42 : 0 };
    },
    environmentPatchCommit: ({ environmentId, patch }) => {
      const environment = environments.get(environmentId)!;
      for (const [id, value] of Object.entries(patch.buckets as BucketConfig)) {
        expect(buckets.has(id)).toBe(true);
        // Synthetic asynchronous visibility. Railway's official BucketInstance
        // has optional flags; committed config need not echo patch directives.
        pendingBuckets.push({ environmentId, bucketId: id,
          value: options.omitBucketFlags && value.isCreated === true
            ? { region: value.region } : { ...environment.config.buckets?.[id], ...value },
          readyAt: Date.now() + (options.bucketDelayMs ?? 0),
        });
      }
      return 'bucket-deployment';
    },
  };
  for (const field of ['projectCreate', 'environmentCreate', 'templateDeployV2', 'serviceCreate', 'variableCollectionUpsert', 'serviceInstanceUpdate', 'volumeCreate', 'volumeDelete', 'serviceInstanceRedeploy', 'serviceDelete', 'serviceDomainCreate', 'bucketCreate', 'environmentPatchCommit']) {
    const resolve = root[field];
    root[field] = (args) => {
      if (!['projectCreate', 'environmentCreate', 'bucketCreate', 'volumeDelete'].includes(field)) {
        if (field === 'variableCollectionUpsert' && options.variableMutationEnvironments) expect(options.variableMutationEnvironments).toContain(args.input?.environmentId);
        else expect(args.input?.environmentId ?? args.environmentId).toBe(stagingId);
      }
      mutations.push({ field, args });
      return resolve(args);
    };
  }

  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).pathname).toBe('/graphql/v2');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    if (options.projectTokenScope) {
      // Official Railway API authentication uses a distinct project-token header.
      expect(headers.get('project-access-token')).toBe('synthetic-project-token');
      expect(headers.has('authorization')).toBe(false);
    } else {
      expect(headers.get('authorization')).toBe('Bearer synthetic-contract-token');
    }
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    completeBucketPatches();
    const override = options.responseOverride?.(request);
    if (override) return override;
    const document = parse(request.query);
    const errors = validate(schema, document);
    if (errors.length) {
      contractErrors.push(...errors.map((error) => error.message));
      return Response.json({ errors }, { status: 400 });
    }
    const result = await execute({ schema, document, variableValues: request.variables, rootValue: root });
    contractErrors.push(...(result.errors ?? [])
      .filter((error) => error.extensions.code !== 'INTERNAL_SERVER_ERROR')
      .map((error) => error.message));
    if (options.dropCreateResponse && request.query.includes('mutation CreateService')) {
      throw new TypeError('Synthetic connection reset after serviceCreate committed');
    }
    if (options.dropTemplateDeployResponse && request.query.includes('templateDeployV2')) {
      throw new TypeError('Synthetic connection reset after templateDeployV2 committed');
    }
    if (options.dropVolumeCreateResponse && request.query.includes('mutation VolumeCreate')) {
      throw new TypeError('Synthetic connection reset after volumeCreate committed');
    }
    if (options.dropBackupCreateResponse && request.query.includes('mutation DatabaseCheckpointCreate')) {
      throw new TypeError('Synthetic connection reset after backup creation committed');
    }
    if (options.dropScheduleUpdateResponse && request.query.includes('mutation DailyBackupScheduleUpdate')) {
      throw new TypeError('Synthetic connection reset after schedule update committed');
    }
    if (options.dropVariableResponse && (request.query.includes('mutation UpsertVariables') || request.query.includes('mutation SynchronizeDatabaseRotationIssuer'))) {
      throw new TypeError('Synthetic connection reset after variable update committed');
    }
    return Response.json(result);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-contract-token', workspaceId: 'workspace-contract' });
  const environment: Environment = {
    id: 'local-staging', projectId: 'local-project', name: 'staging',
    platformBindings: { projectId, ...(options.stagingExists !== false ? { environmentId: stagingId } : {}) },
    createdAt: new Date(), updatedAt: new Date(),
  };
  return { adapter, environment, services, environments, buckets, volumes, addService, addVolume,
    mutations, requests, variables, deployments, deploymentSnapshots, contractErrors, backups, backupWorkflows, backupSchedules };
}
