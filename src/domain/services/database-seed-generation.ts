import type { Component } from '../entities/component.entity.js';
import { getCompletedDatabaseInitializationReceipt } from '../plan/database-initialization.contract.js';
import { bindingIdentityFingerprint } from './binding-identity.js';

/** Legacy databases have no generation marker. Incomplete or invalid markers
 * cannot authorize seeding or certify old rows on newly initialized storage. */
export function databaseSeedGeneration(
  component: Component, environmentBindings: Record<string, unknown>
): string | null | undefined {
  if (!Object.hasOwn(component.bindings, 'freshInitialization')) return undefined;
  const receipt = getCompletedDatabaseInitializationReceipt({ component,
    environment: { id: component.environmentId, platformBindings: environmentBindings } });
  return receipt ? bindingIdentityFingerprint(receipt) : null;
}
