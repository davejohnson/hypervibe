import crypto from 'node:crypto';

export interface AzureBuildRegistry { id: string; loginServer: string }
export interface AzureCiRegistryScope { subscriptionId: string; resourceGroup: string; environmentId: string }

/** Environment identity is stable across branch/name changes; never replace stored images for a rename. */
export function azureCiRegistry(scope: AzureCiRegistryScope): AzureBuildRegistry & { name: string } {
  const hash = crypto.createHash('sha256').update(`${scope.subscriptionId.toLowerCase()}/${scope.resourceGroup.toLowerCase()}/${scope.environmentId.toLowerCase()}`).digest('hex').slice(0, 20);
  const name = `hvci${hash}`;
  return { name, id: `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${name}`, loginServer: `${name}.azurecr.io` };
}
