import type { Environment } from '../entities/environment.entity.js';
import type { ProviderInspectionRequest } from './provider.registry.js';

export function environmentForInspection(
  request: ProviderInspectionRequest
): Environment {
  if (!request.project || !request.environment) {
    throw new Error('Provider environment inspection requires Hypervibe project and environment context.');
  }
  const timestamp = new Date(0);
  return {
    id: request.environment.id,
    projectId: request.environment.projectId,
    name: request.environment.name,
    platformBindings: request.binding ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
