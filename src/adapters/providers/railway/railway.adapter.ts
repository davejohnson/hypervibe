import { GraphQLClient, gql } from 'graphql-request';
import { z } from 'zod';
import type { IProviderAdapter, Receipt, ComponentResult, DeployResult, JobResult } from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const RailwayCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  teamId: z.string().optional(),
});

export type RailwayCredentials = z.infer<typeof RailwayCredentialsSchema>;

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

export class RailwayAdapter implements IProviderAdapter {
  readonly name = 'railway';
  private client: GraphQLClient | null = null;
  private credentials: RailwayCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as RailwayCredentials;
    this.client = new GraphQLClient(RAILWAY_API_URL, {
      headers: {
        Authorization: `Bearer ${this.credentials.apiToken}`,
      },
    });
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
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
        return { success: true, email: result.me.email };
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
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      // Check if we already have a Railway project ID bound
      const bindings = environment.platformBindings as { railwayProjectId?: string };
      if (bindings.railwayProjectId) {
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
            id: bindings.railwayProjectId,
          });
          if (result.project) {
            return {
              success: true,
              message: `Using existing Railway project: ${result.project.name}`,
              data: { projectId: result.project.id, projectName: result.project.name },
            };
          }
        } catch {
          // Project doesn't exist anymore, create new one
        }
      }

      // Create new project
      const mutation = gql`
        mutation CreateProject($name: String!, $teamId: String) {
          projectCreate(input: { name: $name, teamId: $teamId }) {
            id
            name
          }
        }
      `;

      const result = await this.client.request<{ projectCreate: { id: string; name: string } }>(mutation, {
        name: projectName,
        teamId: this.credentials?.teamId,
      });

      return {
        success: true,
        message: `Created Railway project: ${result.projectCreate.name}`,
        data: {
          projectId: result.projectCreate.id,
          projectName: result.projectCreate.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure Railway project',
        error: String(error),
      };
    }
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as { railwayProjectId?: string; railwayEnvironmentId?: string };
    if (!bindings.railwayProjectId) {
      throw new Error('No Railway project bound to this environment');
    }

    try {
      // Create plugin based on type
      let pluginType: string;
      switch (type) {
        case 'postgres':
          pluginType = 'postgresql';
          break;
        case 'redis':
          pluginType = 'redis';
          break;
        case 'mysql':
          pluginType = 'mysql';
          break;
        case 'mongodb':
          pluginType = 'mongodb';
          break;
        default:
          throw new Error(`Unsupported component type: ${type}`);
      }

      const mutation = gql`
        mutation CreatePlugin($projectId: String!, $name: String!) {
          pluginCreate(input: { projectId: $projectId, name: $name }) {
            id
            name
          }
        }
      `;

      const result = await this.client.request<{ pluginCreate: { id: string; name: string } }>(mutation, {
        projectId: bindings.railwayProjectId,
        name: pluginType,
      });

      const component: Component = {
        id: '', // Will be set by repository
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: result.pluginCreate.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created ${type} plugin on Railway`,
          data: { pluginId: result.pluginCreate.id },
        },
      };
    } catch (error) {
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
          error: String(error),
        },
      };
    }
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
      railwayProjectId?: string;
      railwayEnvironmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };

    if (!bindings.railwayProjectId) {
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
            projectId: bindings.railwayProjectId,
            name: service.name,
          }
        );

        railwayServiceId = createResult.serviceCreate.id;
      }

      // Auto-wire database and cache connections from Railway plugins
      const pluginVars = await this.getPluginVariableReferences(bindings.railwayProjectId);
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
      let railwayEnvId = bindings.railwayEnvironmentId;
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
        }>(envQuery, { projectId: bindings.railwayProjectId });

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
          data: { railwayServiceId, railwayEnvironmentId: railwayEnvId },
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
      railwayProjectId?: string;
      railwayEnvironmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };

    if (!bindings.railwayProjectId) {
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

      await this.client.request(mutation, {
        projectId: bindings.railwayProjectId,
        serviceId: railwayServiceId,
        environmentId: bindings.railwayEnvironmentId,
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
      const query = gql`
        query GetDeployment($id: String!) {
          deployment(id: $id) {
            id
            status
            staticUrl
          }
        }
      `;

      const result = await this.client.request<{
        deployment: { id: string; status: string; staticUrl?: string };
      }>(query, { id: deploymentId });

      return {
        status: result.deployment.status,
        url: result.deployment.staticUrl,
      };
    } catch (error) {
      return { status: 'unknown' };
    }
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
