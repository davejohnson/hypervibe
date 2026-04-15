import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { InfraTransaction } from './infra.transaction.js';

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function captureEnvironmentSnapshot(environment: Environment): Environment {
  return {
    ...environment,
    platformBindings: cloneRecord(environment.platformBindings ?? {}),
  };
}

export function restoreEnvironmentSnapshot(
  envRepo: EnvironmentRepository,
  snapshot: Environment
): { success: boolean; message?: string; error?: string } {
  const current = envRepo.findById(snapshot.id);
  if (!current) {
    return {
      success: true,
      message: `Environment ${snapshot.id} already removed`,
    };
  }

  const restored = envRepo.update(snapshot.id, {
    name: current.name,
    platformBindings: snapshot.platformBindings,
  });
  return restored
    ? {
        success: true,
        message: `Restored local environment bindings for ${snapshot.id}`,
      }
    : {
        success: false,
        error: `Failed to restore local environment bindings for ${snapshot.id}`,
      };
}

export function captureComponentSnapshot(component: Component): Component {
  return {
    ...component,
    bindings: cloneRecord(component.bindings ?? {}),
  };
}

export function restoreComponentSnapshot(
  componentRepo: ComponentRepository,
  snapshot: Component
): { success: boolean; message?: string; error?: string } {
  const current = componentRepo.findById(snapshot.id);
  if (!current) {
    return {
      success: false,
      error: `Local component ${snapshot.id} is missing`,
    };
  }

  const restored = componentRepo.update(snapshot.id, {
    type: snapshot.type,
    bindings: snapshot.bindings,
    externalId: snapshot.externalId ?? undefined,
  });
  return restored
    ? {
        success: true,
        message: `Restored local component ${snapshot.id}`,
      }
    : {
        success: false,
        error: `Failed to restore local component ${snapshot.id}`,
      };
}

export function snapshotEnvironmentBindings(params: {
  tx: InfraTransaction;
  envRepo: EnvironmentRepository;
  environmentId: string;
  label: string;
}): void {
  const environment = params.envRepo.findById(params.environmentId);
  if (!environment) return;

  const snapshot = captureEnvironmentSnapshot(environment);
  params.tx.addStep({
    id: `restore-environment-bindings:${params.environmentId}:${params.label}`,
    label: params.label,
    resource: {
      provider: 'hypervibe',
      type: 'environment_bindings',
      id: params.environmentId,
      name: environment.name,
    },
    compensate: async () => {
      return restoreEnvironmentSnapshot(params.envRepo, snapshot);
    },
  });
}

export function snapshotComponentRecord(params: {
  tx: InfraTransaction;
  componentRepo: ComponentRepository;
  component: Component;
  label: string;
}): void {
  const snapshot = captureComponentSnapshot(params.component);

  params.tx.addStep({
    id: `restore-component:${params.component.id}:${params.label}`,
    label: params.label,
    resource: {
      provider: 'hypervibe',
      type: 'component_record',
      id: params.component.id,
      name: params.component.type,
    },
    compensate: async () => {
      return restoreComponentSnapshot(params.componentRepo, snapshot);
    },
  });
}
