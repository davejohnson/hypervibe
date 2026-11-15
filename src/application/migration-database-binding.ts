import type { CommandContext } from './context.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';

type RecordValue = Record<string, unknown>;
type Identity = { provider: string; id: string; scope: Record<string, string> };
type Evidence = { identities: Identity[]; conflict: boolean };
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value === value.trim() ? value : undefined;
const same = (left: Identity, right: Identity): boolean => left.provider === right.provider && left.id === right.id
  && Object.keys(left.scope).length === Object.keys(right.scope).length
  && Object.entries(left.scope).every(([key, value]) => right.scope[key] === value);

/** Persisted IDs can veto an alias; they never prove that two live connections are distinct. */
function componentIdentity(component: Component, environment: Environment, evidence: Evidence): Identity | undefined {
  const bindings = record(component.bindings);
  if (!bindings) { evidence.conflict = true; return; }
  const provider = text(bindings.provider);
  if (!provider) {
    if (bindings.provider !== undefined) evidence.conflict = true;
    return;
  }
  const keys = providerRegistry.get(provider)?.inspection?.selectors.database?.scopeKeys;
  if (!keys?.length) return;
  const explicit = record(bindings.providerScope);
  if (bindings.providerScope !== undefined && !explicit) { evidence.conflict = true; return; }
  let id = text(component.externalId);
  if (!id) return;
  const derived: Record<string, string> = {};
  const normalize = (value: string): string => provider === 'azure-postgres' ? value.toLowerCase() : value;
  // ARM IDs carry their own complete scope; displayed casing is not identity.
  if (provider === 'azure-postgres') {
    const arm = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/([^/]+)$/i.exec(id);
    if (!arm) { evidence.conflict = true; return; }
    derived.subscriptionId = arm[1]!.toLowerCase();
    derived.resourceGroup = arm[2]!.toLowerCase();
    id = id.toLowerCase();
  }
  if (provider === 'rds') {
    // DescribeDBInstances accepts either a case-insensitive identifier or ARN.
    // https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBInstances.html
    if (id.toLowerCase().startsWith('arn:')) {
      const arn = /^arn:aws[a-z-]*:rds:([^:]+):(\d{12}):db:([^:]+)$/i.exec(id);
      if (!arn) { evidence.conflict = true; return; }
      derived.region = arn[1]!.toLowerCase();
      derived.accountId = arn[2]!;
      id = arn[3]!;
    }
    id = id.toLowerCase();
  }
  const environmentScope = environment.platformBindings.provider === provider ? environment.platformBindings : {};
  const scope: Record<string, string> = {};
  for (const key of keys) {
    const supplied = [derived[key], explicit?.[key], bindings[key], environmentScope[key]].filter(value => value !== undefined);
    if (supplied.some(value => !text(value))) { evidence.conflict = true; return; }
    const values = supplied.map(value => normalize(value as string));
    if (new Set(values).size > 1) { evidence.conflict = true; return; }
    if (values[0]) scope[key] = values[0];
  }
  if (Object.keys(scope).length !== keys.length) return;
  return { provider, id, scope };
}

function identities(ctx: CommandContext, project: Project, spec: ProjectSpec, environment: Environment): Evidence {
  const evidence: Evidence = { identities: [], conflict: false };
  if (environment.projectId !== project.id) { evidence.conflict = true; return evidence; }
  const bindings = record(environment.platformBindings);
  if (!bindings) { evidence.conflict = true; return evidence; }
  const declared = spec.environments[environment.name]?.database?.provider;
  const add = (identity: Identity | undefined) => {
    if (!identity) return;
    if (declared !== undefined && declared !== identity.provider) evidence.conflict = true;
    evidence.identities.push(identity);
  };
  const components = ctx.repos.components.findByEnvironmentId(environment.id).filter(component => component.type === 'postgres');
  if (components.length > 1) evidence.conflict = true;
  for (const component of components) {
    const provider = text(record(component.bindings)?.provider);
    if (provider && declared !== undefined && provider !== declared) evidence.conflict = true;
    add(componentIdentity(component, environment, evidence));
  }
  const engine = record(bindings.engine);
  const database = record(engine?.database);
  if (engine?.database !== undefined && !database) evidence.conflict = true;
  if (database) {
    if (declared !== undefined && declared !== 'cloudsql') evidence.conflict = true;
    if (['instanceName', 'connectionName'].some(key => database[key] !== undefined && !text(database[key]))) evidence.conflict = true;
    const instance = text(database.instanceName);
    const projectId = text(bindings.projectId);
    const connectionName = text(database.connectionName);
    const connection = connectionName?.split(':');
    if (connectionName && (connection?.length !== 3 || connection.some(part => !part)
      || instance && connection[2] !== instance || projectId && connection[0] !== projectId
      || text(bindings.environmentId) && connection[1] !== bindings.environmentId)) evidence.conflict = true;
    const nativeInstance = instance ?? connection?.[2];
    const nativeProject = projectId ?? connection?.[0];
    if (nativeInstance && nativeProject) add({ provider: 'cloudsql', id: nativeInstance, scope: { projectId: nativeProject } });
  }
  // AwsEngineBinding currently persists no cluster ARN/ID or account/region.
  // Its generated prefix and databaseLoginAt are not native identity evidence.
  const first = evidence.identities[0];
  if (first && evidence.identities.some(identity => !same(first, identity))) evidence.conflict = true;
  const primary = record(record(bindings.databaseTopology)?.primary);
  if (primary && first && (text(primary.provider) !== first.provider || text(primary.externalId) !== first.id)) {
    // Compare through the same native parser so ARM/ARN representations agree.
    const primaryIdentity = componentIdentity({ ...components[0], bindings: { provider: primary.provider,
      providerScope: first.scope }, externalId: text(primary.externalId) ?? null } as Component, environment, evidence);
    if (!primaryIdentity || !same(first, primaryIdentity)) evidence.conflict = true;
  }
  return evidence;
}

/** Candidate cleanup requires complete distinct native identities for both databases. */
export function migrationDatabaseComponentBindingConflict(
  source: { environment: Environment; component: Component },
  target: { environment: Environment; component: Component },
): string | undefined {
  if (text(source.component.id) && source.component.id === target.component.id) {
    return 'The migration candidate is an existing database component. It cannot be copied into or deleted as a migration candidate.';
  }
  try {
    const evidence: Evidence = { identities: [], conflict: false };
    const left = componentIdentity(source.component, source.environment, evidence);
    const right = componentIdentity(target.component, target.environment, evidence);
    if (source.component.environmentId !== source.environment.id || target.component.environmentId !== target.environment.id
      || evidence.conflict) return 'The recorded database identities conflict. The migration candidate must be preserved for review.';
    if (!left || !right) return 'The recorded database identities are incomplete. The migration candidate must be preserved for review.';
    if (same(left, right)) return 'The migration candidate is bound to an existing database instance. It cannot be copied into or deleted as a migration candidate.';
  } catch {
    return 'The recorded database identities could not be read safely. The migration candidate must be preserved for review.';
  }
  return undefined;
}

/**
 * Early, read-only veto before setup or cutover. Missing bindings are unknown,
 * allowing a new target to be prepared. The transfer boundary must independently
 * prove live database distinctness before replacing any data.
 */
export function migrationDatabaseBindingConflict(ctx: CommandContext, project: Project, spec: ProjectSpec,
  source: Environment, target: Environment | undefined): string | undefined {
  if (target && (source.id === target.id || source.name === target.name)) return 'Choose a different target environment; a migration cannot copy an environment into itself.';
  try {
    const sourceEvidence = identities(ctx, project, spec, source);
    const targetEvidence = target ? identities(ctx, project, spec, target) : undefined;
    if (sourceEvidence.conflict || targetEvidence?.conflict) return 'The recorded database identities conflict. Review the database bindings before migrating; no migration changes were made.';
    if (sourceEvidence.identities.some(left => targetEvidence?.identities.some(right => same(left, right)))) {
      return 'The source and target are bound to the same database instance. Choose a separate target database before migrating.';
    }
  } catch {
    return 'The recorded database identities could not be read safely. Review the database bindings before migrating; no migration changes were made.';
  }
  return undefined;
}
