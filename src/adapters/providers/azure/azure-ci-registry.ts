import { azureCiRegistry, type AzureBuildRegistry, type AzureCiRegistryScope } from '../../../domain/spec/engine-ci-registry.js';
export { azureCiRegistry } from '../../../domain/spec/engine-ci-registry.js';
export type { AzureBuildRegistry, AzureCiRegistryScope } from '../../../domain/spec/engine-ci-registry.js';

/** Retained registries stay desired when CI is disabled; a mismatching binding never becomes new authority. */
export function azureSelectedBuildRegistry(input: AzureCiRegistryScope & { ci?: unknown; buildRegistry?: AzureBuildRegistry; shared: { registryId: string; registryLoginServer: string } }): AzureBuildRegistry {
  if (!input.ci && !input.buildRegistry) return { id: input.shared.registryId, loginServer: input.shared.registryLoginServer };
  const expected = azureCiRegistry(input);
  if (input.buildRegistry && (input.buildRegistry.id.toLowerCase() !== expected.id.toLowerCase() || input.buildRegistry.loginServer !== expected.loginServer)) throw new Error('The applied build registry belongs to a different environment or Azure scope. Preserve it and resolve the binding before planning.');
  return { id: expected.id, loginServer: expected.loginServer };
}

/** Narrow, non-secret projection of the exact applied private engine state. */
export function projectAzureCiRegistry(state: unknown, scope: AzureCiRegistryScope): AzureBuildRegistry {
  const resources = (state as { values?: { root_module?: { resources?: Array<{ address?: string; values?: Record<string, unknown> }> } } })?.values?.root_module?.resources;
  const registry = resources?.find((resource) => resource.address === 'azurerm_container_registry.ci_images')?.values;
  const expected = azureCiRegistry(scope);
  const tags = registry?.tags as Record<string, unknown> | undefined;
  if (typeof registry?.id !== 'string' || registry.id.toLowerCase() !== expected.id.toLowerCase() || registry.login_server !== expected.loginServer || registry.name !== expected.name
    || tags?.['managed-by'] !== 'hypervibe' || tags?.['hv-environment'] !== scope.environmentId.toLowerCase()) throw new Error('The applied CI registry identity or ownership could not be verified.');
  return { id: registry.id, loginServer: expected.loginServer };
}
