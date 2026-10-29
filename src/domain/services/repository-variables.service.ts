import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { CodeRepositoryIdentity, RepositoryConfigurationPort, RepositoryVariableInventory } from '../ports/devops.port.js';
import { RepositoryConfigurationWriteError } from '../ports/devops.port.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

export const REPOSITORY_VARIABLE_OPERATION = 'ci.repository-variable.sync';
const ownershipKey = 'repositoryVariableOwnership';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const fingerprint = (value: unknown) => digest(JSON.stringify(value));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/);
const observedVariableSchema = z.object({ name: nameSchema, valueHash: hashSchema,
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) }).strict();
const identitySchema = z.object({ provider: z.string().min(1), nativeId: z.string().min(1),
  instanceScope: z.string().min(1), canonicalScope: z.string().min(1), path: z.string().min(1) }).strict();
const metadataSchema = z.object({ operation: z.literal(REPOSITORY_VARIABLE_OPERATION),
  mode: z.enum(['create', 'update', 'adopt', 'reconcile']), ciProvider: z.string().min(1), codeProvider: z.string().min(1),
  repositoryScope: z.string().min(1), repositoryId: z.string().min(1), instanceScope: z.string().min(1),
  canonicalScope: z.string().min(1), variableName: nameSchema, desiredHash: hashSchema,
  previous: observedVariableSchema.nullable(), ownershipHash: hashSchema.nullable() }).strict();
const ownershipSchema = z.object({ version: z.literal(1), ciProvider: z.string().min(1), repository: identitySchema,
  variables: z.record(nameSchema, observedVariableSchema), pending: metadataSchema.nullable() }).strict();
type Metadata = z.infer<typeof metadataSchema>;
type Ownership = z.infer<typeof ownershipSchema>;
type Variable = z.infer<typeof observedVariableSchema>;

function identity(value: CodeRepositoryIdentity): Ownership['repository'] {
  return { provider: value.provider, nativeId: value.nativeId, instanceScope: value.instanceScope,
    canonicalScope: value.canonicalScope, path: value.path };
}

function ownership(raw: unknown): Ownership | null {
  if (raw === undefined) return null;
  const parsed = ownershipSchema.safeParse(raw);
  if (!parsed.success || Object.entries(parsed.data.variables).some(([name, value]) => name !== value.name)
    || Object.keys(parsed.data.variables).length > 500) throw new Error('Repository-variable ownership is malformed; retained state was preserved.');
  return parsed.data;
}

function matchesIdentity(metadata: Metadata, repository: CodeRepositoryIdentity): boolean {
  return metadata.repositoryId === repository.nativeId && metadata.codeProvider === repository.provider
    && metadata.instanceScope === repository.instanceScope && metadata.canonicalScope === repository.canonicalScope
    && metadata.repositoryScope === repository.path;
}

export function repositoryVariablesEnvironment(spec: ProjectSpec): string {
  return spec.devops?.canonicalEnvironment ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0] ?? 'repository');
}

/** Retained uncertainty is a project-level prerequisite, even after spec edits. */
export function pendingRepositoryVariableEnvironment(projectId: string): string | null {
  const records = new EnvironmentRepository().findByProjectId(projectId)
    .filter(environment => environment.platformBindings[ownershipKey] !== undefined);
  if (records.length > 1) throw new Error('Repository-variable ownership is ambiguous across environments; retained state was preserved.');
  const record = records[0];
  return record && ownership(record.platformBindings[ownershipKey])?.pending ? record.name : null;
}

function loadAdapter(spec: ProjectSpec): RepositoryConfigurationPort {
  const selection = spec.devops;
  if (!selection?.ci || selection.code.repository.state !== 'present' || selection.code.repository.management !== 'external') {
    throw new Error('Repository variables require an existing externally managed repository and a canonical CI provider.');
  }
  const registration = devOpsProviderRegistry.ciProvider(selection.ci.provider);
  if (!registration?.repositoryConfiguration || !registration.compatibleCodeProviders.includes(selection.code.provider)) {
    throw new Error('The selected CI provider does not support repository configuration variables.');
  }
  const connection = new ConnectionRepository().findBestVerifiedMatch(registration.connectionProvider, selection.code.scope);
  if (!connection) throw new Error('Repository variables require a verified connection for the exact repository scope.');
  try {
    return registration.repositoryConfiguration(getSecretStore().decryptObject<unknown>(connection.credentialsEncrypted));
  } catch {
    throw new Error('The repository configuration connection could not be loaded.');
  }
}

function desired(spec: ProjectSpec, adapter: RepositoryConfigurationPort): Map<string, { value: string; adoptExisting: boolean }> {
  const result = new Map<string, { value: string; adoptExisting: boolean }>();
  for (const [rawName, value] of Object.entries(spec.devops?.ci?.repositoryVariables ?? {})) {
    const name = adapter.normalizeName(rawName);
    if (result.has(name)) throw new Error('Repository variable names are ambiguous after provider normalization.');
    result.set(name, value);
  }
  return result;
}

async function observe(spec: ProjectSpec, adapter: RepositoryConfigurationPort): Promise<RepositoryVariableInventory> {
  const observation = await adapter.observe(spec.devops!.code.scope);
  if (observation.state !== 'present') throw new Error('Repository identity or complete variable inventory is unknown; no mutation is authorized.');
  const repository = observation.value.repository;
  const remote = spec.gitRemoteUrl && normalizeGitRemoteIdentity(spec.gitRemoteUrl);
  if (!remote || !repository.cloneUrls.some(url => normalizeGitRemoteIdentity(url) === remote)) {
    throw new Error('The observed repository identity does not match the declared git remote.');
  }
  return observation.value;
}

function assertBinding(state: Ownership | null, repository: CodeRepositoryIdentity, ciProvider: string): void {
  if (state && (state.ciProvider !== ciProvider || fingerprint(state.repository) !== fingerprint(identity(repository)))) {
    throw new Error('Repository-variable ownership belongs to a different repository identity or CI provider.');
  }
}

function action(metadata: Metadata, noop = false): PlanAction {
  return { id: `ci:repository-variable:${metadata.variableName}`, type: noop ? 'noop' : metadata.mode === 'create' ? 'create' : 'update',
    resource: { kind: 'ci', name: `repository-variable:${metadata.variableName}`, provider: metadata.ciProvider }, verified: true,
    reason: noop ? 'The owned repository variable already matches the desired value.'
      : metadata.mode === 'adopt' ? 'Explicitly adopt the existing variable without changing its provider value; any value change requires a subsequent plan.'
        : metadata.mode === 'reconcile' ? 'Verify the retained write outcome without issuing another provider write.'
          : `${metadata.mode === 'create' ? 'Create' : 'Update'} the selected non-secret repository variable and verify readback.`,
    metadata: { ...metadata } };
}

export function isRepositoryVariableAction(value: PlanAction): boolean {
  const parsed = metadataSchema.safeParse(value.metadata);
  if (!parsed.success) return false;
  const metadata = parsed.data;
  return value.id === `ci:repository-variable:${metadata.variableName}` && value.resource.kind === 'ci'
    && value.resource.name === `repository-variable:${metadata.variableName}` && value.resource.provider === metadata.ciProvider
    && (value.type === 'noop' || value.type === (metadata.mode === 'create' ? 'create' : 'update'))
    && (metadata.mode !== 'create' || metadata.previous === null)
    && (!['update', 'adopt'].includes(metadata.mode) || metadata.previous?.name === metadata.variableName);
}

export async function planRepositoryVariables(params: { project: Project; spec: ProjectSpec; environmentName: string }): Promise<{
  actions: PlanAction[]; stageRequired: boolean; error?: string;
}> {
  const environments = new EnvironmentRepository();
  const records = environments.findByProjectId(params.project.id);
  const canonical = repositoryVariablesEnvironment(params.spec);
  // Retained uncertainty cannot be hidden by moving or omitting the declaration.
  const previousOwner = records.find(record => record.platformBindings[ownershipKey] !== undefined);
  const declared = params.spec.devops?.ci?.repositoryVariables;
  if (!declared && !previousOwner) return { actions: [], stageRequired: false };
  try {
    if (previousOwner && previousOwner.name !== canonical) throw new Error('Repository-variable ownership belongs to another canonical environment; preserve that environment to reconcile it.');
    const state = ownership(previousOwner?.platformBindings[ownershipKey]);
    if (params.environmentName !== canonical) {
      if (state?.pending) throw new Error('Reconcile the pending repository-variable write in the canonical environment before other work.');
      return { actions: [], stageRequired: false };
    }
    if (!declared && !state?.pending) return { actions: [], stageRequired: false };
    const adapter = loadAdapter(params.spec);
    const inventory = await observe(params.spec, adapter);
    assertBinding(state, inventory.repository, params.spec.devops!.ci!.provider);
    if (state?.pending) {
      if (!matchesIdentity(state.pending, inventory.repository)) throw new Error('Retained repository-variable write identity changed.');
      return { actions: [action({ ...state.pending, mode: 'reconcile' })], stageRequired: true };
    }
    const actions: PlanAction[] = [];
    const targets = desired(params.spec, adapter);
    if (new Set([...Object.keys(state?.variables ?? {}), ...targets.keys()]).size > 500) {
      throw new Error('Retained repository-variable ownership capacity is exhausted; existing ownership was preserved and no mutation is authorized.');
    }
    for (const [name, target] of targets) {
      const current = inventory.variables.find(variable => variable.name === name) ?? null;
      const owned = state?.variables[name];
      if (current && !owned && !target.adoptExisting) throw new Error('An existing repository variable requires explicit adoptExisting=true before ownership or value changes.');
      const metadata: Metadata = { operation: REPOSITORY_VARIABLE_OPERATION,
        mode: current ? owned ? 'update' : 'adopt' : 'create', ciProvider: params.spec.devops!.ci!.provider,
        codeProvider: inventory.repository.provider, repositoryScope: inventory.repository.path,
        repositoryId: inventory.repository.nativeId, instanceScope: inventory.repository.instanceScope,
        canonicalScope: inventory.repository.canonicalScope, variableName: name, desiredHash: digest(target.value),
        previous: current, ownershipHash: owned ? fingerprint(owned) : null };
      actions.push(action(metadata, Boolean(owned && current?.valueHash === metadata.desiredHash)));
    }
    return { actions, stageRequired: actions.some(item => item.type !== 'noop') || !params.spec.environments[canonical] };
  } catch (error) {
    // All local messages are fixed and value-free; adapters must not forward raw failures.
    return { actions: [], stageRequired: true, error: error instanceof Error ? error.message : 'Repository variable planning failed.' };
  }
}

export async function applyRepositoryVariable(params: { project: Project; spec: ProjectSpec; environmentName: string; action: PlanAction }): Promise<{
  success: boolean; status?: 'blocked' | 'pending'; message: string; error?: string;
}> {
  const blocked = (message: string) => ({ success: false, status: 'blocked' as const, message });
  const pending = () => ({ success: false, status: 'pending' as const,
    message: 'Repository-variable write outcome is unresolved. Re-run hv_plan and apply its readback-only reconciliation; no write will be repeated.' });
  if (!isRepositoryVariableAction(params.action) || params.action.type === 'noop') return blocked('The action has no repository-variable mutation authority.');
  const metadata = metadataSchema.parse(params.action.metadata);
  try {
    if (params.environmentName !== repositoryVariablesEnvironment(params.spec)) return blocked('The repository-variable action is outside its canonical environment.');
    const environments = new EnvironmentRepository();
    const environment = environments.findByProjectAndName(params.project.id, params.environmentName);
    if (!environment) return blocked('The reviewed environment is missing.');
    let state = ownership(environment.platformBindings[ownershipKey]);
    const adapter = loadAdapter(params.spec);
    const inventory = await observe(params.spec, adapter);
    if (!matchesIdentity(metadata, inventory.repository) || metadata.ciProvider !== params.spec.devops!.ci!.provider) return blocked('The reviewed repository identity or CI provider changed.');
    assertBinding(state, inventory.repository, metadata.ciProvider);
    const current = inventory.variables.find(variable => variable.name === metadata.variableName) ?? null;
    const owned = state?.variables[metadata.variableName];
    const save = (next: Ownership) => {
      if (!environments.updatePlatformBindings(environment.id, { [ownershipKey]: next })) throw new Error('Repository-variable ownership could not be persisted.');
      state = next;
    };
    const accepted = (value: Variable) => save({ version: 1, ciProvider: metadata.ciProvider, repository: identity(inventory.repository),
      variables: { ...state?.variables, [metadata.variableName]: value }, pending: null });
    if (state?.pending) {
      const original = { ...metadata, mode: state.pending.mode };
      if (fingerprint(original) !== fingerprint(state.pending)) return blocked('Another repository-variable write must be reconciled first.');
      if (current?.valueHash !== metadata.desiredHash) return pending();
      accepted(current);
      return { success: true, message: 'The retained repository-variable write is verified by readback; no provider write was repeated.' };
    }
    if (metadata.mode === 'reconcile') return blocked('The retained repository-variable write is no longer pending; re-run hv_plan.');
    if ((owned ? fingerprint(owned) : null) !== metadata.ownershipHash) return blocked('Repository-variable ownership changed after planning; re-run hv_plan.');
    if (!owned && Object.keys(state?.variables ?? {}).length >= 500) return blocked('Retained repository-variable ownership capacity is exhausted.');
    const target = desired(params.spec, adapter).get(metadata.variableName);
    if (!target || digest(target.value) !== metadata.desiredHash) return blocked('The desired repository variable changed after planning.');
    if (fingerprint(current) !== fingerprint(metadata.previous)) return blocked('The provider variable changed after planning; re-run hv_plan.');
    if (metadata.mode === 'adopt') {
      if (!target.adoptExisting || owned || !current) return blocked('Explicit variable adoption authority is missing.');
      accepted(current);
      return { success: true, message: 'Existing repository variable adopted without a provider write. Re-plan to review any desired value change.' };
    }
    if (metadata.mode === 'update' && !owned) return blocked('The existing repository variable has not been adopted.');
    save({ version: 1, ciProvider: metadata.ciProvider, repository: identity(inventory.repository),
      variables: { ...state?.variables }, pending: metadata });
    try {
      if (metadata.mode === 'create') await adapter.create(inventory.repository, metadata.variableName, target.value);
      else await adapter.update(inventory.repository, metadata.variableName, target.value);
    } catch (error) {
      if (error instanceof RepositoryConfigurationWriteError) {
        save({ ...state!, pending: null });
        return blocked('The provider rejected the write without a mutation. Resolve the connection or input problem, then review a new plan.');
      }
      // An ambiguous acknowledgement is reconciled only by readback.
    }
    try {
      const after = await observe(params.spec, adapter);
      if (!matchesIdentity(metadata, after.repository)) return pending();
      const value = after.variables.find(variable => variable.name === metadata.variableName);
      if (!value || value.valueHash !== metadata.desiredHash) return pending();
      accepted(value);
      return { success: true, message: 'Selected repository variable matches the reviewed value after readback. This does not prove workflow execution.' };
    } catch { return pending(); }
  } catch {
    return blocked('Repository-variable identity, observation or retained state could not be verified. No new write is authorized.');
  }
}
