'use strict';
// Hypervibe-owned compatibility envelope. The application owns semantic tests.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const VERSION = __API_EVIDENCE_VERSION__;
const MAX_BYTES = __API_RELEASE_MAX_BYTES__;
const MAX_VERSIONS = __API_RELEASE_MAX_VERSIONS__;
const EVIDENCE_FILE = '__API_EVIDENCE_FILE__';
const SERVER_VERSION = __SERVER_EVIDENCE_VERSION__;
const SERVER_FILE = '__SERVER_EVIDENCE_FILE__';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  return JSON.stringify((function sort(item) { return Array.isArray(item) ? item.map(sort) : record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item; })(value));
}
function requireIdentity(value) {
  if (!record(value) || !/^[^\s/]+\/[^\s/]+$/.test(value.repository || '') || !/^[a-zA-Z0-9_-]+$/.test(value.environment || '')
    || !/^[a-f0-9]{40}$/.test(value.sha || '') || !Number.isSafeInteger(value.runId) || value.runId < 1
    || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(value.workflow || '')) throw new Error('API release identity is incomplete.');
  return {repository: value.repository, environment: value.environment, sha: value.sha, runId: value.runId, workflow: value.workflow};
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(part => part === '..' || !part)) throw new Error('API contract path must remain inside the repository.');
  return value;
}
function safeFile(directory, name) {
  relative(name);
  let resolved = path.resolve(directory);
  for (const part of name.split('/')) {
    resolved = path.join(resolved, part);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error('API contract symbolic links are not supported.');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('API contract must be a bounded regular JSON file.');
  return resolved;
}
function readJson(directory, name) {
  return JSON.parse(fs.readFileSync(safeFile(directory, name), 'utf8'));
}
function validateContract(value) {
  if (!record(value)) throw new Error('API contract must be a JSON object.');
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!record(node)) return;
    if ('$id' in node || '$dynamicRef' in node || '$recursiveRef' in node || ('$ref' in node && (typeof node.$ref !== 'string' || !node.$ref.startsWith('#')))) throw new Error('API contracts must be self-contained; external or dynamic references are not supported.');
    Object.values(node).forEach(visit);
  }
  visit(value);
}
function normalizePolicy(value) {
  if (!record(value) || typeof value.service !== 'string' || !value.service || !record(value.versions) || !Object.keys(value.versions).length
    || !record(value.compatibility) || typeof value.compatibility.command !== 'string' || !value.compatibility.command.trim()) throw new Error('API policy requires a service, version ledger and compatibility command.');
  if (Object.keys(value.versions).length > MAX_VERSIONS) throw new Error('API version ledger exceeds the supported version limit.');
  const versions = {};
  const paths = new Set();
  for (const [name, version] of Object.entries(value.versions)) {
    if (!/^v[1-9]\d*$/.test(name) || !record(version) || typeof version.path !== 'string' || version.path !== '/' + name || paths.has(version.path)) throw new Error('API version paths must be explicit and unique.');
    paths.add(version.path);
    const status = version.status === undefined ? 'supported' : version.status;
    if (!['supported', 'deprecated', 'retired'].includes(status)) throw new Error('API version status is invalid.');
    if (status === 'retired' && (!record(version.retirement) || typeof version.retirement.id !== 'string' || !version.retirement.id.trim() || typeof version.retirement.reason !== 'string' || !version.retirement.reason.trim())) throw new Error('API retirement requires an explicit reviewed decision.');
    if (status !== 'retired' && version.retirement !== undefined) throw new Error('Only a retired API version may declare retirement.');
    versions[name] = {path: version.path, contract: relative(version.contract), status, ...(status === 'retired' ? {retirement: {id: version.retirement.id.trim(), reason: version.retirement.reason.trim()}} : {})};
  }
  const consumers = value.consumers || {};
  if (!record(consumers)) throw new Error('API consumer declarations are invalid.');
  for (const consumer of Object.values(consumers)) {
    if (!record(consumer) || !Array.isArray(consumer.versions) || !consumer.versions.length || consumer.versions.some(name => !versions[name] || versions[name].status === 'retired')) throw new Error('A declared API consumer requires an active version.');
  }
  return {service: value.service, versions, consumers, compatibility: {command: value.compatibility.command.trim(), workingDirectory: value.compatibility.workingDirectory === undefined ? '.' : value.compatibility.workingDirectory, ...(value.compatibility.installCommand ? {installCommand: value.compatibility.installCommand.trim()} : {})}};
}
function apiReleasePolicyHash(policy, runtime) {
  if (!record(policy) || !record(policy.compatibility)) throw new Error('Historical API policy is missing; a reviewed baseline migration is required.');
  const effective = {...policy, compatibility: {...policy.compatibility, ...(policy.compatibility.installCommand || runtime?.installCommand ? {installCommand: policy.compatibility.installCommand || runtime.installCommand} : {})}};
  return sha256(canonical(normalizePolicy(effective)));
}
function snapshotValues(directory, evidence) {
  return Object.fromEntries(Object.entries(evidence.versions || {}).map(([name, version]) => {
    if (!/^v[1-9]\d*$/.test(name) || version.snapshot !== 'contracts/' + name + '.json') throw new Error('API snapshot metadata is invalid.');
    return [version.snapshot, fs.readFileSync(safeFile(directory, version.snapshot))];
  }));
}
function validateSnapshotValues(evidence, snapshots) {
  if (!record(evidence.versions) || !Object.keys(evidence.versions).length) throw new Error('API baseline version ledger is missing.');
  normalizePolicy({service: evidence.service, versions: evidence.versions, consumers: evidence.consumers || {}, compatibility: {command: 'validate baseline'}});
  let totalBytes = Buffer.byteLength(JSON.stringify({...evidence, serverEvidenceSha256: evidence.serverEvidenceSha256 || '0'.repeat(64)}, null, 2) + '\n');
  for (const [name, version] of Object.entries(evidence.versions)) {
    if (!/^v[1-9]\d*$/.test(name) || !record(version) || version.snapshot !== 'contracts/' + name + '.json' || !/^[a-f0-9]{64}$/.test(version.contractHash || '')) throw new Error('API snapshot metadata is invalid.');
    const value = snapshots[version.snapshot];
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) throw new Error('API snapshot is missing.');
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    totalBytes += bytes.length;
    if (totalBytes > MAX_BYTES) throw new Error('API evidence snapshots exceed the supported aggregate size limit.');
    if (bytes.length > MAX_BYTES || sha256(bytes) !== version.contractHash) throw new Error('API snapshot hash does not match release evidence.');
    validateContract(JSON.parse(bytes.toString('utf8')));
  }
}
function validateSnapshots(directory, evidence) { validateSnapshotValues(evidence, snapshotValues(directory, evidence)); }
function validateApiReleaseEvidence(params) {
  const expected = requireIdentity(params.identity), evidence = params.manifest;
  if (!record(evidence) || evidence.version !== VERSION || Object.entries(expected).some(([key, value]) => evidence[key] !== value)
    || evidence.compatibility?.status !== 'passed' || evidence.compatibility?.claim !== 'project-command'
    || !/^[a-f0-9]{64}$/.test(evidence.compatibility?.commandHash || '') || !/^[a-f0-9]{64}$/.test(evidence.policyHash || '')
    || !/^[a-f0-9]{64}$/.test(params.serverEvidenceSha256 || '') || evidence.serverEvidenceSha256 !== params.serverEvidenceSha256) throw new Error('API baseline identity or compatibility evidence is invalid.');
  validateSnapshotValues(evidence, params.snapshots);
  return evidence;
}
function validateApiEvidence(directory, identity, serverEvidencePath) {
  const expected = requireIdentity(identity);
  let evidence;
  try { evidence = readJson(directory, EVIDENCE_FILE); } catch { throw new Error('API baseline companion evidence is missing or invalid.'); }
  if (evidence.version !== VERSION || Object.entries(expected).some(([key, value]) => evidence[key] !== value)
    || evidence.compatibility?.status !== 'passed' || evidence.compatibility?.claim !== 'project-command'
    || !/^[a-f0-9]{64}$/.test(evidence.serverEvidenceSha256 || '')) throw new Error('API baseline identity or compatibility evidence is invalid.');
  const serverBytes = fs.readFileSync(serverEvidencePath || safeFile(directory, SERVER_FILE));
  const server = JSON.parse(serverBytes.toString('utf8'));
  if (sha256(serverBytes) !== evidence.serverEvidenceSha256 || server.version !== SERVER_VERSION || server.environment !== expected.environment
    || server.source?.repository !== expected.repository || server.source?.sha !== expected.sha
    || !Array.isArray(server.target?.resources) || !server.target.resources.some(resource => resource.logicalName === evidence.service)) throw new Error('API baseline does not match its exact server release.');
  return validateApiReleaseEvidence({manifest: evidence, snapshots: snapshotValues(directory, evidence), identity: expected, serverEvidenceSha256: sha256(serverBytes)});
}
function prepareApiRelease(params) {
  const identity = requireIdentity(params.identity);
  const policy = normalizePolicy(params.policy);
  const baseline = params.baselineIdentity ? validateApiEvidence(params.baselineDirectory, params.baselineIdentity) : null;
  if (baseline && (baseline.environment !== identity.environment || baseline.repository !== identity.repository || baseline.workflow !== identity.workflow || baseline.service !== policy.service)) throw new Error('API baseline identity or service changed.');
  if (baseline) for (const [name, old] of Object.entries(baseline.versions)) {
    const next = policy.versions[name];
    if (!next) throw new Error('API version ledger cannot remove ' + name + '; retain it or declare reviewed retirement.');
    if (next.path !== old.path) throw new Error('An existing API version route cannot change. Add another version.');
    if (old.status === 'retired' && (next.status !== 'retired' || canonical(next.retirement) !== canonical(old.retirement))) throw new Error('An API retirement tombstone cannot be changed or revived.');
  }
  const workspace = path.resolve(params.workspace);
  const candidateDirectory = path.resolve(params.candidateDirectory);
  const baselineDirectory = path.resolve(params.baselineDirectory);
  if (candidateDirectory === workspace || candidateDirectory.startsWith(workspace + path.sep) || candidateDirectory === baselineDirectory && baseline) throw new Error('API candidate snapshots require an isolated directory.');
  fs.mkdirSync(path.join(candidateDirectory, 'contracts'), {recursive: true, mode: 0o700});
  fs.mkdirSync(baselineDirectory, {recursive: true, mode: 0o700});
  const versions = {};
  for (const [name, version] of Object.entries(policy.versions)) {
    const previous = baseline?.versions[name];
    let bytes;
    if (version.status === 'retired' && previous) bytes = fs.readFileSync(safeFile(baselineDirectory, previous.snapshot));
    else {
      const content = readJson(workspace, version.contract); validateContract(content);
      bytes = Buffer.from(canonical(content) + '\n');
    }
    const snapshot = 'contracts/' + name + '.json';
    fs.writeFileSync(path.join(candidateDirectory, snapshot), bytes, {mode: 0o600});
    versions[name] = {...version, snapshot, contractHash: sha256(bytes)};
  }
  const evidence = {version: VERSION, ...identity, service: policy.service, versions, consumers: policy.consumers,
    policyHash: sha256(canonical(policy)), baseline: baseline ? requireIdentity(baseline) : null,
    compatibility: {status: 'pending', claim: 'project-command', commandHash: sha256(canonical(policy.compatibility))}};
  fs.writeFileSync(path.join(candidateDirectory, EVIDENCE_FILE), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  const cwd = policy.compatibility.workingDirectory === '.' ? workspace : safeDirectory(workspace, policy.compatibility.workingDirectory);
  validateSnapshots(candidateDirectory, evidence);
  const env = {...process.env, HYPERVIBE_API_BASELINE_DIR: baselineDirectory, HYPERVIBE_API_CANDIDATE_DIR: candidateDirectory, HYPERVIBE_API_ENVIRONMENT: identity.environment};
  for (const command of [policy.compatibility.installCommand, policy.compatibility.command].filter(Boolean)) {
    const result = spawnSync('/bin/sh', ['-eu', '-c', command], {cwd, env, stdio: 'inherit', timeout: 15 * 60 * 1000});
    if (result.error || result.status !== 0) throw new Error('API compatibility command did not succeed; deployment is blocked.');
  }
  validateSnapshots(candidateDirectory, evidence);
  if (baseline && canonical(validateApiEvidence(baselineDirectory, params.baselineIdentity)) !== canonical(baseline)) throw new Error('API baseline evidence changed during the compatibility command.');
  const onDisk = readJson(candidateDirectory, EVIDENCE_FILE);
  if (canonical(onDisk) !== canonical(evidence)) throw new Error('API candidate evidence changed during the compatibility command.');
  evidence.compatibility.status = 'passed';
  fs.writeFileSync(path.join(candidateDirectory, EVIDENCE_FILE), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  return evidence;
}
function safeDirectory(base, relativeDirectory) {
  relative(relativeDirectory);
  let current = path.resolve(base);
  for (const segment of relativeDirectory.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('API compatibility working directory must be a real repository directory.');
  }
  return current;
}
function finalizeApiRelease(params) {
  const identity = requireIdentity(params.identity);
  const evidence = readJson(params.candidateDirectory, EVIDENCE_FILE);
  if (evidence.version !== VERSION || Object.entries(identity).some(([key, value]) => evidence[key] !== value) || evidence.compatibility?.status !== 'passed') throw new Error('API candidate evidence does not match this release.');
  validateSnapshots(params.candidateDirectory, evidence);
  const bytes = fs.readFileSync(params.serverEvidencePath);
  const server = JSON.parse(bytes.toString('utf8'));
  if (server.version !== SERVER_VERSION || server.environment !== identity.environment || server.source?.repository !== identity.repository || server.source?.sha !== identity.sha
    || !Array.isArray(server.target?.resources) || !server.target.resources.some(resource => resource.logicalName === evidence.service)) throw new Error('API evidence requires the exact successful server release.');
  evidence.serverEvidenceSha256 = sha256(bytes);
  fs.writeFileSync(path.join(params.candidateDirectory, EVIDENCE_FILE), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  return evidence;
}
async function pages(method, request, key) {
  const result = [], seen = new Set();
  let total;
  for (let page = 1; page <= 100; page++) {
    const response = await method({...request, per_page: 100, page});
    const data = response?.data;
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || !Array.isArray(data[key])) throw new Error('API baseline history observation is invalid.');
    if (total !== undefined && total !== data.total_count) throw new Error('API baseline history changed during pagination; retry.');
    total = data.total_count;
    for (const entry of data[key]) {
      if (!Number.isSafeInteger(entry?.id) || entry.id < 1 || seen.has(entry.id)) throw new Error('API baseline history contains invalid or duplicate identities.');
      seen.add(entry.id); result.push(entry);
    }
    if (result.length === total) return result;
    if (result.length > total || !data[key].length) throw new Error('API baseline history pagination is incomplete.');
  }
  throw new Error('API baseline history exceeds the bounded observation limit.');
}
async function assertMatchingWorkflow(params) {
  if (!/^[a-f0-9]{40}$/.test(params.currentWorkflowSha || '') || !/^[a-f0-9]{40}$/.test(params.previousWorkflowSha || '')) throw new Error('API baseline workflow source identity is unknown.');
  const [owner, repo] = params.repository.split('/');
  async function content(ref) {
    const response = await params.github.rest.repos.getContent({owner, repo, path: params.workflow, ref});
    const file = response?.data;
    if (!record(file) || file.type !== 'file' || file.path !== params.workflow || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('API baseline workflow contents are unknown.');
    const bytes = Buffer.from(file.content, 'base64');
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('API baseline workflow contents are invalid.');
    return sha256(bytes);
  }
  if (await content(params.currentWorkflowSha) !== await content(params.previousWorkflowSha)) throw new Error('API baseline workflow program differs from the reviewed current workflow; a reviewed evidence migration is required.');
}
async function failedBeforeMutation(params, run) {
  try {
    await assertMatchingWorkflow({...params, previousWorkflowSha: run.head_sha});
    const [owner, repo] = params.repository.split('/');
    const jobs = await pages(params.github.rest.actions.listJobsForWorkflowRun, {owner, repo, run_id: run.id, filter: 'latest'}, 'jobs');
    if (!jobs.length || jobs.some(job => job.run_id !== run.id || job.head_sha !== run.head_sha || job.status !== 'completed' || !['deploy', 'reconciliation'].includes(job.name))) return false;
    const deploy = jobs.filter(job => job.name === 'deploy');
    if (deploy.length !== 1 || !Array.isArray(deploy[0].steps)) return false;
    const steps = deploy[0].steps;
    if (!steps.length || steps.some((step, index) => !Number.isSafeInteger(step.number) || step.status !== 'completed' || index && step.number <= steps[index - 1].number)) return false;
    const gates = steps.filter(step => step.name === 'Verify API compatibility before deployment');
    if (gates.length !== 1 || !['failure', 'skipped', 'cancelled'].includes(gates[0].conclusion)) return false;
    const gateNumber = gates[0].number;
    if (!steps.some(step => step.number <= gateNumber && ['failure', 'cancelled'].includes(step.conclusion))) return false;
    return steps.filter(step => step.number > gateNumber).every(step => step.conclusion === 'skipped' || step.name === 'Complete job' || step.name.startsWith('Post '));
  } catch { return false; }
}
async function selectApiBaseline(params) {
  const [owner, repo] = params.repository.split('/');
  const runs = await pages(params.github.rest.actions.listWorkflowRuns, {owner, repo, workflow_id: params.workflow}, 'workflow_runs');
  const candidates = runs.filter(run => run.id !== params.currentRunId);
  for (const run of candidates) if (run.path !== params.workflow || !/^[a-f0-9]{40}$/.test(run.head_sha || '') || !Number.isFinite(Date.parse(run.updated_at))) throw new Error('API baseline run identity is incomplete.');
  if (candidates.some(run => run.status !== 'completed')) throw new Error('Another managed deployment is active or unknown; re-observe the API baseline after it completes.');
  candidates.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || right.id - left.id);
  if (!candidates.length) return null;
  let run;
  for (const candidate of candidates) {
    if (candidate.conclusion === 'success') { run = candidate; break; }
    if (!await failedBeforeMutation(params, candidate)) throw new Error('The latest managed deployment failed or was cancelled and may have changed production. Inspect and resolve its release evidence before choosing an API baseline.');
  }
  if (!run) return null;
  const artifacts = await pages(params.github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: run.id}, 'artifacts');
  const slug = params.environment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const apiPrefix = 'hypervibe-api-release-v' + VERSION + '-' + slug + '-';
  const serverPrefix = 'hypervibe-server-release-v' + SERVER_VERSION + '-' + slug + '-';
  const apiArtifacts = artifacts.filter(artifact => artifact.name.startsWith(apiPrefix) && /^[a-f0-9]{40}$/.test(artifact.name.slice(apiPrefix.length)));
  if (apiArtifacts.length !== 1) throw new Error('Previous successful deployment lacks a unique API companion artifact. A reviewed baseline migration is required.');
  const deployedSha = apiArtifacts[0].name.slice(apiPrefix.length);
  function exact(name) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    if (matches.length !== 1 || matches[0].expired !== false || matches[0].workflow_run?.id !== run.id || matches[0].workflow_run?.head_sha !== run.head_sha) throw new Error('Previous successful deployment lacks exact unexpired API/server companion artifacts. A reviewed baseline migration is required.');
    return matches[0].id;
  }
  return {...requireIdentity({repository: params.repository, environment: params.environment, workflow: params.workflow, sha: deployedSha, runId: run.id}), workflowHeadSha: run.head_sha, apiArtifactId: exact(apiPrefix + deployedSha), serverArtifactId: exact(serverPrefix + deployedSha)};
}
module.exports = {prepareApiRelease, finalizeApiRelease, validateApiEvidence, validateApiReleaseEvidence, apiReleasePolicyHash, selectApiBaseline, assertMatchingWorkflow};
