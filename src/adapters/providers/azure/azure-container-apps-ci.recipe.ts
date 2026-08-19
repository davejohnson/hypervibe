import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';
import { azureRegistryName } from './azure-container-apps-ci.workflow.js';

export const AZURE_CONTAINER_APPS_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/azure-container-apps-deploy.mjs';

export function buildAzureContainerAppsPortableRuntime(): string {
  return `import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const required = ['AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_RESOURCE_GROUP_ID', 'AZURE_CONTAINER_APP_IDS_JSON', 'AZURE_REGISTRY_SERVER', 'CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'CI_PROJECT_PATH', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (!process.env[key]) throw new Error(key + ' is required');
const groupMatch = process.env.AZURE_RESOURCE_GROUP_ID.match(/^\\/subscriptions\\/([^/]+)\\/resourceGroups\\/([^/]+)$/i);
if (!groupMatch || groupMatch[1].toLowerCase() !== process.env.AZURE_SUBSCRIPTION_ID.toLowerCase()) throw new Error('Azure resource-group binding is invalid');
let appIds;
try { appIds = JSON.parse(process.env.AZURE_CONTAINER_APP_IDS_JSON); } catch { throw new Error('AZURE_CONTAINER_APP_IDS_JSON must be JSON'); }
if (!Array.isArray(appIds) || appIds.length === 0 || appIds.some((value) => typeof value !== 'string')) throw new Error('Azure app bindings are invalid');
appIds = [...new Set(appIds.map((value) => value.trim()))];
const groupId = process.env.AZURE_RESOURCE_GROUP_ID.toLowerCase();
for (const id of appIds) if (!id.toLowerCase().startsWith(groupId + '/providers/microsoft.app/containerapps/')) throw new Error('Container App is outside the bound resource group');
const tokenResponse = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(process.env.AZURE_TENANT_ID) + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'https://management.azure.com//.default' }) });
if (!tokenResponse.ok) throw new Error('Azure authentication failed with HTTP ' + tokenResponse.status);
const token = (await tokenResponse.json()).access_token;
if (!token) throw new Error('Azure authentication returned no access token');
async function arm(method, id, body) {
  const response = await fetch('https://management.azure.com' + id + '?api-version=2026-01-01', { method, headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('Azure returned non-JSON for ' + id); }
  if (!response.ok) throw new Error('Azure ARM HTTP ' + response.status + ' for ' + id);
  return payload;
}
const registryResource = groupId + '/providers/microsoft.containerregistry/registries/' + process.env.AZURE_REGISTRY_SERVER.split('.')[0];
const registryObserved = await arm('GET', registryResource);
if (registryObserved?.id?.toLowerCase() !== registryResource || registryObserved?.properties?.loginServer?.toLowerCase() !== process.env.AZURE_REGISTRY_SERVER.toLowerCase()) throw new Error('Azure registry identity did not match the applied resource-group binding');
const sha = (await readFile('.hypervibe-deploy-sha', 'utf8')).trim().toLowerCase();
const sourceImage = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build artifacts are invalid');
const repository = process.env.CI_PROJECT_PATH.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
const image = process.env.AZURE_REGISTRY_SERVER.toLowerCase() + '/hypervibe/' + repository + ':' + sha;
const docker = './.hypervibe-docker';
function dockerInput(args, input) { execFileSync(docker, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); }
dockerInput(['login', process.env.CI_REGISTRY, '--username', process.env.CI_REGISTRY_USER, '--password-stdin'], process.env.CI_REGISTRY_PASSWORD);
execFileSync(docker, ['pull', sourceImage], { stdio: 'inherit' });
dockerInput(['login', process.env.AZURE_REGISTRY_SERVER, '--username', process.env.AZURE_CLIENT_ID, '--password-stdin'], process.env.AZURE_CLIENT_SECRET);
execFileSync(docker, ['tag', sourceImage, image], { stdio: 'inherit' });
const pushed = execFileSync(docker, ['push', image], { encoding: 'utf8' });
process.stdout.write(pushed);
const digests = [...pushed.matchAll(/digest:\\s*(sha256:[0-9a-f]{64})/gi)].map((match) => match[1].toLowerCase());
if (new Set(digests).size !== 1) throw new Error('Azure Container Registry push did not return one exact image digest');
const digest = digests[digests.length - 1];
const exactImage = image.replace(/:[^/:]+$/, '') + '@' + digest;
execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
execFileSync(docker, ['logout', process.env.AZURE_REGISTRY_SERVER], { stdio: 'ignore' });
const deployments = [];
for (const appId of appIds) {
  const app = await arm('GET', appId);
  if (app?.id?.toLowerCase() !== appId.toLowerCase()) throw new Error('Azure returned a different Container App identity');
  const template = app.properties?.template;
  const containers = [...(template?.containers || [])];
  if (containers.length !== 1) throw new Error('Hypervibe expects exactly one Container App container');
  const env = [...(containers[0].env || [])].filter((entry) => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(entry.name));
  const marker = (name) => env.find((entry) => entry.name === name)?.value;
  const healthPath = marker('HYPERVIBE_HEALTH_CHECK_PATH') || '/';
  const startCommand = marker('HYPERVIBE_START_COMMAND');
  env.push({ name: 'HYPERVIBE_DEPLOY_SHA', value: sha }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest });
  containers[0] = { ...containers[0], image: exactImage, env, command: startCommand ? ['sh'] : undefined, args: startCommand ? ['-lc', startCommand] : undefined, probes: [{ type: 'Liveness', httpGet: { path: healthPath, port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }] };
  await arm('PATCH', appId, { properties: { template: { ...template, revisionSuffix: 'hv-' + sha.slice(0, 10), containers } } });
  let ready;
  for (let attempt = 0; attempt < 120; attempt++) {
    const observed = await arm('GET', appId);
    const active = observed?.properties?.template?.containers?.[0];
    const activeEnv = active?.env || [];
    const value = (name) => activeEnv.find((entry) => entry.name === name)?.value;
    if (observed?.properties?.provisioningState === 'Succeeded' && observed.properties.latestReadyRevisionName === observed.properties.latestRevisionName && active?.image === exactImage && value('HYPERVIBE_DEPLOY_SHA') === sha && value('HYPERVIBE_IMAGE_DIGEST') === digest) { ready = observed; break; }
    if (attempt === 119) throw new Error('Azure Container App did not converge to exact image');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const fqdn = ready?.properties?.configuration?.ingress?.fqdn;
  if (!fqdn) throw new Error('Azure returned no public Container App FQDN');
  const health = await fetch('https://' + fqdn + healthPath, { redirect: 'follow' });
  if (!health.ok) throw new Error('Azure Container App health check failed with HTTP ' + health.status);
  deployments.push({ appId, revision: ready.properties.latestReadyRevisionName, imageDigest: digest, url: 'https://' + fqdn });
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'azure-container-apps', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildAzureContainerAppsPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const resourceGroupId = target.providerProjectId?.trim();
  const appIds = [...new Set(target.providerServiceIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (!resourceGroupId || appIds.length === 0) throw new Error(`Azure Container Apps bindings for ${target.environmentName} are incomplete; apply hosting first`);
  return {
    version: 1,
    provider: 'azure-container-apps',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      { name: 'AZURE_TENANT_ID', source: { kind: 'connection', provider: 'azure-container-apps', credentialKey: 'tenantId' }, secret: true },
      { name: 'AZURE_SUBSCRIPTION_ID', source: { kind: 'connection', provider: 'azure-container-apps', credentialKey: 'subscriptionId' }, secret: false },
      { name: 'AZURE_CLIENT_ID', source: { kind: 'connection', provider: 'azure-container-apps', credentialKey: 'clientId' }, secret: true },
      { name: 'AZURE_CLIENT_SECRET', source: { kind: 'connection', provider: 'azure-container-apps', credentialKey: 'clientSecret' }, secret: true },
      { name: 'AZURE_RESOURCE_GROUP_ID', source: { kind: 'literal', value: resourceGroupId }, secret: false },
      { name: 'AZURE_CONTAINER_APP_IDS_JSON', source: { kind: 'literal', value: JSON.stringify(appIds) }, secret: false },
      { name: 'AZURE_REGISTRY_SERVER', source: { kind: 'literal', value: `${azureRegistryName(resourceGroupId)}.azurecr.io` }, secret: false },
    ],
    runtime: { path: AZURE_CONTAINER_APPS_PORTABLE_RUNTIME_PATH, content: buildAzureContainerAppsPortableRuntime() },
  };
}
