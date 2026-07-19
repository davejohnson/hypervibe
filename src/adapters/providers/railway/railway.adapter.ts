import { GraphQLClient, gql } from 'graphql-request';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type {
  IProviderAdapter,
  Receipt,
  ComponentResult,
  DeployResult,
  JobResult,
  ProviderCapabilities,
  DeploymentMutationOptions,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import { githubPackagePullCredentials } from '../github/package-pull.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { hashEnvValue } from '../../../domain/ports/observe.port.js';
import type { ObservedDatabase, ObservedService, ObservedState, ObservedStorage } from '../../../domain/ports/observe.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import {
  buildRailwayGitHubActionsSteps,
  diagnoseRailwayWorkflowLog,
  RAILWAY_CI_REQUIRED_SECRETS,
} from './railway-ci.workflow.js';
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

export const TASK_EXIT_SENTINEL = /__HYPERVIBE_TASK_EXIT:(\d+)__/;
export const TASK_EXIT_SENTINEL_PREFIX = '__HYPERVIBE_TASK_EXIT:';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildTaskStartCommand(command: string): string {
  const inner = `${command}; hv_exit=$?; echo "__HYPERVIBE_TASK_EXIT:\${hv_exit}__"; exit $hv_exit`;
  return `/bin/sh -c ${shellSingleQuote(inner)}`;
}

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

function railwayNamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    || 'default';
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
    supportsOneOffTasks: true,
    supportsDeferredDeploy: true,
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

      let existingByName: RailwayProject[];
      try {
        existingByName = await this.findProjectsByName(projectName);
      } catch (error) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: [
            `Could not check whether Railway project "${projectName}" already exists, so Hypervibe refused to create a new project that might be a duplicate.`,
            this.describeError(error),
          ].join(' '),
        };
      }
      if (existingByName.length === 1) {
        const existing = existingByName[0];
        return {
          success: true,
          message: `Using existing Railway project: ${existing.name}`,
          data: { projectId: existing.id, projectName: existing.name, created: false },
        };
      }
      if (existingByName.length > 1) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: [
            `Multiple Railway projects named "${projectName}" are visible: ${existingByName.map((p) => `${p.name} (${p.id})`).join(', ')}.`,
            'Hypervibe will not create another project or guess which duplicate to manage. Bind/import the intended Railway project id or delete the duplicate, then run hv_plan again.',
          ].join(' '),
          data: {
            projectName,
            duplicateProjectIds: existingByName.map((p) => p.id),
          },
        };
      }

      // Create a new Railway project. Railway GraphQL schema differs across accounts/versions,
      // so try a few compatible mutation shapes before failing.
      let created: { id: string; name: string } | null = null;
      let createError: string | undefined;
      try {
        created = await this.createProject(projectName);
      } catch (error) {
        createError = this.describeError(error);
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
        message: `Created Railway project: ${created.name}`,
        data: {
          projectId: created.id,
          projectName: created.name,
          created: true,
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
    const baseServiceName = `${type}-db`;
    const serviceName = this.railwayServiceNameForEnvironment(baseServiceName, environment.name);
    const serviceResolution = await this.resolveServiceIdForEnvironment(
      projectId,
      this.railwayServiceNameCandidates(baseServiceName, environment.name),
      environmentId
    );
    const existingServiceId = serviceResolution.serviceId;
    const existingServiceName = serviceResolution.serviceName ?? serviceName;
    if (existingServiceId) {
      const ensured = serviceResolution.verifiedInEnvironment
        ? { success: true as const, created: false }
        : await this.ensureServiceInstanceForEnvironment(
          existingServiceId,
          environmentId
        );
      if (!ensured.success) {
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
            message: `Existing ${type} service ${existingServiceName} is missing an instance in Railway environment ${environment.name}`,
            error: ensured.error,
            data: { serviceId: existingServiceId, serviceName: existingServiceName, environmentId },
          },
        };
      }
      // An earlier provisioning attempt may have created this environment's service without
      // its bootstrap variables (the image then crashloops uninitialized).
      // Verify and repair before reusing.
      const repairKinds: string[] = [];
      if (ensured.created) {
        repairKinds.push('Railway environment instance');
      }
      let repaired = ensured.created;
      let needsRedeploy = ensured.created;
      const requiredVar = this.datastoreRequiredVar(type);
      if (requiredVar) {
        let variableReadError: string | undefined;
        const existingVars = await this.fetchServiceVariables(projectId, existingServiceId, environmentId)
          .catch((error) => {
            variableReadError = this.describeError(error);
            return null;
          });
        if (!existingVars) {
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
              message: `Existing ${type} service ${existingServiceName} could not be verified in Railway environment ${environment.name}`,
              error: variableReadError ?? 'Could not read Railway service variables',
            },
          };
        }
        if (existingVars && !existingVars[requiredVar]) {
          const bootstrapVars = this.buildDatastoreBootstrapVars(type, existingServiceName);
          const varsSet = bootstrapVars
            ? await this.upsertServiceVariables(projectId, existingServiceId, environmentId, bootstrapVars)
            : { success: true as const };
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
                message: `Existing ${type} service ${existingServiceName} is missing ${requiredVar} and repair failed`,
                error: varsSet.error,
              },
            };
          }
          repaired = true;
          repairKinds.push('missing bootstrap variables');
          needsRedeploy = true;
        }
      }
      const mountPath = this.datastoreVolumeMountPath(type);
      let volumeId: string | undefined;
      if (ensured.created && mountPath) {
        const volume = await this.attachServiceVolume(projectId, environmentId, existingServiceId, mountPath);
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
              message: `Existing ${type} service ${existingServiceName} was added to ${environment.name} but failed to attach a volume`,
              error: volume.error,
            },
          };
        }
        volumeId = volume.volumeId;
        repaired = true;
        repairKinds.push('persistent volume');
        needsRedeploy = true;
      }
      if (needsRedeploy) {
        const redeploy = await this.redeployDatastoreService(existingServiceId, environmentId);
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
              message: `Existing ${type} service ${existingServiceName} was repaired but failed to redeploy`,
              error: redeploy.error,
            },
          };
        }
      }

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          resourceKind: 'service',
          pluginName: existingServiceName,
          ...(volumeId ? { volumeId } : {}),
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
            ? `Using existing ${type} datastore service (${existingServiceName}); repaired ${repairKinds.join(', ')} and redeployed`
            : `Using existing ${type} datastore service (${existingServiceName})`,
          data: { serviceId: existingServiceId, serviceName: existingServiceName, serviceBacked: true, reused: true, ...(repaired ? { repaired: true } : {}) },
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

      const ensured = await this.ensureServiceInstanceForEnvironment(
        result.serviceCreate.id,
        environmentId
      );
      if (!ensured.success) {
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
            message: `Created ${type} service ${result.serviceCreate.name} but Railway did not expose an instance in ${environment.name}`,
            error: ensured.error,
          },
        };
      }

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
      let volumeId: string | undefined;
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
        volumeId = volume.volumeId;
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
          ...(volumeId ? { volumeId } : {}),
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
  ): Promise<{ success: boolean; error?: string; volumeId?: string }> {
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
      const result = await this.client.request<{ volumeCreate?: { id?: string } }>(mutation, {
        input: { projectId, environmentId, serviceId, mountPath },
      });
      return { success: true, volumeId: result.volumeCreate?.id };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  async deleteVolume(volumeId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const mutation = gql`
      mutation DeleteVolume($volumeId: String!) {
        volumeDelete(volumeId: $volumeId)
      }
    `;
    try {
      const result = await this.client.request<Record<string, unknown>>(mutation, { volumeId });
      const value = result.volumeDelete;
      if (value === false || value === null) {
        return { success: false, error: 'volumeDelete returned unsuccessful payload' };
      }
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

  private railwayServiceNameForEnvironment(baseName: string, environmentName: string): string {
    const base = railwayNamePart(baseName);
    const env = railwayNamePart(environmentName);
    if (env === 'production' || env === 'prod') {
      return base;
    }
    if (base.endsWith(`-${env}`)) {
      return base;
    }
    return `${base}-${env}`.slice(0, 64).replace(/-+$/g, '') || base;
  }

  private railwayServiceNameCandidates(baseName: string, environmentName: string): string[] {
    return Array.from(new Set([
      baseName,
      this.railwayServiceNameForEnvironment(baseName, environmentName),
    ]));
  }

  private boundServiceNameForId(
    services: Record<string, { serviceId?: string; source?: { repo?: string; branch?: string } }> | undefined,
    serviceId: string
  ): string | undefined {
    return Object.entries(services ?? {})
      .find(([, binding]) => binding.serviceId === serviceId)?.[0];
  }

  private hypervibeServiceNameFromRailwayName(providerName: string, environmentName: string): string {
    const env = railwayNamePart(environmentName);
    if (env === 'production' || env === 'prod') {
      return providerName;
    }
    const suffix = `-${env}`;
    return providerName.endsWith(suffix)
      ? providerName.slice(0, -suffix.length) || providerName
      : providerName;
  }

  private async resolveServiceIdForEnvironment(
    projectId: string,
    serviceNames: string | string[],
    environmentId: string,
    boundServiceId?: string
  ): Promise<{ serviceId?: string; serviceName?: string; ignoredBoundServiceId?: string; verifiedInEnvironment?: boolean }> {
    const services = await this.listProjectServices(projectId);
    const names = new Set(Array.isArray(serviceNames) ? serviceNames : [serviceNames]);
    const candidates = [
      ...(boundServiceId && services.some((s) => s.id === boundServiceId) ? [boundServiceId] : []),
      ...services
        .filter((s) => names.has(s.name) && s.id !== boundServiceId)
        .map((s) => s.id),
    ];

    for (const serviceId of candidates) {
      const hasInstance = await this.serviceHasEnvironmentInstance(serviceId, environmentId).catch(() => false);
      if (hasInstance) {
        const serviceName = services.find((s) => s.id === serviceId)?.name;
        return { serviceId, serviceName, verifiedInEnvironment: true };
      }
    }

    return boundServiceId ? { ignoredBoundServiceId: boundServiceId } : {};
  }

  private async serviceHasEnvironmentInstance(
    serviceId: string,
    environmentId: string
  ): Promise<boolean> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetServiceEnvironmentInstance($serviceId: String!) {
        service(id: $serviceId) {
          id
          serviceInstances {
            edges {
              node {
                environmentId
              }
            }
          }
        }
      }
    `;

    const result = await this.client.request<{
      service?: {
        serviceInstances?: {
          edges?: Array<{ node?: { environmentId?: string } }>;
        };
      } | null;
    }>(query, { serviceId });

    return (result.service?.serviceInstances?.edges ?? [])
      .some((edge) => edge.node?.environmentId === environmentId);
  }

  private async ensureServiceInstanceForEnvironment(
    serviceId: string,
    environmentId: string
  ): Promise<{ success: true; created: boolean } | { success: false; error: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      if (await this.serviceHasEnvironmentInstance(serviceId, environmentId)) {
        return { success: true, created: false };
      }

      return {
        success: false,
        error: `Railway service ${serviceId} has no service instance in environment ${environmentId}. Re-run hv_plan/hv_apply so Hypervibe can create or bind an environment-scoped service before deploy/domain/task operations.`,
      };
    } catch (error) {
      return {
        success: false,
        error: this.describeError(error),
      };
    }
  }

  private async listProjectServices(
    projectId: string,
    options?: { throwOnFailure?: boolean }
  ): Promise<Array<{ id: string; name: string }>> {
    const client = this.client;
    if (!client) return [];
    let lastError: unknown;
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
      } catch (error) {
        lastError = error;
        // Try next shape.
      }
    }

    if (options?.throwOnFailure && lastError) {
      throw lastError;
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

    try {
      const mutation = gql`
        mutation DeleteService($id: String!) {
          serviceDelete(id: $id)
        }
      `;
      const result = await this.client.request<Record<string, unknown>>(mutation, { id: serviceId });
      const accepted = this.isDeleteAccepted(result, 'serviceDelete');
      if (!accepted) {
        return { success: false, error: 'serviceDelete.id: delete mutation returned unsuccessful payload' };
      }
      const deleted = await this.waitUntilServiceDeleted(serviceId);
      if (deleted) {
        return { success: true };
      }
      return { success: false, error: `serviceDelete.id: delete acknowledged but service still exists (${serviceId})` };
    } catch (error) {
      return { success: false, error: `serviceDelete.id: ${this.describeError(error)}` };
    }
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
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
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

      // Check if a service is already bound to this Railway environment. A
      // project-level service that only has instances in another environment
      // cannot be deployed here; create a target-environment service instead.
      const providerServiceName = this.railwayServiceNameForEnvironment(service.name, environment.name);
      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        railwayEnvId,
        bindings.services?.[service.name]?.serviceId
      );
      let railwayServiceId = serviceResolution.serviceId;
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
              name: providerServiceName,
            },
          }
        );

        railwayServiceId = createResult.serviceCreate.id;
        createdService = true;
      }

      const ensuredInstance = serviceResolution.verifiedInEnvironment
        ? { success: true as const, created: false }
        : await this.ensureServiceInstanceForEnvironment(
          railwayServiceId,
          railwayEnvId
        );
      if (!ensuredInstance.success) {
        return {
          serviceId: service.id,
          externalId: railwayServiceId,
          status: 'failed',
          receipt: {
            success: false,
            message: `Railway service ${service.name} is missing an instance in environment ${environment.name}`,
            error: ensuredInstance.error,
            data: {
              provider: this.name,
              phase: 'ensureServiceInstance',
              serviceId: railwayServiceId,
              environmentId: railwayEnvId,
            },
          },
        };
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
        const envReceipt = options.deferDeployment
          ? await this.setEnvVars(
            envForVarSync,
            service,
            allEnvVars,
            { deferDeployment: true }
          )
          : await this.setEnvVars(envForVarSync, service, allEnvVars);
        if (!envReceipt.success) {
          return {
            serviceId: service.id,
            externalId: railwayServiceId,
            status: 'failed',
            receipt: {
              success: false,
              message: `Failed to configure environment variables for ${service.name}`,
              error: envReceipt.error ?? envReceipt.message,
              data: {
                provider: this.name,
                phase: 'setEnvVars',
                railwayServiceId,
                environmentId: railwayEnvId,
              },
            },
          };
        }
      }

      // CI-managed branch deploys release an exact SHA after hv_apply. Do not
      // redeploy the previous image merely because its configuration changed.
      if (!options.deferDeployment && railwayEnvId) {
        const redeployMutation = gql`
          mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
            serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
          }
        `;
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
        status: options.deferDeployment ? 'configured' : 'deploying',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared ${service.name} for CI deployment`
            : `Deployment triggered for ${service.name}`,
          data: {
            railwayServiceId,
            environmentId: railwayEnvId,
            createdService,
            ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
            ...(serviceResolution.ignoredBoundServiceId ? { replacedServiceBinding: serviceResolution.ignoredBoundServiceId } : {}),
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
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
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
      environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);

      if (!environmentId) {
        return {
          success: false,
          message: 'No Railway environment ID available for variable update',
        };
      }

      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        environmentId,
        bindings.services?.[service.name]?.serviceId
      );
      const railwayServiceId = serviceResolution.serviceId;
      if (!railwayServiceId) {
        return {
          success: false,
          message: `Service ${service.name} not found in Railway environment ${environment.name}`,
          data: {
            phase: 'resolveService',
            projectId,
            environmentId,
            ...(serviceResolution.ignoredBoundServiceId
              ? { staleBinding: true, ignoredBoundServiceId: serviceResolution.ignoredBoundServiceId }
              : {}),
          },
        };
      }

      const mutation = gql`
        mutation UpsertVariables($projectId: String!, $serviceId: String!, $environmentId: String!, $variables: EnvironmentVariables!, $skipDeploys: Boolean!) {
          variableCollectionUpsert(
            input: {
              projectId: $projectId
              serviceId: $serviceId
              environmentId: $environmentId
              variables: $variables
              skipDeploys: $skipDeploys
            }
          )
        }
      `;

      const ensuredInstance = await this.ensureServiceInstanceForEnvironment(
        railwayServiceId,
        environmentId
      );
      if (!ensuredInstance.success) {
        return {
          success: false,
          message: `Railway service ${service.name} is missing an instance in environment ${environment.name}`,
          error: ensuredInstance.error,
          data: {
            phase: 'ensureServiceInstance',
            serviceId: railwayServiceId,
            environmentId,
          },
        };
      }

      await this.client.request(mutation, {
        projectId: projectId,
        serviceId: railwayServiceId,
        environmentId: environmentId,
        variables: vars,
        skipDeploys: options.deferDeployment === true,
      });

      return {
        success: true,
        message: `Set ${Object.keys(vars).length} environment variables`,
        data: {
          variableCount: Object.keys(vars).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set environment variables',
        error: String(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
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
    if (!projectId) {
      return {
        success: false,
        message: 'No Railway project bound to this environment',
      };
    }

    const uniqueKeys = [...new Set(keys)].sort();
    const invalidKey = uniqueKeys.find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    if (invalidKey) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
        error: `Invalid environment variable name: ${invalidKey}`,
      };
    }
    if (uniqueKeys.length === 0) {
      return {
        success: true,
        message: 'No environment variables were selected for deletion',
        data: { deletedKeys: [], variableCount: 0, redeployMayBeTriggered: false },
      };
    }

    try {
      const environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);
      if (!environmentId) {
        return {
          success: false,
          message: 'No Railway environment ID available for variable deletion',
        };
      }

      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        environmentId,
        bindings.services?.[service.name]?.serviceId
      );
      const railwayServiceId = serviceResolution.serviceId;
      if (!railwayServiceId) {
        return {
          success: false,
          message: `Service ${service.name} not found in Railway environment ${environment.name}`,
        };
      }

      const mutation = gql`
        mutation DeleteVariable($input: VariableDeleteInput!) {
          variableDelete(input: $input)
        }
      `;
      const deletedKeys: string[] = [];
      for (const key of uniqueKeys) {
        try {
          await this.client.request(mutation, {
            input: {
              projectId,
              serviceId: railwayServiceId,
              environmentId,
              name: key,
            },
          });
          deletedKeys.push(key);
        } catch (error) {
          return {
            success: false,
            message: `Deleted ${deletedKeys.length} of ${uniqueKeys.length} environment variables`,
            error: String(error),
            data: {
              deletedKeys,
              failedKey: key,
              variableCount: deletedKeys.length,
              redeployMayBeTriggered: deletedKeys.length > 0,
            },
          };
        }
      }

      return {
        success: true,
        message: `Deleted ${deletedKeys.length} explicitly retired environment variables`,
        data: {
          deletedKeys,
          variableCount: deletedKeys.length,
          // Railway's documented single-variable delete does not expose the
          // skipDeploys option available to variable upserts.
          redeployMayBeTriggered: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
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
    command: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<JobResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const client = this.client;
    const startedAt = Date.now();
    const cleanupWarnings: string[] = [];
    const fail = (message: string, error?: string, data?: Record<string, unknown>): JobResult => ({
      jobId: '',
      status: 'failed',
      runner: 'railway-temp-service',
      durationMs: Date.now() - startedAt,
      ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}),
      receipt: {
        success: false,
        message,
        ...(error ? { error } : {}),
        ...(data ? { data } : {}),
      },
    });

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string }>;
    };
    const projectId = bindings.projectId;
    const environmentId = bindings.environmentId;
    const sourceServiceId = bindings.services?.[service.name]?.serviceId;
    if (!projectId || !environmentId || !sourceServiceId) {
      return fail(
        `Railway environment task requires bindings for service ${service.name}`,
        'Missing Railway project/environment/service bindings. Apply service convergence first.'
      );
    }

    const sweepWarning = await this.sweepTaskServices(projectId);
    if (sweepWarning) {
      cleanupWarnings.push(sweepWarning);
    }

    const ensuredSourceInstance = await this.ensureServiceInstanceForEnvironment(
      sourceServiceId,
      environmentId
    );
    if (!ensuredSourceInstance.success) {
      return fail(
        `Railway environment task requires service ${service.name} in environment ${environment.name}`,
        ensuredSourceInstance.error,
        { phase: 'ensureServiceInstance', serviceId: sourceServiceId, environmentId }
      );
    }

    // Tasks run the deployed image so they execute the same code and deps.
    let image: string | undefined;
    try {
      const result = await client.request<{ serviceInstance?: { source?: { image?: string | null } | null } }>(
        gql`
          query TaskSourceInstance($serviceId: String!, $environmentId: String!) {
            serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
              source {
                image
              }
            }
          }
        `,
        { serviceId: sourceServiceId, environmentId }
      );
      image = result.serviceInstance?.source?.image ?? undefined;
    } catch (error) {
      return fail(
        `Could not read the deployed image for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!image) {
      return fail(
        `Railway environment task requires a deployed image for service ${service.name}`,
        'The service has no image source yet. Deploy it first (push to the deploy branch or hv_ci_trigger), then re-run the task.',
        { pendingDeploy: true }
      );
    }

    let variables: Record<string, string>;
    try {
      const vars = await this.getServiceVariables(projectId, sourceServiceId, environmentId);
      // RAILWAY_* are provider-injected for the SOURCE service; the temp
      // service gets its own set from Railway.
      variables = Object.fromEntries(Object.entries(vars).filter(([key]) => !key.startsWith('RAILWAY_')));
    } catch (error) {
      return fail(
        `Could not read env vars for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const taskName = `hv-task-${Date.now()}`;
    let taskServiceId: string;
    try {
      const created = await client.request<{ serviceCreate: { id: string } }>(
        gql`
          mutation CreateTaskService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `,
        {
          input: {
            projectId,
            environmentId,
            name: taskName,
            ...(Object.keys(variables).length > 0 ? { variables } : {}),
          },
        }
      );
      taskServiceId = created.serviceCreate.id;
    } catch (error) {
      return fail(
        'Could not create the temporary Railway task service',
        error instanceof Error ? error.message : String(error)
      );
    }

    const runTask = async (): Promise<JobResult> => {
      const pull = image.startsWith('ghcr.io/') ? githubPackagePullCredentials() : null;
      // The sentinel is the exit-code source of truth: Railway deployment
      // statuses have no run-to-completion value for a NEVER-restart service.
      const startCommand = buildTaskStartCommand(command);
      await client.request(
        gql`
          mutation ConfigureTaskService(
            $serviceId: String!
            $environmentId: String!
            $input: ServiceInstanceUpdateInput!
          ) {
            serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
          }
        `,
        {
          serviceId: taskServiceId,
          environmentId,
          input: {
            source: { image },
            ...(pull ? { registryCredentials: { username: pull.username, password: pull.token } } : {}),
            startCommand,
            restartPolicyType: 'NEVER',
            restartPolicyMaxRetries: 0,
          },
        }
      );

      const deployResult = await client.request<{ serviceInstanceDeployV2?: string }>(
        gql`
          mutation DeployTaskService($serviceId: String!, $environmentId: String!) {
            serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
          }
        `,
        { serviceId: taskServiceId, environmentId }
      );
      const deploymentId = deployResult.serviceInstanceDeployV2;
      if (!deploymentId) {
        return fail('Railway did not return a deployment id for the task service');
      }

      const timeoutMs = options?.timeoutMs ?? 4 * 60 * 1000;
      const pollIntervalMs = options?.pollIntervalMs ?? 3000;
      const deadline = Date.now() + timeoutMs;
      let exitCode: number | undefined;
      let deployStatus = 'UNKNOWN';
      let logs: RailwayLogEntry[] = [];
      const outputFrom = (entries: RailwayLogEntry[]): string => entries
        .slice(-100)
        .map((entry) => entry.message)
        .filter((message) => !message.includes(TASK_EXIT_SENTINEL_PREFIX))
        .join('\n')
        .slice(-4000);
      for (;;) {
        try {
          const statusResult = await client.request<{ deployment?: { status?: string } }>(
            gql`
              query TaskDeploymentStatus($id: String!) {
                deployment(id: $id) {
                  status
                }
              }
            `,
            { id: deploymentId }
          );
          deployStatus = statusResult.deployment?.status ?? deployStatus;
        } catch {
          // Keep the last known status; transient API errors must not kill the poll.
        }
        try {
          logs = await this.getDeploymentLogs(deploymentId, 500);
        } catch {
          // Logs are unavailable while the image is still building.
        }
        const logText = logs.map((entry) => entry.message).join('\n');
        const match = logText.match(TASK_EXIT_SENTINEL);
        if (match) {
          exitCode = Number(match[1]);
          break;
        }
        if (logText.includes(TASK_EXIT_SENTINEL_PREFIX)) {
          const durationMs = Date.now() - startedAt;
          const output = outputFrom(logs);
          const data = { taskService: taskName, taskServiceId, deploymentId, image, deployStatus };
          return {
            jobId: deploymentId,
            status: 'failed',
            durationMs,
            output,
            runner: 'railway-temp-service',
            ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}),
            receipt: {
              success: false,
              message: 'Railway environment task emitted a malformed exit sentinel',
              error: `Task logs contained ${TASK_EXIT_SENTINEL_PREFIX} but no parseable exit code. This indicates a Hypervibe command-wrapper bug.`,
              data,
            },
          };
        }
        if (deployStatus === 'CRASHED' || deployStatus === 'FAILED') {
          break;
        }
        if (Date.now() >= deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      const durationMs = Date.now() - startedAt;
      const output = outputFrom(logs);
      const data = { taskService: taskName, taskServiceId, deploymentId, image, deployStatus };
      if (exitCode === 0) {
        return {
          jobId: deploymentId,
          status: 'completed',
          exitCode,
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: { success: true, message: `Completed Railway environment task for ${service.name}`, data },
        };
      }
      if (exitCode !== undefined) {
        return {
          jobId: deploymentId,
          status: 'failed',
          exitCode,
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: {
            success: false,
            message: `Railway environment task exited with code ${exitCode}`,
            error: `Command exited with code ${exitCode}. Check the task output.`,
            data,
          },
        };
      }
      if (deployStatus === 'CRASHED' || deployStatus === 'FAILED') {
        return {
          jobId: deploymentId,
          status: 'failed',
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: {
            success: false,
            message: `Railway environment task deployment ended as ${deployStatus} before the command reported an exit code`,
            error: 'The task container failed to start (image pull or boot failure). Check the task output and registry credentials.',
            data,
          },
        };
      }
      return {
        jobId: deploymentId,
        status: 'timeout',
        durationMs,
        output,
        runner: 'railway-temp-service',
        receipt: {
          success: false,
          message: `Railway environment task did not finish within ${Math.round(timeoutMs / 60000)} minute(s)`,
          error: 'No exit sentinel appeared in the task logs before the timeout.',
          data,
        },
      };
    };

    let outcome: JobResult;
    try {
      outcome = await runTask();
    } catch (error) {
      outcome = fail(
        `Railway environment task failed for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      const deleted = await this.deleteService(taskServiceId);
      if (!deleted.success) {
        cleanupWarnings.push(`Temporary task service ${taskName} (${taskServiceId}) could not be deleted: ${deleted.error ?? 'unknown error'}. Delete it in Railway to avoid billing.`);
      }
    } catch (error) {
      cleanupWarnings.push(`Temporary task service ${taskName} (${taskServiceId}) could not be deleted: ${error instanceof Error ? error.message : String(error)}. Delete it in Railway to avoid billing.`);
    }

    return { ...outcome, ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}) };
  }

  private async sweepTaskServices(projectId: string): Promise<string | undefined> {
    try {
      const services = await this.listProjectServices(projectId, { throwOnFailure: true });
      const taskServices = services.filter((service) => service.name.startsWith('hv-task-'));
      const failures: string[] = [];

      for (const service of taskServices) {
        try {
          const deleted = await this.deleteService(service.id);
          if (!deleted.success) {
            failures.push(`${service.name} (${service.id}): ${deleted.error ?? 'unknown error'}`);
          }
        } catch (error) {
          failures.push(`${service.name} (${service.id}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return failures.length > 0
        ? `Could not delete leftover Railway task service(s): ${failures.join('; ')}.`
        : undefined;
    } catch (error) {
      return `Could not inspect leftover Railway task services before run: ${error instanceof Error ? error.message : String(error)}.`;
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
                  config(decryptVariables: false)
                }
              }
            }
            buckets {
              edges { node { id name } }
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

  /**
   * Read-only lookup of a public TCP proxy for a service port. Used by
   * plan-time resolution, which must never mutate live infrastructure.
   */
  async getTcpProxy(
    environmentId: string,
    serviceId: string,
    applicationPort: number
  ): Promise<RailwayTcpProxy | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query TcpProxies($environmentId: String!, $serviceId: String!) {
        tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
          id
          domain
          proxyPort
          applicationPort
        }
      }
    `;

    try {
      const result = await this.client.request<{ tcpProxies?: RailwayTcpProxy[] }>(query, {
        environmentId,
        serviceId,
      });
      return (result.tcpProxies ?? []).find((proxy) => proxy.applicationPort === applicationPort) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure a public TCP proxy exists for a service port (e.g. postgres 5432)
   * so externally-run tools (pg_dump/pg_restore, CI) can reach an otherwise
   * internal-only datastore. Reuses an existing proxy for the same
   * application port when one is present.
   */
  async ensureTcpProxy(
    environmentId: string,
    serviceId: string,
    applicationPort: number
  ): Promise<{ domain: string; proxyPort: number; created: boolean }> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const existing = await this.getTcpProxy(environmentId, serviceId, applicationPort);
    if (existing) {
      return { domain: existing.domain, proxyPort: existing.proxyPort, created: false };
    }

    const mutation = gql`
      mutation TcpProxyCreate($input: TCPProxyCreateInput!) {
        tcpProxyCreate(input: $input) {
          id
          domain
          proxyPort
          applicationPort
        }
      }
    `;

    try {
      const result = await this.client.request<{ tcpProxyCreate?: RailwayTcpProxy }>(mutation, {
        input: { environmentId, serviceId, applicationPort },
      });
      const created = result.tcpProxyCreate;
      if (!created?.domain || typeof created.proxyPort !== 'number') {
        throw new Error('Railway returned an empty tcpProxyCreate payload');
      }
      return { domain: created.domain, proxyPort: created.proxyPort, created: true };
    } catch (error) {
      throw new Error(this.describeError(error));
    }
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

    const ensuredInstance = await this.ensureServiceInstanceForEnvironment(
      params.serviceId,
      params.environmentId
    );
    if (!ensuredInstance.success) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: `Railway service ${params.serviceId} has no service instance in environment ${params.environmentId}: ${ensuredInstance.error}`,
        data: {
          phase: 'ensureServiceInstance',
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
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
    return (await this.findProjectsByName(name))[0] ?? null;
  }

  async findProjectsByName(name: string): Promise<RailwayProject[]> {
    const projects = await this.listProjects();
    const normalized = name.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase() === normalized);
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

  private async getBucketState(projectId: string, environmentId: string): Promise<{
    projectBuckets: Array<{ id: string; name: string }>;
    environmentBuckets: Record<string, { region?: string; isDeleted?: boolean }>;
    unmergedChangesCount: number;
  }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const query = gql`
      query GetBucketState($projectId: String!, $environmentId: String!) {
        project(id: $projectId) {
          buckets { edges { node { id name } } }
          environments { edges { node { id unmergedChangesCount } } }
        }
        environment(id: $environmentId) { config(decryptVariables: false) }
      }
    `;
    const result = await this.client.request<{
      project: {
        buckets?: { edges?: Array<{ node: { id: string; name: string } }> };
        environments?: { edges?: Array<{ node: { id: string; unmergedChangesCount?: number | null } }> };
      };
      environment?: { config?: { buckets?: Record<string, { region?: string; isDeleted?: boolean }> } };
    }>(query, { projectId, environmentId });
    const environmentNode = result.project.environments?.edges?.find((edge) => edge.node.id === environmentId)?.node;
    return {
      projectBuckets: (result.project.buckets?.edges ?? []).map((edge) => edge.node),
      environmentBuckets: result.environment?.config?.buckets ?? {},
      unmergedChangesCount: environmentNode?.unmergedChangesCount ?? 0,
    };
  }

  private async getBucketUsage(bucketId: string, environmentId: string): Promise<{ objectCount?: number; sizeBytes?: number }> {
    if (!this.client) return {};
    const query = gql`
      query BucketUsage($bucketId: String!, $environmentId: String!) {
        bucketInstanceDetails(bucketId: $bucketId, environmentId: $environmentId) { objectCount sizeBytes }
      }
    `;
    try {
      const result = await this.client.request<{ bucketInstanceDetails?: { objectCount?: number; sizeBytes?: number } }>(query, { bucketId, environmentId });
      return result.bucketInstanceDetails ?? {};
    } catch {
      return {};
    }
  }

  private async commitBucketPatch(
    environmentId: string,
    buckets: Record<string, Record<string, unknown>>,
    commitMessage: string
  ): Promise<void> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const mutation = gql`
      mutation CommitBucketPatch($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) {
        environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage)
      }
    `;
    await this.client.request(mutation, { environmentId, patch: { buckets }, commitMessage });
  }

  async ensureStorageContext(
    projectName: string,
    environment: Environment,
    context: { projectId?: string; environmentId?: string } = {}
  ): Promise<Receipt> {
    const virtualEnvironment: Environment = {
      ...environment,
      platformBindings: {
        projectId: context.projectId,
        environmentId: context.environmentId,
        services: {},
      },
    };
    const projectReceipt = await this.ensureProject(projectName, virtualEnvironment);
    if (!projectReceipt.success) return projectReceipt;
    const projectId = typeof projectReceipt.data?.projectId === 'string' ? projectReceipt.data.projectId : context.projectId;
    if (!projectId) return { success: false, message: 'Failed to resolve Railway storage project id' };
    const envId = await this.resolveRailwayEnvironmentId(projectId, {
      ...virtualEnvironment,
      platformBindings: { projectId, environmentId: context.environmentId, services: {} },
    });
    if (!envId) {
      return { success: false, message: `Failed to ensure Railway environment "${environment.name}" for storage` };
    }
    return {
      success: true,
      message: `Railway storage context is ready for ${projectName}/${environment.name}`,
      data: { projectId, environmentId: envId },
    };
  }

  async getStorageCredentials(
    environment: Environment,
    externalId: string
  ): Promise<{ bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; region: string; urlStyle: string }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as { projectId?: string; environmentId?: string };
    if (!bindings.projectId || !bindings.environmentId) throw new Error('Railway storage context is missing');
    const query = gql`
      query BucketCredentials($projectId: String!, $environmentId: String!, $bucketId: String!) {
        bucketS3Credentials(projectId: $projectId, environmentId: $environmentId, bucketId: $bucketId) {
          endpoint accessKeyId secretAccessKey bucketName region urlStyle
        }
      }
    `;
    const result = await this.client.request<{
      bucketS3Credentials: Array<{
        endpoint: string; accessKeyId: string; secretAccessKey: string; bucketName: string; region: string; urlStyle: string;
      }>;
    }>(query, { projectId: bindings.projectId, environmentId: bindings.environmentId, bucketId: externalId });
    const credential = result.bucketS3Credentials?.[0];
    if (!credential) throw new Error('Railway returned no S3 credentials for the bucket');
    return {
      bucket: credential.bucketName,
      endpoint: credential.endpoint,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      region: credential.region,
      urlStyle: credential.urlStyle,
    };
  }

  async ensureStorage(environment: Environment, name: string, options: { region: string }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as { projectId?: string; environmentId?: string };
    if (!bindings.projectId || !bindings.environmentId) {
      return { success: false, message: `Failed to create Railway bucket "${name}"`, error: 'Railway project/environment bindings are missing. Apply project scaffolding first.' };
    }
    try {
      const state = await this.getBucketState(bindings.projectId, bindings.environmentId);
      const existing = state.projectBuckets.find((bucket) => bucket.name.toLowerCase() === name.toLowerCase());
      const existingInstance = existing ? state.environmentBuckets[existing.id] : undefined;
      if (existing && existingInstance && existingInstance.isDeleted !== true) {
        const region = existingInstance.region;
        if (region && region !== options.region) {
          return { success: false, message: `Railway bucket "${name}" has immutable region ${region}`, error: `Requested region ${options.region} requires an explicit data migration and replacement.` };
        }
        return { success: true, message: `Using existing Railway bucket "${name}"`, data: { externalId: existing.id, region: region ?? options.region, created: false } };
      }
      if (state.unmergedChangesCount > 0) {
        return {
          success: false,
          message: `Railway environment has ${state.unmergedChangesCount} unmerged change(s)`,
          error: 'Commit or discard the staged Railway environment changes before Hypervibe creates the bucket, then re-run hv_plan.',
        };
      }
      let bucket = existing;
      if (!bucket) {
        const mutation = gql`
          mutation CreateBucket($input: BucketCreateInput!) {
            bucketCreate(input: $input) { id name projectId }
          }
        `;
        const created = await this.client.request<{ bucketCreate: { id: string; name: string; projectId: string } }>(mutation, {
          input: { projectId: bindings.projectId, name },
        });
        bucket = created.bucketCreate;
      }
      await this.commitBucketPatch(
        bindings.environmentId,
        { [bucket.id]: { region: options.region, isCreated: true, isDeleted: false } },
        `Create bucket ${bucket.name}`
      );
      return { success: true, message: `Created Railway bucket "${bucket.name}" in ${options.region}`, data: { externalId: bucket.id, region: options.region, created: true } };
    } catch (error) {
      return { success: false, message: `Failed to ensure Railway bucket "${name}"`, error: this.describeError(error) };
    }
  }

  async destroyStorage(environment: Environment, externalId: string): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as { projectId?: string; environmentId?: string };
    if (!bindings.projectId || !bindings.environmentId) {
      return { success: false, message: 'Failed to delete Railway bucket', error: 'Railway project/environment bindings are missing.' };
    }
    try {
      const state = await this.getBucketState(bindings.projectId, bindings.environmentId);
      const bucket = state.projectBuckets.find((candidate) => candidate.id === externalId);
      if (!bucket || state.environmentBuckets[externalId]?.isDeleted === true) {
        return { success: true, message: 'Railway bucket is already absent', data: { externalId, deleted: false } };
      }
      if (state.unmergedChangesCount > 0) {
        return {
          success: false,
          message: `Railway environment has ${state.unmergedChangesCount} unmerged change(s)`,
          error: 'Commit or discard the staged Railway environment changes before deleting the bucket, then re-run hv_plan.',
        };
      }
      await this.commitBucketPatch(bindings.environmentId, { [externalId]: { isDeleted: true } }, `Delete bucket ${bucket.name}`);
      return {
        success: true,
        message: `Deleted Railway bucket "${bucket.name}" (Railway permanently deletes it after its recovery window)`,
        data: { externalId, deleted: true },
      };
    } catch (error) {
      return { success: false, message: 'Failed to delete Railway bucket', error: this.describeError(error) };
    }
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
      return {
        provider: 'railway',
        observedAt,
        projectExists: true,
        projectId,
        services: [],
        databases: [],
        partial: false,
        warnings,
      };
    }

    const services: ObservedService[] = [];
    const databases: ObservedDatabase[] = [];
    const storage: ObservedStorage[] = [];

    const environmentConfig = projectEnvironments.find((candidate) => candidate.id === environmentId)?.config;
    for (const edge of details.buckets?.edges ?? []) {
      const instance = environmentConfig?.buckets?.[edge.node.id];
      if (!instance || instance.isDeleted === true) continue;
      const usage = await this.getBucketUsage(edge.node.id, environmentId);
      storage.push({
        provider: 'railway',
        kind: 'object',
        externalId: edge.node.id,
        name: edge.node.name,
        region: instance.region,
        status: 'ready',
        ...usage,
      });
    }

    for (const edge of details.services?.edges ?? []) {
      const node = edge.node;
      const instanceEdges = node.serviceInstances?.edges ?? [];
      const instance = instanceEdges.find((e) => e.node.environmentId === environmentId)?.node;
      if (!instance) {
        continue;
      }

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

      const observedServiceName = this.boundServiceNameForId(bindings.services, node.id)
        ?? this.hypervibeServiceNameFromRailwayName(node.name, environment.name);

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
          warnings.push(`Failed to read service instance for "${observedServiceName}" (${node.name}): ${this.describeError(error)}`);
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
          warnings.push(`Failed to read variables for "${observedServiceName}" (${node.name}): ${this.describeError(error)}`);
          partial = true;
        }
      }

      // serviceConnect sets ServiceInstance.source.repo (per-environment);
      // repoTriggers on the Service is for webhook-configured deploys.
      // Use the instance source as primary, repoTriggers as fallback.
      const repoTrigger = node.repoTriggers?.edges?.[0]?.node;
      const cachedSource = bindings.services?.[observedServiceName]?.source;
      const sourceRepo = instanceSourceRepo ?? repoTrigger?.repository ?? cachedSource?.repo;
      const sourceBranch = repoTrigger?.branch ?? cachedBranchForSource(cachedSource, sourceRepo);

      services.push({
        name: observedServiceName,
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
      storage,
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

export interface RailwayTcpProxy {
  id: string;
  domain: string;
  proxyPort: number;
  applicationPort: number;
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
        config?: { buckets?: Record<string, { region?: string; isDeleted?: boolean }> };
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
  buckets?: {
    edges: Array<{ node: { id: string; name: string } }>;
  };
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'railway',
    displayName: 'Railway',
    category: 'deployment',
    credentialsSchema: RailwayCredentialsSchema,
    setupHelpUrl: 'https://railway.com/account/tokens',
    credentials: {
      defaultScalarKey: 'apiToken',
    },
    orchestration: {
      project: {
        shareAcrossEnvironments: true,
      },
      diff: {
        requiresBranchDeployForCode: true,
        workloadKindObservation: 'cron-only',
        presenceOnlyManagedEnvVar: ({ value }) => /^\$\{\{[^}]+\}\}$/.test(value),
      },
      logs: {
        runtime: true,
        deployments: true,
        build: true,
      },
      ci: {
        displayName: 'Railway',
        requiredSecrets: RAILWAY_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          RAILWAY_API_TOKEN: 'apiToken',
        },
        requiresGitHubPackagePull: true,
        buildGitHubActionsSteps: buildRailwayGitHubActionsSteps,
        diagnoseWorkflowLog: diagnoseRailwayWorkflowLog,
      },
      nativeBranchDeploy: {
        needsGitHubAppAccess: true,
        githubAppInstallUrl: 'https://github.com/apps/railway-app/installations/new',
      },
    },
  },
  factory: (credentials) => {
    const adapter = new RailwayAdapter();
    // Note: Railway's connect is async but we can't await in factory
    // The adapter handles this by checking client state in each method
    adapter.connect(credentials);
    return adapter;
  },
});
