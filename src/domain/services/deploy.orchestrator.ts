import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../entities/service.entity.js';
import type { Run, RunPlan, RunStep, RunReceipt } from '../entities/run.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter, HostingBindings } from '../ports/hosting.port.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { SecretMappingRepository } from '../../adapters/db/repositories/secret-mapping.repository.js';
import { SecretResolver } from './secret.resolver.js';
import { InfraTransaction, type InfraTransactionRollbackResult } from './infra.transaction.js';
import { snapshotEnvironmentBindings } from './local-state.transaction.js';

export interface DeployOptions {
  project: Project;
  environment: Environment;
  services?: Service[];
  envVars?: Record<string, string>;
  verifyHttpHealth?: boolean;
  /** The hosting adapter to use for deployment (can be IProviderAdapter or IHostingAdapter) */
  adapter: IProviderAdapter | IHostingAdapter;
}

export interface DeployResult {
  run: Run;
  success: boolean;
  urls: string[];
  serviceUrls: Record<string, string>;
  primaryUrl?: string;
  errors: string[];
  createdResources?: Array<{ provider: string; type: string; id?: string; name?: string; metadata?: Record<string, unknown> }>;
  rollback?: InfraTransactionRollbackResult;
}

interface HttpHealthResult {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
}

/**
 * Imperative deploy engine. This is the escape hatch OUTSIDE the
 * spec -> plan -> apply loop: hv_deploy and hv_rollback drive it directly,
 * and executeBootstrap (the hv_apply converge pass) delegates the actual
 * service deploys to it. It builds its own RunPlan and does not consult
 * spec revisions — model durable infrastructure changes in the spec and
 * reconcile via hv_plan/hv_apply instead of adding steps here.
 */
export class DeployOrchestrator {
  private runRepo = new RunRepository();
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private auditRepo = new AuditRepository();
  private mappingRepo = new SecretMappingRepository();
  private secretResolver = new SecretResolver();

  buildPlan(options: DeployOptions): RunPlan {
    const steps: RunStep[] = [];

    // Step 1: Ensure project exists on provider
    steps.push({
      name: 'ensure_project',
      action: 'ensureProject',
      target: options.project.name,
      params: { projectId: options.project.id },
    });

    // Step 2: Resolve secrets from secret managers
    // Check if there are any secret mappings for this project/environment
    const mappings = this.mappingRepo.findByProjectAndEnvironment(
      options.project.id,
      options.environment.name
    );
    if (mappings.length > 0) {
      steps.push({
        name: 'resolve_secrets',
        action: 'resolveSecrets',
        params: {
          projectId: options.project.id,
          environmentName: options.environment.name,
          mappingCount: mappings.length,
        },
      });
    }

    // Step 3: Set environment variables if provided. Only key NAMES go into
    // the persisted plan — runs.plan is returned verbatim by hv_runs, so
    // values (which include DATABASE_URL and resolved secrets) must never
    // be stored. The step reads the live options.envVars at execution time.
    if (options.envVars && Object.keys(options.envVars).length > 0) {
      steps.push({
        name: 'set_env_vars',
        action: 'setEnvVars',
        params: { envVarKeys: Object.keys(options.envVars).sort() },
      });
    }

    // Step 4: Deploy each workload. Services remain the storage primitive, but
    // workloadKind drives provider behavior and plan semantics.
    const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);
    for (const service of services) {
      const workloadKind = serviceWorkloadKind(service);
      const isCron = workloadKind === 'cron';
      steps.push({
        name: `${isCron ? 'deploy_cron' : 'deploy'}_${service.name}`,
        action: isCron ? 'deployCron' : 'deploy',
        target: service.name,
        params: { serviceId: service.id, workloadKind },
      });
    }

    // Step 5: Verify health
    steps.push({
      name: 'verify_health',
      action: 'verifyHealth',
    });

    return {
      steps,
      metadata: {
        projectId: options.project.id,
        environmentId: options.environment.id,
        serviceCount: services.length,
      },
    };
  }

  async execute(options: DeployOptions): Promise<DeployResult> {
    const plan = this.buildPlan(options);
    const urls: string[] = [];
    const serviceUrls: Record<string, string> = {};
    const errors: string[] = [];
    const tx = new InfraTransaction();

    // Create run record
    const run = this.runRepo.create({
      projectId: options.project.id,
      environmentId: options.environment.id,
      type: 'deploy',
      plan,
    });

    // Start run
    this.runRepo.updateStatus(run.id, 'running');

    this.auditRepo.create({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: run.id,
      details: {
        projectId: options.project.id,
        environmentId: options.environment.id,
      },
    });

    try {
      for (const step of plan.steps) {
        const receipt = await this.executeStep(step, options, tx);
        this.runRepo.addReceipt(run.id, receipt);

        if (receipt.status === 'failure') {
          errors.push(receipt.error ?? `Step ${step.name} failed`);
          // Continue with other steps even if one fails
        }

        if (receipt.result?.url) {
          const url = receipt.result.url as string;
          urls.push(url);
          if (typeof receipt.result.service === 'string') {
            serviceUrls[receipt.result.service] = url;
          }
        }
      }

      const hasErrors = errors.length > 0;
      let rollback: InfraTransactionRollbackResult | undefined;
      if (hasErrors) {
        rollback = await tx.rollback();
      }
      this.runRepo.updateStatus(
        run.id,
        hasErrors ? 'failed' : 'succeeded',
        hasErrors ? errors.join('; ') : undefined
      );

      this.auditRepo.create({
        action: hasErrors ? 'deploy.failed' : 'deploy.succeeded',
        resourceType: 'run',
        resourceId: run.id,
        details: { urls, errors },
      });

      return {
        run: this.runRepo.findById(run.id)!,
        success: !hasErrors,
        urls,
        serviceUrls,
        primaryUrl: urls[0],
        errors,
        createdResources: tx.listResources(),
        rollback,
      };
    } catch (error) {
      const rollback = await tx.rollback();
      this.runRepo.updateStatus(run.id, 'failed', String(error));

      this.auditRepo.create({
        action: 'deploy.failed',
        resourceType: 'run',
        resourceId: run.id,
        details: { error: String(error) },
      });

      return {
        run: this.runRepo.findById(run.id)!,
        success: false,
        urls,
        serviceUrls,
        primaryUrl: urls[0],
        errors: [...errors, String(error)],
        createdResources: tx.listResources(),
        rollback,
      };
    }
  }

  private async executeStep(step: RunStep, options: DeployOptions, tx: InfraTransaction): Promise<RunReceipt> {
    const timestamp = new Date().toISOString();

    try {
      switch (step.action) {
        case 'ensureProject': {
          const receipt = await options.adapter.ensureProject(
            options.project.name,
            options.environment
          );

          // Update environment bindings if we got a project ID
          // Use platform-agnostic keys that work with any hosting provider
          if (receipt.success && receipt.data?.projectId) {
            const currentEnvironment = this.envRepo.findById(options.environment.id) ?? options.environment;
            const currentBindings = currentEnvironment.platformBindings as Partial<HostingBindings>;
            const nextProjectId = receipt.data.projectId as string;
            const projectChanged = Boolean(currentBindings.projectId && currentBindings.projectId !== nextProjectId);
            const bindings: Partial<HostingBindings> = {
              provider: options.adapter.name,
              projectId: nextProjectId,
            };

            // Also store environment ID if provided
            if (receipt.data.environmentId) {
              bindings.environmentId = receipt.data.environmentId as string;
            }
            // If provider project was recreated/switched, drop stale service/environment bindings.
            if (projectChanged || receipt.data?.created === true) {
              bindings.services = undefined;
              if (!receipt.data.environmentId) {
                bindings.environmentId = undefined;
              }
            }

            snapshotEnvironmentBindings({
              tx,
              envRepo: this.envRepo,
              environmentId: options.environment.id,
              label: 'environment_bindings_ensure_project',
            });
            this.envRepo.updatePlatformBindings(options.environment.id, bindings);
            const refreshed = this.envRepo.findById(options.environment.id);
            if (refreshed) {
              options.environment = refreshed;
            }

            if (receipt.data?.created === true) {
              const createdProjectId = receipt.data.projectId as string;
              tx.addStep({
                id: `provider-project:${createdProjectId}`,
                label: 'ensure_project',
                resource: {
                  provider: options.adapter.name,
                  type: 'project',
                  id: createdProjectId,
                  name: (receipt.data.projectName as string | undefined) ?? options.project.name,
                },
                compensate: async () => {
                  const adapterWithDelete = options.adapter as (IProviderAdapter | IHostingAdapter) & {
                    deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
                  };
                  if (typeof adapterWithDelete.deleteProject !== 'function') {
                    return {
                      success: false,
                      error: `Manual cleanup required: ${options.adapter.name} project ${createdProjectId}`,
                    };
                  }
                  const result = await adapterWithDelete.deleteProject(createdProjectId);
                  return {
                    success: result.success,
                    error: result.error,
                    message: result.success ? `Deleted provider project ${createdProjectId}` : undefined,
                  };
                },
              });
            }
          }

          return {
            step: step.name,
            status: receipt.success ? 'success' : 'failure',
            result: receipt.data,
            error: receipt.error,
            timestamp,
          };
        }

        case 'resolveSecrets': {
          // Resolve secret references from secret managers
          const resolved = await this.secretResolver.resolveForEnvironment({
            projectId: step.params?.projectId as string,
            environmentName: step.params?.environmentName as string,
          });

          if (resolved.failed > 0 && resolved.resolved === 0) {
            // All secrets failed - this is a deployment blocker
            return {
              step: step.name,
              status: 'failure',
              error: `Failed to resolve secrets: ${resolved.errors.map((e) => `${e.envVar}: ${e.error}`).join('; ')}`,
              result: { resolved: resolved.resolved, failed: resolved.failed },
              timestamp,
            };
          }

          // Merge resolved secrets into envVars for subsequent steps
          Object.assign(options.envVars ?? {}, resolved.vars);
          if (!options.envVars) {
            options.envVars = resolved.vars;
          }

          return {
            step: step.name,
            // Mark as success even with partial failures - individual errors are logged
            status: 'success',
            result: {
              resolved: resolved.resolved,
              failed: resolved.failed,
              errors: resolved.errors,
            },
            timestamp,
          };
        }

        case 'setEnvVars': {
          const vars = options.envVars ?? {};
          if (Object.keys(vars).length === 0) {
            return {
              step: step.name,
              status: 'skipped',
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const bindings = environment.platformBindings as Partial<HostingBindings>;
          const boundServices = bindings.services ?? {};
          const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);
          const alreadyDeployed = services.filter((s) => Boolean(boundServices[s.name]?.serviceId));

          if (alreadyDeployed.length === 0) {
            return {
              step: step.name,
              status: 'skipped',
              result: { reason: 'No existing deployed services to pre-sync env vars' },
              timestamp,
            };
          }

          const failures: string[] = [];
          const skippedStaleBindings: string[] = [];
          for (const service of alreadyDeployed) {
            const receipt = await options.adapter.setEnvVars(environment, service, vars);
            if (!receipt.success) {
              if ((receipt.data as Record<string, unknown> | undefined)?.staleBinding === true) {
                skippedStaleBindings.push(service.name);
                continue;
              }
              failures.push(`${service.name}: ${receipt.error ?? receipt.message}`);
            }
          }

          return {
            step: step.name,
            status: failures.length > 0 ? 'failure' : 'success',
            result: {
              serviceCount: alreadyDeployed.length,
              variableCount: Object.keys(vars).length,
              ...(skippedStaleBindings.length > 0 ? { skippedStaleBindings } : {}),
            },
            error: failures.length > 0 ? failures.join('; ') : undefined,
            timestamp,
          };
        }

        case 'deploy':
        case 'deployCron': {
          const service = this.serviceRepo.findById(step.params?.serviceId as string);
          if (!service) {
            return {
              step: step.name,
              status: 'failure',
              error: `Service not found: ${step.params?.serviceId}`,
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const result = await options.adapter.deploy(
            service,
            environment,
            options.envVars ?? {}
          );

          // Update environment bindings with service info using platform-agnostic structure
          if (result.externalId) {
            const latestEnvironment = this.envRepo.findById(options.environment.id) ?? environment;
            const currentBindings = latestEnvironment.platformBindings as Partial<HostingBindings>;
            const services = currentBindings.services ?? {};
            const existingServiceBinding = services[service.name] ?? {};
            services[service.name] = {
              ...existingServiceBinding,
              serviceId: result.externalId,
              url: result.url ?? existingServiceBinding.url,
              workloadKind: serviceWorkloadKind(service),
            };
            const deployData = (result.receipt.data ?? {}) as Record<string, unknown>;
            if (typeof deployData.imageUri === 'string') {
              services[service.name].imageUri = deployData.imageUri;
            }
            for (const key of ['resourceType', 'jobName', 'schedulerJobName'] as const) {
              if (typeof deployData[key] === 'string') {
                services[service.name][key] = deployData[key];
              }
            }
            const resolvedEnvironmentId = typeof deployData.environmentId === 'string'
              ? deployData.environmentId
              : undefined;
            const bindingUpdates: Partial<HostingBindings> = {
              provider: options.adapter.name,
              services,
            };
            if (resolvedEnvironmentId) {
              bindingUpdates.environmentId = resolvedEnvironmentId;
            }
            snapshotEnvironmentBindings({
              tx,
              envRepo: this.envRepo,
              environmentId: options.environment.id,
              label: `environment_bindings_deploy_${service.name}`,
            });
            this.envRepo.updatePlatformBindings(options.environment.id, bindingUpdates);

            const createdService = result.receipt.data?.createdService === true || result.receipt.data?.created === true;
            if (createdService) {
              const createdServiceId = result.externalId;
              tx.addStep({
                id: `provider-service:${createdServiceId}`,
                label: `deploy_${service.name}`,
                resource: {
                  provider: options.adapter.name,
                  type: 'service',
                  id: createdServiceId,
                  name: service.name,
                },
                compensate: async () => {
                  const adapterWithDelete = options.adapter as (IProviderAdapter | IHostingAdapter) & {
                    deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string }>;
                  };
                  if (typeof adapterWithDelete.deleteService !== 'function') {
                    return {
                      success: false,
                      error: `Manual cleanup required: ${options.adapter.name} service ${createdServiceId}`,
                    };
                  }
                  const deleted = await adapterWithDelete.deleteService(createdServiceId);
                  return {
                    success: deleted.success,
                    error: deleted.error,
                    message: deleted.success ? `Deleted provider service ${createdServiceId}` : undefined,
                  };
                },
              });
            }
          }

          return {
            step: step.name,
            status: result.receipt.success ? 'success' : 'failure',
            result: { service: service.name, url: result.url, publicUrl: result.url, externalId: result.externalId },
            error: result.receipt.error,
            timestamp,
          };
        }

        case 'verifyHealth': {
          if (typeof options.adapter.getDeployStatus !== 'function') {
            return {
              step: step.name,
              status: 'skipped',
              result: { reason: 'Provider does not support deploy status checks' },
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const bindings = environment.platformBindings as Partial<HostingBindings>;
          const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);

          const failures: string[] = [];
          const pending: string[] = [];
          const health: Array<{ service: string; status: string; url?: string; http?: HttpHealthResult }> = [];

          for (const service of services) {
            const serviceBinding = bindings.services?.[service.name];
            const deployTarget = serviceBinding?.serviceId;
            if (!deployTarget) {
              continue;
            }

            const check = await this.waitForHealthyDeployment(options, environment, deployTarget);
            const url = check.url ?? serviceBinding?.url;
            const entry: { service: string; status: string; url?: string; http?: HttpHealthResult } = {
              service: service.name,
              status: check.status,
              url,
            };

            if (check.status === 'failed' || check.status === 'canceled' || check.status === 'cancelled') {
              failures.push(`${service.name}: status=${check.status}`);
            } else if (check.status !== 'deployed') {
              pending.push(`${service.name}: status=${check.status}`);
            } else if (options.verifyHttpHealth === true && serviceWorkloadKind(service) === 'web' && service.buildConfig.healthCheckPath) {
              if (!url) {
                pending.push(`${service.name}: deployed but no URL is available for ${service.buildConfig.healthCheckPath}`);
              } else {
                const http = await this.checkHttpHealth(url, service.buildConfig.healthCheckPath);
                entry.http = http;
                if (!http.ok) {
                  const detail = http.status ? `HTTP ${http.status}` : http.error ?? 'request failed';
                  failures.push(`${service.name}: ${detail} at ${http.url}`);
                }
              }
            }
            health.push(entry);
          }

          const warning = pending.length > 0
            ? `Health check inconclusive for ${pending.join(', ')}`
            : undefined;

          return {
            step: step.name,
            status: failures.length > 0 ? 'failure' : 'success',
            result: { services: health, warning },
            error: failures.length > 0
              ? `Health check failed for ${failures.join(', ')}`
              : undefined,
            timestamp,
          };
        }

        default:
          return {
            step: step.name,
            status: 'skipped',
            error: `Unknown action: ${step.action}`,
            timestamp,
          };
      }
    } catch (error) {
      return {
        step: step.name,
        status: 'failure',
        error: String(error),
        timestamp,
      };
    }
  }

  private async waitForHealthyDeployment(
    options: DeployOptions,
    environment: Environment,
    deployTarget: string
  ): Promise<{ status: string; url?: string | undefined }> {
    if (typeof options.adapter.getDeployStatus !== 'function') {
      return { status: 'unknown' };
    }

    const maxAttempts = 8;
    const pollDelayMs = 2000;
    let last: { status: string; url?: string | undefined } = { status: 'unknown', url: undefined };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await options.adapter.getDeployStatus(environment, deployTarget);

      if (last.status === 'deployed') {
        return last;
      }
      if (last.status === 'failed' || last.status === 'canceled' || last.status === 'cancelled') {
        return last;
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }

    return last;
  }

  private buildHealthUrl(baseUrl: string, healthCheckPath: string): string {
    const path = healthCheckPath.trim() || '/';
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(path, normalizedBase).toString();
  }

  private async checkHttpHealth(baseUrl: string, healthCheckPath: string): Promise<HttpHealthResult> {
    let url: string;
    try {
      url = this.buildHealthUrl(baseUrl, healthCheckPath);
    } catch (error) {
      return {
        ok: false,
        url: `${baseUrl}${healthCheckPath}`,
        error: `Invalid health check URL: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.ok) {
        return { ok: true, url, status: response.status };
      }
      const body = await response.text().catch(() => '');
      const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 200);
      return {
        ok: false,
        url,
        status: response.status,
        ...(excerpt ? { error: excerpt } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
