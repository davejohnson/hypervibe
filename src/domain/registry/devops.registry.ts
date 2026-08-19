import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { CodeHostIdentityPort, CodeRepositoryLifecyclePort, CiOperationsPort } from '../ports/devops.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import type { CiRollbackFailure, CiRollbackResult } from '../services/ci-rollback.service.js';

export interface CiLifecycleResult {
  /** One provider mutation per action; secret/config bundles are never implicit. */
  actions?: PlanAction[];
  /** Compatibility for the existing GitHub lifecycle while it is migrated. */
  action?: PlanAction;
  warnings: string[];
  /** Fail-closed planning result for unknown authority or unsupported semantics. */
  error?: string;
}

export interface CiApplyResult {
  success: boolean;
  status?: 'pending' | 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface CiLifecyclePort {
  planDeploy(params: {
    project: Project;
    spec: ProjectSpec;
    environmentName: string;
    environmentSpec: EnvironmentSpec;
    environment: Environment | null;
    dependsOn?: string[];
    bindingsWillChange?: boolean;
  }): Promise<CiLifecycleResult>;
  applyDeploy(params: {
    project: Project;
    spec: ProjectSpec;
    environmentName: string;
    environmentSpec: EnvironmentSpec;
    action: PlanAction;
  }): Promise<CiApplyResult>;
  planAppliedSpecHash?(params: {
    project: Project;
    spec: ProjectSpec;
    environmentName: string;
    environmentSpec: EnvironmentSpec;
    environment: Environment | null;
    dependsOn?: string[];
  }): Promise<CiLifecycleResult>;
  applyAppliedSpecHash?(params: {
    project: Project;
    spec: ProjectSpec;
    environmentName: string;
    action: PlanAction;
  }): Promise<CiApplyResult>;
}

export interface CodeHostRegistration {
  id: string;
  connectionProvider: string;
  suggestedCiProvider?: string;
  create(credentials: unknown): CodeHostIdentityPort;
  /** Optional explicit repository lifecycle; file ports never bootstrap projects. */
  createLifecycle?: (credentials: unknown) => CodeRepositoryLifecyclePort;
}

export interface CiProviderRegistration {
  id: string;
  connectionProvider: string;
  compatibleCodeProviders: readonly string[];
  create(credentials: unknown): CiOperationsPort;
  lifecycle: CiLifecyclePort;
  rollback?: (params: {
    project: Project;
    environment: Environment;
    toSha?: string;
  }) => Promise<CiRollbackFailure | CiRollbackResult>;
}

export class DevOpsProviderRegistry {
  private readonly codeHosts = new Map<string, CodeHostRegistration>();
  private readonly ciProviders = new Map<string, CiProviderRegistration>();

  registerCodeHost(registration: CodeHostRegistration): void {
    if (this.codeHosts.has(registration.id)) {
      throw new Error(`Code-host provider "${registration.id}" is already registered`);
    }
    this.codeHosts.set(registration.id, registration);
  }

  registerCiProvider(registration: CiProviderRegistration): void {
    if (this.ciProviders.has(registration.id)) {
      throw new Error(`CI provider "${registration.id}" is already registered`);
    }
    this.ciProviders.set(registration.id, registration);
  }

  codeHost(id: string): CodeHostRegistration | undefined {
    return this.codeHosts.get(id);
  }

  ciProvider(id: string): CiProviderRegistration | undefined {
    return this.ciProviders.get(id);
  }

  codeHostIds(): string[] {
    return [...this.codeHosts.keys()];
  }

  ciProviderIds(): string[] {
    return [...this.ciProviders.keys()];
  }

  compatible(codeProvider: string, ciProvider: string): boolean {
    return this.ciProviders.get(ciProvider)?.compatibleCodeProviders.includes(codeProvider) ?? false;
  }
}

export const devOpsProviderRegistry = new DevOpsProviderRegistry();
