import { GraphQLClient, gql } from 'graphql-request';
import { z } from 'zod';
import type { IProviderAdapter, Receipt, ComponentResult, DeployResult, JobResult, ProviderCapabilities } from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const RailwayCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
});

export type RailwayCredentials = z.infer<typeof RailwayCredentialsSchema>;

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

export class RailwayAdapter implements IProviderAdapter {
  readonly name = 'railway';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['nixpacks', 'dockerfile'],
    supportedComponents: ['postgres', 'redis', 'mysql', 'mongodb'],
    supportsAutoWiring: true,
    supportsHealthChecks: true,
    supportsCronSchedule: true,
    supportsReleaseCommand: false, // Railway uses start commands
    supportsMultiEnvironment: true,
    managedTls: true,
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
      // Check if we already have a project ID bound (check both new and legacy keys)
      const bindings = environment.platformBindings as {
        projectId?: string;
        railwayProjectId?: string;
      };
      const existingProjectId = bindings.projectId || bindings.railwayProjectId;
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
          errors?: Array<{ message?: string }>;
          status?: number;
        };
      };
      const gqlErrors = anyError.response?.errors ?? [];
      if (gqlErrors.length > 0) {
        return gqlErrors
          .map((entry) => entry.message ?? 'Unknown GraphQL error')
          .join('; ');
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
      railwayProjectId?: string;
      environmentId?: string;
      railwayEnvironmentId?: string;
    };
    const projectId = bindings.projectId || bindings.railwayProjectId;
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
      redis: 'redis:7',
      mysql: 'mysql:8',
      mongodb: 'mongo:7',
    };
    const image = imageMap[type];
    if (!image) return null;

    const environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);
    const serviceName = `${type}-db`;
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
    } catch {
      return null;
    }
  }

  private async resolveRailwayEnvironmentId(
    projectId: string,
    environment: Environment
  ): Promise<string | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const bindings = environment.platformBindings as {
      environmentId?: string;
      railwayEnvironmentId?: string;
    };
    let environmentId = bindings.environmentId || bindings.railwayEnvironmentId;
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
      'Then run connection_verify provider=\"railway\" again to refresh connection context.',
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
      railwayProjectId?: string;
      environmentId?: string;
      railwayEnvironmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId || bindings.railwayProjectId;
    let environmentId = bindings.environmentId || bindings.railwayEnvironmentId;

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
      // Check if service already exists
      let railwayServiceId = bindings.services?.[service.name]?.serviceId;
      let createdService = false;

      if (!railwayServiceId) {
        // Create service
        const createMutation = gql`
          mutation CreateService($projectId: String!, $name: String!) {
            serviceCreate(input: { projectId: $projectId, name: $name }) {
              id
              name
            }
          }
        `;

        const createResult = await this.client.request<{ serviceCreate: { id: string; name: string } }>(
          createMutation,
          {
            projectId: projectId,
            name: service.name,
          }
        );

        railwayServiceId = createResult.serviceCreate.id;
        createdService = true;
      }

      // Auto-wire database and cache connections from Railway plugins
      const pluginVars = await this.getPluginVariableReferences(projectId);
      const allEnvVars = { ...pluginVars, ...envVars }; // User vars override auto-detected

      // Set environment variables (including auto-wired plugin connections)
      if (Object.keys(allEnvVars).length > 0) {
        await this.setEnvVars(environment, service, allEnvVars);
      }

      // Trigger redeploy
      const redeployMutation = gql`
        mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }
      `;

      // Get or create environment
      let railwayEnvId = environmentId;
      if (!railwayEnvId) {
        // Use default environment
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

        const envResult = await this.client.request<{
          project: { environments: { edges: Array<{ node: { id: string; name: string } }> } };
        }>(envQuery, { projectId: projectId });

        railwayEnvId = envResult.project.environments.edges[0]?.node.id;
      }

      if (railwayEnvId) {
        await this.client.request(redeployMutation, {
          serviceId: railwayServiceId,
          environmentId: railwayEnvId,
        });
      }

      return {
        serviceId: service.id,
        externalId: railwayServiceId,
        status: 'deploying',
        receipt: {
          success: true,
          message: `Deployment triggered for ${service.name}`,
          data: { railwayServiceId, railwayEnvironmentId: railwayEnvId, createdService },
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
      railwayProjectId?: string;
      environmentId?: string;
      railwayEnvironmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId || bindings.railwayProjectId;
    let environmentId = bindings.environmentId || bindings.railwayEnvironmentId;

    if (!projectId) {
      return {
        success: false,
        message: 'No Railway project bound to this environment',
      };
    }

    try {
      const railwayServiceId = bindings.services?.[service.name]?.serviceId;
      if (!railwayServiceId) {
        return {
          success: false,
          message: `Service ${service.name} not found in Railway bindings`,
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

      if (!environmentId) {
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
        const envResult = await this.client.request<{
          project: { environments: { edges: Array<{ node: { id: string } }> } };
        }>(envQuery, { projectId: projectId });
        environmentId = envResult.project.environments.edges[0]?.node.id;
      }

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
          error: 'Direct command execution not available. Use Railway CLI instead: railway run ' + command,
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

    const query = gql`
      query ListProjects {
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
    }>(query);

    return result.me.projects.edges.map((e) => e.node);
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
                            domain
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
    } catch {
      return {};
    }
  }

  async findProjectByName(name: string): Promise<RailwayProject | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  /**
   * Detect Railway plugins (Postgres, Redis, etc.) and return variable references
   * that can be used to auto-wire services to databases/caches
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
        } else if (pluginName.includes('redis')) {
          vars['REDIS_URL'] = ref(name, 'REDIS_URL');
          vars['REDIS_HOST'] = ref(name, 'REDISHOST');
          vars['REDIS_PORT'] = ref(name, 'REDISPORT');
          vars['REDIS_PASSWORD'] = ref(name, 'REDISPASSWORD');
        } else if (pluginName.includes('mysql')) {
          vars['DATABASE_URL'] = ref(name, 'DATABASE_URL');
          vars['MYSQL_URL'] = ref(name, 'MYSQL_URL');
          vars['MYSQLHOST'] = ref(name, 'MYSQLHOST');
          vars['MYSQLPORT'] = ref(name, 'MYSQLPORT');
          vars['MYSQLUSER'] = ref(name, 'MYSQLUSER');
          vars['MYSQLPASSWORD'] = ref(name, 'MYSQLPASSWORD');
          vars['MYSQLDATABASE'] = ref(name, 'MYSQLDATABASE');
        } else if (pluginName.includes('mongo')) {
          vars['DATABASE_URL'] = ref(name, 'DATABASE_URL');
          vars['MONGO_URL'] = ref(name, 'MONGO_URL');
          vars['MONGOHOST'] = ref(name, 'MONGOHOST');
          vars['MONGOPORT'] = ref(name, 'MONGOPORT');
          vars['MONGOUSER'] = ref(name, 'MONGOUSER');
          vars['MONGOPASSWORD'] = ref(name, 'MONGOPASSWORD');
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
      else if (name.includes('redis')) type = 'redis';
      else if (name.includes('mysql')) type = 'mysql';
      else if (name.includes('mongo')) type = 'mongodb';

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
        buildLogs(deploymentId: $deploymentId)
      }
    `;

    try {
      const result = await this.client.request<{ buildLogs: string }>(query, { deploymentId });
      return result.buildLogs ?? '';
    } catch {
      return '';
    }
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
    customDomains: Array<{ domain: string }>;
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
