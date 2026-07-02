import { GraphQLClient, gql } from 'graphql-request';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { IProviderAdapter, Receipt, ComponentResult, DeployResult, JobResult, ProviderCapabilities } from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { hashEnvValue } from '../../../domain/ports/observe.port.js';
import type { ObservedDatabase, ObservedService, ObservedState } from '../../../domain/ports/observe.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import {
  normalizeProviderDnsRecord,
  providerDnsRecordsAreConfigured,
  type NormalizedDnsRecord,
} from '../../../domain/services/domain-dns-records.js';

// Credentials schema for self-registration
export const RailwayCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
});

export type RailwayCredentials = z.infer<typeof RailwayCredentialsSchema>;

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

function normalizeRailwayGitRepo(repo?: string): string | undefined {
  if (!repo) {
    return undefined;
  }

  return repo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

function cachedBranchForSource(
  cachedSource: { repo?: string; branch?: string } | undefined,
  sourceRepo: string | undefined
): string | undefined {
  if (!cachedSource?.branch || !sourceRepo) {
    return undefined;
  }
  return normalizeRailwayGitRepo(cachedSource.repo) === normalizeRailwayGitRepo(sourceRepo)
    ? cachedSource.branch
    : undefined;
}

export class RailwayAdapter implements IProviderAdapter {
  readonly name = 'railway';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['nixpacks', 'dockerfile'],
    supportedComponents: ['postgres'],
    supportsAutoWiring: true,
    supportsHealthChecks: true,
    supportsCronSchedule: true,
    supportsReleaseCommand: true, // mapped to Railway's preDeployCommand
    supportsMultiEnvironment: true,
    managedTls: true,
    supportsObserve: true,
    queues: { backend: 'postgres' },
  };

  private client: GraphQLClient | null = null;
  private credentials: RailwayCredentials | null = null;
  private resolvedWorkspaceId: string | null | undefined;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as RailwayCredentials;
    this.resolvedWorkspaceId = undefined;
    this.client = new GraphQLClient(RAILWAY_API_URL, {
      headers: {
        Authorization: `Bearer ${this.credentials.apiToken}`,
      },
    });
  }

  async verify(): Promise<{
    success: boolean;
    error?: string;
    email?: string;
    workspaceId?: string;
    workspaces?: Array<{ id: string; name?: string }>;
  }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const query = gql`
        query Me {
          me {
            id
            email
          }
        }
      `;
      const result = await this.client.request<{ me: { id: string; email: string } }>(query);
      if (result.me?.id) {
        const workspaces = await this.getWorkspaces();
        const workspaceId = await this.resolveWorkspaceId();
        return { success: true, email: result.me.email, workspaceId: workspaceId ?? undefined, workspaces };
      }
      return { success: false, error: 'No user returned from Railway API' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
    this.resolvedWorkspaceId = undefined;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      // Check if we already have a project ID bound
      const bindings = environment.platformBindings as { projectId?: string };
      const existingProjectId = bindings.projectId;
      if (existingProjectId) {
        // Verify project still exists
        const query = gql`
          query GetProject($id: String!) {
            project(id: $id) {
              id
              name
            }
          }
        `;
        try {
          const result = await this.client.request<{ project: { id: string; name: string } }>(query, {
            id: existingProjectId,
          });
          if (result.project) {
            return {
              success: true,
              message: `Using existing Railway project: ${result.project.name}`,
              data: { projectId: result.project.id, projectName: result.project.name, created: false },
            };
          }
        } catch {
          // Project doesn't exist anymore, create new one
        }
      }

      // Create a new Railway project. Railway GraphQL schema differs across accounts/versions,
      // so try a few compatible mutation shapes before failing.
      let created: { id: string; name: string } | null = null;
      let createError: string | undefined;
      let reusedByName = false;
      try {
        created = await this.createProject(projectName);
      } catch (error) {
        createError = this.describeError(error);
      }
      if (!created) {
        // Last-resort compatibility: if creation is blocked because a project already exists
        // with this name, try to reuse it.
        const existingByName = await this.findProjectByName(projectName);
        if (existingByName) {
          created = existingByName;
          reusedByName = true;
        }
      }
      if (!created) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: createError || `Unable to create project "${projectName}" on Railway`,
        };
      }

      return {
        success: true,
        message: reusedByName ? `Using existing Railway project: ${created.name}` : `Created Railway project: ${created.name}`,
        data: {
          projectId: created.id,
          projectName: created.name,
          created: !reusedByName,
        },
      };
    } catch (error) {
      const message = this.describeError(error);
      return {
        success: false,
        message: 'Failed to ensure Railway project',
        error: message,
      };
    }
  }

  private async createProject(projectName: string): Promise<{ id: string; name: string } | null> {
    if (!this.client) return null;
    const workspaceId = await this.resolveWorkspaceId();

    const attempts: Array<{ mutation: string; variables: Record<string, unknown>; label: string }> = [
      {
        label: 'input.workspaceId',
        mutation: `
          mutation CreateProject($name: String!, $workspaceId: String!) {
            projectCreate(input: { name: $name, workspaceId: $workspaceId }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName, workspaceId },
      },
      {
        label: 'input.teamId',
        mutation: `
          mutation CreateProject($name: String!, $teamId: String) {
            projectCreate(input: { name: $name, teamId: $teamId }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName, teamId: this.credentials?.teamId ?? workspaceId ?? null },
      },
      {
        label: 'input.name_only',
        mutation: `
          mutation CreateProject($name: String!) {
            projectCreate(input: { name: $name }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName },
      },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      if (attempt.label === 'input.workspaceId' && !workspaceId) {
        errors.push('input.workspaceId: No workspaceId available from credentials or Railway account');
        continue;
      }
      try {
        const result = await this.client.request<{ projectCreate: { id: string; name: string } }>(
          gql`${attempt.mutation}`,
          attempt.variables
        );
        if (result?.projectCreate?.id) {
          return result.projectCreate;
        }
        errors.push(`${attempt.label}: Railway returned empty projectCreate payload`);
      } catch (error) {
        errors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    throw new Error(errors.join(' | '));
  }

  private async resolveWorkspaceId(): Promise<string | null> {
    if (this.resolvedWorkspaceId !== undefined) {
      return this.resolvedWorkspaceId;
    }
    if (!this.client) {
      this.resolvedWorkspaceId = null;
      return this.resolvedWorkspaceId;
    }

    if (this.credentials?.workspaceId) {
      this.resolvedWorkspaceId = this.credentials.workspaceId;
      return this.resolvedWorkspaceId;
    }

    // Backward compatibility: some users stored teamId previously.
    if (this.credentials?.teamId) {
      this.resolvedWorkspaceId = this.credentials.teamId;
      return this.resolvedWorkspaceId;
    }

    try {
      const workspaces = await this.getWorkspaces();
      const id = workspaces[0]?.id;
      this.resolvedWorkspaceId = id ?? null;
      return this.resolvedWorkspaceId;
    } catch {
      this.resolvedWorkspaceId = null;
      return this.resolvedWorkspaceId;
    }
  }

  private async getWorkspaces(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) return [];
    const attempts: Array<{
      query: string;
      parse: (payload: unknown) => Array<{ id: string; name?: string }>;
    }> = [
      {
        // Connection-style shape (older API responses)
        query: `
          query MyWorkspacesConnection {
            me {
              workspaces {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
        parse: (payload) => {
          const result = payload as {
            me?: {
              workspaces?: {
                edges?: Array<{ node?: { id?: string; name?: string } }>;
              };
            };
          };
          const edges = result.me?.workspaces?.edges ?? [];
          return edges
            .map((edge) => ({
              id: edge.node?.id ?? '',
              name: edge.node?.name,
            }))
            .filter((workspace) => workspace.id.length > 0);
        },
      },
      {
        // Direct array/object shape (newer API responses)
        query: `
          query MyWorkspacesDirect {
            me {
              workspaces {
                id
                name
              }
            }
          }
        `,
        parse: (payload) => {
          const result = payload as {
            me?: {
              workspaces?: { id?: string; name?: string } | Array<{ id?: string; name?: string }>;
            };
          };
          const raw = result.me?.workspaces;
          const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
          return list
            .map((workspace) => ({ id: workspace.id ?? '', name: workspace.name }))
            .filter((workspace) => workspace.id.length > 0);
        },
      },
      {
        // Singular workspace shape fallback
        query: `
          query MyWorkspaceSingular {
            me {
              workspace {
                id
                name
              }
            }
          }
        `,
        parse: (payload) => {
          const result = payload as { me?: { workspace?: { id?: string; name?: string } } };
          const workspace = result.me?.workspace;
          if (!workspace?.id) return [];
          return [{ id: workspace.id, name: workspace.name }];
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await this.client.request<unknown>(gql`${attempt.query}`);
        const parsed = attempt.parse(result);
        if (parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Try the next schema variant.
      }
    }

    return [];
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      const anyError = error as Error & {
        response?: {
          errors?: Array<{
            message?: string;
            path?: Array<string | number>;
            extensions?: Record<string, unknown>;
          }>;
          status?: number;
        };
      };
      const gqlErrors = anyError.response?.errors ?? [];
      if (gqlErrors.length > 0) {
        return gqlErrors
          .map((entry) => {
            const details = [
              typeof entry.extensions?.code === 'string' ? `code: ${entry.extensions.code}` : undefined,
              typeof entry.extensions?.statusCode === 'number' ? `status: ${entry.extensions.statusCode}` : undefined,
              entry.path?.length ? `path: ${entry.path.join('.')}` : undefined,
            ].filter(Boolean);
            const suffix = details.length ? ` (${details.join(', ')})` : '';
            return `${entry.message ?? 'Unknown GraphQL error'}${suffix}`;
          })
          .join('; ');
      }
      if (anyError.response?.status) {
        return `${error.message} (HTTP ${anyError.response.status})`;
      }
      return error.message;
    }
    return String(error);
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      throw new Error('No Railway project bound to this environment');
    }

    // Railway component provisioning is service-first: create a datastore service.
    const created = await this.createServiceBackedDatastore(type, environment, projectId);
    if (created) {
      return created;
    }

    const emptyComponent: Component = {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return {
      component: emptyComponent,
      receipt: {
        success: false,
        message: `Failed to create ${type} component`,
        error: `Unable to create ${type} service-backed datastore on Railway project ${projectId}`,
      },
    };
  }

  private async createServiceBackedDatastore(
    type: ComponentType,
    environment: Environment,
    projectId: string
  ): Promise<ComponentResult | null> {
    const client = this.client;
    if (!client) return null;

    const imageMap: Partial<Record<ComponentType, string>> = {
      postgres: 'postgres:16',
    };
    const image = imageMap[type];
    if (!image) return null;

    const environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);
    if (!environmentId) {
      return {
        component: {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {},
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        receipt: {
          success: false,
          message: `No Railway environment resolved for ${environment.name}`,
          error: `Could not resolve or create Railway environment "${environment.name}" on project ${projectId}`,
          data: { phase: 'resolveEnvironment', projectId, environmentName: environment.name },
        },
      };
    }
    const serviceName = `${type}-db`;
    const existingServiceId = await this.resolveServiceIdForProject(projectId, serviceName);
    if (existingServiceId) {
      // An earlier provisioning attempt may have created this service without
      // its bootstrap variables (the image then crashloops uninitialized).
      // Verify and repair before reusing.
      let repaired = false;
      const requiredVar = this.datastoreRequiredVar(type);
      if (requiredVar) {
        const existingVars = await this.fetchServiceVariables(projectId, existingServiceId, environmentId)
          .catch(() => null);
        if (existingVars && !existingVars[requiredVar]) {
          const bootstrapVars = this.buildDatastoreBootstrapVars(type, serviceName);
          const varsSet = bootstrapVars
            ? await this.upsertServiceVariables(projectId, existingServiceId, environmentId, bootstrapVars)
            : { success: true as const };
          const redeploy = varsSet.success
            ? await this.redeployDatastoreService(existingServiceId, environmentId)
            : varsSet;
          if (!varsSet.success || !redeploy.success) {
            return {
              component: {
                id: '',
                environmentId: environment.id,
                type,
                bindings: {},
                externalId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              receipt: {
                success: false,
                message: `Existing ${type} service ${serviceName} is missing ${requiredVar} and repair failed`,
                error: ('error' in varsSet ? varsSet.error : undefined) ?? ('error' in redeploy ? redeploy.error : undefined),
              },
            };
          }
          repaired = true;
        }
      }

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          resourceKind: 'service',
          pluginName: serviceName,
        },
        externalId: existingServiceId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        receipt: {
          success: true,
          message: repaired
            ? `Using existing ${type} datastore service (${serviceName}); repaired missing bootstrap variables and redeployed`
            : `Using existing ${type} datastore service (${serviceName})`,
          data: { serviceId: existingServiceId, serviceName, serviceBacked: true, reused: true, ...(repaired ? { repaired: true } : {}) },
        },
      };
    }
    const createMutation = gql`
      mutation CreateService($input: ServiceCreateInput!) {
        serviceCreate(input: $input) {
          id
          name
        }
      }
    `;

    try {
      const result = await client.request<{ serviceCreate: { id: string; name: string } }>(
        createMutation,
        {
          input: {
            projectId,
            environmentId,
            name: serviceName,
            source: {
              image,
            },
          },
        }
      );

      const bootstrapVars = this.buildDatastoreBootstrapVars(type, serviceName);
      if (bootstrapVars) {
        const varsSet = await this.upsertServiceVariables(projectId, result.serviceCreate.id, environmentId, bootstrapVars);
        if (!varsSet.success) {
          return {
            component: {
              id: '',
              environmentId: environment.id,
              type,
              bindings: {},
              externalId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            receipt: {
              success: false,
              message: `Created ${type} service ${result.serviceCreate.name} but failed to set bootstrap variables`,
              error: varsSet.error,
            },
          };
        }
      }

      // Persist data across redeploys; without a volume the datastore is ephemeral.
      const mountPath = this.datastoreVolumeMountPath(type);
      if (mountPath) {
        const volume = await this.attachServiceVolume(projectId, environmentId, result.serviceCreate.id, mountPath);
        if (!volume.success) {
          return {
            component: {
              id: '',
              environmentId: environment.id,
              type,
              bindings: {},
              externalId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            receipt: {
              success: false,
              message: `Created ${type} service ${result.serviceCreate.name} but failed to attach a volume`,
              error: volume.error,
            },
          };
        }
      }

      // serviceCreate with source.image starts the first deployment before the
      // variables/volume above exist (postgres crashloops with "superuser
      // password is not specified"); redeploy so the container boots with them.
      const redeploy = await this.redeployDatastoreService(result.serviceCreate.id, environmentId);
      if (!redeploy.success) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: `Created ${type} service ${result.serviceCreate.name} but failed to redeploy it with bootstrap configuration`,
            error: redeploy.error,
          },
        };
      }

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          resourceKind: 'service',
          pluginName: result.serviceCreate.name,
        },
        externalId: result.serviceCreate.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created ${type} datastore as Railway service (${result.serviceCreate.name})`,
          data: { serviceId: result.serviceCreate.id, serviceName: result.serviceCreate.name, serviceBacked: true },
        },
      };
    } catch (error) {
      return {
        component: {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {},
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        receipt: {
          success: false,
          message: `Failed to create ${type} service-backed datastore`,
          error: this.describeError(error),
          data: { phase: 'serviceCreate', projectId, environmentId, image },
        },
      };
    }
  }

  private buildDatastoreBootstrapVars(type: ComponentType, serviceName: string): Record<string, string> | null {
    const serviceHost = `${serviceName}.railway.internal`;

    if (type === 'postgres') {
      const password = randomBytes(18).toString('base64url');
      const connectionUrl = `postgresql://postgres:${password}@${serviceHost}:5432/postgres`;
      return {
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: 'postgres',
        // Volume mounts contain lost+found; initdb refuses a non-empty dir,
        // so point PGDATA at a subdirectory of the mount.
        PGDATA: '/var/lib/postgresql/data/pgdata',
        DATABASE_URL: connectionUrl,
        DATABASE_PRIVATE_URL: connectionUrl,
        PGHOST: serviceHost,
        PGPORT: '5432',
        PGUSER: 'postgres',
        PGPASSWORD: password,
        PGDATABASE: 'postgres',
      };
    }

    return null;
  }

  /** Env var that must exist for the datastore image to initialize; null = boots without vars. */
  private datastoreRequiredVar(type: ComponentType): string | null {
    if (type === 'postgres') return 'POSTGRES_PASSWORD';
    return null;
  }

  private datastoreVolumeMountPath(type: ComponentType): string | null {
    if (type === 'postgres') return '/var/lib/postgresql/data';
    return null;
  }

  private async attachServiceVolume(
    projectId: string,
    environmentId: string,
    serviceId: string,
    mountPath: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const mutation = gql`
      mutation VolumeCreate($input: VolumeCreateInput!) {
        volumeCreate(input: $input) {
          id
        }
      }
    `;
    try {
      await this.client.request(mutation, {
        input: { projectId, environmentId, serviceId, mountPath },
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async redeployDatastoreService(
    serviceId: string,
    environmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const mutation = gql`
      mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    try {
      await this.client.request(mutation, { serviceId, environmentId });
      return { success: true };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async upsertServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const mutation = gql`
      mutation UpsertVariables($projectId: String!, $serviceId: String!, $environmentId: String!, $variables: EnvironmentVariables!) {
        variableCollectionUpsert(
          input: {
            projectId: $projectId
            serviceId: $serviceId
            environmentId: $environmentId
            variables: $variables
          }
        )
      }
    `;
    try {
      await this.client.request(mutation, {
        projectId,
        serviceId,
        environmentId,
        variables,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async resolveRailwayEnvironmentId(
    projectId: string,
    environment: Environment
  ): Promise<string | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const bindings = environment.platformBindings as { environmentId?: string };
    let environmentId = bindings.environmentId;
    const projectEnvironments = await this.listProjectEnvironments(projectId);
    const environmentIds = projectEnvironments.map((env) => env.id);
    if (environmentId && environmentIds.includes(environmentId)) {
      return environmentId;
    }
    const byName = projectEnvironments.find((env) => env.name.toLowerCase() === environment.name.toLowerCase());
    if (byName?.id) {
      return byName.id;
    }
    const targetIsProduction = environment.name.toLowerCase() === 'production';
    if (!targetIsProduction) {
      const createdEnvironmentId = await this.createRailwayEnvironment(projectId, environment.name);
      if (createdEnvironmentId) {
        return createdEnvironmentId;
      }
      // Never silently send non-production deployments to the default/production env.
      return undefined;
    }
    if (environmentIds.length > 0) {
      return environmentIds[0];
    }

    if (environmentId) return environmentId;

    const envQuery = gql`
      query GetEnvironments($projectId: String!) {
        project(id: $projectId) {
          environments {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `;

    try {
      const envResult = await client.request<{
        project: { environments: { edges: Array<{ node: { id: string } }> } };
      }>(envQuery, { projectId });
      environmentId = envResult.project.environments.edges[0]?.node.id;
      return environmentId;
    } catch {
      return undefined;
    }
  }

  private async listProjectEnvironments(projectId: string): Promise<Array<{ id: string; name: string }>> {
    const client = this.client;
    if (!client) return [];
    const envQuery = gql`
      query GetEnvironments($projectId: String!) {
        project(id: $projectId) {
          environments {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    try {
      const envResult = await client.request<{
        project?: {
          environments?:
            | { edges?: Array<{ node?: { id?: string; name?: string } }> }
            | Array<{ id?: string; name?: string }>;
        };
      }>(envQuery, { projectId });
      const envs = envResult.project?.environments;
      if (!envs) return [];

      if (Array.isArray(envs)) {
        return envs
          .map((e) => ({ id: e.id ?? '', name: e.name ?? '' }))
          .filter((env) => env.id.length > 0 && env.name.length > 0);
      }
      const edges = envs.edges ?? [];
      return edges
        .map((e) => ({ id: e.node?.id ?? '', name: e.node?.name ?? '' }))
        .filter((env) => env.id.length > 0 && env.name.length > 0);
    } catch {
      return [];
    }
  }

  private async createRailwayEnvironment(projectId: string, environmentName: string): Promise<string | undefined> {
    if (!this.client) return undefined;
    const attempts: Array<{ mutation: string; variables: Record<string, unknown> }> = [
      {
        mutation: `
          mutation CreateEnvironment($projectId: String!, $name: String!) {
            environmentCreate(input: { projectId: $projectId, name: $name }) {
              id
              name
            }
          }
        `,
        variables: { projectId, name: environmentName },
      },
      {
        mutation: `
          mutation CreateEnvironment($projectId: String!, $name: String!) {
            environmentCreate(projectId: $projectId, name: $name) {
              id
              name
            }
          }
        `,
        variables: { projectId, name: environmentName },
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await this.client.request<Record<string, unknown>>(gql`${attempt.mutation}`, attempt.variables);
        const created = result.environmentCreate as { id?: string } | undefined;
        if (created?.id) return created.id;
      } catch {
        // Try next schema variant.
      }
    }

    return undefined;
  }

  private async resolveServiceIdForProject(
    projectId: string,
    serviceName: string,
    boundServiceId?: string
  ): Promise<string | undefined> {
    const services = await this.listProjectServices(projectId);
    if (boundServiceId && services.some((s) => s.id === boundServiceId)) {
      return boundServiceId;
    }
    const byName = services.find((s) => s.name === serviceName);
    return byName?.id;
  }

  private async listProjectServices(projectId: string): Promise<Array<{ id: string; name: string }>> {
    const client = this.client;
    if (!client) return [];
    const attempts = [
      gql`
        query GetProjectServicesConnection($projectId: String!) {
          project(id: $projectId) {
            services {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      gql`
        query GetProjectServicesDirect($projectId: String!) {
          project(id: $projectId) {
            services {
              id
              name
            }
          }
        }
      `,
    ];

    for (const query of attempts) {
      try {
        const result = await client.request<Record<string, unknown>>(query, { projectId });
        const project = result.project as
          | {
              services?:
                | { edges?: Array<{ node?: { id?: string; name?: string } }> }
                | Array<{ id?: string; name?: string }>;
            }
          | undefined;
        const services = project?.services;
        if (!services) continue;
        if (Array.isArray(services)) {
          return services
            .map((s) => ({ id: s.id ?? '', name: s.name ?? '' }))
            .filter((s) => s.id.length > 0 && s.name.length > 0);
        }
        const edges = services.edges ?? [];
        return edges
          .map((e) => ({ id: e.node?.id ?? '', name: e.node?.name ?? '' }))
          .filter((s) => s.id.length > 0 && s.name.length > 0);
      } catch {
        // Try next shape.
      }
    }

    return [];
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const attempts: Array<{ mutation: string; variables: Record<string, unknown>; label: string }> = [
      {
        label: 'projectDelete.id',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(id: $id)
          }
        `,
        variables: { id: projectId },
      },
      {
        label: 'projectDelete.input.id',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(input: { id: $id })
          }
        `,
        variables: { id: projectId },
      },
      {
        label: 'projectDelete.input.projectId',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(input: { projectId: $id })
          }
        `,
        variables: { id: projectId },
      },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<Record<string, unknown>>(gql`${attempt.mutation}`, attempt.variables);
        const accepted = this.isDeleteAccepted(result, 'projectDelete');
        if (!accepted) {
          errors.push(`${attempt.label}: delete mutation returned unsuccessful payload`);
          continue;
        }
        const deleted = await this.waitUntilProjectDeleted(projectId);
        if (deleted) {
          return { success: true };
        }
        errors.push(`${attempt.label}: delete acknowledged but project still exists (${projectId})`);
      } catch (error) {
        errors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }
    return { success: false, error: errors.join(' | ') };
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const attempts: Array<{ mutation: string; variables: Record<string, unknown>; label: string }> = [
      {
        label: 'serviceDelete.id',
        mutation: `
          mutation DeleteService($id: String!) {
            serviceDelete(id: $id)
          }
        `,
        variables: { id: serviceId },
      },
      {
        label: 'serviceDelete.input.id',
        mutation: `
          mutation DeleteService($id: String!) {
            serviceDelete(input: { id: $id })
          }
        `,
        variables: { id: serviceId },
      },
      {
        label: 'serviceDelete.input.serviceId',
        mutation: `
          mutation DeleteService($id: String!) {
            serviceDelete(input: { serviceId: $id })
          }
        `,
        variables: { id: serviceId },
      },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<Record<string, unknown>>(gql`${attempt.mutation}`, attempt.variables);
        const accepted = this.isDeleteAccepted(result, 'serviceDelete');
        if (!accepted) {
          errors.push(`${attempt.label}: delete mutation returned unsuccessful payload`);
          continue;
        }
        const deleted = await this.waitUntilServiceDeleted(serviceId);
        if (deleted) {
          return { success: true };
        }
        errors.push(`${attempt.label}: delete acknowledged but service still exists (${serviceId})`);
      } catch (error) {
        errors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    return { success: false, error: errors.join(' | ') };
  }

  private isDeleteAccepted(payload: Record<string, unknown>, field: 'projectDelete' | 'serviceDelete'): boolean {
    const value = payload[field];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0 && value.toLowerCase() !== 'false';
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if ('success' in record) return Boolean(record.success);
      if ('id' in record) return Boolean(record.id);
      return true;
    }
    return false;
  }

  private async waitUntilProjectDeleted(projectId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const exists = await this.projectExists(projectId);
      if (!exists) return true;
      await this.sleep(500);
    }
    return false;
  }

  private async waitUntilServiceDeleted(serviceId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const exists = await this.serviceExists(serviceId);
      if (!exists) return true;
      await this.sleep(500);
    }
    return false;
  }

  private async projectExists(projectId: string): Promise<boolean> {
    if (!this.client) return true;
    try {
      const query = gql`
        query GetProject($id: String!) {
          project(id: $id) {
            id
          }
        }
      `;
      const result = await this.client.request<{ project: { id: string } | null }>(query, { id: projectId });
      return Boolean(result.project?.id);
    } catch (error) {
      const message = this.describeError(error).toLowerCase();
      if (message.includes('not found')) return false;
      return true;
    }
  }

  private async serviceExists(serviceId: string): Promise<boolean> {
    if (!this.client) return true;
    try {
      const query = gql`
        query GetService($id: String!) {
          service(id: $id) {
            id
          }
        }
      `;
      const result = await this.client.request<{ service: { id: string } | null }>(query, { id: serviceId });
      return Boolean(result.service?.id);
    } catch (error) {
      const message = this.describeError(error).toLowerCase();
      if (message.includes('not found')) return false;
      return true;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private describeRailwayAuthorizationError(error: unknown, projectId: string, type: ComponentType): string {
    const message = this.describeError(error);
    if (!/not authorized/i.test(message)) {
      return message;
    }

    return [
      message,
      `Not authorized to create ${type} on Railway project ${projectId}.`,
      'Use an Account token or a Workspace token with write access to this workspace/project.',
      'If you are using OAuth, ensure project/workspace member scopes were granted.',
      'Then run hv_connect provider="railway" action="verify" again to refresh connection context.',
    ].join(' ');
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<DeployResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId;
    let environmentId = bindings.environmentId;

    if (!projectId) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: 'No Railway project bound to this environment',
        },
      };
    }

    try {
      const railwayEnvId = await this.resolveRailwayEnvironmentId(projectId, environment);
      if (!railwayEnvId) {
        return {
          serviceId: service.id,
          status: 'failed',
          receipt: {
            success: false,
            message: `Railway environment "${environment.name}" not found and could not be created`,
          },
        };
      }

      // Check if service already exists
      let railwayServiceId = await this.resolveServiceIdForProject(
        projectId,
        service.name,
        bindings.services?.[service.name]?.serviceId
      );
      let createdService = false;

      if (!railwayServiceId) {
        // Create service
        const createMutation = gql`
          mutation CreateService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `;

        const createResult = await this.client.request<{ serviceCreate: { id: string; name: string } }>(
          createMutation,
          {
            input: {
              projectId,
              environmentId: railwayEnvId,
              name: service.name,
            },
          }
        );

        railwayServiceId = createResult.serviceCreate.id;
        createdService = true;
      }

      const runtimeConfig = {
        startCommand: service.buildConfig.startCommand,
        releaseCommand: service.buildConfig.releaseCommand,
        healthcheckPath: service.buildConfig.healthCheckPath,
        cronSchedule: service.buildConfig.cronSchedule,
      };
      if (runtimeConfig.startCommand || runtimeConfig.releaseCommand || runtimeConfig.healthcheckPath || runtimeConfig.cronSchedule) {
        const configReceipt = await this.updateServiceInstanceConfig({
          serviceId: railwayServiceId,
          environmentId: railwayEnvId,
          ...runtimeConfig,
        });
        if (!configReceipt.success) {
          return {
            serviceId: service.id,
            externalId: railwayServiceId,
            status: 'failed',
            receipt: {
              success: false,
              message: `Failed to configure ${service.name} before deploy`,
              error: configReceipt.error || configReceipt.message,
            },
          };
        }
      }

      // Auto-wire database and cache connections from Railway plugins
      const pluginVars = await this.getPluginVariableReferences(projectId);
      const allEnvVars = { ...pluginVars, ...envVars }; // User vars override auto-detected

      // Set environment variables (including auto-wired plugin connections)
      if (Object.keys(allEnvVars).length > 0) {
        const envForVarSync: Environment = {
          ...environment,
          platformBindings: {
            ...bindings,
            services: {
              ...(bindings.services ?? {}),
              [service.name]: { serviceId: railwayServiceId },
            },
          },
        };
        await this.setEnvVars(envForVarSync, service, allEnvVars);
      }

      // Trigger redeploy
      const redeployMutation = gql`
        mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }
      `;

      if (railwayEnvId) {
        await this.client.request(redeployMutation, {
          serviceId: railwayServiceId,
          environmentId: railwayEnvId,
        });
      }

      // Public services need a Railway-generated service domain; Railway does
      // not create one automatically (the "Generate Domain" button in its UI).
      let url: string | undefined;
      let domainError: string | undefined;
      if (service.buildConfig.public === true && railwayEnvId) {
        const ensured = await this.ensureServiceDomain(railwayServiceId, railwayEnvId);
        url = ensured.domain ? `https://${ensured.domain}` : undefined;
        domainError = ensured.error;
      }

      return {
        serviceId: service.id,
        externalId: railwayServiceId,
        ...(url ? { url } : {}),
        status: 'deploying',
        receipt: {
          success: true,
          message: `Deployment triggered for ${service.name}`,
          data: {
            railwayServiceId,
            environmentId: railwayEnvId,
            createdService,
            ...(url ? { url } : {}),
            ...(domainError ? { domainError } : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Deployment failed for ${service.name}`,
          error: String(error),
        },
      };
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>
  ): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId;
    let environmentId = bindings.environmentId;

    if (!projectId) {
      return {
        success: false,
        message: 'No Railway project bound to this environment',
      };
    }

    try {
      const railwayServiceId = await this.resolveServiceIdForProject(
        projectId,
        service.name,
        bindings.services?.[service.name]?.serviceId
      );
      if (!railwayServiceId) {
        return {
          success: false,
          message: `Service ${service.name} not found in Railway project ${projectId}`,
        };
      }

      const mutation = gql`
        mutation UpsertVariables($projectId: String!, $serviceId: String!, $environmentId: String!, $variables: EnvironmentVariables!) {
          variableCollectionUpsert(
            input: {
              projectId: $projectId
              serviceId: $serviceId
              environmentId: $environmentId
              variables: $variables
            }
          )
        }
      `;

      environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);

      if (!environmentId) {
        return {
          success: false,
          message: 'No Railway environment ID available for variable update',
        };
      }

      await this.client.request(mutation, {
        projectId: projectId,
        serviceId: railwayServiceId,
        environmentId: environmentId,
        variables: vars,
      });

      return {
        success: true,
        message: `Set ${Object.keys(vars).length} environment variables`,
        data: { variableCount: Object.keys(vars).length },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set environment variables',
        error: String(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      // First attempt: deployment ID lookup (legacy behavior)
      try {
        const deploymentQuery = gql`
          query GetDeployment($id: String!) {
            deployment(id: $id) {
              id
              status
              staticUrl
            }
          }
        `;

        const deploymentResult = await this.client.request<{
          deployment: { id: string; status: string; staticUrl?: string };
        }>(deploymentQuery, { id: deploymentId });

        if (deploymentResult.deployment) {
          return {
            status: this.normalizeStatus(deploymentResult.deployment.status),
            url: deploymentResult.deployment.staticUrl,
          };
        }
      } catch {
        // Fall through to service-based status lookup.
      }

      // Second attempt: treat deploymentId as a service ID (current deploy flow),
      // supporting both connection and array response shapes.
      const serviceQueries = [
        gql`
          query GetServiceStatusConnection($id: String!) {
            service(id: $id) {
              id
              serviceInstances {
                edges {
                  node {
                    latestDeployment {
                      id
                      status
                      staticUrl
                    }
                  }
                }
              }
            }
          }
        `,
        gql`
          query GetServiceStatusDirect($id: String!) {
            service(id: $id) {
              id
              serviceInstances {
                latestDeployment {
                  id
                  status
                  staticUrl
                }
              }
            }
          }
        `,
      ];

      for (const query of serviceQueries) {
        try {
          const serviceResult = await this.client.request<Record<string, unknown>>(query, { id: deploymentId });
          const latestDeployment = this.extractLatestDeployment(serviceResult);
          if (!latestDeployment) {
            continue;
          }
          return {
            status: this.normalizeStatus(latestDeployment.status),
            url: latestDeployment.staticUrl,
          };
        } catch {
          // Try next query shape.
        }
      }

      return { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }

  private extractLatestDeployment(payload: Record<string, unknown>): { status: string; staticUrl?: string } | null {
    const service = payload.service as
      | {
          serviceInstances?:
            | { edges?: Array<{ node?: { latestDeployment?: { status?: string; staticUrl?: string } } }> }
            | Array<{ latestDeployment?: { status?: string; staticUrl?: string } }>;
        }
      | undefined;
    const instances = service?.serviceInstances;
    if (!instances) return null;

    const edges = (instances as { edges?: Array<{ node?: { latestDeployment?: { status?: string; staticUrl?: string } } }> }).edges;
    if (Array.isArray(edges)) {
      const deployment = edges[0]?.node?.latestDeployment;
      if (deployment?.status) {
        return { status: deployment.status, staticUrl: deployment.staticUrl };
      }
    }

    if (Array.isArray(instances)) {
      const deployment = instances[0]?.latestDeployment;
      if (deployment?.status) {
        return { status: deployment.status, staticUrl: deployment.staticUrl };
      }
    }

    return null;
  }

  private normalizeStatus(status: string): string {
    const normalized = status.toUpperCase();
    if (normalized.includes('SUCCESS')) return 'deployed';
    if (normalized.includes('FAIL')) return 'failed';
    if (normalized.includes('CANCEL')) return 'canceled';
    if (normalized.includes('BUILD') || normalized.includes('QUEUED') || normalized.includes('DEPLOY')) {
      return 'deploying';
    }
    return status.toLowerCase();
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult> {
    // Railway doesn't have a direct job API - you'd typically use a cron service
    // This is a placeholder for future implementation
    return {
      jobId: '',
      status: 'failed',
      receipt: {
        success: false,
        message: 'Job execution not yet implemented for Railway',
      },
    };
  }

  /**
   * Execute a one-off command on a service (for migrations, etc.)
   * Uses Railway's execution API to run commands in ephemeral containers
   */
  async executeCommand(
    projectId: string,
    environmentId: string,
    serviceId: string,
    command: string
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      // Railway uses ephemeral containers for one-off commands
      // This creates a temporary instance that runs the command and exits
      const mutation = gql`
        mutation ExecuteCommand($input: ServiceInstanceExecuteCommandInput!) {
          serviceInstanceExecuteCommand(input: $input)
        }
      `;

      const result = await this.client.request<{ serviceInstanceExecuteCommand: string }>(
        mutation,
        {
          input: {
            projectId,
            environmentId,
            serviceId,
            command,
          },
        }
      );

      return {
        success: true,
        output: result.serviceInstanceExecuteCommand,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If the execute API isn't available, provide alternative instructions
      if (errorMsg.includes('Cannot query field') || errorMsg.includes('Unknown field')) {
        return {
          success: false,
          error: `Railway's API does not support one-off command execution for this account. Configure the command as the service's releaseCommand (pre-deploy) in the spec instead: hv_spec_set serviceConfig releaseCommand="${command}".`,
        };
      }

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get the database connection URL from a Railway service
   * Useful for running migrations locally against remote DB
   */
  async getDatabaseUrl(
    projectId: string,
    environmentId: string,
    serviceId: string
  ): Promise<string | null> {
    const vars = await this.getServiceVariables(projectId, serviceId, environmentId);
    return vars['DATABASE_URL'] || vars['DATABASE_PRIVATE_URL'] || null;
  }

  async listProjects(): Promise<RailwayProject[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // The top-level `projects` query spans every workspace the token can
    // access. `me { projects }` only returns personal-account projects, which
    // silently hides workspace/team projects.
    const query = gql`
      query ListProjects($after: String) {
        projects(first: 100, after: $after) {
          edges {
            node {
              id
              name
              description
              createdAt
              updatedAt
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    try {
      const all: RailwayProject[] = [];
      let after: string | null = null;
      do {
        const result: {
          projects: {
            edges: Array<{ node: RailwayProject }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } = await this.client.request(query, { after });
        all.push(...result.projects.edges.map((e) => e.node));
        after = result.projects.pageInfo.hasNextPage ? result.projects.pageInfo.endCursor : null;
      } while (after);
      return all;
    } catch {
      // Fallback for token types that cannot use the top-level projects query.
      const legacyQuery = gql`
        query ListPersonalProjects {
          me {
            projects {
              edges {
                node {
                  id
                  name
                  description
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      `;
      const result = await this.client.request<{
        me: { projects: { edges: Array<{ node: RailwayProject }> } };
      }>(legacyQuery);
      return result.me.projects.edges.map((e) => e.node);
    }
  }

  async getProjectDetails(projectId: string): Promise<RailwayProjectDetails | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      const query = gql`
        query GetProjectDetails($id: String!) {
          project(id: $id) {
            id
            name
            description
            environments {
              edges {
                node {
                  id
                  name
                }
              }
            }
            services {
              edges {
                node {
                  id
                  name
                  icon
                  repoTriggers {
                    edges {
                      node {
                        repository
                        branch
                      }
                    }
                  }
                  serviceInstances {
                    edges {
                      node {
                        environmentId
                        domains {
                          serviceDomains {
                            domain
                          }
                          customDomains {
                            id
                            domain
                            status {
                              verified
                              dnsRecords {
                                currentValue
                                fqdn
                                hostlabel
                                purpose
                                recordType
                                requiredValue
                                status
                                zone
                              }
                              verificationDnsHost
                              verificationToken
                            }
                          }
                        }
                        startCommand
                        healthcheckPath
                        numReplicas
                        sleepApplication
                      }
                    }
                  }
                }
              }
            }
            plugins {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `;

      const result = await this.client.request<{ project: RailwayProjectDetails }>(query, { id: projectId });
      return result.project;
    } catch {
      return null;
    }
  }

  async getServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string
  ): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      return await this.fetchServiceVariables(projectId, serviceId, environmentId);
    } catch {
      return {};
    }
  }

  private async fetchServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string
  ): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetVariables($projectId: String!, $serviceId: String!, $environmentId: String!) {
        variables(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId)
      }
    `;

    const result = await this.client.request<{ variables: Record<string, string> }>(query, {
      projectId,
      serviceId,
      environmentId,
    });
    return result.variables ?? {};
  }

  async updateServiceInstanceConfig(params: {
    serviceId: string;
    environmentId: string;
    startCommand?: string;
    releaseCommand?: string;
    healthcheckPath?: string;
    cronSchedule?: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const input: Record<string, unknown> = {};
    if (params.startCommand) {
      input.startCommand = params.startCommand;
    }
    if (params.releaseCommand) {
      // Railway models the release/predeploy step as preDeployCommand: [String!]
      input.preDeployCommand = [params.releaseCommand];
    }
    if (params.healthcheckPath) {
      input.healthcheckPath = params.healthcheckPath;
    }
    if (params.cronSchedule) {
      input.cronSchedule = params.cronSchedule;
    }

    if (Object.keys(input).length === 0) {
      return {
        success: true,
        message: 'No Railway service instance updates requested',
      };
    }

    const mutation = gql`
      mutation UpdateServiceInstance(
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(
          serviceId: $serviceId
          environmentId: $environmentId
          input: $input
        )
      }
    `;

    try {
      await this.client.request(mutation, {
        serviceId: params.serviceId,
        environmentId: params.environmentId,
        input,
      });
      return {
        success: true,
        message: 'Railway service instance updated',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Railway service instance',
        error: this.describeError(error),
      };
    }
  }

  async connectServiceToRepo(params: {
    serviceId: string;
    repo: string;
    branch: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const mutation = gql`
      mutation ServiceConnect($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) {
          id
        }
      }
    `;

    try {
      await this.client.request(mutation, {
        id: params.serviceId,
        input: {
          repo: params.repo,
          branch: params.branch,
        },
      });

      return {
        success: true,
        message: 'Railway service connected to repository',
        data: {
          repo: params.repo,
          branch: params.branch,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to connect Railway service to repository',
        error: this.describeError(error),
      };
    }
  }

  private normalizeRailwayRecordName(record: RailwayCustomDomainDnsRecord): string | null {
    const fqdn = typeof record.fqdn === 'string' ? record.fqdn.trim().replace(/\.$/, '') : '';
    if (fqdn) {
      return fqdn;
    }

    const hostlabel = typeof record.hostlabel === 'string' ? record.hostlabel.trim() : '';
    const zone = typeof record.zone === 'string' ? record.zone.trim() : '';
    if (!hostlabel && !zone) {
      return null;
    }
    if (hostlabel === '@' || hostlabel.length === 0) {
      return zone || null;
    }
    if (!zone) {
      return hostlabel;
    }
    return `${hostlabel}.${zone}`;
  }

  private extractCustomDomainDnsRecords(status?: RailwayCustomDomainStatus | null): NormalizedDnsRecord[] {
    const records: NormalizedDnsRecord[] = [];

    for (const record of status?.dnsRecords ?? []) {
      const name = this.normalizeRailwayRecordName(record);
      const normalized = normalizeProviderDnsRecord({
        name,
        type: record.recordType,
        value: record.requiredValue,
        currentValue: record.currentValue,
        purpose: record.purpose,
        status: record.status,
      });
      if (!normalized) {
        continue;
      }
      records.push(normalized);
    }

    const verificationHost = status?.verificationDnsHost?.trim().replace(/\.$/, '');
    const verificationToken = status?.verificationToken?.trim();
    if (verificationHost && verificationToken) {
      records.push({
        name: verificationHost,
        type: 'TXT',
        value: verificationToken,
        purpose: 'verification',
      });
    }

    return records;
  }

  async getCustomDomainStatus(params: {
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<RailwayCustomDomain | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetServiceCustomDomains($id: String!) {
        service(id: $id) {
          id
          serviceInstances {
            edges {
              node {
                environmentId
                domains {
                  customDomains {
                    id
                    domain
                    status {
                      verified
                      dnsRecords {
                        currentValue
                        fqdn
                        hostlabel
                        purpose
                        recordType
                        requiredValue
                        status
                        zone
                      }
                      verificationDnsHost
                      verificationToken
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const result = await this.client.request<{
        service?: {
          serviceInstances?: {
            edges?: Array<{
              node?: {
                environmentId?: string;
                domains?: {
                  customDomains?: RailwayCustomDomain[];
                };
              };
            }>;
          };
        };
      }>(query, { id: params.serviceId });

      for (const edge of result.service?.serviceInstances?.edges ?? []) {
        if (edge.node?.environmentId !== params.environmentId) {
          continue;
        }
        const match = edge.node.domains?.customDomains?.find(
          (domain) => domain.domain.toLowerCase() === params.domain.toLowerCase()
        );
        if (match) {
          return match;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (!params.projectId) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: 'Railway custom-domain creation requires the Railway projectId, but no project binding was available. Re-run hv_status or hv_plan to refresh repo bindings, then retry.',
      };
    }

    const existing = await this.getCustomDomainStatus(params);
    if (existing) {
      return {
        success: true,
        message: 'Railway custom domain already attached',
        data: {
          domain: existing.domain,
          customDomainId: existing.id,
          created: false,
          dnsRecords: this.extractCustomDomainDnsRecords(existing.status),
        },
      };
    }

    const mutation = gql`
      mutation CreateCustomDomain($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id
          domain
        }
      }
    `;

    try {
      const result = await this.client.request<{
        customDomainCreate: {
          id: string;
          domain: string;
        };
      }>(mutation, {
        input: {
          projectId: params.projectId,
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      });

      const current = await this.getCustomDomainStatus(params);
      return {
        success: true,
        message: 'Railway custom domain attached',
        data: {
          domain: result.customDomainCreate.domain,
          customDomainId: result.customDomainCreate.id,
          created: true,
          dnsRecords: this.extractCustomDomainDnsRecords(current?.status),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: this.describeError(error),
      };
    }
  }

  /**
   * Return the service's Railway-generated domain for an environment,
   * creating one when none exists. Returns null (with error) on failure
   * rather than throwing, so a domain problem degrades to a missing URL
   * instead of failing the deploy.
   */
  private async ensureServiceDomain(
    serviceId: string,
    environmentId: string
  ): Promise<{ domain: string | null; error?: string }> {
    if (!this.client) {
      return { domain: null, error: 'Not connected. Call connect() first.' };
    }
    try {
      const query = gql`
        query ServiceDomains($serviceId: String!) {
          service(id: $serviceId) {
            serviceInstances {
              edges {
                node {
                  environmentId
                  domains {
                    serviceDomains {
                      domain
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const existing = await this.client.request<{
        service?: {
          serviceInstances?: {
            edges?: Array<{
              node?: {
                environmentId?: string;
                domains?: { serviceDomains?: Array<{ domain?: string }> };
              };
            }>;
          };
        };
      }>(query, { serviceId });
      const instance = existing.service?.serviceInstances?.edges
        ?.map((edge) => edge.node)
        .find((node) => node?.environmentId === environmentId);
      const current = instance?.domains?.serviceDomains?.[0]?.domain;
      if (current) {
        return { domain: current };
      }

      const mutation = gql`
        mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) {
            domain
          }
        }
      `;
      const created = await this.client.request<{ serviceDomainCreate?: { domain?: string } }>(
        mutation,
        { input: { serviceId, environmentId } }
      );
      return { domain: created.serviceDomainCreate?.domain ?? null };
    } catch (error) {
      return { domain: null, error: this.describeError(error) };
    }
  }

  /**
   * Whether Railway's GitHub integration (the Railway GitHub App) can access
   * a repo ("owner/name"). serviceConnect can succeed without this — builds
   * work, but Railway's UI shows "repo not found" and pushes never
   * auto-deploy. Returns null when access could not be determined.
   */
  async isGitHubRepoAccessible(fullRepoName: string): Promise<boolean | null> {
    if (!this.client) return null;
    const query = gql`
      query GitHubRepoAccess($fullRepoName: String!) {
        gitHubRepoAccessAvailable(fullRepoName: $fullRepoName) {
          hasAccess
          isPublic
        }
      }
    `;
    try {
      const result = await this.client.request<{
        gitHubRepoAccessAvailable?: { hasAccess?: boolean; isPublic?: boolean };
      }>(query, { fullRepoName });
      const access = result.gitHubRepoAccessAvailable;
      return typeof access?.hasAccess === 'boolean' ? access.hasAccess : null;
    } catch {
      return null;
    }
  }

  async findProjectByName(name: string): Promise<RailwayProject | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  /**
   * Detect Railway Postgres plugins and return variable references
   * that can be used to auto-wire services to databases
   */
  async getPluginVariableReferences(projectId: string): Promise<Record<string, string>> {
    if (!this.client) {
      return {};
    }

    try {
      const query = gql`
        query GetProjectPlugins($id: String!) {
          project(id: $id) {
            plugins {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `;

      const result = await this.client.request<{
        project: { plugins: { edges: Array<{ node: { id: string; name: string } }> } };
      }>(query, { id: projectId });

      const vars: Record<string, string> = {};

      // Helper to create Railway variable reference syntax: ${{PluginName.VAR}}
      const ref = (pluginName: string, varName: string) => '${{' + pluginName + '.' + varName + '}}';

      for (const edge of result.project.plugins.edges) {
        const pluginName = edge.node.name.toLowerCase();
        const name = edge.node.name;

        // Railway uses variable references like ${{Postgres.DATABASE_URL}}
        // The plugin name in the reference matches how Railway names them
        if (pluginName.includes('postgres') || pluginName === 'postgresql') {
          vars['DATABASE_URL'] = ref(name, 'DATABASE_URL');
          vars['PGHOST'] = ref(name, 'PGHOST');
          vars['PGPORT'] = ref(name, 'PGPORT');
          vars['PGUSER'] = ref(name, 'PGUSER');
          vars['PGPASSWORD'] = ref(name, 'PGPASSWORD');
          vars['PGDATABASE'] = ref(name, 'PGDATABASE');
        }
      }

      return vars;
    } catch {
      return {};
    }
  }

  /**
   * List plugins in a Railway project
   */
  async listPlugins(projectId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetProjectPlugins($id: String!) {
        project(id: $id) {
          plugins {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const result = await this.client.request<{
      project: { plugins: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(query, { id: projectId });

    return result.project.plugins.edges.map((e) => {
      const name = e.node.name.toLowerCase();
      let type = 'unknown';
      if (name.includes('postgres') || name === 'postgresql') type = 'postgres';

      return { id: e.node.id, name: e.node.name, type };
    });
  }

  async getDeployments(
    projectId: string,
    environmentId: string,
    serviceId?: string,
    limit = 10
  ): Promise<RailwayDeployment[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetDeployments($projectId: String!, $environmentId: String!, $serviceId: String, $first: Int) {
        deployments(
          input: {
            projectId: $projectId
            environmentId: $environmentId
            serviceId: $serviceId
          }
          first: $first
        ) {
          edges {
            node {
              id
              status
              createdAt
              staticUrl
            }
          }
        }
      }
    `;

    const result = await this.client.request<{
      deployments: { edges: Array<{ node: RailwayDeployment }> };
    }>(query, { projectId, environmentId, serviceId, first: limit });

    return result.deployments.edges.map((e) => e.node);
  }

  async getDeploymentLogs(
    deploymentId: string,
    limit = 500
  ): Promise<RailwayLogEntry[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetLogs($deploymentId: String!, $limit: Int) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          message
          severity
        }
      }
    `;

    try {
      const result = await this.client.request<{
        deploymentLogs: RailwayLogEntry[];
      }>(query, { deploymentId, limit });
      return result.deploymentLogs ?? [];
    } catch {
      return [];
    }
  }

  async getBuildLogs(deploymentId: string): Promise<string> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetBuildLogs($deploymentId: String!) {
        buildLogs(deploymentId: $deploymentId) {
          timestamp
          message
          severity
        }
      }
    `;

    try {
      const result = await this.client.request<{ buildLogs: RailwayLogEntry[] }>(query, { deploymentId });
      return this.formatRailwayLogEntries(result.buildLogs ?? []);
    } catch {
      return '';
    }
  }

  private formatRailwayLogEntries(logs: RailwayLogEntry[]): string {
    return logs
      .map((log) => [log.timestamp, log.severity, log.message].filter(Boolean).join(' '))
      .filter((line) => line.length > 0)
      .join('\n');
  }

  /**
   * Read back the live state of an environment for spec → observe → diff reconciliation.
   * Never includes raw env var values — only key names and sha256 hashes.
   */
  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const observedAt = new Date().toISOString();
    const warnings: string[] = [];
    let partial = false;

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; source?: { repo?: string; branch?: string } }>;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      return {
        provider: 'railway',
        observedAt,
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      };
    }

    const details = await this.getProjectDetails(projectId);
    if (!details) {
      return {
        provider: 'railway',
        observedAt,
        projectExists: false,
        projectId,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      };
    }

    const projectEnvironments = (details.environments?.edges ?? []).map((e) => e.node);
    let environmentId = bindings.environmentId;
    if (!environmentId || !projectEnvironments.some((env) => env.id === environmentId)) {
      environmentId = projectEnvironments.find(
        (env) => env.name.toLowerCase() === environment.name.toLowerCase()
      )?.id;
    }
    if (!environmentId) {
      warnings.push(`Could not resolve Railway environment for "${environment.name}"`);
      partial = true;
    }

    const services: ObservedService[] = [];
    const databases: ObservedDatabase[] = [];

    for (const edge of details.services?.edges ?? []) {
      const node = edge.node;
      const engine = this.classifyDatastoreEngine(node.name);
      if (engine) {
        databases.push({
          provider: 'railway',
          engine,
          externalId: node.id,
          name: node.name,
          status: 'unknown',
        });
        continue;
      }

      const instanceEdges = node.serviceInstances?.edges ?? [];
      const instance =
        (environmentId
          ? instanceEdges.find((e) => e.node.environmentId === environmentId)
          : instanceEdges[0])?.node ?? instanceEdges[0]?.node;

      const serviceDomain = instance?.domains?.serviceDomains?.[0]?.domain;
      const customDomains = (instance?.domains?.customDomains ?? []).map((d) => d.domain);
      const customDomainStatus = Object.fromEntries(
        (instance?.domains?.customDomains ?? []).map((domain) => {
          const dnsRecords = this.extractCustomDomainDnsRecords(domain.status);
          const dnsConfigured = typeof domain.status?.verified === 'boolean'
            ? domain.status.verified
            : providerDnsRecordsAreConfigured(dnsRecords);
          return [domain.domain, {
            ...(dnsRecords.length > 0 ? { dnsRecords } : {}),
            ...(dnsConfigured !== undefined
              ? { dnsConfigured }
              : {}),
          }];
        })
      );
      const isPublic = Boolean(serviceDomain || customDomains.length > 0);

      let startCommand = instance?.startCommand ?? undefined;
      let releaseCommand: string | undefined;
      let healthCheckPath = instance?.healthcheckPath ?? undefined;
      let cronSchedule: string | undefined;
      let instanceSourceRepo: string | undefined;
      let status: ObservedService['status'] = 'unknown';

      if (environmentId) {
        try {
          const instanceDetails = await this.getServiceInstanceDetails(node.id, environmentId);
          if (instanceDetails) {
            startCommand = instanceDetails.startCommand ?? startCommand;
            releaseCommand = this.normalizePreDeployCommand(instanceDetails.preDeployCommand);
            healthCheckPath = instanceDetails.healthcheckPath ?? healthCheckPath;
            cronSchedule = instanceDetails.cronSchedule ?? undefined;
            instanceSourceRepo = instanceDetails.source?.repo ?? undefined;
            // No deployment at all means the service has no source connected.
            status = instanceDetails.latestDeployment
              ? this.toObservedStatus(instanceDetails.latestDeployment.status)
              : 'empty';
          }
        } catch (error) {
          warnings.push(`Failed to read service instance for "${node.name}": ${this.describeError(error)}`);
          partial = true;
        }
      }

      const envVarKeys: string[] = [];
      const envVarHashes: Record<string, string> = {};
      if (environmentId) {
        try {
          const vars = await this.fetchServiceVariables(projectId, node.id, environmentId);
          for (const [key, value] of Object.entries(vars)) {
            envVarKeys.push(key);
            envVarHashes[key] = hashEnvValue(value);
          }
        } catch (error) {
          warnings.push(`Failed to read variables for "${node.name}": ${this.describeError(error)}`);
          partial = true;
        }
      }

      // serviceConnect sets ServiceInstance.source.repo (per-environment);
      // repoTriggers on the Service is for webhook-configured deploys.
      // Use the instance source as primary, repoTriggers as fallback.
      const repoTrigger = node.repoTriggers?.edges?.[0]?.node;
      const cachedSource = bindings.services?.[node.name]?.source;
      const sourceRepo = instanceSourceRepo ?? repoTrigger?.repository ?? cachedSource?.repo;
      const sourceBranch = repoTrigger?.branch ?? cachedBranchForSource(cachedSource, sourceRepo);

      services.push({
        name: node.name,
        externalId: node.id,
        workloadKind: cronSchedule ? 'cron' : 'web',
        url: serviceDomain ? `https://${serviceDomain}` : undefined,
        customDomains,
        ...(Object.keys(customDomainStatus).length > 0 ? { customDomainStatus } : {}),
        config: {
          startCommand,
          releaseCommand,
          healthCheckPath,
          cronSchedule,
          public: isPublic,
        },
        ...(sourceRepo
          ? { source: { repo: sourceRepo, ...(sourceBranch ? { branch: sourceBranch } : {}) } }
          : {}),
        envVarKeys,
        envVarHashes,
        status,
      });
    }

    for (const edge of details.plugins?.edges ?? []) {
      const node = edge.node;
      databases.push({
        provider: 'railway',
        engine: this.classifyDatastoreEngine(node.name) ?? 'unknown',
        externalId: node.id,
        name: node.name,
        status: 'unknown',
      });
    }

    return {
      provider: 'railway',
      observedAt,
      projectExists: true,
      projectId,
      environmentId,
      services,
      databases,
      partial,
      warnings,
    };
  }

  private async getServiceInstanceDetails(
    serviceId: string,
    environmentId: string
  ): Promise<{
    startCommand?: string;
    preDeployCommand?: unknown;
    healthcheckPath?: string;
    cronSchedule?: string;
    source?: { repo?: string } | null;
    latestDeployment?: { status?: string } | null;
  } | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetServiceInstance($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          startCommand
          preDeployCommand
          healthcheckPath
          cronSchedule
          source {
            repo
          }
          latestDeployment {
            status
          }
        }
      }
    `;

    const result = await this.client.request<{
      serviceInstance?: {
        startCommand?: string;
        preDeployCommand?: unknown;
        healthcheckPath?: string;
        cronSchedule?: string;
        source?: { repo?: string } | null;
        latestDeployment?: { status?: string } | null;
      } | null;
    }>(query, { serviceId, environmentId });
    return result.serviceInstance ?? null;
  }

  /**
   * Railway returns preDeployCommand as a JSON scalar — a list of command
   * strings (we always write a single-element list). Normalize to the
   * spec's single releaseCommand string for drift comparison.
   */
  private normalizePreDeployCommand(value: unknown): string | undefined {
    if (typeof value === 'string') return value || undefined;
    if (Array.isArray(value)) {
      const commands = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
      return commands.length > 0 ? commands.join(' && ') : undefined;
    }
    return undefined;
  }

  /** Same name-based datastore classification used by listPlugins. */
  private classifyDatastoreEngine(name: string): string | null {
    const normalized = name.toLowerCase();
    if (normalized.includes('postgres')) return 'postgres';
    return null;
  }

  private toObservedStatus(status?: string): ObservedService['status'] {
    if (!status) return 'unknown';
    const normalized = status.toUpperCase();
    if (normalized.includes('SUCCESS')) return 'running';
    if (normalized.includes('FAIL') || normalized.includes('CRASH')) return 'failed';
    return 'unknown';
  }
}

export interface RailwayProject {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RailwayServiceInstance {
  environmentId: string;
  domains: {
    serviceDomains: Array<{ domain: string }>;
    customDomains: Array<{ id?: string; domain: string; status?: RailwayCustomDomainStatus | null }>;
  };
  startCommand?: string;
  healthcheckPath?: string;
  numReplicas?: number;
  sleepApplication?: boolean;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  staticUrl?: string;
}

export interface RailwayCustomDomainDnsRecord {
  fqdn?: string;
  hostlabel?: string;
  purpose?: string;
  recordType?: string;
  requiredValue?: string;
  currentValue?: string;
  status?: string;
  zone?: string;
}

export interface RailwayCustomDomainStatus {
  verified?: boolean;
  dnsRecords?: RailwayCustomDomainDnsRecord[];
  verificationDnsHost?: string;
  verificationToken?: string;
}

export interface RailwayCustomDomain {
  id: string;
  domain: string;
  status?: RailwayCustomDomainStatus | null;
}

export interface RailwayLogEntry {
  timestamp: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
}

export interface RailwayProjectDetails {
  id: string;
  name: string;
  description?: string;
  environments: {
    edges: Array<{
      node: {
        id: string;
        name: string;
      };
    }>;
  };
  services: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        icon?: string;
        repoTriggers: {
          edges: Array<{
            node: {
              repository: string;
              branch: string;
            };
          }>;
        };
        serviceInstances: {
          edges: Array<{
            node: RailwayServiceInstance;
          }>;
        };
      };
    }>;
  };
  plugins: {
    edges: Array<{
      node: {
        id: string;
        name: string;
      };
    }>;
  };
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'railway',
    displayName: 'Railway',
    category: 'deployment',
    credentialsSchema: RailwayCredentialsSchema,
    setupHelpUrl: 'https://railway.app/account/tokens',
  },
  factory: (credentials) => {
    const adapter = new RailwayAdapter();
    // Note: Railway's connect is async but we can't await in factory
    // The adapter handles this by checking client state in each method
    adapter.connect(credentials);
    return adapter;
  },
});
