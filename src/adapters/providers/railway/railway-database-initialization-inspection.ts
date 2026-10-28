import { createHash } from 'node:crypto';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import {
  databaseInitializationApprovedVariablesSchema, databaseInitializationBootstrapInspectionSchema,
  databaseInitializationImageSchema, type IDatabaseInitializationBootstrap,
} from '../../../domain/ports/database-initialization-bootstrap.port.js';
import type { RecoverySourceIdentity } from '../../../domain/ports/recovery-source.port.js';
import { completedDatabaseInitializationReceiptSchema, completedDatabaseInitializationDeploymentId } from '../../../domain/plan/database-initialization.contract.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from '../../../domain/services/recovery-source.js';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const identity = recoveryIdentityStringSchema;
const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const reference = /^\$\{\{\s*([A-Za-z0-9_-]+)\.([A-Z_][A-Z0-9_]*)\s*\}\}$/;
const unsafeKey = (key: string) => /^(?:PG|NODE_|HYPERVIBE_|RAILWAY_)/.test(key);
const nodeOverrides = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']);
const variables = z.record(z.string(), z.string());
const inspectedVariables = z.object({ applicationDefinitions: variables, applicationResolved: variables,
  databaseDefinitions: variables, databaseResolved: variables }).strict();
const inputSchema = z.object({ completedInitialization: completedDatabaseInitializationReceiptSchema.pick({
  target: true, storageId: true, storageInstanceId: true, deploymentId: true, activationReconciliation: true,
}),
  sourceServiceName: identity, expectedImage: databaseInitializationImageSchema,
  databaseEnvAliases: z.record(envKey, z.enum(['DATABASE_URL', 'DIRECT_URL'])).optional(),
  approvedVariables: databaseInitializationApprovedVariablesSchema.optional(),
}).strict();
const owns = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key);
const fail = (): never => { throw new Error('Private database bootstrap configuration could not be verified. Re-plan after resolving the exact source, image, references or supported connection configuration.'); };

function connection(value: string) {
  if (!value || value.trim() !== value || value.includes('${{') || /[\u0000-\u0020\u007f]/.test(value)) return fail();
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password
    || url.pathname.length < 2 || url.hash
    || [...url.searchParams.keys()].some(key => !['sslmode', 'application_name'].includes(key))
    || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.has('sslmode') && !['disable', 'require', 'verify-full', 'no-verify'].includes(url.searchParams.get('sslmode')!)) return fail();
  const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
  if ([username, password, database].some(part => !part || /[\u0000-\u001f\u007f]/.test(part))) return fail();
  return { username, password, database, hostname: url.hostname.toLowerCase(), port: url.port || '5432' };
}

function issuerDefinitions(raw: Record<string, string>, resolved: Record<string, string>, roots: Set<string>): Record<string, string> {
  const retained: Record<string, string> = {};
  const visit = (key: string, active = new Set<string>()) => {
    if (active.has(key) || active.size >= 16 || Object.keys(retained).length >= 64) return fail();
    if (owns(retained, key)) return;
    if (!owns(raw, key)) {
      // Native private DNS is injected by Railway, not necessarily authored.
      if (key === 'RAILWAY_PRIVATE_DOMAIN' && resolved[key]) return;
      return fail();
    }
    const value = raw[key]!;
    const dependencies: string[] = [];
    const remainder = value.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (_token, name: string) => {
      dependencies.push(name); return '';
    });
    if (remainder.includes('${{') || remainder.includes('}}')) return fail();
    for (const dependency of dependencies) visit(dependency, new Set([...active, key]));
    retained[key] = value;
  };
  for (const key of roots) if (owns(raw, key)) visit(key);
  return retained;
}

/** No mutations and no public/private SQL bridge. Opaque variable-map semantics
 * follow Railway's documented raw references and deployment-resolved values. */
export function createRailwayDatabaseInitializationInspection(
  client: () => GraphQLClient | null | undefined,
  validateSource: (source: RecoverySourceIdentity) => Promise<void>,
): IDatabaseInitializationBootstrap {
  return {
    async inspect(input) {
      try {
        const { environment, ...selection } = input;
        const checked = inputSchema.parse(selection), initialized = checked.completedInitialization;
        const source = recoverySourceIdentitySchema.parse({
          provider: initialized.target.provider, primaryExternalId: initialized.target.externalId,
          providerScope: initialized.target.providerScope,
          resourceIdentity: { volumeId: initialized.storageId, volumeInstanceId: initialized.storageInstanceId },
        });
        const databaseDeploymentId = completedDatabaseInitializationDeploymentId(initialized);
        const projectId = source.providerScope.projectId, environmentId = source.providerScope.environmentId;
        const bindings = environment.platformBindings;
        const service = record(bindings.services) ? bindings.services[checked.sourceServiceName] : undefined;
        const serviceId = record(service) ? service.serviceId : undefined;
        if (source.provider !== 'railway' || Object.keys(source.providerScope).length !== 2
          || !projectId || !environmentId || Object.keys(source.resourceIdentity).length !== 2
          || !source.resourceIdentity.volumeId || !source.resourceIdentity.volumeInstanceId
          || bindings.provider !== 'railway' || bindings.projectId !== projectId || bindings.environmentId !== environmentId
          || !identity.safeParse(serviceId).success || serviceId === source.primaryExternalId) return fail();
        const sourceServiceId = String(serviceId), databaseId = source.primaryExternalId;
        const connected = client();
        if (!connected) return fail();
        const request = (query: string, values: Record<string, unknown>) => connected.request<unknown>(query, values);
        await validateSource(source);
        const ids = { projectId, environmentId, serviceId: sourceServiceId, databaseId,
          deploymentId: databaseDeploymentId };
        const state = await request(gql`
          query DatabaseInitializationIdentity($projectId: String!, $environmentId: String!, $serviceId: String!, $databaseId: String!, $deploymentId: String!) {
            environment(id: $environmentId, projectId: $projectId) { id projectId deletedAt }
            applicationService: service(id: $serviceId) { id name projectId deletedAt }
            databaseService: service(id: $databaseId) { id name projectId deletedAt }
            application: serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
              id serviceId environmentId deletedAt source { image }
            }
            database: serviceInstance(serviceId: $databaseId, environmentId: $environmentId) {
              id serviceId environmentId deletedAt activeDeployments { id }
            }
            initializedDeployment: deployment(id: $deploymentId) {
              id projectId environmentId serviceId status deploymentStopped
            }
          }
        `, ids);
        if (!record(state) || !record(state.environment) || state.environment.id !== environmentId
          || state.environment.projectId !== projectId || state.environment.deletedAt !== null) return fail();
        for (const [key, expected] of [['applicationService', sourceServiceId], ['databaseService', databaseId]] as const) {
          const observed = state[key];
          if (!record(observed) || observed.id !== expected || observed.projectId !== projectId || observed.deletedAt !== null
            || typeof observed.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(observed.name)) return fail();
        }
        for (const [key, expected] of [['application', sourceServiceId], ['database', databaseId]] as const) {
          const observed = state[key];
          if (!record(observed) || !identity.safeParse(observed.id).success || observed.serviceId !== expected
            || observed.environmentId !== environmentId || observed.deletedAt !== null) return fail();
        }
        const application = state.application as Record<string, unknown>, database = state.database as Record<string, unknown>;
        const deployment = state.initializedDeployment;
        if (!record(application.source) || application.source.image !== checked.expectedImage
          || !Array.isArray(database.activeDeployments) || database.activeDeployments.length !== 1
          || !record(database.activeDeployments[0]) || database.activeDeployments[0].id !== databaseDeploymentId
          || !record(deployment) || deployment.id !== databaseDeploymentId || deployment.projectId !== projectId
          || deployment.environmentId !== environmentId || deployment.serviceId !== databaseId
          || deployment.status !== 'SUCCESS' || deployment.deploymentStopped !== false) return fail();
        const applicationName = String((state.applicationService as Record<string, unknown>).name);
        const databaseName = String((state.databaseService as Record<string, unknown>).name);
        const names: Array<{ id: string; name: string }> = [], seenIds = new Set<string>(), cursors = new Set<string>();
        let after: string | undefined;
        for (let page = 0; ; page += 1) {
          if (page >= 20) return fail();
          const inventory = await request(gql`
            query DatabaseInitializationServices($projectId: String!, $after: String) {
              project(id: $projectId) {
                id services(first: 100, after: $after) {
                  edges { node { id name projectId deletedAt } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          `, { projectId, ...(after ? { after } : {}) });
          if (!record(inventory) || !record(inventory.project) || inventory.project.id !== projectId
            || !record(inventory.project.services)) return fail();
          const list = inventory.project.services;
          if (!Array.isArray(list.edges) || list.edges.length > 100 || !record(list.pageInfo)
            || typeof list.pageInfo.hasNextPage !== 'boolean' || !owns(list.pageInfo, 'endCursor')) return fail();
          for (const edge of list.edges) {
            const node = record(edge) ? edge.node : undefined;
            if (!record(node) || !identity.safeParse(node.id).success || typeof node.name !== 'string'
              || node.projectId !== projectId || node.deletedAt !== null && typeof node.deletedAt !== 'string'
              || seenIds.has(String(node.id))) return fail();
            seenIds.add(String(node.id));
            if (node.deletedAt === null) names.push({ id: String(node.id), name: node.name });
          }
          if (!list.pageInfo.hasNextPage) break;
          const next = list.pageInfo.endCursor;
          if (typeof next !== 'string' || !next || cursors.has(next)) return fail();
          cursors.add(next); after = next;
        }
        for (const [id, name] of [[sourceServiceId, applicationName], [databaseId, databaseName]]) {
          if (names.filter(item => item.name === name).length !== 1 || !names.some(item => item.id === id && item.name === name)) return fail();
        }
        const applicationKeys = new Set<string>(), variableIds = new Set<string>(), variableCursors = new Set<string>();
        after = undefined;
        for (let page = 0; ; page += 1) {
          if (page >= 20) return fail();
          const inventory = await request(gql`
            query DatabaseInitializationVariableKeys($environmentId: String!, $after: String) {
              environment(id: $environmentId) {
                id projectId variables(first: 100, after: $after) {
                  edges { node { id name serviceId } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          `, { environmentId, ...(after ? { after } : {}) });
          if (!record(inventory) || !record(inventory.environment) || inventory.environment.id !== environmentId
            || inventory.environment.projectId !== projectId || !record(inventory.environment.variables)) return fail();
          const list = inventory.environment.variables;
          if (!Array.isArray(list.edges) || list.edges.length > 100 || !record(list.pageInfo)
            || typeof list.pageInfo.hasNextPage !== 'boolean' || !owns(list.pageInfo, 'endCursor')) return fail();
          for (const edge of list.edges) {
            const node = record(edge) ? edge.node : undefined;
            if (!record(node) || !identity.safeParse(node.id).success || typeof node.name !== 'string'
              || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name)
              || node.serviceId !== null && !identity.safeParse(node.serviceId).success
              || variableIds.has(String(node.id))) return fail();
            variableIds.add(String(node.id));
            if (node.serviceId === sourceServiceId) {
              if (applicationKeys.has(String(node.name))) return fail();
              applicationKeys.add(String(node.name));
            }
          }
          if (!list.pageInfo.hasNextPage) break;
          const next = list.pageInfo.endCursor;
          if (typeof next !== 'string' || !next || variableCursors.has(next)) return fail();
          variableCursors.add(next); after = next;
        }
        const values = inspectedVariables.parse(await request(gql`
          query DatabaseInitializationVariables($projectId: String!, $environmentId: String!, $serviceId: String!, $databaseId: String!) {
            applicationDefinitions: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
            applicationResolved: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
            databaseDefinitions: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $databaseId, unrendered: true)
            databaseResolved: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $databaseId)
          }
        `, { projectId, environmentId, serviceId: sourceServiceId, databaseId }));
        const { applicationDefinitions: raw, applicationResolved: resolved, databaseDefinitions: issuerRaw, databaseResolved: issuer } = values;
        if ([...applicationKeys, ...Object.keys(raw), ...Object.keys(resolved)].some(key => key.startsWith('PG') || nodeOverrides.has(key))) return fail();
        const approvedVariables = checked.approvedVariables ?? {};
        if (owns(raw, 'NODE_ENV') !== owns(approvedVariables, 'NODE_ENV')
          || owns(resolved, 'NODE_ENV') !== owns(approvedVariables, 'NODE_ENV')
          || applicationKeys.has('NODE_ENV') !== owns(approvedVariables, 'NODE_ENV')
          || owns(approvedVariables, 'NODE_ENV') && resolved.NODE_ENV !== approvedVariables.NODE_ENV) return fail();
        const aliases = checked.databaseEnvAliases ?? {};
        if (Object.keys(aliases).some(key => ['DATABASE_URL', 'DIRECT_URL'].includes(key) || unsafeKey(key))) return fail();
        const keys = [...new Set(['DATABASE_URL',
          ...(applicationKeys.has('DIRECT_URL') || owns(raw, 'DIRECT_URL') || owns(resolved, 'DIRECT_URL') || Object.values(aliases).includes('DIRECT_URL') ? ['DIRECT_URL'] : []),
          ...Object.keys(aliases)])].sort();
        if (keys.length > 16 || keys.some(key => !applicationKeys.has(key))) return fail();
        const canonicalSources: Record<string, string> = {};
        for (const key of keys.filter(key => key === 'DATABASE_URL' || key === 'DIRECT_URL')) {
          const match = reference.exec(raw[key] ?? '');
          if (!match || match[1] !== databaseName || (key === 'DATABASE_URL' ? match[2] !== 'DATABASE_URL'
            : !['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL'].includes(match[2]!))) return fail();
          canonicalSources[key] = match[2]!;
        }
        const privateDomain = issuer.RAILWAY_PRIVATE_DOMAIN;
        if (!privateDomain || !/^[a-z0-9][a-z0-9.-]*\.railway\.internal$/i.test(privateDomain)
          || !issuer.POSTGRES_PASSWORD || issuer.POSTGRES_PASSWORD.includes('${{')
          || ['POSTGRES_PASSWORD_FILE', 'POSTGRES_USER_FILE', 'POSTGRES_DB_FILE'].some(key => owns(issuerRaw, key) || owns(issuer, key))) return fail();
        // Official postgres entrypoint defaults: user postgres; database defaults
        // to the selected user. This fresh-only path never treats these settings
        // as password rotation of an initialized cluster.
        const username = issuer.POSTGRES_USER ?? 'postgres', databaseNameExpected = issuer.POSTGRES_DB ?? username;
        if (!username || !databaseNameExpected || [username, databaseNameExpected].some(value => value.includes('${{'))) return fail();
        const variableReferences: Array<{ sourceServiceId: string; variableName: string; targetName: string }> = [];
        for (const key of keys) {
          const match = reference.exec(raw[key] ?? ''), expected = canonicalSources[aliases[key] ?? key];
          if (!match || match[1] !== databaseName || match[2] !== expected || !owns(issuerRaw, expected!)
            || !resolved[key] || resolved[key] !== issuer[expected!]) return fail();
          const url = connection(resolved[key]!);
          if (url.username !== username || url.database !== databaseNameExpected || url.password !== issuer.POSTGRES_PASSWORD
            || url.hostname !== privateDomain.toLowerCase() || issuer.PGPORT !== undefined && url.port !== issuer.PGPORT) return fail();
          variableReferences.push({ sourceServiceId: databaseId, variableName: expected!, targetName: key });
        }
        const issuerKeys = new Set([...Object.values(canonicalSources), 'POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB',
          'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGHOST', 'PGPORT', 'RAILWAY_PRIVATE_DOMAIN']);
        await validateSource(source);
        return databaseInitializationBootstrapInspectionSchema.parse({ source, databaseDeploymentId,
          sourceServiceId, sourceInstanceId: application.id, image: checked.expectedImage, variableReferences, approvedVariables,
          verification: { rawReferences: 'verified', configuredValues: 'matched', sqlAuthentication: 'unchecked',
            deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' },
          privateConfiguration: { keys,
            expectedHashes: Object.fromEntries(keys.map(key => [key, createHash('sha256').update(resolved[key]!).digest('hex')])),
            authentication: { username, database: databaseNameExpected },
            rawDefinitions: Object.fromEntries([...keys, ...Object.keys(approvedVariables)].map(key => [key, raw[key]!])),
            issuerDefinitions: issuerDefinitions(issuerRaw, issuer, issuerKeys),
            resolvedValues: Object.fromEntries(keys.map(key => [key, resolved[key]!])),
          },
        });
      } catch {
        // GraphQL and schema errors may quote resolved URLs or secret input.
        return fail();
      }
    },
  };
}
