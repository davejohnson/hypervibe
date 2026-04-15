import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter, type SendGridCredentials } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { InfraTransaction } from '../domain/services/infra.transaction.js';
import { resolveProject } from './resolve-project.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const DB_PROVIDERS = ['supabase', 'rds', 'cloudsql', 'railway'] as const;

interface GoldenPathPlanItem {
  action: string;
  status: 'ok' | 'needed' | 'blocked';
  detail: string;
}

interface DesiredState {
  environmentName: string;
  serviceName: string;
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  deploy?: {
    strategy?: 'branch' | 'manual';
    branches?: {
      staging?: string;
      production?: string;
    };
  };
  migrations?: {
    mode?: 'none' | 'releaseCommand' | 'tool';
    runInDeploy?: boolean;
    command?: string;
  };
}

export function resolveDesiredState(
  policyState: Partial<DesiredState> | undefined,
  overrides: Partial<DesiredState>
): DesiredState {
  return {
    environmentName: overrides.environmentName ?? policyState?.environmentName ?? 'staging',
    serviceName: overrides.serviceName ?? policyState?.serviceName ?? 'web',
    domain: overrides.domain ?? policyState?.domain,
    databaseProvider: overrides.databaseProvider ?? policyState?.databaseProvider ?? 'supabase',
    setupEmail: overrides.setupEmail ?? policyState?.setupEmail ?? true,
    deploy: overrides.deploy ?? policyState?.deploy,
    migrations: overrides.migrations ?? policyState?.migrations,
  };
}

const deployDesiredSchema = z.object({
  strategy: z.enum(['branch', 'manual']).optional(),
  branches: z
    .object({
      staging: z.string().min(1).optional(),
      production: z.string().min(1).optional(),
    })
    .optional(),
});

const migrationDesiredSchema = z.object({
  mode: z.enum(['none', 'releaseCommand', 'tool']).optional(),
  runInDeploy: z.boolean().optional(),
  command: z.string().min(1).optional(),
});

function buildPlan(params: {
  projectName: string;
  environmentName: string;
  serviceName: string;
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
}): GoldenPathPlanItem[] {
  const project = resolveProject({ projectName: params.projectName });
  const plan: GoldenPathPlanItem[] = [];

  if (!project) {
    plan.push({
      action: 'project_create',
      status: 'needed',
      detail: `Create project "${params.projectName}"`,
    });
  } else {
    plan.push({
      action: 'project_create',
      status: 'ok',
      detail: `Project "${params.projectName}" already exists`,
    });
  }

  const effectiveProject = project ?? projectRepo.findByName(params.projectName) ?? null;
  const scopeHints = effectiveProject ? getProjectScopeHints(effectiveProject) : [];
  const env = effectiveProject ? envRepo.findByProjectAndName(effectiveProject.id, params.environmentName) : null;

  plan.push({
    action: 'env_create',
    status: env ? 'ok' : 'needed',
    detail: env
      ? `Environment "${params.environmentName}" exists`
      : `Create environment "${params.environmentName}"`,
  });

  const service = effectiveProject ? serviceRepo.findByProjectAndName(effectiveProject.id, params.serviceName) : null;
  plan.push({
    action: 'service_create',
    status: service ? 'ok' : 'needed',
    detail: service ? `Service "${params.serviceName}" exists` : `Create service "${params.serviceName}"`,
  });

  const dbConnection = connectionRepo.findBestMatchFromHints(params.databaseProvider, scopeHints);
  plan.push({
    action: 'db_provision',
    status: dbConnection ? 'needed' : 'blocked',
    detail: dbConnection
      ? `Provision postgres on ${params.databaseProvider}`
      : `Missing verified ${params.databaseProvider} connection`,
  });

  const railwayConnection = connectionRepo.findBestMatchFromHints('railway', scopeHints);
  plan.push({
    action: 'deploy',
    status: railwayConnection ? 'needed' : 'blocked',
    detail: railwayConnection ? 'Deploy to Railway' : 'Missing verified Railway connection',
  });

  if (params.domain) {
    const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
    plan.push({
      action: 'dns_configure',
      status: cfConnection ? 'needed' : 'blocked',
      detail: cfConnection
        ? `Configure DNS for ${params.domain}`
        : `Missing verified Cloudflare connection for ${params.domain}`,
    });
  }

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    plan.push({
      action: 'sendgrid_setup',
      status: sgConnection ? 'needed' : 'blocked',
      detail: sgConnection ? 'Sync SendGrid key and domain auth' : 'Missing verified SendGrid connection',
    });
  }

  return plan;
}

export function isProtectedEnvironment(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const protectedEnvs = Array.isArray(project.policies?.protectedEnvironments)
    ? (project.policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

export function infraApprovalsRequiredForEnvironment(
  project: { policies: Record<string, unknown> },
  environmentName: string
): boolean {
  if (!isProtectedEnvironment(project, environmentName)) return false;
  return project.policies?.requireApprovalForProtectedEnvironments !== false;
}

async function executeBootstrap(params: {
  projectName: string;
  environmentName: string;
  serviceName: string;
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
}): Promise<{ success: boolean; summary: Record<string, unknown> }> {
  const tx = new InfraTransaction();
  let project = resolveProject({ projectName: params.projectName });
  if (!project) {
    project = projectRepo.create({ name: params.projectName, defaultPlatform: 'railway' });
    const createdProjectId = project.id;
    tx.addStep({
      id: `project:${createdProjectId}`,
      label: 'project_create',
      resource: { provider: 'hypervibe', type: 'project', id: createdProjectId, name: project.name },
      compensate: async () => ({
        success: projectRepo.delete(createdProjectId),
        message: `Deleted local project ${createdProjectId}`,
      }),
    });
  }

  let environment = envRepo.findByProjectAndName(project.id, params.environmentName);
  if (!environment) {
    environment = envRepo.create({ projectId: project.id, name: params.environmentName });
    const createdEnvironmentId = environment.id;
    tx.addStep({
      id: `environment:${createdEnvironmentId}`,
      label: 'env_create',
      resource: { provider: 'hypervibe', type: 'environment', id: createdEnvironmentId, name: environment.name },
      compensate: async () => ({
        success: envRepo.delete(createdEnvironmentId),
        message: `Deleted local environment ${createdEnvironmentId}`,
      }),
    });
  }

  let service = serviceRepo.findByProjectAndName(project.id, params.serviceName);
  if (!service) {
    service = serviceRepo.create({
      projectId: project.id,
      name: params.serviceName,
      buildConfig: { builder: 'nixpacks' },
    });
    const createdServiceId = service.id;
    tx.addStep({
      id: `service:${createdServiceId}`,
      label: 'service_create',
      resource: { provider: 'hypervibe', type: 'service', id: createdServiceId, name: service.name },
      compensate: async () => ({
        success: serviceRepo.delete(createdServiceId),
        message: `Deleted local service ${createdServiceId}`,
      }),
    });
  }

  const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.databaseProvider, project);
  if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: dbAdapterResult.error || 'Database adapter unavailable',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const dbProvision = await dbAdapterResult.adapter.provision('postgres', environment, {
    databaseName: project.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
  });
  if (!dbProvision.receipt.success) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: dbProvision.receipt.error || dbProvision.receipt.message,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
        debug: {
          phase: 'db_provision',
          provider: params.databaseProvider,
          receiptData: dbProvision.receipt.data ?? null,
        },
      },
    };
  }
  const dbReceiptData = (dbProvision.receipt.data ?? {}) as Record<string, unknown>;
  const provisionProjectId = typeof dbReceiptData.railwayProjectId === 'string' ? dbReceiptData.railwayProjectId : null;
  const provisionCreatedProject = dbReceiptData.ensureProjectCreated === true;
  if (params.databaseProvider === 'railway' && provisionCreatedProject && provisionProjectId) {
    tx.addStep({
      id: `provider-project:${provisionProjectId}`,
      label: 'db_provision_ensure_project',
      resource: {
        provider: 'railway',
        type: 'project',
        id: provisionProjectId,
        name: params.projectName,
      },
      compensate: async () => {
        const hosting = await adapterFactory.getHostingAdapter(project!);
        if (!hosting.success || !hosting.adapter || typeof hosting.adapter.deleteProject !== 'function') {
          return {
            success: false,
            error: `Manual cleanup required: railway project ${provisionProjectId}`,
          };
        }
        const deleted = await hosting.adapter.deleteProject(provisionProjectId);
        return {
          success: deleted.success,
          error: deleted.error,
          message: deleted.success ? `Deleted provider project ${provisionProjectId}` : undefined,
        };
      },
    });
  }
  tx.addStep({
    id: `database:${dbProvision.component.externalId ?? dbProvision.component.id}`,
    label: 'db_provision',
    resource: {
      provider: params.databaseProvider,
      type: dbProvision.component.type,
      id: dbProvision.component.externalId ?? dbProvision.component.id,
      metadata: { environmentId: environment.id },
    },
    compensate: async () => dbAdapterResult.adapter!.destroy(dbProvision.component),
  });

  const existingComponent = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
  if (existingComponent) {
    componentRepo.update(existingComponent.id, {
      bindings: dbProvision.component.bindings,
      externalId: dbProvision.component.externalId ?? undefined,
    });
  } else {
    const createdComponent = componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: dbProvision.component.bindings,
      externalId: dbProvision.component.externalId ?? undefined,
    });
    tx.addStep({
      id: `component:${createdComponent.id}`,
      label: 'component_record_create',
      resource: { provider: 'hypervibe', type: 'component', id: createdComponent.id, name: 'postgres' },
      compensate: async () => ({
        success: componentRepo.delete(createdComponent.id),
        message: `Deleted local component ${createdComponent.id}`,
      }),
    });
  }

  const hostingResult = await adapterFactory.getHostingAdapter(project);
  if (!hostingResult.success || !hostingResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: hostingResult.error || 'Hosting adapter unavailable',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deploy = await orchestrator.execute({
    project,
    environment,
    services: [service],
    envVars: dbProvision.envVars,
    adapter: hostingResult.adapter,
  });

  const summary: Record<string, unknown> = {
    project: project.name,
    environment: environment.name,
    service: service.name,
    deploymentRunId: deploy.run.id,
    deploymentSuccess: deploy.success,
    urls: deploy.urls,
    deploymentCreatedResources: deploy.createdResources,
    deploymentRollback: deploy.rollback,
    transaction: {
      created: tx.listResources(),
    },
    debug: {
      dbProvision: {
        provider: params.databaseProvider,
        receiptData: dbProvision.receipt.data ?? null,
      },
    },
  };

  if (!deploy.success) {
    const cleanup = await tx.rollback();
    summary.rollback = cleanup;
    return {
      success: false,
      summary: {
        ...summary,
        error: deploy.errors.join('; ') || 'Deploy failed',
      },
    };
  }

  const scopeHints = getProjectScopeHints(project);
  const secretStore = getSecretStore();

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    if (sgConnection) {
      const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const receipt = await hostingResult.adapter.setEnvVars(latestEnvironment, service, {
        SENDGRID_API_KEY: sgCreds.apiKey,
      });
      summary.sendgridApiKeySynced = receipt.success;
      if (!receipt.success) {
        summary.sendgridApiKeySyncError = receipt.error || receipt.message;
      }

      if (params.domain) {
        const sgAdapter = new SendGridAdapter();
        sgAdapter.connect(sgCreds);
        const existingDomains = await sgAdapter.listDomainAuthentications();
        const existingAuth = existingDomains.find((d) => d.domain.toLowerCase() === params.domain!.toLowerCase());
        const auth = existingAuth ?? await sgAdapter.createDomainAuthentication(params.domain, { default: false });
        const records = [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname].filter(
          (r): r is NonNullable<typeof r> => Boolean(r)
        );

        const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
        if (cfConnection) {
          const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
          const cfAdapter = new CloudflareAdapter();
          cfAdapter.connect(cfCreds);
          const zone = await cfAdapter.findZoneByName(params.domain);
          if (zone) {
            const dnsResults: Array<{ name: string; type: string; action: string }> = [];
            for (const record of records) {
              const upsert = await cfAdapter.upsertDnsRecord(zone.id, record.host, record.type, record.data, {
                proxied: false,
              });
              dnsResults.push({ name: record.host, type: record.type, action: upsert.action });
            }
            summary.sendgridDnsSynced = true;
            summary.sendgridDnsRecords = dnsResults;
          } else {
            summary.sendgridDnsSynced = false;
            summary.sendgridDnsError = `Cloudflare zone not found for ${params.domain}`;
          }
        } else {
          summary.sendgridDnsSynced = false;
          summary.sendgridDnsError = 'No Cloudflare connection available for domain DNS setup';
        }
      }
    } else {
      summary.sendgridApiKeySynced = false;
      summary.sendgridApiKeySyncError = 'No SendGrid connection found';
    }
  }

  if (params.domain && deploy.urls[0]) {
    try {
      const targetHost = new URL(deploy.urls[0]).hostname;
      const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
      if (cfConnection) {
        const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
        const cfAdapter = new CloudflareAdapter();
        cfAdapter.connect(cfCreds);
        const zone = await cfAdapter.findZoneByName(params.domain);
        if (zone) {
          const result = await cfAdapter.upsertDnsRecord(zone.id, params.domain, 'CNAME', targetHost, { proxied: true });
          summary.domainDnsConfigured = true;
          summary.domainDns = { name: params.domain, type: 'CNAME', target: targetHost, action: result.action };
        }
      }
    } catch {
      summary.domainDnsConfigured = false;
    }
  }

  summary.intent = syncProjectIntent(project.id);
  return { success: deploy.success, summary };
}

export function registerInfraTools(server: McpServer): void {
  server.tool(
    'infra_plan',
    'Generate a desired-state plan (Terraform-style) for Railway + DB + DNS + SendGrid.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Environment (default: staging)'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain for DNS configuration'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup checks (default: true)'),
    },
    async ({
      projectName,
      environmentName = 'staging',
      serviceName = 'web',
      domain,
      databaseProvider = 'supabase',
      setupEmail = true,
    }) => {
      const plan = buildPlan({
        projectName,
        environmentName,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            mode: 'plan',
            projectName,
            environmentName,
            serviceName,
            plan,
            summary: {
              needed: plan.filter((p) => p.status === 'needed').length,
              blocked: plan.filter((p) => p.status === 'blocked').length,
              ok: plan.filter((p) => p.status === 'ok').length,
            },
          }),
        }],
      };
    }
  );

  server.tool(
    'stack_bootstrap',
    'Bootstrap full web stack quickly: project/env/service, DB provisioning, deploy, optional DNS and SendGrid.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Environment (default: staging)'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain to configure'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Configure SendGrid (default: true)'),
      confirm: z.boolean().optional().describe('Set true to apply changes'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({
      projectName,
      environmentName = 'staging',
      serviceName = 'web',
      domain,
      databaseProvider = 'supabase',
      setupEmail = true,
      confirm = false,
      approvalId,
    }) => {
      const previewPlan = buildPlan({
        projectName,
        environmentName,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
      });

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Call again with confirm=true to execute bootstrap.',
              plan: previewPlan,
            }),
          }],
        };
      }

      const existingProject = resolveProject({ projectName });
      if (existingProject && isProtectedEnvironment(existingProject, environmentName)) {
        const requireApprovals = infraApprovalsRequiredForEnvironment(existingProject, environmentName);
        if (requireApprovals) {
          if (!approvalId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Approval required for protected environment "${environmentName}". Create one with approval_request_create and re-run with approvalId.`,
                  requiredAction: 'infra.apply',
                }),
              }],
            };
          }
          const { ApprovalRepository } = await import('../adapters/db/repositories/approval.repository.js');
          const approvalRepo = new ApprovalRepository();
          const validation = approvalRepo.validateForAction(approvalId, existingProject.id, environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${environmentName}" is protected by project policy. Use deploy/rollback tools with explicit production confirm.`,
            }),
          }],
        };
      }

      const executed = await executeBootstrap({
        projectName,
        environmentName,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
      });
      if (!executed.success && executed.summary.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: executed.summary.error,
              summary: executed.summary,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: executed.success,
            ...executed.summary,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_desired_set',
    'Persist desired stack state on project policies for team/repeatable apply flows.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Desired environment (default: staging)'),
      serviceName: z.string().optional().describe('Desired service (default: web)'),
      domain: z.string().optional().describe('Optional desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Desired DB provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup (default: true)'),
      deploy: deployDesiredSchema.optional().describe('Desired deploy strategy and branch mapping'),
      migrations: migrationDesiredSchema.optional().describe('Desired migration behavior during deploy'),
    },
    async ({
      projectName,
      environmentName = 'staging',
      serviceName = 'web',
      domain,
      databaseProvider = 'supabase',
      setupEmail = true,
      deploy,
      migrations,
    }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const desiredState: DesiredState = {
        environmentName,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        deploy,
        migrations,
      };
      const nextPolicies = { ...(project.policies ?? {}), desiredState };
      const updated = projectRepo.update(project.id, { policies: nextPolicies });
      const intent = syncProjectIntent(project.id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: updated?.name ?? project.name,
            desiredState,
            intent,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_desired_get',
    'Read persisted desired stack state for a project.',
    {
      projectName: z.string().describe('Project name'),
    },
    async ({ projectName }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: project.name,
            desiredState: (project.policies?.desiredState as Record<string, unknown> | undefined) ?? null,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_apply',
    'Apply persisted desired state (or explicit state) to create/update provider infrastructure. Use this for new setup and retries; use project_import only to adopt already-existing live projects.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Override desired environment'),
      serviceName: z.string().optional().describe('Override desired service'),
      domain: z.string().optional().describe('Override desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Override desired DB provider'),
      setupEmail: z.boolean().optional().describe('Override desired email setup'),
      deploy: deployDesiredSchema.optional().describe('Override desired deploy strategy and branches'),
      migrations: migrationDesiredSchema.optional().describe('Override desired migration behavior'),
      confirm: z.boolean().optional().describe('Set true to apply'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({ projectName, environmentName, serviceName, domain, databaseProvider, setupEmail, deploy, migrations, confirm = false, approvalId }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const policyState = (project.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const desired = resolveDesiredState(policyState, {
        environmentName,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        deploy,
        migrations,
      });

      const plan = buildPlan({
        projectName,
        environmentName: desired.environmentName,
        serviceName: desired.serviceName,
        domain: desired.domain,
        databaseProvider: desired.databaseProvider,
        setupEmail: desired.setupEmail,
      });

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              desired,
              plan,
              message: 'Call again with confirm=true to apply desired state.',
            }),
          }],
        };
      }

      if (isProtectedEnvironment(project, desired.environmentName)) {
        const requireApprovals = infraApprovalsRequiredForEnvironment(project, desired.environmentName);
        if (requireApprovals) {
          if (!approvalId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Approval required for protected environment "${desired.environmentName}". Create one with approval_request_create and re-run with approvalId.`,
                  requiredAction: 'infra.apply',
                }),
              }],
            };
          }
          const { ApprovalRepository } = await import('../adapters/db/repositories/approval.repository.js');
          const approvalRepo = new ApprovalRepository();
          const validation = approvalRepo.validateForAction(approvalId, project.id, desired.environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${desired.environmentName}" is protected by project policy.`,
            }),
          }],
        };
      }

      const executed = await executeBootstrap({
        projectName,
        environmentName: desired.environmentName,
        serviceName: desired.serviceName,
        domain: desired.domain,
        databaseProvider: desired.databaseProvider,
        setupEmail: desired.setupEmail,
      });
      if (!executed.success && executed.summary.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: executed.summary.error, summary: executed.summary }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: executed.success,
            desired,
            ...executed.summary,
          }),
        }],
      };
    }
  );
}
