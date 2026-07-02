import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { adapterFactory } from './adapter.factory.js';
import type { InfraTransaction } from './infra.transaction.js';
import {
  snapshotComponentRecord,
  snapshotEnvironmentBindings,
} from './local-state.transaction.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { Receipt } from '../ports/provider.port.js';
import { DB_PROVIDERS, resolveExistingDatabaseState } from './spec.service.js';

const envRepo = new EnvironmentRepository();
const componentRepo = new ComponentRepository();

type DatabaseEnsuringAdapter = {
  ensureDatabase?: (component: Component, databaseName?: string) => Promise<Receipt>;
};

async function ensureDatabaseIfSupported(
  adapter: unknown,
  component: Component,
  databaseName?: string
): Promise<Receipt | undefined> {
  const databaseAdapter = adapter as DatabaseEnsuringAdapter;
  if (typeof databaseAdapter.ensureDatabase !== 'function') {
    return undefined;
  }
  return databaseAdapter.ensureDatabase(component, databaseName);
}

export interface DbProvision {
  component: Component;
  receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
  connectionUrl?: string;
  envVars?: Record<string, string>;
}

export type BootstrapDatabaseResult =
  | { ok: true; environment: Environment; dbProvision?: DbProvision; dbEnsureReceipt?: Receipt }
  | { ok: false; failure: { success: false; summary: Record<string, unknown> } };

/**
 * Database provisioning leg of executeBootstrap: reuse a matching component
 * (ensuring it still exists for Cloud SQL) or provision a new one, recording
 * transaction compensation steps and the local component row. Rolls back the
 * transaction and returns a failure summary on any error, matching the
 * inline behavior this was extracted from.
 */
export async function provisionBootstrapDatabase(args: {
  projectName: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  project: Project;
  environment: Environment;
  tx: InfraTransaction;
}): Promise<BootstrapDatabaseResult> {
  const { projectName, databaseProvider, project, tx } = args;
  let environment = args.environment;

  let dbEnsureReceipt: Receipt | undefined;
  let dbProvision: DbProvision | undefined;

  const existingDatabase = resolveExistingDatabaseState(environment.id, databaseProvider);

  if (existingDatabase.status === 'match' && existingDatabase.component) {
    if (databaseProvider === 'cloudsql') {
      const dbAdapterResult = await adapterFactory.getDatabaseAdapter(databaseProvider, project);
      if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
        const cleanup = await tx.rollback();
        return {
          ok: false,
          failure: {
            success: false,
            summary: {
              error: dbAdapterResult.error || 'Database adapter unavailable',
              rollback: cleanup,
              transaction: { created: tx.listResources() },
            },
          },
        };
      }
      dbEnsureReceipt = await ensureDatabaseIfSupported(dbAdapterResult.adapter, existingDatabase.component);
      if (dbEnsureReceipt && !dbEnsureReceipt.success) {
        const cleanup = await tx.rollback();
        return {
          ok: false,
          failure: {
            success: false,
            summary: {
              error: dbEnsureReceipt.error || dbEnsureReceipt.message,
              rollback: cleanup,
              transaction: { created: tx.listResources() },
              debug: {
                phase: 'db_ensure',
                provider: databaseProvider,
                receiptData: dbEnsureReceipt.data ?? null,
              },
            },
          },
        };
      }
    }
    dbProvision = {
      component: existingDatabase.component,
      receipt: {
        success: true,
        message: `Reusing existing postgres on ${databaseProvider}`,
        data: {
          phase: 'reuseExisting',
          provider: databaseProvider,
          componentId: existingDatabase.component.externalId ?? existingDatabase.component.id,
        },
      },
      connectionUrl: existingDatabase.connectionUrl,
      envVars: existingDatabase.envVars,
    };
    return { ok: true, environment, dbProvision, dbEnsureReceipt };
  }

  const dbAdapterResult = await adapterFactory.getDatabaseAdapter(databaseProvider, project);
  if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      ok: false,
      failure: {
        success: false,
        summary: {
          error: dbAdapterResult.error || 'Database adapter unavailable',
          rollback: cleanup,
          transaction: { created: tx.listResources() },
        },
      },
    };
  }

  snapshotEnvironmentBindings({
    tx,
    envRepo,
    environmentId: environment.id,
    label: 'environment_bindings_db_provision',
  });
  dbProvision = await dbAdapterResult.adapter.provision('postgres', environment, {
    databaseName: 'app',
  });
  if (!dbProvision.receipt.success) {
    const cleanup = await tx.rollback();
    return {
      ok: false,
      failure: {
        success: false,
        summary: {
          error: dbProvision.receipt.error || dbProvision.receipt.message,
          rollback: cleanup,
          transaction: { created: tx.listResources() },
          debug: {
            phase: 'db_provision',
            provider: databaseProvider,
            receiptData: dbProvision.receipt.data ?? null,
          },
        },
      },
    };
  }
  const dbReceiptData = (dbProvision.receipt.data ?? {}) as Record<string, unknown>;
  const provisionProjectId =
    (typeof dbReceiptData.projectId === 'string' ? dbReceiptData.projectId : null) ??
    (typeof dbReceiptData.providerProjectId === 'string' ? dbReceiptData.providerProjectId : null);
  const provisionCreatedProject = dbReceiptData.ensureProjectCreated === true;
  if (databaseProvider === 'railway' && provisionCreatedProject && provisionProjectId) {
    tx.addStep({
      id: `provider-project:${provisionProjectId}`,
      label: 'db_provision_ensure_project',
      resource: {
        provider: 'railway',
        type: 'project',
        id: provisionProjectId,
        name: projectName,
      },
      compensate: async () => {
        const hosting = await adapterFactory.getHostingAdapter(project);
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
  // DB provisioning may update provider bindings; refresh the environment object before deploy planning.
  environment = envRepo.findById(environment.id) ?? environment;
  tx.addStep({
    id: `database:${dbProvision.component.externalId ?? dbProvision.component.id}`,
    label: 'db_provision',
    resource: {
      provider: databaseProvider,
      type: dbProvision.component.type,
      id: dbProvision.component.externalId ?? dbProvision.component.id,
      metadata: { environmentId: environment.id },
    },
    compensate: async () => dbAdapterResult.adapter!.destroy(dbProvision!.component),
  });

  const existingComponent = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
  if (existingComponent) {
    snapshotComponentRecord({
      tx,
      componentRepo,
      component: existingComponent,
      label: 'component_record_update',
    });
    const existingBindings = existingComponent.bindings as Record<string, unknown>;
    const existingProvider = typeof existingBindings.provider === 'string' ? existingBindings.provider : undefined;
    const nextBindings = existingProvider && existingProvider !== databaseProvider
      ? {
          ...(dbProvision.component.bindings as Record<string, unknown>),
          previousProvider: existingProvider,
          previousExternalId: existingComponent.externalId ?? undefined,
          previousBindings: existingComponent.bindings,
        }
      : dbProvision.component.bindings;
    componentRepo.update(existingComponent.id, {
      bindings: nextBindings,
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

  return { ok: true, environment, dbProvision, dbEnsureReceipt };
}
