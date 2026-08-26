import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';

export const CLOUDRUN_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/cloudrun-deploy.mjs';

export function buildCloudRunPortableRuntime(): string {
  return `import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const required = ['GCP_SERVICE_ACCOUNT_JSON_B64', 'GCP_PROJECT_ID', 'GCP_BOUND_PROJECT_ID', 'GCP_REGION', 'GCP_ARTIFACT_REPOSITORY', 'CLOUDRUN_SERVICE_NAMES', 'CLOUDRUN_JOB_NAMES', 'CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'CI_PROJECT_PATH', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (process.env[key] === undefined || process.env[key] === '') throw new Error(key + ' is required');
if (process.env.GCP_PROJECT_ID !== process.env.GCP_BOUND_PROJECT_ID) throw new Error('The verified GCP connection does not match the exact applied project binding');
let credentials;
try { credentials = JSON.parse(Buffer.from(process.env.GCP_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8')); } catch { throw new Error('GCP service-account credential is invalid'); }
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signer = createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  const assertion = unsigned + '.' + signer.sign(credentials.private_key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!response.ok) throw new Error('GCP token exchange failed with HTTP ' + response.status);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('GCP token exchange returned no token');
  return payload.access_token;
}
const token = await accessToken();
const auth = { Authorization: 'Bearer ' + token };
async function json(url, options = {}, description = url) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('GCP returned non-JSON during ' + description); }
  if (!response.ok) throw new Error(description + ' failed with HTTP ' + response.status);
  return payload;
}
const repository = process.env.GCP_ARTIFACT_REPOSITORY;
if (!/^[a-z][a-z0-9-]{0,62}$/.test(repository)) throw new Error('GCP artifact repository name is invalid');
const repoUrl = 'https://artifactregistry.googleapis.com/v1/projects/' + encodeURIComponent(process.env.GCP_PROJECT_ID) + '/locations/' + encodeURIComponent(process.env.GCP_REGION) + '/repositories/' + encodeURIComponent(repository);
const repo = await json(repoUrl, { headers: auth }, 'Artifact Registry observation');
if (repo.name !== 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/repositories/' + repository || repo.format !== 'DOCKER') throw new Error('Artifact Registry repository identity or format is inconsistent');
const sha = (await readFile('.hypervibe-deploy-sha', 'utf8')).trim().toLowerCase();
const sourceImage = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build artifacts are invalid');
const imageName = process.env.CI_PROJECT_PATH.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
const registry = process.env.GCP_REGION + '-docker.pkg.dev';
const image = registry + '/' + process.env.GCP_PROJECT_ID + '/' + repository + '/' + imageName + ':' + sha;
const docker = './.hypervibe-docker';
function dockerInput(args, input) { execFileSync(docker, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); }
dockerInput(['login', process.env.CI_REGISTRY, '--username', process.env.CI_REGISTRY_USER, '--password-stdin'], process.env.CI_REGISTRY_PASSWORD);
execFileSync(docker, ['pull', sourceImage], { stdio: 'inherit' });
dockerInput(['login', registry, '--username', 'oauth2accesstoken', '--password-stdin'], token);
execFileSync(docker, ['tag', sourceImage, image], { stdio: 'inherit' });
const pushed = execFileSync(docker, ['push', image], { encoding: 'utf8' });
process.stdout.write(pushed);
const digests = [...pushed.matchAll(/digest:\\s*(sha256:[0-9a-f]{64})/gi)].map((match) => match[1].toLowerCase());
if (new Set(digests).size !== 1) throw new Error('Artifact Registry push did not return one exact image digest');
const digest = digests[digests.length - 1];
const exactImage = image.replace(/:[^/:]+$/, '') + '@' + digest;
execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
execFileSync(docker, ['logout', registry], { stdio: 'ignore' });
const services = process.env.CLOUDRUN_SERVICE_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
const jobs = process.env.CLOUDRUN_JOB_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
if (services.length === 0 && jobs.length === 0) throw new Error('No bound Cloud Run service or job names were supplied');
const headers = { ...auth, 'Content-Type': 'application/json' };
async function waitOperation(operation, description) {
  if (!operation?.name?.includes('/operations/')) throw new Error(description + ' returned no operation identity');
  let current = operation;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (current.done) { if (current.error) throw new Error(description + ' operation failed'); return; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    current = await json('https://run.googleapis.com/v2/' + current.name, { headers: auth }, description + ' operation');
  }
  throw new Error(description + ' operation timed out');
}
function ready(resource) {
  const condition = resource?.terminalCondition || (resource?.conditions || []).find((entry) => entry.type === 'Ready');
  const state = condition?.state || condition?.status;
  return (state === 'CONDITION_SUCCEEDED' || state === 'True' || (!condition && resource?.uri)) && resource?.reconciling !== true;
}
async function waitReady(url, name, kind, expectedImage) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await json(url, { headers: auth }, 'Cloud Run ' + kind + ' observation');
    const container = kind === 'service' ? value?.template?.containers?.[0] : value?.template?.template?.containers?.[0];
    if (ready(value) && container?.image === expectedImage) return value;
    if (attempt === 119) throw new Error('Cloud Run ' + kind + ' ' + name + ' did not converge to the exact image');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const deployments = [];
for (const name of services) {
  const url = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(process.env.GCP_PROJECT_ID) + '/locations/' + encodeURIComponent(process.env.GCP_REGION) + '/services/' + encodeURIComponent(name);
  const current = await json(url, { headers: auth }, 'Cloud Run service lookup');
  if (current.name !== 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + name) throw new Error('Cloud Run returned a different service identity');
  const template = { ...(current.template || {}) };
  const containers = Array.isArray(template.containers) && template.containers.length ? [...template.containers] : [{}];
  containers[0] = { ...containers[0], image: exactImage };
  template.containers = containers;
  await waitOperation(await json(url + '?updateMask=template.containers', { method: 'PATCH', headers, body: JSON.stringify({ template }) }, 'Cloud Run service update'), 'Cloud Run service update');
  const observed = await waitReady(url, name, 'service', exactImage);
  deployments.push({ kind: 'service', name, imageDigest: digest, uri: observed.uri || null });
}
for (const name of jobs) {
  const url = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(process.env.GCP_PROJECT_ID) + '/locations/' + encodeURIComponent(process.env.GCP_REGION) + '/jobs/' + encodeURIComponent(name);
  const current = await json(url, { headers: auth }, 'Cloud Run job lookup');
  if (current.name !== 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + name) throw new Error('Cloud Run returned a different job identity');
  const template = { ...(current.template || {}) };
  const task = { ...(template.template || {}) };
  const containers = Array.isArray(task.containers) && task.containers.length ? [...task.containers] : [{}];
  containers[0] = { ...containers[0], image: exactImage };
  task.containers = containers; template.template = task;
  await waitOperation(await json(url + '?updateMask=template.template.containers', { method: 'PATCH', headers, body: JSON.stringify({ template }) }, 'Cloud Run job update'), 'Cloud Run job update');
  await waitReady(url, name, 'job', exactImage);
  deployments.push({ kind: 'job', name, imageDigest: digest });
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'cloudrun', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildCloudRunPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const projectId = target.providerProjectId?.trim();
  const region = target.providerRegion?.trim();
  const services = [...new Set(target.providerServiceIds)].sort();
  const jobs = [...new Set(target.providerJobNames ?? [])].sort();
  if (!projectId || !region || (target.needsServiceNames && services.length === 0) || (target.needsJobNames && jobs.length === 0) || (services.length === 0 && jobs.length === 0)) {
    throw new Error(`Cloud Run bindings for ${target.environmentName} are incomplete; apply hosting first`);
  }
  return {
    version: 1,
    provider: 'cloudrun',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      { name: 'GCP_SERVICE_ACCOUNT_JSON_B64', source: { kind: 'connection', provider: 'cloudrun', credentialKey: 'credentials' }, secret: true, transform: 'base64' },
      { name: 'GCP_PROJECT_ID', source: { kind: 'connection', provider: 'cloudrun', credentialKey: 'projectId' }, secret: false },
      { name: 'GCP_BOUND_PROJECT_ID', source: { kind: 'literal', value: projectId }, secret: false },
      { name: 'GCP_REGION', source: { kind: 'literal', value: region }, secret: false },
      { name: 'GCP_ARTIFACT_REPOSITORY', source: { kind: 'literal', value: 'infraprint' }, secret: false },
      { name: 'CLOUDRUN_SERVICE_NAMES', source: { kind: 'literal', value: services.join(',') }, secret: false },
      { name: 'CLOUDRUN_JOB_NAMES', source: { kind: 'literal', value: jobs.join(',') }, secret: false },
    ],
    runtime: { path: CLOUDRUN_PORTABLE_RUNTIME_PATH, content: buildCloudRunPortableRuntime() },
  };
}
