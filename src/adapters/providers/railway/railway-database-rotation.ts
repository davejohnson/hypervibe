import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { DatabaseCredentialConfiguration, DatabaseCredentialRuntimeConfiguration, DatabaseCredentialTarget } from '../../../domain/ports/database-credential.port.js';
import { DatabaseCredentialReviewError } from '../../../domain/ports/database-credential.port.js';
import { hashEnvValue } from '../../../domain/ports/observe.port.js';
import { replaceDatabasePassword } from '../../../domain/services/database-credential-value.js';
import type { RailwayRuntimeReader } from './railway-runtime-evidence.js';
import { prepareRailwayDatabaseCredentialAliases, RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS } from './railway-database-credential-aliases.js';

const text = z.string().min(1), variables = z.record(z.string(), z.string());
const serviceSchema = z.object({ id: text, name: text, projectId: text, deletedAt: z.null() });
const instanceSchema = z.object({ id: text, serviceId: text, environmentId: text, deletedAt: z.null(), service: serviceSchema,
  latestDeployment: z.object({ id: text, status: text }).nullable() });
const connectionSchema = z.object({ edges: z.array(z.object({ node: instanceSchema })), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });
const stateSchema = z.object({ baselinePassword: text, required: z.record(z.string(), z.array(text)), inventory: z.array(z.object({ id: text, serviceId: text, name: text })),
  issuer: z.object({ definitions: variables, rendered: variables }),
  references: z.record(z.string(), variables) }).strict();
const urlKeys = new Set(['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL']);
const tokenPattern = /\$\{\{\s*([^{}]+?)\s*\}\}/g;
const wholeReference = /^\$\{\{\s*([^{}]+?)\s*\}\}$/;
const driverEnvironment = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGOPTIONS', 'PGAPPNAME', 'PGCLIENT_ENCODING', 'PGREPLICATION'];
type Instance = z.infer<typeof instanceSchema> & { definitions: Record<string, string>; rendered: Record<string, string> };

/** PRIVATE issuer/reference evidence. All returned values are encrypted by the
 * rotation plan; only bounded state enums may cross an application boundary. */
export function createRailwayDatabaseRotationConfiguration(clientFor: () => GraphQLClient | null | undefined,
  runtime?: RailwayRuntimeReader): DatabaseCredentialRuntimeConfiguration {
  const request = async (document: string, values: Record<string, unknown>): Promise<unknown> => {
    try { const client = clientFor(); if (!client) throw new Error(); return await client.request(document, values); }
    catch { throw new Error('Railway database rotation evidence or acknowledgement is unavailable.'); }
  };
  function scope(environment: Environment, component: Component, target: DatabaseCredentialTarget) {
    const ids = z.object({ projectId: text, environmentId: text }).strict().parse(component.bindings.providerScope);
    if (target.provider !== 'railway' || target.componentId !== component.id || target.environmentId !== environment.id
      || target.externalId !== component.externalId || !isDeepStrictEqual(ids, target.providerScope)
      || environment.platformBindings.projectId !== ids.projectId || environment.platformBindings.environmentId !== ids.environmentId
      || component.environmentId !== environment.id || component.bindings.provider !== 'railway'
      || component.bindings.resourceKind !== 'service' || component.bindings.retainedCleanup === true) throw new Error('Database rotation identity changed.');
    return { ...ids, serviceId: target.externalId };
  }
  async function read(environment: Environment, component: Component, target: DatabaseCredentialTarget) {
    const ids = scope(environment, component, target), all: Instance[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 64; page++) {
      const result = z.object({ environment: z.object({ id: text, projectId: text, deletedAt: z.null(), serviceInstances: connectionSchema }) }).parse(await request(gql`
        query DatabaseRotationInventory($environmentId: String!, $after: String) {
          environment(id: $environmentId) { id projectId deletedAt serviceInstances(first: 100, after: $after) {
            edges { node { id serviceId environmentId deletedAt service { id name projectId deletedAt } latestDeployment { id status } } }
            pageInfo { hasNextPage endCursor }
          } }
        }
      `, { environmentId: ids.environmentId, after: cursor }));
      if (result.environment.id !== ids.environmentId || result.environment.projectId !== ids.projectId) throw new Error('Database rotation environment identity changed.');
      const connection = result.environment.serviceInstances;
      for (const { node } of connection.edges) {
        if (node.environmentId !== ids.environmentId || node.service.projectId !== ids.projectId || node.service.id !== node.serviceId
          || all.some(existing => existing.id === node.id || existing.serviceId === node.serviceId || existing.service.name === node.service.name)) throw new Error('Database rotation service inventory is ambiguous.');
        const values = z.object({ definitions: variables, rendered: variables }).parse(await request(gql`
          query DatabaseRotationVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
            definitions: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
            rendered: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
          }
        `, { ...ids, serviceId: node.serviceId }));
        if (Object.keys(values.definitions).some(key => !Object.hasOwn(values.rendered, key))
          || Object.values(values.rendered).some(value => value.includes('${{'))) throw new Error('Database rotation variable dependency evidence is incomplete.');
        all.push({ ...node, ...values });
      }
      if (!connection.pageInfo.hasNextPage) return { ids, all: all.sort((a, b) => a.serviceId.localeCompare(b.serviceId)) };
      cursor = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor) || all.length > 1000) break;
      seen.add(cursor);
    }
    throw new Error('Database rotation service inventory is incomplete.');
  }
  async function inspect(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string,
    required: Record<string, string[]>, priorReview?: DatabaseCredentialConfiguration): Promise<DatabaseCredentialConfiguration> {
    if (!/^[A-Za-z0-9._~-]+$/.test(replacement)) throw new Error('Database rotation requires a URL-safe replacement.');
    const { ids, all } = await read(environment, component, target);
    const issuer = all.find(item => item.serviceId === ids.serviceId);
    if (!issuer || component.bindings.pluginName !== issuer.service.name) throw new Error('Database rotation issuer identity changed.');
    const prepared = prepareRailwayDatabaseCredentialAliases(issuer.definitions, issuer.rendered);
    if (prepared.status !== 'supported' || prepared.unmanagedKeys.length || Object.keys(prepared.changes).length) throw new Error('Database password aliases require the reviewed credential-alias repair before rotation.');
    const prior = priorReview ? stateSchema.parse(priorReview.privateState) : undefined;
    if (!prior && prepared.sourcePassword === replacement) throw new Error('The replacement must differ from the currently configured database password.');
    if (prior && (!isDeepStrictEqual(prior.required, required)
      || ![prior.baselinePassword, replacement].includes(prepared.sourcePassword))) throw new Error('Database password issuer changed outside the reviewed rotation.');
    const projected: Record<string, string> = { ...issuer.rendered, POSTGRES_PASSWORD: replacement };
    for (const key of Object.keys(prepared.expected)) projected[key] = key === 'PGPASSWORD' ? replacement
      : replaceDatabasePassword(issuer.rendered[key], replacement, target);
    for (const [key, value] of Object.entries(issuer.rendered)) {
      if (!RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS.includes(key) && value.includes(prepared.sourcePassword)) throw new Error('The database issuer has an additional unreviewed credential alias.');
    }
    for (const key of Object.keys(projected).filter(key => urlKeys.has(key))) {
      const url = new URL(projected[key]);
      if ([...url.searchParams.keys()].some(key => !['sslmode', 'application_name'].includes(key))
        || (url.searchParams.has('sslmode') && !['disable', 'require', 'verify-full', 'no-verify'].includes(url.searchParams.get('sslmode')!))) {
        throw new Error('Database rotation application authentication does not support these URL connection options.');
      }
    }
    const issuerDefinitions = Object.fromEntries(RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS.filter(key => Object.hasOwn(issuer.definitions, key))
      .map(key => [key, key === 'POSTGRES_PASSWORD' ? replacement : issuer.definitions[key]]));
    const issuerRendered = Object.fromEntries(RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS.filter(key => Object.hasOwn(projected, key)).map(key => [key, projected[key]]));
    const byName = new Map(all.map(item => [item.service.name, item]));
    const endpointKeys = new Set(Object.entries(issuer.rendered).filter(([key]) => urlKeys.has(key)).map(([, value]) => {
      const url = new URL(value); return `${url.hostname}:${url.port || '5432'}`;
    }));
    const dependencies = (service: Instance, key: string, seen = new Set<string>()): string | undefined => {
      if (service.serviceId === issuer.serviceId) {
        if (urlKeys.has(key) && prepared.expected[key as keyof typeof prepared.expected]) return key;
        if (key === 'POSTGRES_PASSWORD' || key === 'PGPASSWORD') return key;
      }
      const identity = `${service.serviceId}/${key}`;
      if (seen.has(identity)) throw new Error('Database rotation variable references contain a cycle.');
      const definition = service.definitions[key];
      if (definition === undefined) throw new Error('Database rotation reference source is unavailable.');
      const tokens = [...definition.matchAll(tokenPattern)];
      const results = tokens.map(match => {
        const value = match[1].trim(), separator = value.lastIndexOf('.');
        const source = separator < 0 ? service : byName.get(value.slice(0, separator).trim());
        const sourceKey = separator < 0 ? value : value.slice(separator + 1).trim();
        // An unknown/shared source cannot establish complete dependency coverage.
        // Native Railway system variables are independently rendered constants.
        if (!source) throw new Error('Database rotation reference dependency coverage is incomplete.');
        if (sourceKey.startsWith('RAILWAY_') && !Object.hasOwn(source.definitions, sourceKey)) return undefined;
        return dependencies(source, sourceKey, new Set([...seen, identity]));
      }).filter((value): value is string => Boolean(value));
      if (results.length && (tokens.length !== 1 || !wholeReference.test(definition) || !urlKeys.has(results[0]))) {
        throw new Error('An affected credential consumer needs a reviewed whole-URL reference.');
      }
      return results[0];
    };
    const bindings = z.record(z.string(), z.object({ serviceId: text }).passthrough()).parse(environment.platformBindings.services);
    const consumers: DatabaseCredentialConfiguration['consumers'] = [], references: Record<string, Record<string, string>> = {};
    for (const service of all) {
      if (service.serviceId === issuer.serviceId) continue;
      const name = Object.keys(required).find(name => bindings[name]?.serviceId === service.serviceId);
      const hashes: Record<string, string> = {}, definitions: Record<string, string> = {};
      for (const [key, definition] of Object.entries(service.definitions).sort(([a], [b]) => a.localeCompare(b))) {
        const dependency = dependencies(service, key);
        if (dependency) {
          if (!name || !/^[A-Z][A-Z0-9_]*$/.test(key) || service.rendered[key] !== issuer.rendered[dependency]) throw new Error('An affected database consumer is unlisted or its reference cannot be verified.');
          hashes[key] = hashEnvValue(projected[dependency]); definitions[key] = definition;
        } else if ([prepared.sourcePassword, prior?.baselinePassword, replacement].some(password => password && service.rendered[key]?.includes(password))) {
          throw new Error('A database consumer has an unreviewed copied credential.');
        } else if (/^postgres(?:ql)?:\/\//.test(service.rendered[key] ?? '')) {
          const url = new URL(service.rendered[key]);
          if (decodeURIComponent(url.username) === target.username && decodeURIComponent(url.pathname.slice(1)) === target.database
            && endpointKeys.has(`${url.hostname}:${url.port || '5432'}`)) throw new Error('A database consumer has a copied credential instead of a verified issuer reference.');
        }
      }
      if (!name) continue;
      if (!required[name].length || required[name].some(key => !Object.hasOwn(hashes, key))) throw new Error('A declared database credential alias is not a verified issuer reference.');
      if (driverEnvironment.some(key => service.rendered[key])) throw new Error('Database rotation application verification requires URL-contained connection settings; additional PG environment settings need an explicit configuration verifier.');
      consumers.push({ service: name, externalId: service.serviceId, envVarHashes: hashes }); references[service.serviceId] = definitions;
    }
    if (consumers.length !== Object.keys(required).length || !consumers.length) throw new Error('Database rotation consumer inventory is incomplete.');
    // Raw snapshots retain references on real Railway deployments. Preflight
    // therefore requires already authorized native access to every currently
    // running replica, before any SQL mutation. Compare exact connection
    // configuration while tolerating stale passwords only; 28P01 remains failed
    // authentication, never proof that the intended replacement works.
    for (const consumer of consumers) {
      const service = all.find(item => item.serviceId === consumer.externalId)!;
      if (!runtime || !service.latestDeployment) throw new DatabaseCredentialReviewError();
      const keys = Object.keys(consumer.envVarHashes);
      const connectionConfigurationHashes = Object.fromEntries(keys.map(key => [key,
        hashEnvValue(replaceDatabasePassword(service.rendered[key], 'hypervibe-credential-placeholder', target))]));
      const evidence = await runtime.read({ ...ids, serviceId: consumer.externalId, deploymentId: service.latestDeployment.id },
        { keys, connectionConfigurationHashes, authentication: { username: target.username, database: target.database } });
      if (evidence.state !== 'verified' || !['authenticated', 'rejected'].includes(evidence.authentication)) {
        throw new DatabaseCredentialReviewError();
      }
    }
    return { issuerNames: ['POSTGRES_PASSWORD'], consumers: consumers.sort((a, b) => a.service.localeCompare(b.service)),
      privateState: { baselinePassword: prior?.baselinePassword ?? prepared.sourcePassword, required,
        inventory: all.map(item => ({ id: item.id, serviceId: item.serviceId, name: item.service.name })),
        issuer: { definitions: issuerDefinitions, rendered: issuerRendered }, references } };
  }
  async function checked(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string, review: DatabaseCredentialConfiguration) {
    const state = stateSchema.parse(review.privateState);
    const current = await inspect(environment, component, target, replacement, state.required, review);
    if (!isDeepStrictEqual(current, review)) throw new Error('Database rotation references changed after review.');
    const observed = await read(environment, component, target);
    const issuer = observed.all.find(item => item.serviceId === target.externalId)!;
    if (![state.baselinePassword, replacement].includes(issuer.definitions.POSTGRES_PASSWORD)
      || issuer.rendered.POSTGRES_PASSWORD !== issuer.definitions.POSTGRES_PASSWORD) throw new Error('Database rotation issuer changed after review.');
    return { ids: observed.ids, issuer: issuer.definitions.POSTGRES_PASSWORD === replacement ? 'match' as const : 'different' as const };
  }
  return {
    inspect,
    async observe(environment, component, target, replacement, review) {
      try { return { issuer: (await checked(environment, component, target, replacement, review)).issuer, references: 'match' }; }
      catch { return { issuer: 'unknown', references: 'unknown' }; }
    },
    async synchronize(environment, component, target, replacement, review) {
      let attempted = false;
      try {
        const before = await checked(environment, component, target, replacement, review);
        if (before.issuer === 'match') return { state: 'acknowledged' };
        attempted = true;
        const result = z.object({ variableCollectionUpsert: z.literal(true) }).parse(await request(gql`
          mutation SynchronizeDatabaseRotationIssuer($projectId: String!, $environmentId: String!, $serviceId: String!, $values: EnvironmentVariables!) {
            variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId,
              variables: $values, replace: false, skipDeploys: true })
          }
        `, { ...before.ids, values: { POSTGRES_PASSWORD: replacement } }));
        return { state: result.variableCollectionUpsert && (await checked(environment, component, target, replacement, review)).issuer === 'match' ? 'acknowledged' : 'unknown' };
      } catch { return { state: attempted ? 'unknown' : 'blocked' }; }
    },
    async verifyAuthentication(environment, component, target, review, driver) {
      const tested = 'Fresh node-postgres authentication inside every exact running consumer replica using unchanged runtime URLs, session identity and database; application business queries were not tested.';
      try {
        if (driver !== 'node-postgres' || !runtime || !review.consumers.length) return { state: 'unknown', tested };
        const { ids, all } = await read(environment, component, target);
        const state = stateSchema.parse(review.privateState);
        for (const consumer of review.consumers) {
          const instance = all.find(item => item.serviceId === consumer.externalId);
          const expectedInstance = state.inventory.find(item => item.serviceId === consumer.externalId);
          if (!instance?.latestDeployment || instance.id !== expectedInstance?.id) return { state: 'unknown', tested };
          const result = await runtime.read({ ...ids, serviceId: consumer.externalId, deploymentId: instance.latestDeployment.id },
            { keys: Object.keys(consumer.envVarHashes), expectedHashes: consumer.envVarHashes,
              authentication: { username: target.username, database: target.database } });
          if (result.state !== 'verified' || result.authentication !== 'authenticated') return { state: result.authentication === 'rejected' ? 'rejected' : 'unknown', tested };
        }
        return { state: 'authenticated', tested };
      } catch { return { state: 'unknown', tested }; }
    },
  };
}
