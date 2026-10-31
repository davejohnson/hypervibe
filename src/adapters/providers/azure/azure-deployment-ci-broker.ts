import type { BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import { reviewedCloudDeploymentCiAccess, buildGitHubDeploymentSessionRuntime, GITHUB_EPHEMERAL_DOCKER_LOGIN_RUNTIME } from '../../../domain/services/cloud-deployment-ci.js';

/** Native resource lifetimes must come from applied bindings, never name discovery. */
export function azureDeploymentCiBinding(target: BranchDeployTarget) {
  const access = reviewedCloudDeploymentCiAccess(target), principal = access.connection.principals.release;
  if (principal.kind !== 'azure-managed-identity' || access.connection.hostingProvider !== 'azure-container-apps') throw new Error('Azure deployment authority does not match this workflow.');
  const scope = access.connection.nativeScope, group = `/subscriptions/${principal.subscriptionId}/resourceGroups/${scope.resourceGroup}`;
  const native = target.providerScope, id = native?.registryResourceId, server = native?.registryServer, createdAt = native?.registryCreatedAt;
  const name = id?.slice(`${group}/providers/Microsoft.ContainerRegistry/registries/`.length);
  if (target.providerProjectId?.toLowerCase() !== group.toLowerCase() || !id?.toLowerCase().startsWith(`${group}/providers/Microsoft.ContainerRegistry/registries/`.toLowerCase())
    || !name || !/^[a-zA-Z0-9]{5,50}$/.test(name) || !server || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(server) || server !== `${name.toLowerCase()}.azurecr.io`
    || !createdAt || !Number.isFinite(Date.parse(createdAt)) || !target.runtimeResources?.length || target.providerJobNames?.length) throw new Error('Azure CI requires exact applied registry and workload lifetime bindings.');
  const apps = target.runtimeResources.map(resource => {
    if (resource.providerResourceType !== 'service' || resource.workloadKind !== 'web' || !resource.providerResourceId.toLowerCase().startsWith(`${group}/providers/Microsoft.App/containerApps/`.toLowerCase())
      || !resource.providerResourceUid || !Number.isFinite(Date.parse(resource.providerResourceUid))) throw new Error('Azure CI requires exact applied workload lifetime bindings.');
    const identity = access.connection.runtimeIdentities.find(identity => identity.workload === resource.logicalName)?.principal;
    if (!identity || identity.kind !== 'azure-managed-identity') throw new Error('Azure CI requires its independently reviewed workload identity.');
    return { id: resource.providerResourceId, createdAt: resource.providerResourceUid, identity };
  });
  if (apps.length !== target.providerServiceIds.length || new Set(apps.map(app => app.id.toLowerCase())).size !== apps.length
    || target.providerServiceIds.some(id => !apps.some(app => app.id === id))) throw new Error('Azure CI workload bindings differ from the reviewed program.');
  return { access, principal, group, registry: { id, server, createdAt }, apps };
}

/** Azure-owned bounded transport. Provider error bodies can echo bearer/refresh tokens. */
export const AZURE_CI_JSON_RUNTIME = `async function hvAzureJson(url, options = {}) {
  const failed = () => new Error('Azure response could not be verified.');
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failed()); }, 15000); });
  const bounded = value => Promise.race([value, deadline]);
  try {
    const response = await bounded(fetch(url, { ...options, redirect: 'error', signal: controller.signal }));
    if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) { void response.body?.cancel().catch(() => {}); throw failed(); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const part = await bounded(reader.read()); if (part.done) break; size += part.value.byteLength; if (size > 1048576) throw failed(); chunks.push(part.value); } }
    catch { void reader.cancel().catch(() => {}); throw failed(); } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw failed(); } finally { clearTimeout(timer); controller.abort(); }
}
`;

export function azureBrokerRuntime(target: BranchDeployTarget): string {
  return buildGitHubDeploymentSessionRuntime(target) + AZURE_CI_JSON_RUNTIME;
}

export function azureBrokerRegistryLogin(target: BranchDeployTarget): string {
  const binding = azureDeploymentCiBinding(target);
  return `${azureBrokerRuntime(target)}
const reviewedRegistry = ${JSON.stringify(binding.registry)};
const arm = await hvDeploymentSession('resource-manager');
const observed = await hvAzureJson('https://management.azure.com' + reviewedRegistry.id + '?api-version=2025-11-01', { headers: { Authorization: 'Bearer ' + arm.token } });
if (observed?.id?.toLowerCase() !== reviewedRegistry.id.toLowerCase() || observed?.systemData?.createdAt !== reviewedRegistry.createdAt
  || observed?.properties?.loginServer !== reviewedRegistry.server || observed?.properties?.provisioningState !== 'Succeeded') throw new Error('Azure registry identity could not be verified.');
const registry = reviewedRegistry.server;
const acr = await hvDeploymentSession('container-registry');
const exchanged = await hvAzureJson('https://' + registry + '/oauth2/exchange', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'access_token', service: registry, tenant: ${JSON.stringify(binding.principal.tenantId)}, access_token: acr.token }) });
if (!exchanged || Object.keys(exchanged).length !== 1 || typeof exchanged.refresh_token !== 'string' || !exchanged.refresh_token
  || exchanged.refresh_token.length > 16384 || /[\\r\\n]/.test(exchanged.refresh_token)) throw new Error('Azure exchange response could not be verified.');
const username = '00000000-0000-0000-0000-000000000000', password = exchanged.refresh_token;
${GITHUB_EPHEMERAL_DOCKER_LOGIN_RUNTIME}`;
}
