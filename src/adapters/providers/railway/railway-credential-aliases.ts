import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Receipt } from '../../../domain/ports/provider.port.js';
import { databaseCredentialAliasesInspectionSchema, type IDatabaseCredentialAliases } from '../../../domain/ports/database-credential-aliases.port.js';
import { prepareRailwayDatabaseCredentialAliases, verifyRailwayDatabaseCredentialAliases,
  railwayDatabaseCredentialAliasFingerprintInput } from './railway-database-credential-aliases.js';

const identity = z.string().min(1);
const scopeSchema = z.object({ projectId: identity, environmentId: identity }).strict();
const variableMap = z.record(z.string());
const privateSchema = z.object({ instanceId: identity, definitions: variableMap, rendered: variableMap }).strict();
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const relevant = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([key]) =>
  ['POSTGRES_PASSWORD', 'PGPASSWORD', 'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL'].includes(key)));
type Input = { component: Component; environment: Environment };

/** Provider-owned configuration repair, separate from SQL password rotation.
 * Public receipts contain no URLs, values or credential-derived fingerprints. */
export function createRailwayCredentialAliases(client: () => GraphQLClient | null | undefined): IDatabaseCredentialAliases {
  const scope = ({ component, environment }: Input) => {
    const parsed = scopeSchema.safeParse(component.bindings.providerScope);
    if (!parsed.success || component.type !== 'postgres' || component.bindings.provider !== 'railway'
      || component.bindings.resourceKind !== 'service' || component.bindings.retainedCleanup === true
      || component.environmentId !== environment.id || !component.externalId
      || parsed.data.projectId !== environment.platformBindings.projectId
      || parsed.data.environmentId !== environment.platformBindings.environmentId
      || component.bindings.projectId !== undefined && component.bindings.projectId !== parsed.data.projectId
      || component.bindings.serviceId !== undefined && component.bindings.serviceId !== component.externalId) {
      throw new Error('Credential alias repair requires the exact bound database service and environment.');
    }
    return { ...parsed.data, serviceId: component.externalId };
  };
  const request = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const connected = client();
    if (!connected) throw new Error('Database credential alias provider is unavailable.');
    try { return await connected.request(query, variables); }
    catch { throw new Error('Database credential alias provider observation or acknowledgement is unavailable.'); }
  };
  const read = async (input: Input) => {
    const ids = scope(input);
    const observed = await request(gql`
      query DatabaseCredentialAliasIdentity($projectId: String!, $environmentId: String!, $serviceId: String!) {
        project(id: $projectId) { id }
        environment(id: $environmentId) { id projectId deletedAt }
        service(id: $serviceId) { id projectId deletedAt }
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId deletedAt }
      }
    `, ids);
    if (!record(observed) || !record(observed.project) || observed.project.id !== ids.projectId
      || !record(observed.environment) || observed.environment.id !== ids.environmentId
      || observed.environment.projectId !== ids.projectId || observed.environment.deletedAt !== null
      || !record(observed.service) || observed.service.id !== ids.serviceId
      || observed.service.projectId !== ids.projectId || observed.service.deletedAt !== null
      || !record(observed.serviceInstance) || observed.serviceInstance.serviceId !== ids.serviceId
      || observed.serviceInstance.environmentId !== ids.environmentId || observed.serviceInstance.deletedAt !== null
      || typeof observed.serviceInstance.id !== 'string' || !observed.serviceInstance.id) {
      throw new Error('The provider did not verify the exact database service instance and scope.');
    }
    const values = await request(gql`
      query DatabaseCredentialAliasVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
        definitions: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
        rendered: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }
    `, ids);
    const parsed = z.object({ definitions: variableMap, rendered: variableMap }).strict().safeParse(values);
    if (!parsed.success) throw new Error('The database variable definitions or resolved values are incomplete.');
    return { ids, state: { instanceId: observed.serviceInstance.id,
      definitions: relevant(parsed.data.definitions), rendered: relevant(parsed.data.rendered) } };
  };

  return {
    async inspect(input) {
      const current = await read(input);
      const prepared = prepareRailwayDatabaseCredentialAliases(current.state.definitions, current.state.rendered);
      if (prepared.status !== 'supported') throw new Error(`Database credential references cannot be repaired: ${prepared.reason}.`);
      if (prepared.unmanagedKeys.length) throw new Error('Additional database credential URLs require a reviewed repair contract.');
      return { target: { provider: 'railway', resourceId: current.ids.serviceId,
        providerScope: { projectId: current.ids.projectId, environmentId: current.ids.environmentId } },
        checkedNames: Object.keys(prepared.expected).sort(), changeNames: Object.keys(prepared.changes).sort(),
        privateState: current.state };
    },
    async repair(input): Promise<Receipt> {
      let attempted = false;
      let count = 0;
      const failure = (message: string): Receipt => ({ success: false, message,
        data: { mutationAttempted: attempted, requestedCount: count, appliedCount: attempted ? null : 0,
          skippedCount: attempted ? null : count, referencesVerified: false, authentication: 'unchecked', deploymentDeferred: true } });
      try {
        const expected = databaseCredentialAliasesInspectionSchema.parse(input.expected);
        const old = privateSchema.parse(expected.privateState);
        const prepared = prepareRailwayDatabaseCredentialAliases(old.definitions, old.rendered);
        if (prepared.status !== 'supported' || prepared.unmanagedKeys.length) return failure('The reviewed reference definitions are unsupported.');
        const checked = Object.keys(prepared.expected).sort();
        count = checked.length;
        if (!isDeepStrictEqual(checked, expected.checkedNames)
          || !isDeepStrictEqual(Object.keys(prepared.changes).sort(), expected.changeNames)) return failure('The reviewed variable selection changed.');
        const check = (current: Awaited<ReturnType<typeof read>>) => {
          if (expected.target.provider !== 'railway' || expected.target.resourceId !== current.ids.serviceId
            || !isDeepStrictEqual(expected.target.providerScope, { projectId: current.ids.projectId, environmentId: current.ids.environmentId })
            || old.instanceId !== current.state.instanceId) throw new Error('The reviewed database identity changed.');
        };
        let current = await read(input);
        check(current);
        const verified = () => !Object.prototype.hasOwnProperty.call(current.state.definitions, 'DATABASE_PUBLIC_URL')
          && !Object.prototype.hasOwnProperty.call(current.state.rendered, 'DATABASE_PUBLIC_URL')
          && verifyRailwayDatabaseCredentialAliases(prepared, current.state.definitions, current.state.rendered).status === 'verified';
        const complete = (applied: number): Receipt => ({ success: true,
          message: `Database password references verified: ${applied} changed, ${count - applied} already configured. Deployment deferred.`,
          data: { requestedCount: count, appliedCount: applied, skippedCount: count - applied,
            referencesVerified: true, authentication: 'unchecked', deploymentDeferred: true } });
        if (verified()) return complete(0);
        if (!input.allowWrite) return failure('The previous write remains unverified; only readback was attempted.');
        const unchanged = () => railwayDatabaseCredentialAliasFingerprintInput(old.definitions, old.rendered)
          === railwayDatabaseCredentialAliasFingerprintInput(current.state.definitions, current.state.rendered);
        if (!unchanged()) return failure('Database variables changed after review; re-plan before writing.');
        await input.beforeWrite();
        // Persistence can take time; recheck provider identity and values after
        // recording intent, immediately before the sole permitted mutation.
        current = await read(input);
        check(current);
        if (!unchanged()) return failure('Database variables changed before mutation; the saved intent was preserved.');
        attempted = true;
        const result = await request(gql`
          mutation RepairDatabaseCredentialAliases($projectId: String!, $environmentId: String!, $serviceId: String!, $values: EnvironmentVariables!) {
            variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId,
              serviceId: $serviceId, variables: $values, replace: false, skipDeploys: true })
          }
        `, { ...current.ids, values: prepared.changes });
        if (!record(result) || result.variableCollectionUpsert !== true) return failure('The provider did not acknowledge the reference update; re-entry will only verify.');
        current = await read(input);
        check(current);
        if (!verified()) return failure('The reference update is not yet verified; re-entry will only verify.');
        return complete(Object.keys(prepared.changes).length);
      } catch {
        return failure('Database reference repair could not be verified. No automatic retry or deployment was performed.');
      }
    },
  };
}
