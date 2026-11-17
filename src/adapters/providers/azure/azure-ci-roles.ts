import crypto from 'node:crypto';

export const AZURE_CI_ACTIONS = {
  release: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/revisions/read', 'Microsoft.App/jobs/read', 'Microsoft.App/jobs/write'],
  build: ['Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/tasks/read', 'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action', 'Microsoft.ContainerRegistry/registries/scheduleRun/action', 'Microsoft.ContainerRegistry/registries/runs/read'],
} as const;

/** Fixed roles installed during reviewed owner setup, never editable by the deploy identity. */
export function azureCiRoleDefinitions(subscriptionId: string, resourceGroup: string) {
  const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  return Object.fromEntries((['release', 'build'] as const).map((kind) => {
    const hex = crypto.createHash('sha256').update(`hypervibe-ci-v1|${scope.toLowerCase()}|${kind}`).digest('hex');
    const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return [kind, { guid, id: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${guid}`,
      scope, properties: { roleName: `Hypervibe ${resourceGroup} CI ${kind}`, description: 'Hypervibe CI access v1; managed by approved owner setup.', type: 'CustomRole',
        permissions: [{ actions: [...AZURE_CI_ACTIONS[kind]], notActions: [], dataActions: [], notDataActions: [] }], assignableScopes: [scope] } }];
  })) as Record<'release' | 'build', { guid: string; id: string; scope: string; properties: { roleName: string; description: string; type: string; permissions: Array<{ actions: string[]; notActions: never[]; dataActions: never[]; notDataActions: never[] }>; assignableScopes: string[] } }>;
}
