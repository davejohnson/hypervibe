import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IStorageAdapter, StorageContext, StorageEnsureResult } from '../../../domain/ports/storage.port.js';
import { RailwayAdapter } from './railway.adapter.js';

function virtualEnvironment(environment: Environment, context: StorageContext): Environment {
  return { ...environment, platformBindings: { projectId: context.projectId, environmentId: context.environmentId, services: {} } };
}

export function createRailwayStorageAdapter(railway: RailwayAdapter): IStorageAdapter {
  return {
    name: 'railway',
    capabilities: {
      kind: 'object',
      regions: ['sjc', 'iad', 'ams', 'sin'],
      privateOnly: true,
      supportsUsageObservation: true,
    },
    connect: (credentials) => railway.connect(credentials),
    verify: () => railway.verify(),
    disconnect: () => railway.disconnect(),
    async ensureContext(projectName, environment, context): Promise<StorageEnsureResult> {
      const receipt = await railway.ensureStorageContext(projectName, environment, context);
      const projectId = typeof receipt.data?.projectId === 'string' ? receipt.data.projectId : undefined;
      const environmentId = typeof receipt.data?.environmentId === 'string' ? receipt.data.environmentId : undefined;
      return { receipt, ...(projectId && environmentId ? { context: { projectId, environmentId } } : {}) };
    },
    async ensureBucket(environment, context, name, region): Promise<StorageEnsureResult> {
      const receipt = await railway.ensureStorage(virtualEnvironment(environment, context), name, { region });
      const externalId = typeof receipt.data?.externalId === 'string' ? receipt.data.externalId : undefined;
      return { receipt, externalId, context };
    },
    async observe(environment, context) {
      const observed = await railway.observe(virtualEnvironment(environment, context));
      return observed.storage ?? [];
    },
    getCredentials: (environment, context, externalId) => railway.getStorageCredentials(virtualEnvironment(environment, context), externalId),
    destroyBucket: (environment, context, externalId) => railway.destroyStorage(virtualEnvironment(environment, context), externalId),
  };
}
