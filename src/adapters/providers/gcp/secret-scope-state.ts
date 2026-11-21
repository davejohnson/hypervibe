import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { engineStatePaths, ensureEngineStateDirectories } from '../../engine/opentofu/workspace.js';
import { hardenPrivateFile } from '../../storage/paths.js';
import type { GcpAppliedWorkload } from '../../../domain/services/gcp-secret-scope.js';
import { secretScopeDirectGrantProblems, secretScopeExclusions, secretScopePolicyProblems, type IamPolicy, type SecretScopeSetupInput } from './tofu/secret-scope-setup.js';
import { GcpBootstrapClient } from './gcp-bootstrap.client.js';

/**
 * Local, private evidence for limited-secret access on Google Cloud. It sits
 * beside the engine state it describes and is never exported to a repository.
 *
 * - Per environment: what each workload was last known to run as and reference.
 * - Per Google Cloud project: the setup that was applied AND verified against
 *   the live project policy. A saved setup plan alone proves nothing.
 */
function read<T>(file: string): T | undefined {
  if (!hardenPrivateFile(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { throw new Error('The saved limited-secret access record could not be read. Restore it before continuing.'); }
}

function write(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function environmentFile(projectId: string, environmentId: string, dataDir?: string, create = false): string {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId, partition: 'environment' }, dataDir);
  if (create) ensureEngineStateDirectories(paths);
  return path.join(paths.root, 'secret-scope-workloads.json');
}

function projectFile(projectId: string, gcpProjectId: string, dataDir?: string, create = false): string {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  if (create) ensureEngineStateDirectories(paths);
  return path.join(paths.root, 'secret-scope-verified.json');
}

export function readAppliedWorkloads(projectId: string, environmentId: string, dataDir?: string): Record<string, GcpAppliedWorkload> {
  return read<{ workloads?: Record<string, GcpAppliedWorkload> }>(environmentFile(projectId, environmentId, dataDir))?.workloads ?? {};
}

/** `undefined` removes a workload's record (it was deleted). */
export function recordAppliedWorkloads(projectId: string, environmentId: string, changes: Record<string, GcpAppliedWorkload | undefined>, dataDir?: string): void {
  if (!Object.keys(changes).length) return;
  const workloads = { ...readAppliedWorkloads(projectId, environmentId, dataDir) };
  for (const [name, value] of Object.entries(changes)) {
    if (value) workloads[name] = { identity: value.identity, secretIds: [...value.secretIds].sort() };
    else delete workloads[name];
  }
  write(environmentFile(projectId, environmentId, dataDir, true), { workloads });
}

export function readVerifiedSecretScope(projectId: string, gcpProjectId: string, dataDir?: string): SecretScopeSetupInput | undefined {
  const saved = read<{ input?: SecretScopeSetupInput }>(projectFile(projectId, gcpProjectId, dataDir))?.input;
  return saved?.gcpProjectId === gcpProjectId ? saved : undefined;
}

export function recordVerifiedSecretScope(projectId: string, input: SecretScopeSetupInput, dataDir?: string): void {
  write(projectFile(projectId, input.gcpProjectId, dataDir, true), { input, verifiedAt: new Date().toISOString() });
}

/**
 * Read-only check after setup was applied: the project policy, the policy attached to each limited secret,
 * and each service identity (present, enabled, and not usable by another workload identity).
 * Anything that cannot be read is a problem: unknown is never "enforced".
 */
export async function observeSecretScope(token: string, input: SecretScopeSetupInput, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const post = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  const response = await fetchImpl(`https://cloudresourcemanager.googleapis.com/v1/projects/${input.gcpProjectId}:getIamPolicy`,
    { ...post, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) });
  if (!response.ok) return [`Google project IAM lookup failed (HTTP ${response.status}).`];
  const problems = secretScopePolicyProblems(await response.json() as IamPolicy, input);
  const secretPolicies: Record<string, IamPolicy> = {};
  for (const secretId of Object.keys(secretScopeExclusions(input))) {
    const read = await fetchImpl(`https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}/secrets/${encodeURIComponent(secretId)}:getIamPolicy?options.requestedPolicyVersion=3`,
      { headers: { Authorization: `Bearer ${token}` } });
    // A secret that does not exist yet has no grants of its own.
    if (read.status === 404) continue;
    if (!read.ok) { problems.push(`The access policy of secret ${secretId} could not be read (HTTP ${read.status}).`); continue; }
    secretPolicies[secretId] = await read.json() as IamPolicy;
  }
  const client = new GcpBootstrapClient({ accessToken: token, fetch: fetchImpl, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) });
  const accountPolicies: Record<string, IamPolicy> = {};
  for (const identity of input.identities) {
    const account = await client.getServiceAccount(input.gcpProjectId, identity.accountId);
    if (!account || account.email !== identity.email || account.disabled) { problems.push(`${identity.email} is missing or disabled.`); continue; }
    accountPolicies[identity.email] = await client.getServiceAccountIamPolicy(input.gcpProjectId, account.uniqueId);
  }
  return [...problems, ...secretScopeDirectGrantProblems(input, secretPolicies, accountPolicies)];
}
