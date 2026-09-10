import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';
import {
  buildCloudRunReleaseRuntime,
  cloudRunContainerBuildStartCommand,
  reviewedCloudRunRuntimeResources,
} from './cloudrun-ci.release-runtime.js';
import {
  CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION,
  cloudRunReleaseCommandHash,
} from './cloudrun-release-command.js';

export const CLOUDRUN_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/cloudrun-deploy.mjs';

export function buildCloudRunPortableRuntime(): string {
  return `import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const rollback = process.env.HYPERVIBE_ROLLBACK === 'true';
const required = ['GCP_SERVICE_ACCOUNT_JSON_B64', 'GCP_PROJECT_ID', 'GCP_BOUND_PROJECT_ID', 'GCP_REGION', 'GCP_ARTIFACT_REPOSITORY', 'CLOUDRUN_SERVICE_NAMES', 'CLOUDRUN_JOB_NAMES', 'CLOUDRUN_RELEASE_COMMANDS_B64', 'CLOUDRUN_RUNTIME_RESOURCES_B64', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT', 'HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT', 'HYPERVIBE_RELEASE_SERVICES', 'HYPERVIBE_RELEASE_PROVIDER_IDENTITY', 'HYPERVIBE_RELEASE_PROVIDER_RESOURCES'];
required.push(...(rollback
  ? ['CI_API_V4_URL', 'CI_PROJECT_ID', 'CI_JOB_TOKEN', 'HYPERVIBE_SOURCE_ARTIFACT_ID', 'HYPERVIBE_SOURCE_PIPELINE_ID']
  : ['CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'CI_PROJECT_PATH']));
const emptyListValues = new Set(['CLOUDRUN_SERVICE_NAMES', 'CLOUDRUN_JOB_NAMES']);
for (const key of required) if (process.env[key] === undefined || (!emptyListValues.has(key) && process.env[key] === '')) throw new Error(key + ' is required');
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
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Build SHA artifact is invalid');
const registry = process.env.GCP_REGION + '-docker.pkg.dev';
const services = process.env.CLOUDRUN_SERVICE_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
const jobs = process.env.CLOUDRUN_JOB_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
const providerResources = [...services.map((name) => 'service:' + name), ...jobs.map((name) => 'job:' + name)].sort();
let releaseCommands;
try { releaseCommands = JSON.parse(Buffer.from(process.env.CLOUDRUN_RELEASE_COMMANDS_B64, 'base64').toString('utf8')); } catch { throw new Error('CLOUDRUN_RELEASE_COMMANDS_B64 is invalid'); }
if (services.length === 0 && jobs.length === 0) throw new Error('No bound Cloud Run service or job names were supplied');
function parseJson(name) {
  try { return JSON.parse(process.env[name]); } catch { throw new Error(name + ' is invalid'); }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const expectedServices = [...parseJson('HYPERVIBE_RELEASE_SERVICES')].sort();
const expectedProviderIdentity = parseJson('HYPERVIBE_RELEASE_PROVIDER_IDENTITY');
const expectedProviderResources = [...parseJson('HYPERVIBE_RELEASE_PROVIDER_RESOURCES')].sort();
if (!same(expectedProviderResources, providerResources)) throw new Error('Cloud Run release resources differ from the reviewed bindings');
if (expectedProviderIdentity?.scope?.projectId !== process.env.GCP_PROJECT_ID || expectedProviderIdentity?.scope?.region !== process.env.GCP_REGION || expectedProviderIdentity?.region !== process.env.GCP_REGION) throw new Error('Cloud Run release provider identity differs from the reviewed project and region');
let exactImage;
let digest;
if (rollback) {
  const artifactMatch = process.env.HYPERVIBE_SOURCE_ARTIFACT_ID.match(/^([1-9]\\d*):\\.hypervibe-release\\.json$/);
  if (!artifactMatch || !/^[1-9]\\d*$/.test(process.env.HYPERVIBE_SOURCE_PIPELINE_ID) || !/^[1-9]\\d*$/.test(process.env.CI_PROJECT_ID)) throw new Error('Cloud Run rollback source evidence identity is invalid');
  const sourceJobId = artifactMatch[1];
  const artifactUrl = process.env.CI_API_V4_URL.replace(/\\/+$/, '') + '/projects/' + encodeURIComponent(process.env.CI_PROJECT_ID) + '/jobs/' + encodeURIComponent(sourceJobId) + '/artifacts/.hypervibe-release.json';
  const artifactResponse = await fetch(artifactUrl, { headers: { Accept: 'application/json', 'JOB-TOKEN': process.env.CI_JOB_TOKEN } });
  if (!artifactResponse.ok) throw new Error('Cloud Run rollback release evidence lookup failed with HTTP ' + artifactResponse.status);
  let evidence;
  try { evidence = await artifactResponse.json(); } catch { throw new Error('Cloud Run rollback release evidence is malformed'); }
  const evidenceServices = Array.isArray(evidence?.services) ? [...evidence.services].sort() : null;
  const evidenceResources = Array.isArray(evidence?.providerResources) ? [...evidence.providerResources].sort() : null;
  const evidenceImage = String(evidence?.imageUri || '').trim().toLowerCase();
  const imagePrefix = registry + '/' + process.env.GCP_PROJECT_ID + '/' + repository + '/';
  const deploymentResources = Array.isArray(evidence?.deployments)
    ? evidence.deployments.map((deployment) => deployment?.kind + ':' + deployment?.name).sort()
    : null;
  if (
    evidence?.version !== 2
    || evidence.provider !== 'cloudrun'
    || evidence.repository !== process.env.HYPERVIBE_REPOSITORY
    || evidence.environment !== process.env.HYPERVIBE_ENVIRONMENT
    || String(evidence.sha || '').toLowerCase() !== sha
    || evidence.programFingerprint !== process.env.HYPERVIBE_PROGRAM_FINGERPRINT
    || evidence.deploymentContractFingerprint !== process.env.HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT
    || !same(evidenceServices, expectedServices)
    || !same(evidence.providerIdentity, expectedProviderIdentity)
    || !same(evidenceResources, providerResources)
    || !same(deploymentResources, providerResources)
    || String(evidence?.ci?.projectId || '') !== process.env.CI_PROJECT_ID
    || String(evidence?.ci?.pipelineId || '') !== process.env.HYPERVIBE_SOURCE_PIPELINE_ID
    || String(evidence?.ci?.jobId || '') !== sourceJobId
    || !evidenceImage.startsWith(imagePrefix)
    || !/^[^\\s@]+@sha256:[0-9a-f]{64}$/.test(evidenceImage)
    || evidence.deployments.some((deployment) => deployment?.imageUri !== evidenceImage || deployment?.imageDigest !== evidenceImage.split('@')[1])
  ) throw new Error('Cloud Run rollback release evidence does not match the exact repository, environment, provider project, region, services, SHA, program, and immutable image');
  exactImage = evidenceImage;
  digest = evidenceImage.split('@')[1];
} else {
  const sourceImage = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
  if (!/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build image artifact is invalid');
  const imageName = process.env.CI_PROJECT_PATH.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
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
  digest = digests[digests.length - 1];
  exactImage = image.replace(/:[^/:]+$/, '') + '@' + digest;
  execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
  execFileSync(docker, ['logout', registry], { stdio: 'ignore' });
}
const headers = { ...auth, 'Content-Type': 'application/json' };
async function waitOperation(operation, description) {
  const operationPrefix = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/operations/';
  if (!operation?.name?.startsWith(operationPrefix) || operation.name.length <= operationPrefix.length) throw new Error(description + ' returned a different operation identity');
  const exactOperationName = operation.name;
  let current = operation;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (current.name !== exactOperationName) throw new Error(description + ' operation lookup returned a different identity');
    if (current.done) { if (current.error) throw new Error(description + ' operation failed'); return current; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    current = await json('https://run.googleapis.com/v2/' + exactOperationName, { headers: auth }, description + ' operation');
  }
  throw new Error(description + ' operation timed out');
}
${buildCloudRunReleaseRuntime()}
const runtimeResources = cloudRunRuntimeResourcesFromBase64(
  process.env.CLOUDRUN_RUNTIME_RESOURCES_B64,
  services,
  jobs
);
function ready(resource) {
  const condition = resource?.terminalCondition || (resource?.conditions || []).find((entry) => entry.type === 'Ready');
  const state = condition?.state || condition?.status;
  return (state === 'CONDITION_SUCCEEDED' || state === 'True' || (!condition && resource?.uri)) && resource?.reconciling !== true;
}
async function waitReady(url, name, kind, expectedImage, runtimeResource) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await json(url, { headers: auth }, 'Cloud Run ' + kind + ' observation');
    const container = kind === 'service' ? value?.template?.containers?.[0] : value?.template?.template?.containers?.[0];
    if (ready(value) && container?.image === expectedImage) {
      const expectedName = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/' + (kind === 'service' ? 'services/' : 'jobs/') + name;
      if (value.name !== expectedName) throw new Error('Cloud Run returned a different ' + kind + ' identity');
      const mismatch = cloudRunRuntimeMismatch(container, runtimeResource);
      if (mismatch) throw new Error('Cloud Run ' + kind + ' ' + name + ' did not converge to the exact reviewed ' + mismatch);
      return value;
    }
    if (attempt === 119) throw new Error('Cloud Run ' + kind + ' ' + name + ' did not converge to the exact image');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const deployments = [];
if (!rollback) {
  await runCloudRunReleaseCommands({
    releases: releaseCommands,
    imageUri: exactImage,
    projectId: process.env.GCP_PROJECT_ID,
    region: process.env.GCP_REGION,
    headers,
    authHeaders: auth,
    getJson: json,
    waitOperation,
  });
}
const releaseHashes = new Map(releaseCommands.map((release) => [release.providerServiceId, release.commandHash]));
for (const name of services) {
  const url = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(process.env.GCP_PROJECT_ID) + '/locations/' + encodeURIComponent(process.env.GCP_REGION) + '/services/' + encodeURIComponent(name);
  const current = await json(url, { headers: auth }, 'Cloud Run service lookup');
  if (current.name !== 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + name) throw new Error('Cloud Run returned a different service identity');
  const runtimeResource = cloudRunRuntimeResource(runtimeResources, 'service', name);
  const template = { ...(current.template || {}) };
  const containers = Array.isArray(template.containers) && template.containers.length ? [...template.containers] : [{}];
  containers[0] = cloudRunContainerWithRuntime(containers[0], exactImage, runtimeResource);
  template.containers = containers;
  const releaseHash = rollback ? undefined : releaseHashes.get(name);
  const annotations = releaseHash ? { ...(current.annotations || {}), [${JSON.stringify(CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION)}]: releaseHash } : current.annotations;
  const updateMask = releaseHash ? 'annotations,template.containers' : 'template.containers';
  await waitOperation(await json(url + '?updateMask=' + updateMask, { method: 'PATCH', headers, body: JSON.stringify({ ...(annotations ? { annotations } : {}), template }) }, 'Cloud Run service update'), 'Cloud Run service update');
  const observed = await waitReady(url, name, 'service', exactImage, runtimeResource);
  deployments.push({ kind: 'service', name, imageUri: exactImage, imageDigest: digest, uri: observed.uri || null });
}
for (const name of jobs) {
  const url = 'https://run.googleapis.com/v2/projects/' + encodeURIComponent(process.env.GCP_PROJECT_ID) + '/locations/' + encodeURIComponent(process.env.GCP_REGION) + '/jobs/' + encodeURIComponent(name);
  const current = await json(url, { headers: auth }, 'Cloud Run job lookup');
  if (current.name !== 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + name) throw new Error('Cloud Run returned a different job identity');
  const runtimeResource = cloudRunRuntimeResource(runtimeResources, 'job', name);
  const template = { ...(current.template || {}) };
  const task = { ...(template.template || {}) };
  const containers = Array.isArray(task.containers) && task.containers.length ? [...task.containers] : [{}];
  containers[0] = cloudRunContainerWithRuntime(containers[0], exactImage, runtimeResource);
  task.containers = containers; template.template = task;
  await waitOperation(await json(url + '?updateMask=template.template.containers', { method: 'PATCH', headers, body: JSON.stringify({ template }) }, 'Cloud Run job update'), 'Cloud Run job update');
  await waitReady(url, name, 'job', exactImage, runtimeResource);
  deployments.push({ kind: 'job', name, imageUri: exactImage, imageDigest: digest });
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'cloudrun', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, providerResources, imageUri: exactImage, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildCloudRunPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const projectId = target.providerScope?.projectId?.trim();
  const region = target.providerRegion?.trim();
  const artifactRepository = target.providerScope?.artifactRepository?.trim() || 'hypervibe';
  const services = [...new Set(target.providerServiceIds)].sort();
  const jobs = [...new Set(target.providerJobNames ?? [])].sort();
  const providerResources = [
    ...services.map((name) => `service:${name}`),
    ...jobs.map((name) => `job:${name}`),
  ].sort();
  const releaseCommands = target.releaseCommands ?? [];
  const runtimeResources = reviewedCloudRunRuntimeResources(target);
  const releaseCommandsValid = releaseCommands.every((release) => (
    Boolean(release.providerServiceId)
    && Boolean(release.jobName)
    && services.includes(release.providerServiceId!)
    && Boolean(release.command.trim())
  ));
  if (!projectId || !region || target.providerScope?.region !== region || !/^[a-z][a-z0-9-]{0,62}$/.test(artifactRepository) || !releaseCommandsValid || (target.needsServiceNames && services.length === 0) || (target.needsJobNames && jobs.length === 0) || (services.length === 0 && jobs.length === 0) || providerResources.length !== target.serviceNames.length) {
    throw new Error(`Cloud Run bindings for ${target.environmentName} are incomplete; apply hosting first`);
  }
  const encodedReleaseCommands = Buffer.from(JSON.stringify(releaseCommands.map((release) => ({
    serviceName: release.serviceName,
    providerServiceId: release.providerServiceId!,
    jobName: release.jobName!,
    command: release.command,
    commandHash: cloudRunReleaseCommandHash(release.command),
  })))).toString('base64');
  const encodedRuntimeResources = Buffer.from(JSON.stringify(runtimeResources)).toString('base64');
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
      { name: 'GCP_ARTIFACT_REPOSITORY', source: { kind: 'literal', value: artifactRepository }, secret: false },
      { name: 'CLOUDRUN_SERVICE_NAMES', source: { kind: 'literal', value: services.join(',') }, secret: false },
      { name: 'CLOUDRUN_JOB_NAMES', source: { kind: 'literal', value: jobs.join(',') }, secret: false },
      { name: 'CLOUDRUN_RELEASE_COMMANDS_B64', source: { kind: 'literal', value: encodedReleaseCommands }, secret: false },
      { name: 'CLOUDRUN_RUNTIME_RESOURCES_B64', source: { kind: 'literal', value: encodedRuntimeResources }, secret: false },
    ],
    runtime: { path: CLOUDRUN_PORTABLE_RUNTIME_PATH, content: buildCloudRunPortableRuntime() },
    containerBuildStartCommand: cloudRunContainerBuildStartCommand(target),
    releaseEvidence: {
      providerResources,
      requiresImmutableImage: true,
    },
  };
}
