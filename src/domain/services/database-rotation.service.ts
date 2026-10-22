import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentPlan, PlanOptions } from '../plan/plan.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { databaseCredentialRotationTargetSchema, databaseRotationTargetsMatch } from '../ports/database-password-rotation.port.js';
import type { IDatabasePasswordRotation, DatabaseCredentialRotationTarget } from '../ports/database-password-rotation.port.js';
import type { ObservedState } from '../ports/observe.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint } from './binding-identity.js';
import { buildDatabaseEnvVarsFromComponent, buildDatabaseAliasEnvVars, DATABASE_ENV_KEYS } from './database-env.js';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const rotationMetadataSchema = z.object({
  operation: z.enum(['databasePasswordRotate', 'databasePasswordDistribute']),
  componentId: z.string().min(1), generation: z.number().int().positive(),
  environmentFingerprint: fingerprint, bindingsFingerprint: fingerprint,
  target: databaseCredentialRotationTargetSchema,
  services: z.array(z.string().min(1)).min(1), service: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
}).strict();
type RotationMetadata = z.infer<typeof rotationMetadataSchema>;
class RotationPrerequisite extends Error {}
export const databaseRotationActionSchema = z.object({
  id: z.string(), type: z.literal('update'),
  resource: z.object({ kind: z.enum(['database', 'secret']), name: z.string(), provider: z.string() }).strict(),
  verified: z.literal(true), requiresConfirm: z.literal(true), reason: z.string(),
  dependsOn: z.array(z.string()).optional(), metadata: rotationMetadataSchema,
}).strict().superRefine((action, ctx) => {
  const m = action.metadata;
  const issuerId = `database-rotation:${m.componentId}:${m.generation}`;
  const issuer = m.operation === 'databasePasswordRotate';
  if (issuer ? action.resource.kind !== 'database' || action.resource.name !== 'postgres'
    || action.resource.provider !== m.target.provider || action.id !== issuerId
    || Boolean(m.service || m.serviceId || action.dependsOn?.length)
    : action.resource.kind !== 'secret' || !m.service || !m.serviceId
      || !m.services.includes(m.service) || action.resource.name !== `database:${m.service}`
      || action.id !== `${issuerId}:service:${m.service}` || !isDeepStrictEqual(action.dependsOn, [issuerId])) {
    ctx.addIssue({ code: 'custom', message: 'Database rotation action has inconsistent authority.' });
  }
  if (new Set(m.services).size !== m.services.length || !isDeepStrictEqual(m.services, [...m.services].sort())) {
    ctx.addIssue({ code: 'custom', message: 'Database rotation consumers must be exact and unique.' });
  }
});

const rotationStateSchema = z.object({
  generation: z.number().int().positive(), phase: z.enum(['attempted', 'issuer-verified', 'installed']),
  target: databaseCredentialRotationTargetSchema, environmentFingerprint: fingerprint, bindingsFingerprint: fingerprint,
  oldPassword: z.string().min(1), replacementPassword: z.string().min(32),
  services: z.array(z.string().min(1)).min(1), installedServices: z.array(z.string()),
  startedAt: z.string().datetime(), issuerVerifiedAt: z.string().datetime().optional(), installedAt: z.string().datetime().optional(),
}).strict();
type RotationState = z.infer<typeof rotationStateSchema>;
function rotationState(component: Component): RotationState | undefined {
  if (component.bindings.credentialRotation === undefined) return undefined;
  const parsed = rotationStateSchema.safeParse(component.bindings.credentialRotation);
  if (!parsed.success) throw new RotationPrerequisite('Recorded database rotation recovery state is invalid; it was preserved.');
  return parsed.data;
}
export function rotationGenerationPending(spec: EnvironmentSpec, bindings: Record<string, unknown>): boolean {
  const desired = spec.database?.credentialRotation?.generation;
  if (!desired) return false;
  const state = bindings.credentialRotation as { generation?: number; phase?: string } | undefined;
  return state?.generation !== desired || state.phase !== 'installed';
}

/** Password-bearing bindings stay in the encrypted component store. */
export function replaceDatabaseBindingPassword(bindings: Record<string, unknown>, previous: string, next: string): Record<string, unknown> {
  const result = { ...bindings };
  if (bindings.password !== undefined && bindings.password !== previous && bindings.password !== next) {
    throw new RotationPrerequisite('The recorded database password changed; review its identity before rotation.');
  }
  result.password = next;
  let urls = 0;
  for (const key of ['connectionString', 'connectionUrl', 'pooledUrl']) {
    if (bindings[key] === undefined) continue;
    try {
      const url = new URL(String(bindings[key]));
      if (!['postgres:', 'postgresql:'].includes(url.protocol)
        || ![previous, next].includes(decodeURIComponent(url.password))) throw new RotationPrerequisite();
      url.password = next;
      result[key] = url.toString();
      urls++;
    } catch { throw new RotationPrerequisite('A database endpoint has an unknown credential; no binding was changed.'); }
  }
  if (!urls) throw new RotationPrerequisite('No bound database credential endpoint is available.');
  return result;
}

type Observe = (project: Project, environment: Environment, spec: EnvironmentSpec, recovery?: { databaseUrl?: string }) => Promise<{ observed: ObservedState | null }>;
async function maintenanceRecoveryInput(issuer: IDatabasePasswordRotation, component: Component,
  target: DatabaseCredentialRotationTarget, state?: RotationState): Promise<{ databaseUrl?: string }> {
  if (!state) return {};
  if (!databaseRotationTargetsMatch(state.target, target)) throw new RotationPrerequisite('Recovery target identity changed.');
  // A successful reset can leave the durable active binding on the OLD value
  // after a lost receipt. Verify the retained candidate before using it for
  // read-only fence observation. This does not accept or activate a rotation.
  const proof = await issuer.verifyPassword({ component, target, password: state.replacementPassword });
  if (proof.status !== 'accepted') return {};
  const bindings = replaceDatabaseBindingPassword(component.bindings, state.oldPassword, state.replacementPassword);
  const direct = bindings.connectionString ?? bindings.connectionUrl;
  if (typeof direct !== 'string' || !direct) throw new RotationPrerequisite('The exact recovery database endpoint is unavailable.');
  return { databaseUrl: direct };
}
const componentRepo = new ComponentRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
function load(project: Project, environmentName: string, spec: EnvironmentSpec) {
  const environment = envRepo.findByProjectAndName(project.id, environmentName);
  const matches = environment ? componentRepo.findByEnvironmentId(environment.id).filter(c => c.type === spec.database?.engine) : [];
  const component = matches.length === 1 ? matches[0] : undefined;
  if (!environment || !component || !component.externalId || component.bindings.provider !== spec.database?.provider
    || component.bindings.retainedCleanup || component.bindings.provisioningIncomplete || component.bindings.unresolvedMutation) {
    throw new RotationPrerequisite('Password rotation requires one complete, durably bound existing database in this environment.');
  }
  if (environment.platformBindings.ci !== undefined
    && (typeof environment.platformBindings.ci !== 'object' || environment.platformBindings.ci === null
      || Object.keys(environment.platformBindings.ci).length > 0)) {
    throw new RotationPrerequisite('Recorded CI credential consumers remain bound. Reconcile their lifecycle before database rotation; removing deploy intent does not remove stored credentials.');
  }
  return { environment, component };
}
function identityBindings(component: Component) {
  const { credentialRotation: _rotation, ...bindings } = component.bindings;
  return bindings;
}
function assertExclusive(component: Component) {
  const scope = z.record(z.string().min(1), z.string().min(1)).safeParse(component.bindings.providerScope);
  const scopeKeys = scope.success ? Object.keys(scope.data).sort() : [];
  const independentScope = (other: Component) => {
    const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(other.bindings.providerScope);
    return scopeKeys.length > 0 && parsed.success && isDeepStrictEqual(Object.keys(parsed.data).sort(), scopeKeys)
      && !isDeepStrictEqual(parsed.data, scope.success ? scope.data : undefined);
  };
  for (const project of new ProjectRepository().findAll()) for (const env of envRepo.findByProjectId(project.id)) {
    for (const other of componentRepo.findByEnvironmentId(env.id)) {
      if (other.id !== component.id && other.bindings.provider === component.bindings.provider
        && other.externalId === component.externalId && !independentScope(other)) {
        throw new RotationPrerequisite('The database identity is also bound to another environment. Shared credential rotation is unsupported.');
      }
    }
  }
}
function consumerNames(spec: EnvironmentSpec) { return Object.keys(spec.services).sort(); }
function consumerValuesMatch(observed: ObservedState | null, spec: EnvironmentSpec, component: Component, services: string[]): boolean {
  if (!observed || observed.partial || observed.completeness?.services === 'unknown') return false;
  const projection = buildDatabaseEnvVarsFromComponent(component).envVars;
  return services.every(name => {
    const found = observed.services.filter(service => service.name === name);
    const vars = { ...projection, ...buildDatabaseAliasEnvVars(projection, spec.services[name]?.databaseEnvAliases) };
    return found.length === 1 && Object.entries(vars).every(([key, value]) =>
      found[0].envVarKeys.includes(key) && found[0].envVarHashes[key] === hashEnvValue(value));
  });
}
function assertConsumers(spec: EnvironmentSpec, environment: Environment, observed: ObservedState | null) {
  const services = consumerNames(spec);
  if (!spec.maintenance?.enabled || observed?.maintenance?.state !== 'active' || observed.partial
    || observed.completeness?.services === 'unknown' || !services.length) {
    throw new RotationPrerequisite('Enter and verify environment maintenance before replacing this single-password credential.');
  }
  const bindings = environment.platformBindings.services as Record<string, { serviceId?: string }> | undefined;
  if (observed.services.length !== services.length || services.some(name => {
    const found = observed.services.filter(s => s.name === name);
    return found.length !== 1 || found[0].externalId !== bindings?.[name]?.serviceId
      || found[0].sourceState !== 'disconnected'
      || observed.maintenance?.workloads[name]?.state !== 'suspended'
      || observed.maintenance?.workloads[name]?.serviceId !== found[0].externalId;
  })) throw new RotationPrerequisite('Every consumer must have an exact observed identity, suspended workload and disconnected automatic deploy source.');
  return services;
}
function assertScope(spec: EnvironmentSpec, projectSpec?: ProjectSpec) {
  if (spec.backups?.mode === 'daily' && spec.backups.runnerImage) throw new RotationPrerequisite('Managed backup database consumers are not yet supported for rotation.');
  const ownedKeys = new Set<string>([...DATABASE_ENV_KEYS, ...Object.values(spec.services).flatMap(service => Object.keys(service.databaseEnvAliases ?? {}))]);
  if (Object.keys(spec.envVars).some(key => ownedKeys.has(key)) || Object.keys(projectSpec?.secrets ?? {}).some(key => ownedKeys.has(key))) {
    throw new RotationPrerequisite('Database runtime configuration overlaps separately managed application configuration. Resolve credential ownership before rotation.');
  }
  if (Object.values(projectSpec?.github?.actions ?? {}).some(action => action.kind === 'environment-task')) {
    throw new RotationPrerequisite('Environment-task database credential consumers are not yet supported for rotation.');
  }
  if (!spec.database?.credentialRotation || spec.database.credentialRotation.consumers !== 'environment-only'
    || spec.database.credentialRotation.destinations !== 'trusted') throw new RotationPrerequisite('Declare the database rotation generation, reviewed environment-only consumers and trusted destinations.');
  if (spec.deploy?.strategy === 'branch' && spec.deploy.trigger !== 'native') throw new RotationPrerequisite('Database password rotation cannot yet synchronize CI database consumers. This environment is blocked before issuance.');
  if (spec.database.resilience?.restoreDrill) throw new RotationPrerequisite('Managed restore-drill credential consumers are not yet supported for rotation.');
  if (Object.keys(spec.database.resilience?.replicas ?? {}).length) throw new RotationPrerequisite('Database replica credential consumers are not supported for rotation.');
}

export async function planDatabaseRotation(params: { project: Project; spec: ProjectSpec; revision: number;
  environmentName: string; observe: Observe; options?: PlanOptions }): Promise<EnvironmentPlan | { error: string }> {
  const { project, environmentName } = params;
  if (params.options?.serviceFilter !== undefined || params.options?.envVarOverrides !== undefined
    || params.options?.envFile !== undefined || params.options?.secretRefs !== undefined || params.options?.includeEnvFile === true) {
    return { error: 'Database rotation accepts no deployment, dotenv or secret inputs. Hypervibe generates the replacement password.' };
  }
  const spec = params.spec.environments[environmentName];
  if (!spec?.database) return { error: 'Database rotation requires a declared database.' };
  let observed: ObservedState | null = null;
  const actions: PlanAction[] = [];
  const blocked: EnvironmentPlan['blocked'] = [];
  let encrypted: string | undefined;
  let verification: RotationMetadata | undefined;
  let environment: Environment | undefined;
  try {
    assertScope(spec, params.spec);
    const current = load(project, environmentName, spec); environment = current.environment;
    const component = current.component;
    assertExclusive(component);
    const existing = rotationState(component);
    const generation = spec.database.credentialRotation!.generation;
    if (existing && existing.generation > generation) throw new RotationPrerequisite('Rotation generations cannot move backwards.');
    if (existing && existing.generation !== generation && existing.phase !== 'installed') throw new RotationPrerequisite('Recover the pending database rotation before requesting another generation.');
    const resolved = await adapterFactory.getDatabaseAdapter(spec.database.provider, project);
    const issuer = resolved.adapter?.passwordRotation;
    if (!resolved.success || !issuer) throw new RotationPrerequisite(`Database password rotation is unsupported or unavailable for ${spec.database.provider}. No host variable is treated as an issuer reset.`);
    const host = await adapterFactory.getHostingAdapterByName(spec.hosting.provider, project);
    if (!host.success || !host.adapter?.capabilities.supportsDeferredSecretUpdates) throw new RotationPrerequisite('The host cannot safely update passwords while keeping workloads stopped.');
    const target = await issuer.observeTarget(component);
    if (target.provider !== spec.database.provider || target.resourceId !== component.externalId
      || !isDeepStrictEqual(target.providerScope, component.bindings.providerScope)) throw new RotationPrerequisite('Database issuer scope does not match the durable binding.');
    const environmentFingerprint = bindingIdentityFingerprint(environment.platformBindings);
    const resuming = existing?.generation === generation ? existing : undefined;
    observed = (await params.observe(project, environment, spec, await maintenanceRecoveryInput(issuer, component, target, resuming))).observed;
    const services = assertConsumers(spec, environment, observed);
    if (resuming && (!databaseRotationTargetsMatch(target, resuming.target)
      || resuming.environmentFingerprint !== environmentFingerprint || !isDeepStrictEqual(resuming.services, services))) {
      throw new RotationPrerequisite('Pending rotation target or consumers changed; preserve the encrypted recovery record and review the original scope.');
    }
    const oldPassword = resuming?.oldPassword ?? component.bindings.password;
    if (typeof oldPassword !== 'string' || !oldPassword) throw new RotationPrerequisite('The previous database password is unavailable for authentication and recovery checks.');
    const replacementPassword = resuming?.replacementPassword ?? randomBytes(32).toString('base64url');
    const replacementBindings = replaceDatabaseBindingPassword(component.bindings, oldPassword, replacementPassword);
    const projected = buildDatabaseEnvVarsFromComponent({ ...component, bindings: replacementBindings }).envVars;
    for (const service of services) buildDatabaseAliasEnvVars(projected, spec.services[service].databaseEnvAliases);
    const bindingsFingerprint = resuming?.bindingsFingerprint ?? bindingIdentityFingerprint(identityBindings(component));
    const metadata: RotationMetadata = { operation: 'databasePasswordRotate', componentId: component.id, generation,
      target, environmentFingerprint, bindingsFingerprint, services };
    const id = `database-rotation:${component.id}:${generation}`;
    if (resuming?.phase === 'installed') {
      const replacement = await issuer.verifyPassword({ component, target, password: replacementPassword });
      const previous = await issuer.verifyPassword({ component, target, password: oldPassword });
      if (replacement.status !== 'accepted' || previous.status !== 'rejected'
        || !consumerValuesMatch(observed, spec, { ...component, bindings: replacementBindings }, services)) {
        throw new RotationPrerequisite('The saved installed generation no longer matches fresh issuer or consumer evidence. Review credential drift; no new password was issued.');
      }
      verification = metadata;
    }
    if (!resuming || resuming.phase !== 'installed') {
      actions.push({ id, type: 'update', resource: { kind: 'database', provider: target.provider, name: 'postgres' },
        verified: true, requiresConfirm: true, reason: 'Replace the database login password during maintenance; existing sessions and outside consumers remain an owner-reviewed boundary.', metadata });
      for (const name of services) {
        if (!serviceRepo.findByProjectAndName(project.id, name)) throw new RotationPrerequisite('A database consumer has no local service binding.');
        const serviceId = observed!.services.find(s => s.name === name)!.externalId;
        actions.push({ id: `${id}:service:${name}`, type: 'update', resource: { kind: 'secret', provider: spec.hosting.provider, name: `database:${name}` },
          verified: true, requiresConfirm: true, reason: `Install the verified replacement database credentials on ${name} without restarting it.`, dependsOn: [id],
          metadata: { ...metadata, operation: 'databasePasswordDistribute', service: name, serviceId } });
      }
      encrypted = getSecretStore().encryptObject({ oldPassword, replacementPassword });
    }
  } catch (error) {
    // Our own closed messages contain no values; adapter errors are never rendered.
    const message = error instanceof RotationPrerequisite
      ? error.message : 'Database rotation prerequisites or identity could not be verified.';
    actions.length = 0; encrypted = undefined; verification = undefined;
    blocked.push({ category: 'prerequisite', provider: spec.database.provider, reason: message });
  }
  const warnings = ['Rotation covers issuer password authentication and recorded runtime configuration. Existing sessions, application use and runtime rollout remain unchecked; keep maintenance until separately verified.'];
  const document = { kind: 'hv_plan', scope: 'database-rotation', databaseRotationReady: blocked.length === 0, environmentName, specRevision: params.revision,
    observedFingerprint: null, actions, warnings, ...(verification ? { databaseRotationVerification: verification } : {}),
    ...(encrypted ? { overrides: { databaseRotationEncrypted: encrypted } } : {}) };
  if (!environment) environment = envRepo.findByProjectAndName(project.id, environmentName) ?? undefined;
  if (!environment) return { error: blocked[0]?.reason ?? 'No bound environment is available for database rotation.' };
  const runs = new RunRepository();
  const run = runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: document });
  runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, scope: 'database-rotation', specRevision: params.revision, environmentName,
    verified: blocked.length === 0, observed: null, actions, warnings, blocked, inputRequired: [], unmanaged: [] };
}

const stop = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
/** No provider mutations, no new plan, and no saved marker substituted for live evidence. */
export async function verifyInstalledDatabaseRotation(params: { project: Project; projectSpec: ProjectSpec;
  spec: EnvironmentSpec; environmentName: string; metadata: unknown; observe: Observe }): Promise<boolean> {
  try {
    const m = rotationMetadataSchema.parse(params.metadata);
    assertScope(params.spec, params.projectSpec);
    const { component, environment } = load(params.project, params.environmentName, params.spec);
    const state = rotationState(component);
    if (!state || state.phase !== 'installed' || state.generation !== m.generation || component.id !== m.componentId
      || params.spec.database?.credentialRotation?.generation !== m.generation
      || state.bindingsFingerprint !== m.bindingsFingerprint || state.environmentFingerprint !== m.environmentFingerprint
      || bindingIdentityFingerprint(environment.platformBindings) !== m.environmentFingerprint
      || !databaseRotationTargetsMatch(state.target, m.target) || !isDeepStrictEqual(state.services, m.services)) return false;
    assertExclusive(component);
    const adapter = await adapterFactory.getDatabaseAdapter(m.target.provider, params.project);
    const issuer = adapter.adapter?.passwordRotation;
    if (!adapter.success || !issuer || !databaseRotationTargetsMatch(await issuer.observeTarget(component), m.target)) return false;
    const observed = (await params.observe(params.project, environment, params.spec,
      await maintenanceRecoveryInput(issuer, component, m.target, state))).observed;
    if (!isDeepStrictEqual(assertConsumers(params.spec, environment, observed), m.services)) return false;
    const bindings = replaceDatabaseBindingPassword(component.bindings, state.oldPassword, state.replacementPassword);
    return consumerValuesMatch(observed, params.spec, { ...component, bindings }, m.services)
      && (await issuer.verifyPassword({ component, target: m.target, password: state.replacementPassword })).status === 'accepted'
      && (await issuer.verifyPassword({ component, target: m.target, password: state.oldPassword })).status === 'rejected';
  } catch { return false; }
}
export async function applyDatabaseRotation(params: { project: Project; projectSpec: ProjectSpec; spec: EnvironmentSpec; environmentName: string;
  action: PlanAction; confirmed: ReadonlySet<string>; encrypted: string | undefined; observe: Observe }): Promise<ActionResult> {
  const parsed = databaseRotationActionSchema.safeParse(params.action);
  if (!parsed.success || !params.confirmed.has(params.action.id) || !params.encrypted) return stop('Database rotation requires its exact confirmed action and encrypted recovery input.');
  const m = parsed.data.metadata;
  try {
    assertScope(params.spec, params.projectSpec);
    const { environment, component } = load(params.project, params.environmentName, params.spec);
    if (component.id !== m.componentId || component.externalId !== m.target.resourceId
      || params.spec.database!.credentialRotation!.generation !== m.generation
      || bindingIdentityFingerprint(environment.platformBindings) !== m.environmentFingerprint) return stop('Database or consumer scope changed. Re-plan without discarding the recovery record.');
    assertExclusive(component);
    const prior = rotationState(component);
    const current = prior?.generation === m.generation ? prior : undefined;
    if (prior && prior.generation !== m.generation && prior.phase !== 'installed') return stop('A different database rotation needs recovery first.');
    if (!current && bindingIdentityFingerprint(identityBindings(component)) !== m.bindingsFingerprint) return stop('Database credentials changed after planning.');
    const values = z.object({ oldPassword: z.string().min(1), replacementPassword: z.string().min(32) }).strict()
      .parse(getSecretStore().decryptObject(params.encrypted));
    if (current && (current.oldPassword !== values.oldPassword || current.replacementPassword !== values.replacementPassword
      || current.bindingsFingerprint !== m.bindingsFingerprint || !databaseRotationTargetsMatch(current.target, m.target)
      || !isDeepStrictEqual(current.services, m.services))) return stop('Encrypted recovery inputs do not match the original rotation.');
    const expectedBindings = replaceDatabaseBindingPassword(component.bindings, values.oldPassword, values.replacementPassword);
    const projected = buildDatabaseEnvVarsFromComponent({ ...component, bindings: expectedBindings }).envVars;
    for (const service of m.services) buildDatabaseAliasEnvVars(projected, params.spec.services[service]?.databaseEnvAliases);
    const resolved = await adapterFactory.getDatabaseAdapter(m.target.provider, params.project);
    const issuer = resolved.adapter?.passwordRotation;
    const host = await adapterFactory.getHostingAdapterByName(params.spec.hosting.provider, params.project);
    if (!resolved.success || !issuer || !host.success || !host.adapter?.capabilities.supportsDeferredSecretUpdates) return stop('The reviewed database or stopped-workload writer is unavailable.');
    if (!databaseRotationTargetsMatch(await issuer.observeTarget(component), m.target)) return stop('The exact database identity changed.');
    const recoveryInput = await maintenanceRecoveryInput(issuer, component, m.target, current);
    const observed = (await params.observe(params.project, environment, params.spec, recoveryInput)).observed;
    if (!isDeepStrictEqual(assertConsumers(params.spec, environment, observed), m.services)) return stop('The exact consumer identities changed.');
    const verify = async () => ({
      replacement: await issuer.verifyPassword({ component, target: m.target, password: values.replacementPassword }),
      previous: await issuer.verifyPassword({ component, target: m.target, password: values.oldPassword }),
    });
    let proofs = await verify();
    let state: RotationState = current ?? { generation: m.generation, phase: 'attempted', target: m.target,
      environmentFingerprint: m.environmentFingerprint, bindingsFingerprint: m.bindingsFingerprint, services: m.services,
      installedServices: [], ...values, startedAt: new Date().toISOString() };
    if (m.operation === 'databasePasswordRotate') {
      if (!current) {
        if (proofs.previous.status !== 'accepted' || proofs.replacement.status !== 'rejected') return stop('Fresh authentication does not prove the expected original password and unused replacement. No issuer write was attempted.');
        // Commit encrypted intent BEFORE the irreversible network boundary.
        componentRepo.updateBindings(component.id, { credentialRotation: state });
        const saved = rotationState(componentRepo.findById(component.id)!);
        if (!saved || !isDeepStrictEqual(saved, state)) return stop('Encrypted recovery intent could not be verified; issuer write blocked.');
        await issuer.replacePassword({ component, target: m.target, replacementPassword: values.replacementPassword });
        proofs = await verify();
      }
      if (proofs.replacement.status !== 'accepted' || proofs.previous.status !== 'rejected') return stop('Password replacement is not verified. The encrypted recovery record is retained; retries only check authentication and never repeat an uncertain reset.');
      state = { ...state, phase: state.phase === 'installed' ? 'installed' : 'issuer-verified', issuerVerifiedAt: state.issuerVerifiedAt ?? new Date().toISOString() };
      componentRepo.update(component.id, { bindings: { ...expectedBindings, credentialRotation: state } });
      return { success: true, message: 'New database password accepted and old password rejected on fresh connections. Consumer installation follows; existing sessions remain unchecked.',
        data: { issuerPasswordVerified: true, existingSessions: 'unchecked', applicationUse: 'unchecked' } };
    }
    if (!current || current.phase === 'attempted' || proofs.replacement.status !== 'accepted' || proofs.previous.status !== 'rejected') return stop('Issuer password replacement must be verified before consumer installation.');
    if (params.action.resource.provider !== params.spec.hosting.provider
      || observed!.services.find(s => s.name === m.service)?.externalId !== m.serviceId) return stop('The exact hosting consumer changed.');
    const service = serviceRepo.findByProjectAndName(params.project.id, m.service!);
    if (!service) return stop('The reviewed consumer is no longer bound.');
    const projection = buildDatabaseEnvVarsFromComponent({ ...component, bindings: expectedBindings }).envVars;
    const vars = { ...projection, ...buildDatabaseAliasEnvVars(projection, params.spec.services[m.service!].databaseEnvAliases) };
    const matches = (state: ObservedState | null) => {
      const found = state?.services.filter(s => s.name === m.service && s.externalId === m.serviceId);
      return !state?.partial && state?.completeness?.services !== 'unknown' && found?.length === 1
        && Object.entries(vars).every(([key, value]) => found[0].envVarKeys.includes(key) && found[0].envVarHashes[key] === hashEnvValue(value));
    };
    if (!matches(observed)) {
      const receipt = await host.adapter.setEnvVars(environment, service, vars, { deferDeployment: true, requireDeferredSecretUpdate: true });
      if (!receipt.success) return stop('The host did not acknowledge credential installation. Recovery retains the same replacement.');
    }
    const after = (await params.observe(params.project, environment, params.spec, recoveryInput)).observed;
    assertConsumers(params.spec, environment, after);
    if (!matches(after)) return stop('Replacement values are not yet verified on the exact consumer. Re-plan to reconcile; no rollout was authorized.');
    const installedServices = [...new Set([...current.installedServices, m.service!])].sort();
    const installed = isDeepStrictEqual(installedServices, m.services);
    if (installed) {
      proofs = await verify();
      if (proofs.replacement.status !== 'accepted' || proofs.previous.status !== 'rejected'
        || !consumerValuesMatch(after, params.spec, { ...component, bindings: expectedBindings }, m.services)) {
        return stop('Final verification did not cover the issuer and every current consumer. Recovery stays pending; no rollout is authorized.');
      }
    }
    state = { ...current, installedServices, phase: installed ? 'installed' : 'issuer-verified', ...(installed ? { installedAt: new Date().toISOString() } : {}) };
    componentRepo.updateBindings(component.id, { credentialRotation: state });
    return { success: true, message: 'Replacement database credentials verified on the stopped consumer. Resume and verify the application through the separate deployment lifecycle.',
      data: { credentialsInstalled: true, runtimeRollout: 'pending', applicationUse: 'unchecked', existingSessions: 'unchecked' } };
  } catch { return stop('Database rotation could not be verified safely. No secret diagnostics are returned; preserve the encrypted recovery record and re-plan.'); }
}
