import { mergeRecoveryRuntimeBindings, recoveryRuntimeBindings } from '../services/runtime-evidence.js';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { repoBindingsFileSchema } from './repo-bindings.schema.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { findRepoRoot, readRepoSpecFile, repositoryMatchesProjectIdentity, repoSpecEnabled } from './repo-spec-file.js';
import { withStorageInstanceScopes } from '../services/storage-instance-identity.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';
import { parseServiceVolumeBindings } from '../services/service-volume.service.js';
import type { ServiceVolumeComponentBinding } from '../ports/service-volume.port.js';
import { databaseCheckpointBindings } from '../services/database-checkpoint.js';
import { backupPolicyAttempts, mergeBackupPolicyAttempts } from '../services/backup-policy-attempts.js';
import { projectRecoveryDatabases, recoveryDatabaseBindings } from '../services/recovery-database-bindings.js';
import type { Component } from '../entities/component.entity.js';
import { secretContainerBindings } from '../ports/secret-destination-lifecycle.port.js';
import { isDeepStrictEqual } from 'node:util';
import { mergeRuntimeAccessBindings, runtimeAccessBindings } from '../services/runtime-access.service.js';
import { preparedHostingMarkerSchema } from '../ports/hosting-prepared.port.js';

// Bindings are the inverse of the spec's source-of-truth contract: the DB
// column `environments.platform_bindings` is authoritative (it holds data the
// sanitizer strips), and `.hypervibe/bindings.json` is a sanitized export so
// teammates can converge the same provider resources.

export interface RepoBindingsEnvironment {
  platformBindings: Record<string, unknown>;
}

export interface RepoBindingsFile {
  version: 1;
  project: string;
  environments: Record<string, RepoBindingsEnvironment>;
}

const HYPERVIBE_DIR = '.hypervibe';
const BINDINGS_FILE = 'bindings.json';
const SENSITIVE_KEY_PATTERN = /(^|_)?(secret|token|password|connectionstring|connectionurl|databaseurl|databaseprivateurl|privateurl|privatekey|apikey)($|_)?/i;
const LOCAL_ONLY_BINDING_KEYS = new Set([
  'delegatedEnvBindings',
  'recoveryRuntimeSecretInputs',
  'credentialUpdates',
  'runtimeRollouts',
  'delegatedActionsBindings',
]);

function bindingsPath(root: string): string {
  return path.join(root, HYPERVIBE_DIR, BINDINGS_FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function repoOmittedBindingKey(key: string): boolean {
  return LOCAL_ONLY_BINDING_KEYS.has(key)
    || SENSITIVE_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ''));
}

function mergeSanitizedBindingObject(
  existing: Record<string, unknown>,
  repoBindings: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...repoBindings };
  for (const [key, existingValue] of Object.entries(existing)) {
    if (!(key in repoBindings)) {
      if (repoOmittedBindingKey(key)) {
        merged[key] = existingValue;
      }
      continue;
    }
    const existingRecord = asRecord(existingValue);
    const repoRecord = asRecord(repoBindings[key]);
    if (existingRecord && repoRecord) {
      merged[key] = mergeSanitizedBindingObject(existingRecord, repoRecord);
    }
  }
  return merged;
}

function mergeVolumeRecovery<T extends ServiceVolumeComponentBinding>(previous: T, next: T, name: string): T {
  if (previous.externalId !== undefined && next.externalId !== undefined && previous.externalId !== next.externalId) {
    throw new Error(`Repository service-volume identity conflicts with retained local state for ${name}.`);
  }
  const rank = { creating: 0, identified: 1, bound: 2 };
  return rank[next.state] >= rank[previous.state] ? next : previous;
}

/**
 * Overlay the sanitized repository export onto authoritative local bindings.
 * Top-level bindings absent from the export retain the historical merge
 * behavior. Within a shared binding, only fields omitted by the sanitizer are
 * retained so ordinary public metadata can still be removed by the export.
 */
export function mergeRepoPlatformBindings(
  existing: Record<string, unknown>,
  repoBindings: Record<string, unknown>
): Record<string, unknown> {
  if (Object.hasOwn(repoBindings, 'recoveryRuntimeSecretInputs')) throw new Error('Private recovery inputs are local only and cannot be imported.');
  if (Object.hasOwn(repoBindings, 'credentialUpdates')) throw new Error('Credential acceptance and recovery state are local only and cannot be imported.');
  if (Object.hasOwn(repoBindings, 'runtimeRollouts')) throw new Error('Runtime configuration expectations and activation requirements are local only and cannot be imported.');
  if (existing.recoveryDatabases !== undefined) recoveryDatabaseBindings(existing.recoveryDatabases);
  if (repoBindings.recoveryDatabases !== undefined) recoveryDatabaseBindings(repoBindings.recoveryDatabases);
  const localVolumes = parseServiceVolumeBindings({ platformBindings: existing });
  const incomingVolumes = parseServiceVolumeBindings({ platformBindings: repoBindings });
  if (!localVolumes || !incomingVolumes) {
    throw new Error('Malformed retained service-volume bindings; refusing to overwrite recovery state.');
  }
  const merged: Record<string, unknown> = { ...existing, ...repoBindings, ...mergeRuntimeAccessBindings(existing, repoBindings) };
  if (existing.preparedHosting !== undefined || repoBindings.preparedHosting !== undefined) {
    const local = existing.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(existing.preparedHosting);
    const incoming = repoBindings.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(repoBindings.preparedHosting);
    if (local && incoming) {
      if ((['installationId', 'planDigest', 'receiptDigest'] as const).some(key => local[key] !== incoming[key])
        || local.pendingFirstRelease.some(name => incoming.firstReleaseConfigurationDigests?.[name] !== undefined
          && local.firstReleaseConfigurationDigests?.[name] !== undefined
          && incoming.firstReleaseConfigurationDigests[name] !== local.firstReleaseConfigurationDigests[name]))
        throw new Error('Repository prepared hosting evidence conflicts with retained local authority. Reconcile the reviewed metadata plan.');
    }
    // Repository replay cannot complete or reinstate a release. A fresh native
    // observation and an explicit local metadata action advance this journal.
    merged.preparedHosting = local ?? incoming;
  }
  if (existing.recoveryRuntime !== undefined || repoBindings.recoveryRuntime !== undefined) merged.recoveryRuntime = mergeRecoveryRuntimeBindings(existing.recoveryRuntime, repoBindings.recoveryRuntime);
  if (existing.backupPolicyAttempts !== undefined || repoBindings.backupPolicyAttempts !== undefined) {
    merged.backupPolicyAttempts = mergeBackupPolicyAttempts(existing.backupPolicyAttempts, repoBindings.backupPolicyAttempts);
  }
  if (existing.databaseCheckpoints !== undefined || repoBindings.databaseCheckpoints !== undefined) {
    merged.databaseCheckpoints = databaseCheckpointBindings(
      { resilience: { checkpoints: existing.databaseCheckpoints } },
      { databaseCheckpoints: repoBindings.databaseCheckpoints }
    );
  }
  for (const [key, repoValue] of Object.entries(repoBindings)) {
    if (key === 'secretDestinationContainers') {
      const retained = secretContainerBindings(existing[key]);
      for (const [name, incoming] of Object.entries(secretContainerBindings(repoValue))) {
        const previous = retained[name];
        if (previous && (previous.attemptId !== incoming.attemptId || !isDeepStrictEqual(previous.owner, incoming.owner)
          || !isDeepStrictEqual(previous.destination, incoming.destination)
          || previous.state === 'ready' && incoming.state === 'ready' && (previous.resource !== incoming.resource || previous.createTime !== incoming.createTime)))
          throw new Error(`Repository secret container identity conflicts with retained state for ${name}.`);
        if (!previous || previous.state !== 'ready') retained[name] = incoming;
      }
      merged[key] = retained;
      continue;
    }
    if (key === 'databaseCheckpoints' || key === 'backupPolicyAttempts' || key === 'runtimeIdentities' || key === 'storageRuntimeAccess' || key === 'preparedHosting' || key === 'recoveryRuntime') continue;
    if (key === 'serviceVolumes' && existing[key] !== undefined) {
      const retained = { ...incomingVolumes, ...localVolumes };
      for (const [name, next] of Object.entries(incomingVolumes)) {
        const previous = localVolumes[name];
        if (!previous) { retained[name] = next; continue; }
        const previousTarget = previous.target;
        const nextTarget = next.target;
        if (previous.provider !== next.provider
          || (['projectId', 'environmentId', 'serviceId', 'mountPath'] as const).some((field) => previousTarget[field] !== nextTarget[field])
          || JSON.stringify(Object.entries(previousTarget.instanceScope ?? {}).sort()) !== JSON.stringify(Object.entries(nextTarget.instanceScope ?? {}).sort())
          || (previous.state === 'staged') !== (next.state === 'staged')) {
          throw new Error(`Repository service-volume identity conflicts with retained local state for ${name}.`);
        }
        if (previous.state === 'staged' && next.state === 'staged') {
          const components = { ...next.components, ...previous.components };
          for (const [key, component] of Object.entries(next.components)) {
            components[key] = previous.components[key]
              ? mergeVolumeRecovery(previous.components[key], component, `${name}/${key}`)
              : component;
          }
          retained[name] = { ...previous, components };
        } else if (previous.state !== 'staged' && next.state !== 'staged') {
          retained[name] = mergeVolumeRecovery(previous, next, name);
        }
      }
      merged[key] = retained;
      continue;
    }
    const existingRecord = asRecord(existing[key]);
    const repoRecord = asRecord(repoValue);
    if (existingRecord && repoRecord) {
      merged[key] = mergeSanitizedBindingObject(existingRecord, repoRecord);
    }
  }
  if (!parseServiceVolumeBindings({ platformBindings: merged })) {
    throw new Error('Malformed or duplicate merged service-volume identity; refusing to overwrite recovery state.');
  }
  return merged;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (repoOmittedBindingKey(key)) {
      continue;
    }
    const sanitizedChild = sanitize(child);
    const sanitizedRecord = asRecord(sanitizedChild);
    if (sanitizedRecord && Object.keys(sanitizedRecord).length === 0) {
      continue;
    }
    sanitized[key] = sanitizedChild;
  }
  return sanitized;
}

function presentStorageInstanceScopes(platformBindings: Record<string, unknown>): Record<string, unknown> {
  const storage = asRecord(platformBindings.storage);
  const providerContexts = asRecord(platformBindings.storageProviders);
  if (!storage || !providerContexts) return platformBindings;
  return {
    ...platformBindings,
    storage: withStorageInstanceScopes(storage, providerContexts),
  };
}

function sanitizePlatformBindings(raw: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitize(raw) as Record<string, unknown>;
  // Only the closed value-free schema bypasses redaction for workload names.
  if (raw.preparedHosting !== undefined) sanitized.preparedHosting = preparedHostingMarkerSchema.parse(raw.preparedHosting);
  const access = runtimeAccessBindings({ platformBindings: raw });
  if (!access) throw new Error('Malformed runtime permission bindings cannot be exported safely.');
  for (const key of ['runtimeIdentities', 'storageRuntimeAccess'] as const) {
    if (raw[key] !== undefined) sanitized[key] = access[key];
  }
  if (raw.secretDestinationContainers !== undefined) sanitized.secretDestinationContainers = secretContainerBindings(raw.secretDestinationContainers);
  if (raw.recoveryRuntime !== undefined) sanitized.recoveryRuntime = recoveryRuntimeBindings(raw.recoveryRuntime);
  if (raw.recoveryDatabases !== undefined) sanitized.recoveryDatabases = recoveryDatabaseBindings(raw.recoveryDatabases);
  if (raw.backupPolicyAttempts !== undefined) {
    // Strict value-free identities remain recoverable even for secret-shaped names.
    sanitized.backupPolicyAttempts = backupPolicyAttempts(raw.backupPolicyAttempts);
  }
  if (raw.databaseCheckpoints !== undefined) {
    // Strict non-secret checkpoint identities must survive even when their
    // reviewed logical intent id contains a word such as "token".
    sanitized.databaseCheckpoints = databaseCheckpointBindings({}, raw);
  }
  if (raw.serviceVolumes !== undefined) {
    const serviceVolumes = parseServiceVolumeBindings({ platformBindings: raw });
    if (!serviceVolumes) throw new Error('Malformed retained service-volume bindings cannot be exported or imported safely.');
    // Logical names can contain "token". Only this strictly value-free identity
    // schema bypasses generic key redaction; arbitrary metadata never does.
    sanitized.serviceVolumes = serviceVolumes;
  }
  return sanitized;
}

function parseDocument(raw: unknown, file: string, projectName?: string): RepoBindingsFile {
  const parsed = repoBindingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `${file} does not match the repository bindings schema: ${issues}. `
      + 'Fix the file (or intentionally delete it when no shared bindings should remain) and retry.'
    );
  }
  if (projectName && parsed.data.project !== projectName) {
    throw new Error(
      `${file} belongs to project "${parsed.data.project}", not resolved project "${projectName}". `
      + 'Use the matching checkout or repair the repository bindings project identity before retrying.'
    );
  }

  const normalized: RepoBindingsFile['environments'] = {};
  for (const [envName, value] of Object.entries(parsed.data.environments)) {
    normalized[envName] = {
      platformBindings: sanitizePlatformBindings(value.platformBindings),
    };
  }
  return {
    version: 1,
    project: parsed.data.project,
    environments: normalized,
  };
}

function readExistingBindingsFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`${file} could not be read${code ? ` (${code})` : ''}. Fix the file permissions and retry.`);
  }
}

function parseBindingsJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `${file} is not valid JSON. Fix the file (or intentionally delete it when no shared bindings should remain) and retry.`
    );
  }
}

export function readRepoBindingsFile(projectName?: string, startDir = primaryWorkspaceDirectory()): { path: string; document: RepoBindingsFile } | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }
  const file = bindingsPath(root);
  const raw = readExistingBindingsFile(file);
  if (raw === null) return null;
  const document = parseDocument(parseBindingsJson(raw, file), file, projectName);
  return { path: file, document };
}

export function writeRepoBindingsForEnvironment(project: Project, environment: Environment, startDir = primaryWorkspaceDirectory(),
  loadComponents?: () => Component[]): string | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const spec = readRepoSpecFile(root)?.spec;
  if (spec && spec.project !== project.name) return null;
  const expectedRemote = project.gitRemoteUrl ?? spec?.gitRemoteUrl;
  if ((!spec || expectedRemote)
    && !repositoryMatchesProjectIdentity(root, project.name, expectedRemote)) {
    return null;
  }

  const file = bindingsPath(root);
  const raw = readExistingBindingsFile(file);
  const current = raw === null
    ? { version: 1 as const, project: project.name, environments: {} }
    : parseDocument(parseBindingsJson(raw, file), file, project.name);

  const platformBindings = presentStorageInstanceScopes(
    sanitizePlatformBindings(environment.platformBindings)
  );
  const backupPolicy = spec?.environments[environment.name]?.backups;
  if (Object.keys(platformBindings).length && backupPolicy?.mode === 'daily' && backupPolicy.runnerImage) {
    if (!loadComponents) throw new Error('Managed backup bindings require a fresh component inventory.');
    platformBindings.recoveryDatabases = projectRecoveryDatabases(loadComponents(), environment.id);
  }
  if (Object.keys(platformBindings).length === 0) {
    delete current.environments[environment.name];
  } else {
    current.environments[environment.name] = { platformBindings };
  }
  if (Object.keys(current.environments).length === 0) {
    if (raw !== null) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return file;
}
