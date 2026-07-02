import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from '../adapter.factory.js';
import type { IDatabaseAdapter } from '../../ports/database.port.js';
import { executeBootstrap } from '../bootstrap.service.js';
import { resolveDesiredState, resolveDatabaseProviderForProject, normalizeCrons, type DesiredState } from '../spec.service.js';

type JsonObj = Record<string, unknown>;


async function applyInfra(args: {
  projectName: string;
  environmentName?: string;
  services?: string[];
  crons?: Record<string, { schedule: string; command?: string; timeZone?: string }>;
  serviceName?: string;
  domain?: string;
  databaseProvider?: 'supabase' | 'cloudsql' | 'railway';
  setupEmail?: boolean;
  serviceConfig?: Record<string, Record<string, unknown>>;
  envVars?: Record<string, string>;
  deploy?: Record<string, unknown>;
  confirm?: boolean;
}): Promise<JsonObj> {
  // Replicates the legacy infra_apply handler: resolve desired state from
  // project policies plus overrides, then run the bootstrap converge.
  const project = new ProjectRepository().findByName(args.projectName);
  const policyState = (project?.policies?.desiredState ?? {}) as Partial<DesiredState>;
  const resolvedDatabaseProvider = project
    ? resolveDatabaseProviderForProject(project, policyState, {
      environmentName: args.environmentName,
      databaseProvider: args.databaseProvider,
    })
    : args.databaseProvider;
  const desired = resolveDesiredState(policyState, {
    environmentName: args.environmentName,
    services: args.services,
    crons: normalizeCrons(args.crons),
    serviceName: args.serviceName,
    domain: args.domain,
    databaseProvider: resolvedDatabaseProvider,
    setupEmail: args.setupEmail,
    serviceConfig: args.serviceConfig as Partial<DesiredState>['serviceConfig'],
    envVars: args.envVars,
    deploy: args.deploy as Partial<DesiredState>['deploy'],
  });
  const executed = await executeBootstrap({
    projectName: args.projectName,
    environmentName: desired.environmentName,
    services: desired.services,
    crons: desired.crons,
    domain: desired.domain,
    databaseProvider: desired.databaseProvider,
    setupEmail: desired.setupEmail,
    serviceConfig: desired.serviceConfig,
    envVars: desired.envVars,
    deploy: desired.deploy,
  });
  if (!executed.success && executed.summary.error) {
    return { success: false, error: executed.summary.error, summary: executed.summary } as JsonObj;
  }
  return { success: executed.success, ...executed.summary } as JsonObj;
}

describe('infra_apply local rollback coverage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-infra-rollback-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores environment bindings when database provision mutates local state then fails', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'rollback-bootstrap-project', defaultPlatform: 'railway' });
    const originalBindings = {
      provider: 'railway',
      projectId: 'rail-original-project',
      environmentId: 'rail-original-env',
    };
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: originalBindings,
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, env) {
        envRepo.updatePlatformBindings(env.id, {
          provider: 'railway',
          projectId: 'rail-stale-project',
          environmentId: 'rail-stale-env',
          services: {
            web: { serviceId: 'rail-stale-service' },
          },
        });
        return {
          component: {
            id: '',
            environmentId: env.id,
            type: 'postgres',
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'provision failed',
            error: 'forced failure after local mutation',
          },
        };
      },
      async getConnectionUrl() {
        return null;
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'staging',
      serviceName: 'web',
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.summary && (payload.summary as JsonObj).error)).toContain('forced failure');
    const restored = envRepo.findById(environment.id);
    expect(restored?.platformBindings).toEqual(originalBindings);
  });
});
