import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';
import { parseVercelServiceBinding } from './vercel.binding.js';

export const VERCEL_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/vercel-deploy.mjs';

export function buildVercelPortableRuntime(): string {
  return `import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { writeFile } from 'node:fs/promises';

const required = ['VERCEL_ACCESS_TOKEN', 'VERCEL_SCOPE_BINDING', 'VERCEL_PROJECT_IDS_JSON', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (!process.env[key]) throw new Error(key + ' is required');
const token = process.env.VERCEL_ACCESS_TOKEN.trim();
const deploySha = readFileSync('.hypervibe-deploy-sha', 'utf8').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(deploySha)) throw new Error('Deploy SHA artifact is invalid');
const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
if (checkedOut !== deploySha) throw new Error('Checked-out source does not match the reviewed deploy SHA');
const scopeMatch = process.env.VERCEL_SCOPE_BINDING.trim().match(/^(team|user):(.+)$/);
if (!scopeMatch) throw new Error('VERCEL_SCOPE_BINDING must be team:<id> or user:<id>');
const [, scopeKind, scopeId] = scopeMatch;
let projectIds;
try { projectIds = JSON.parse(process.env.VERCEL_PROJECT_IDS_JSON); } catch { throw new Error('VERCEL_PROJECT_IDS_JSON must be JSON'); }
if (!Array.isArray(projectIds) || projectIds.length === 0 || projectIds.some((id) => typeof id !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(id))) {
  throw new Error('VERCEL_PROJECT_IDS_JSON must contain bound Vercel project IDs');
}
projectIds = [...new Set(projectIds)];
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
function url(path, query = {}) {
  const value = new URL(path, 'https://api.vercel.com');
  if (scopeKind === 'team') value.searchParams.set('teamId', scopeId);
  for (const [key, entry] of Object.entries(query)) if (entry !== undefined) value.searchParams.set(key, String(entry));
  return value;
}
async function request(method, path, options = {}) {
  const attempts = options.retry === false ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url(path, options.query), {
      method,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
      await response.text();
      await delay(Math.min(1000 * (2 ** attempt), 15000));
      continue;
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : undefined; } catch { throw new Error('Vercel returned non-JSON for ' + path); }
    if (!response.ok) {
      const error = new Error('Vercel API HTTP ' + response.status + ' for ' + path);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
}
const inventory = execFileSync('git', ['ls-files', '-z', '--cached'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).toString('utf8').split('\\0').filter(Boolean);
if (inventory.length === 0) throw new Error('The checked-out commit contains no tracked files');
const workspace = resolve('.');
const files = [];
const contents = new Map();
for (const relative of inventory) {
  if (relative.startsWith('/') || relative.split(/[\\\\/]/).includes('..')) throw new Error('Unsafe tracked path');
  const absolute = resolve(workspace, relative);
  if (absolute !== workspace && !absolute.startsWith(workspace + sep)) throw new Error('Tracked path escaped repository');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Vercel deploys require tracked regular files: ' + relative);
  const content = readFileSync(absolute);
  const sha = createHash('sha1').update(content).digest('hex');
  files.push({ file: relative, sha, size: content.length });
  contents.set(sha, content);
}
for (const [sha, content] of contents) {
  const response = await fetch(url('/v2/files'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length), 'x-vercel-digest': sha },
    body: content,
  });
  if (!response.ok) throw new Error('Vercel file upload failed with HTTP ' + response.status);
}
async function findExact(projectId) {
  const listed = await request('GET', '/v7/deployments', { query: { projectId, target: 'production', limit: 100 } });
  const match = (listed?.deployments || []).filter((candidate) => candidate?.projectId === projectId && candidate?.target === 'production' && candidate?.meta?.hypervibeGitSha === deploySha && candidate?.meta?.hypervibeRepository === process.env.HYPERVIBE_REPOSITORY).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
  const id = match?.uid || match?.id;
  return id ? request('GET', '/v13/deployments/' + encodeURIComponent(id)) : null;
}
const deployments = [];
for (const projectId of projectIds) {
  const project = await request('GET', '/v9/projects/' + encodeURIComponent(projectId));
  if (project?.id !== projectId || project?.accountId !== scopeId || project.link) throw new Error('Vercel project escaped the source-less applied binding');
  let deployment = await findExact(projectId);
  if (!deployment) {
    try {
      deployment = await request('POST', '/v13/deployments', { retry: false, body: {
        name: project.name, project: project.id, files, target: 'production',
        meta: { hypervibeGitSha: deploySha, hypervibeRepository: process.env.HYPERVIBE_REPOSITORY },
      }});
    } catch (error) {
      if (![429, 500, 502, 503, 504].includes(error?.status)) throw error;
      for (let attempt = 0; attempt < 10 && !deployment; attempt++) { await delay(2000); deployment = await findExact(projectId); }
      if (!deployment) throw error;
    }
  }
  const id = deployment?.id || deployment?.uid;
  if (!id) throw new Error('Vercel deployment returned no durable id');
  let observed = deployment;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (observed.projectId !== projectId || observed.target !== 'production' || observed.meta?.hypervibeGitSha !== deploySha || observed.meta?.hypervibeRepository !== process.env.HYPERVIBE_REPOSITORY) throw new Error('Vercel deployment provenance changed');
    if (observed.readyState === 'READY') break;
    if (['BLOCKED', 'CANCELED', 'ERROR'].includes(observed.readyState)) throw new Error('Vercel deployment entered ' + observed.readyState);
    if (attempt === 179) throw new Error('Vercel deployment did not reach READY');
    await delay(2000);
    observed = await request('GET', '/v13/deployments/' + encodeURIComponent(id));
  }
  deployments.push({ projectId, deploymentId: id, url: observed.url ? 'https://' + observed.url : null });
}
await writeFile('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'vercel', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha: deploySha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildVercelPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const bindings = target.providerServiceIds.map(parseVercelServiceBinding);
  if (target.providerProjectId && bindings.some((binding) => binding.scope.binding !== target.providerProjectId)) {
    throw new Error('A Vercel service binding does not belong to the target account scope');
  }
  const projectIds = [...new Set(bindings.map((binding) => binding.projectId))];
  if (!target.providerProjectId || projectIds.length === 0) {
    throw new Error(`Vercel bindings for ${target.environmentName} are incomplete; apply hosting first`);
  }
  return {
    version: 1,
    provider: 'vercel',
    kind: 'repository',
    runnerCapabilities: ['linux-amd64'],
    values: [
      { name: 'VERCEL_ACCESS_TOKEN', source: { kind: 'connection', provider: 'vercel', credentialKey: 'accessToken' }, secret: true },
      { name: 'VERCEL_SCOPE_BINDING', source: { kind: 'literal', value: target.providerProjectId }, secret: false },
      { name: 'VERCEL_PROJECT_IDS_JSON', source: { kind: 'literal', value: JSON.stringify(projectIds.sort()) }, secret: false },
    ],
    runtime: { path: VERCEL_PORTABLE_RUNTIME_PATH, content: buildVercelPortableRuntime() },
  };
}
