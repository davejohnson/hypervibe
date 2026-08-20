import type {
  BranchDeployTarget,
  PortableCiDeployRecipe,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  parseFlyOrganizationBinding,
  parseFlyServiceBinding,
} from './fly.binding.js';

export const FLY_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/fly-deploy.mjs';

export function buildFlyPortableRuntime(): string {
  return `import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const required = ['FLY_API_TOKEN', 'FLY_ORGANIZATION_SLUG', 'FLY_SERVICE_BINDINGS_JSON', 'FLY_REGISTRY_APP', 'CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (!process.env[key]) throw new Error(key + ' is required');
const sha = (await readFile('.hypervibe-deploy-sha', 'utf8')).trim().toLowerCase();
const sourceImage = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build artifacts are invalid');
const organization = process.env.FLY_ORGANIZATION_SLUG.trim();
const registryApp = process.env.FLY_REGISTRY_APP.trim();
if (!/^(?:personal|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(organization)) throw new Error('FLY_ORGANIZATION_SLUG is invalid');
if (!/^[a-z0-9][a-z0-9-]*$/.test(registryApp)) throw new Error('FLY_REGISTRY_APP is invalid');
let rawBindings;
try { rawBindings = JSON.parse(process.env.FLY_SERVICE_BINDINGS_JSON); } catch { throw new Error('FLY_SERVICE_BINDINGS_JSON must be JSON'); }
if (!Array.isArray(rawBindings) || rawBindings.length === 0 || rawBindings.some((value) => typeof value !== 'string')) throw new Error('At least one Fly.io service binding is required');
const bindings = rawBindings.map((value) => {
  if (!value.startsWith('flyapp:v1:')) throw new Error('Invalid Fly.io service binding');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value.slice('flyapp:v1:'.length), 'base64url').toString('utf8')); } catch { throw new Error('Invalid Fly.io service binding payload'); }
  if (parsed?.version !== 1 || parsed.organizationSlug !== organization || typeof parsed.appId !== 'string' || typeof parsed.appName !== 'string' || typeof parsed.machineId !== 'string') throw new Error('Fly.io service binding is outside the reviewed target');
  return parsed;
});
if (new Set(bindings.map((binding) => binding.appId)).size !== bindings.length) throw new Error('Fly.io service bindings contain duplicate Apps');
if (!bindings.some((binding) => binding.appName === registryApp)) throw new Error('FLY_REGISTRY_APP is not one of the reviewed App bindings');

const docker = './.hypervibe-docker';
function dockerInput(args, input) { execFileSync(docker, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); }
dockerInput(['login', process.env.CI_REGISTRY, '--username', process.env.CI_REGISTRY_USER, '--password-stdin'], process.env.CI_REGISTRY_PASSWORD);
execFileSync(docker, ['pull', sourceImage], { stdio: 'inherit' });
dockerInput(['login', 'registry.fly.io', '--username', 'x', '--password-stdin'], process.env.FLY_API_TOKEN);
const taggedImage = 'registry.fly.io/' + registryApp + ':' + sha;
execFileSync(docker, ['tag', sourceImage, taggedImage], { stdio: 'inherit' });
execFileSync(docker, ['push', taggedImage], { stdio: 'inherit' });
const repoDigestsText = execFileSync(docker, ['image', 'inspect', '--format={{json .RepoDigests}}', taggedImage], { encoding: 'utf8' }).trim();
let repoDigests;
try { repoDigests = JSON.parse(repoDigestsText); } catch { throw new Error('Docker returned invalid registry digest evidence'); }
const prefix = 'registry.fly.io/' + registryApp + '@';
const exactDigests = Array.isArray(repoDigests) ? repoDigests.filter((value) => typeof value === 'string' && value.startsWith(prefix)) : [];
if (exactDigests.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(exactDigests[0].slice(prefix.length))) throw new Error('Fly.io registry did not return one immutable image digest');
const digest = exactDigests[0].slice(prefix.length);
const image = prefix + digest;
execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
execFileSync(docker, ['logout', 'registry.fly.io'], { stdio: 'ignore' });

async function fly(method, path, body, description) {
  const response = await fetch('https://api.machines.dev' + path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + process.env.FLY_API_TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('Fly.io returned non-JSON during ' + description); }
  if (!response.ok) throw new Error('Fly.io API HTTP ' + response.status + ' during ' + description);
  return payload;
}

const deployments = [];
for (const binding of bindings) {
  const app = await fly('GET', '/v1/apps/' + encodeURIComponent(binding.appName), undefined, 'App observation');
  if (app?.id !== binding.appId || app?.name !== binding.appName || app?.organization?.slug !== organization) throw new Error('Fly.io App identity changed for ' + binding.appName);
  const machines = await fly('GET', '/v1/apps/' + encodeURIComponent(binding.appName) + '/machines', undefined, 'Machine observation');
  const exact = Array.isArray(machines) ? machines.filter((machine) => machine?.id === binding.machineId && machine?.config?.metadata?.hypervibe_managed === 'true') : [];
  if (!Array.isArray(machines) || machines.length !== 1 || exact.length !== 1) throw new Error('Fly.io App ' + binding.appName + ' does not contain only the exact reviewed Hypervibe Machine');
  const machine = exact[0];
  if (!machine.id || !machine.instance_id || !machine.config) throw new Error('Fly.io Machine identity or configuration is incomplete');
  const config = { ...machine.config, image, metadata: { ...(machine.config.metadata || {}), hypervibe_git_sha: sha, hypervibe_repository: process.env.HYPERVIBE_REPOSITORY } };
  const updated = await fly('POST', '/v1/apps/' + encodeURIComponent(binding.appName) + '/machines/' + encodeURIComponent(machine.id), { config, current_version: machine.instance_id, skip_launch: false }, 'exact Machine update');
  if (updated?.id !== machine.id) throw new Error('Fly.io updated an unexpected Machine identity');
  let observed;
  for (let attempt = 1; attempt <= 120; attempt++) {
    observed = await fly('GET', '/v1/apps/' + encodeURIComponent(binding.appName) + '/machines/' + encodeURIComponent(machine.id), undefined, 'Machine convergence observation');
    const state = String(observed?.state || '').toLowerCase();
    if (['destroyed', 'failed'].includes(state)) throw new Error('Fly.io Machine ' + machine.id + ' entered terminal state ' + state);
    const checks = Array.isArray(observed?.checks) ? observed.checks : [];
    const checksReady = checks.every((check) => ['passing', 'warning'].includes(String(check?.status || '').toLowerCase()));
    if (state === 'started' && checksReady) break;
    if (attempt === 120) throw new Error('Fly.io Machine ' + machine.id + ' did not become healthy before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const observedDigest = String(observed?.image_ref?.digest || '').toLowerCase();
  if (observed?.id !== machine.id || observed?.config?.metadata?.hypervibe_git_sha !== sha || observed?.config?.metadata?.hypervibe_repository !== process.env.HYPERVIBE_REPOSITORY || (observedDigest !== digest && observed?.config?.image !== image)) throw new Error('Fly.io Machine ' + machine.id + ' did not converge to the exact image digest');
  deployments.push({ appId: app.id, machineId: machine.id, image, digest });
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'fly', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildFlyPortableRecipe(
  target: BranchDeployTarget
): PortableCiDeployRecipe {
  if (target.providerServiceIds.length === 0) {
    throw new Error(
      `Fly.io bindings for ${target.environmentName} are incomplete; apply hosting first, then re-plan CI`
    );
  }
  const bindings = target.providerServiceIds.map(parseFlyServiceBinding);
  if (bindings.some((binding) => !binding.machineId)) {
    throw new Error(
      `Fly.io deploy target ${target.environmentName} is missing a reviewed Machine identity.`
    );
  }
  const organizations = new Set(bindings.map((binding) => binding.organizationSlug));
  if (organizations.size !== 1) {
    throw new Error(
      `Fly.io deploy target ${target.environmentName} contains Apps from multiple organizations.`
    );
  }
  const organization = target.providerProjectId
    ? parseFlyOrganizationBinding(target.providerProjectId)
    : bindings[0]!.organizationSlug;
  if (bindings.some((binding) => binding.organizationSlug !== organization)) {
    throw new Error('A Fly.io service binding does not belong to the target organization.');
  }
  if (new Set(bindings.map((binding) => binding.appId)).size !== bindings.length) {
    throw new Error('Fly.io deploy target contains duplicate App bindings.');
  }
  return {
    version: 1,
    provider: 'fly',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      {
        name: 'FLY_API_TOKEN',
        source: { kind: 'connection', provider: 'fly', credentialKey: 'apiToken' },
        secret: true,
      },
      {
        name: 'FLY_ORGANIZATION_SLUG',
        source: { kind: 'literal', value: organization },
        secret: false,
      },
      {
        name: 'FLY_SERVICE_BINDINGS_JSON',
        source: {
          kind: 'literal',
          value: JSON.stringify([...target.providerServiceIds].sort()),
        },
        secret: false,
      },
      {
        name: 'FLY_REGISTRY_APP',
        source: { kind: 'literal', value: bindings[0]!.appName },
        secret: false,
      },
    ],
    runtime: {
      path: FLY_PORTABLE_RUNTIME_PATH,
      content: buildFlyPortableRuntime(),
    },
  };
}
