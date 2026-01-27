import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { Run, RunPlan, RunStep, RunReceipt } from '../entities/run.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';

export interface DeployOptions {
  project: Project;
  environment: Environment;
  services?: Service[];
  envVars?: Record<string, string>;
  adapter: IProviderAdapter;
}

export interface DeployResult {
  run: Run;
  success: boolean;
  urls: string[];
  errors: string[];
}

export class DeployOrchestrator {
  private runRepo = new RunRepository();
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private auditRepo = new AuditRepository();

  buildPlan(options: DeployOptions): RunPlan {
    const steps: RunStep[] = [];

    // Step 1: Ensure project exists on provider
    steps.push({
      name: 'ensure_project',
      action: 'ensureProject',
      target: options.project.name,
      params: { projectId: options.project.id },
    });

    // Step 2: Set environment variables if provided
    if (options.envVars && Object.keys(options.envVars).length > 0) {
      steps.push({
        name: 'set_env_vars',
        action: 'setEnvVars',
        params: { vars: options.envVars },
      });
    }

    // Step 3: Deploy each service
    const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);
    for (const service of services) {
      steps.push({
        name: `deploy_${service.name}`,
        action: 'deploy',
        target: service.name,
        params: { serviceId: service.id },
      });
    }

    // Step 4: Verify health
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
    const errors: string[] = [];

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
        const receipt = await this.executeStep(step, options);
        this.runRepo.addReceipt(run.id, receipt);

        if (receipt.status === 'failure') {
          errors.push(receipt.error ?? `Step ${step.name} failed`);
          // Continue with other steps even if one fails
        }

        if (receipt.result?.url) {
          urls.push(receipt.result.url as string);
        }
      }

      const hasErrors = errors.length > 0;
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
        errors,
      };
    } catch (error) {
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
        errors: [...errors, String(error)],
      };
    }
  }

  private async executeStep(step: RunStep, options: DeployOptions): Promise<RunReceipt> {
    const timestamp = new Date().toISOString();

    try {
      switch (step.action) {
        case 'ensureProject': {
          const receipt = await options.adapter.ensureProject(
            options.project.name,
            options.environment
          );

          // Update environment bindings if we got a project ID
          if (receipt.success && receipt.data?.projectId) {
            this.envRepo.updatePlatformBindings(options.environment.id, {
              railwayProjectId: receipt.data.projectId,
            });
          }

          return {
            step: step.name,
            status: receipt.success ? 'success' : 'failure',
            result: receipt.data,
            error: receipt.error,
            timestamp,
          };
        }

        case 'setEnvVars': {
          // This requires knowing which service to set vars for
          // For now, we'll skip this step as vars are set during deploy
          return {
            step: step.name,
            status: 'skipped',
            timestamp,
          };
        }

        case 'deploy': {
          const service = this.serviceRepo.findById(step.params?.serviceId as string);
          if (!service) {
            return {
              step: step.name,
              status: 'failure',
              error: `Service not found: ${step.params?.serviceId}`,
              timestamp,
            };
          }

          const result = await options.adapter.deploy(
            service,
            options.environment,
            options.envVars ?? {}
          );

          // Update environment bindings with service info
          if (result.externalId) {
            const currentBindings = options.environment.platformBindings as {
              services?: Record<string, { serviceId: string }>;
            };
            const services = currentBindings.services ?? {};
            services[service.name] = { serviceId: result.externalId };
            this.envRepo.updatePlatformBindings(options.environment.id, { services });
          }

          return {
            step: step.name,
            status: result.receipt.success ? 'success' : 'failure',
            result: { url: result.url, externalId: result.externalId },
            error: result.receipt.error,
            timestamp,
          };
        }

        case 'verifyHealth': {
          // Placeholder for health check logic
          // In a real implementation, we'd poll deployment status
          return {
            step: step.name,
            status: 'success',
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
}
