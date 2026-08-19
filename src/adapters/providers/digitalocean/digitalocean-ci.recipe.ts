import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';

export const DIGITALOCEAN_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/digitalocean-deploy.mjs';

function appIdsFromBindings(bindings: string[]): string[] {
  return [...new Set(bindings.flatMap((binding) => {
    const [appId, collection, component, ...extra] = binding.split(':');
    return appId && component && extra.length === 0 && ['services', 'workers', 'jobs'].includes(collection)
      ? [appId]
      : [];
  }))];
}

function registryFromImageBindings(imageUris: string[]): string {
  const parsed = imageUris.map((value) => value.match(/^registry\.digitalocean\.com\/([a-z0-9-]{3,63})\//)?.[1]);
  const registries = [...new Set(parsed.filter((value): value is string => Boolean(value)))];
  if (imageUris.length === 0 || parsed.some((value) => !value) || registries.length !== 1) {
    throw new Error('DigitalOcean CI requires one exact DOCR registry preserved in the hosting image bindings');
  }
  return registries[0]!;
}

export function buildDigitalOceanPortableRuntime(): string {
  return `import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const required = ['DIGITALOCEAN_TOKEN', 'DIGITALOCEAN_APP_ID', 'DIGITALOCEAN_REGISTRY', 'DIGITALOCEAN_TARGET_BINDINGS', 'DIGITALOCEAN_TARGET_NAMES', 'CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'CI_PROJECT_PATH', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (!process.env[key]) throw new Error(key + ' is required');
const sha = (await readFile('.hypervibe-deploy-sha', 'utf8')).trim().toLowerCase();
const sourceImage = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build artifacts are invalid');
function array(name) {
  let value;
  try { value = JSON.parse(process.env[name]); } catch { throw new Error(name + ' must be JSON'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(name + ' must contain strings');
  return value.map((entry) => entry.trim()).filter(Boolean);
}
async function api(method, path, body) {
  const response = await fetch('https://api.digitalocean.com' + path, { method, headers: { Accept: 'application/json', Authorization: 'Bearer ' + process.env.DIGITALOCEAN_TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('DigitalOcean returned non-JSON for ' + path); }
  if (!response.ok) throw new Error('DigitalOcean API HTTP ' + response.status + ' for ' + path);
  return payload;
}
const registryResult = await api('GET', '/v2/registries?page=1&per_page=200');
const registry = process.env.DIGITALOCEAN_REGISTRY;
if (!/^[a-z0-9-]{3,63}$/.test(registry)) throw new Error('DigitalOcean registry binding is invalid');
const registries = (registryResult.registries || []).filter((entry) => entry?.name === registry);
if (registries.length !== 1) throw new Error('DigitalOcean did not expose the exact bound DOCR registry');
const repository = process.env.CI_PROJECT_PATH.toLowerCase();
if (!/^[a-z0-9._/-]+$/.test(repository)) throw new Error('GitLab project path is unsafe for DOCR');
const image = 'registry.digitalocean.com/' + registry + '/' + repository + ':' + sha;
const docker = './.hypervibe-docker';
function dockerInput(args, input) { execFileSync(docker, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); }
dockerInput(['login', process.env.CI_REGISTRY, '--username', process.env.CI_REGISTRY_USER, '--password-stdin'], process.env.CI_REGISTRY_PASSWORD);
execFileSync(docker, ['pull', sourceImage], { stdio: 'inherit' });
dockerInput(['login', 'registry.digitalocean.com', '--username', process.env.DIGITALOCEAN_TOKEN, '--password-stdin'], process.env.DIGITALOCEAN_TOKEN);
execFileSync(docker, ['tag', sourceImage, image], { stdio: 'inherit' });
execFileSync(docker, ['push', image], { stdio: 'inherit' });
execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
execFileSync(docker, ['logout', 'registry.digitalocean.com'], { stdio: 'ignore' });

const appId = process.env.DIGITALOCEAN_APP_ID;
const bindingValues = array('DIGITALOCEAN_TARGET_BINDINGS');
const desiredNames = array('DIGITALOCEAN_TARGET_NAMES');
if (bindingValues.length === 0 && desiredNames.length === 0) throw new Error('No DigitalOcean component targets were supplied');
const current = (await api('GET', '/v2/apps/' + encodeURIComponent(appId))).app;
if (!current || current.id !== appId || !current.spec) throw new Error('DigitalOcean returned a different app identity');
const collections = ['services', 'workers', 'jobs'];
const indexed = collections.flatMap((collection) => (current.spec[collection] || []).filter((component) => typeof component?.name === 'string').map((component) => ({ collection, component })));
const targets = [];
if (bindingValues.length) {
  for (const binding of bindingValues) {
    const parts = binding.split(':');
    if (parts.length !== 3 || parts[0] !== appId || !collections.includes(parts[1]) || !parts[2]) throw new Error('Invalid cross-app DigitalOcean binding');
    const matches = indexed.filter((entry) => entry.collection === parts[1] && entry.component.name === parts[2]);
    if (matches.length !== 1) throw new Error('DigitalOcean binding is absent or ambiguous: ' + binding);
    targets.push(matches[0]);
  }
} else {
  for (const name of desiredNames) {
    const matches = indexed.filter((entry) => entry.component.name === name);
    if (matches.length !== 1) throw new Error('DigitalOcean component is absent or ambiguous: ' + name);
    targets.push(matches[0]);
  }
}
const targetKeys = new Set(targets.map((entry) => entry.collection + ':' + entry.component.name));
if (targetKeys.size !== targets.length) throw new Error('DigitalOcean target bindings contain duplicates');
const nextSpec = { ...current.spec };
for (const collection of collections) {
  if (!Array.isArray(current.spec[collection])) continue;
  nextSpec[collection] = current.spec[collection].map((component) => {
    if (!targetKeys.has(collection + ':' + component.name)) return component;
    const updated = { ...component, image: { registry_type: 'DOCR', registry, repository, tag: sha, deploy_on_push: { enabled: false } } };
    delete updated.github; delete updated.git; delete updated.gitlab; delete updated.bitbucket;
    return updated;
  });
}
const update = await api('PUT', '/v2/apps/' + encodeURIComponent(appId), { spec: nextSpec });
const deploymentId = update.app?.in_progress_deployment?.id || update.app?.active_deployment?.id;
if (!deploymentId) throw new Error('DigitalOcean returned no deployment id');
const failures = new Set(['ERROR', 'CANCELED', 'SUPERSEDED']);
for (let attempt = 0; attempt < 120; attempt++) {
  const deployment = (await api('GET', '/v2/apps/' + encodeURIComponent(appId) + '/deployments/' + encodeURIComponent(deploymentId))).deployment;
  const phase = String(deployment?.phase || '').toUpperCase();
  if (phase === 'ACTIVE') break;
  if (failures.has(phase)) throw new Error('DigitalOcean deployment entered ' + phase);
  if (attempt === 119) throw new Error('DigitalOcean deployment did not become ACTIVE');
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
const finalApp = (await api('GET', '/v2/apps/' + encodeURIComponent(appId))).app;
if (finalApp?.active_deployment?.id !== deploymentId || String(finalApp.active_deployment.phase).toUpperCase() !== 'ACTIVE') throw new Error('DigitalOcean did not report the exact deployment active');
const finalComponents = collections.flatMap((collection) => (finalApp.spec?.[collection] || []).map((component) => ({ collection, component })));
for (const key of targetKeys) {
  const [collection, name] = key.split(':');
  const matches = finalComponents.filter((entry) => entry.collection === collection && entry.component.name === name);
  const deployed = matches[0]?.component?.image;
  if (matches.length !== 1 || deployed?.registry_type !== 'DOCR' || deployed?.registry !== registry || deployed?.repository !== repository || deployed?.tag !== sha) throw new Error('DigitalOcean component did not converge to exact SHA: ' + key);
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'digitalocean', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments: [{ appId, deploymentId }] }) + '\\n', { mode: 0o600 });
`;
}

export function buildDigitalOceanPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const appIds = appIdsFromBindings(target.providerServiceIds);
  if (appIds.length > 1) throw new Error(`DigitalOcean target ${target.environmentName} spans multiple apps`);
  const appId = target.providerProjectId ?? appIds[0];
  if (!appId || (appIds[0] && appIds[0] !== appId)) throw new Error(`DigitalOcean binding for ${target.environmentName} is incomplete or inconsistent`);
  const registry = registryFromImageBindings(target.providerImageUris ?? []);
  return {
    version: 1,
    provider: 'digitalocean',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      { name: 'DIGITALOCEAN_TOKEN', source: { kind: 'connection', provider: 'digitalocean', credentialKey: 'apiToken' }, secret: true },
      { name: 'DIGITALOCEAN_APP_ID', source: { kind: 'literal', value: appId }, secret: false },
      { name: 'DIGITALOCEAN_REGISTRY', source: { kind: 'literal', value: registry }, secret: false },
      { name: 'DIGITALOCEAN_TARGET_BINDINGS', source: { kind: 'literal', value: JSON.stringify([...target.providerServiceIds].sort()) }, secret: false },
      { name: 'DIGITALOCEAN_TARGET_NAMES', source: { kind: 'literal', value: JSON.stringify([...target.serviceNames].sort()) }, secret: false },
    ],
    runtime: { path: DIGITALOCEAN_PORTABLE_RUNTIME_PATH, content: buildDigitalOceanPortableRuntime() },
  };
}
