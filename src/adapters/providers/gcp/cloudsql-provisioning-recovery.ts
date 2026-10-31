import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IDatabaseProvisioningRecovery, DatabaseProvisioningProgress, DatabaseProvisioningReview } from '../../../domain/ports/database-provisioning-recovery.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const scopeSchema = z.object({ projectId: id, region: id }).strict();
const instanceSchema = z.object({ name: id, project: id, region: id, createTime: z.iso.datetime(),
  databaseVersion: z.literal('POSTGRES_15'), connectionName: z.string(), state: z.string() });
const operationSchema = z.object({ name: id, targetProject: id, targetId: id,
  operationType: z.string(), status: z.enum(['PENDING', 'RUNNING', 'DONE']),
  error: z.object({ errors: z.array(z.unknown()).optional() }).optional() });
const databaseSchema = z.object({ name: id, instance: id, project: id });
type Inputs = { environment: Environment; component: Component };
type Dependencies = {
  scope: () => { projectId: string; region: string } | null;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  authenticate: (environment: Environment, component: Component) => Promise<boolean>;
};

/** SQL Admin v1 operations identify the instance and operation type, not the
 * password. Never persist native responses; they may echo private inputs. */
export function createCloudSqlProvisioningRecovery(deps: Dependencies): IDatabaseProvisioningRecovery {
  async function read(input: Inputs) {
    const { component } = input, scope = scopeSchema.parse(component.bindings.providerScope);
    if (component.environmentId !== input.environment.id || component.type !== 'postgres'
      || component.bindings.provider !== 'cloudsql' || component.bindings.instanceId !== component.externalId
      || !id.safeParse(component.externalId).success || !equal(scope, deps.scope())) throw new Error('Scope mismatch');
    const base = `https://sqladmin.googleapis.com/v1/projects/${scope.projectId}`;
    const url = `${base}/instances/${component.externalId}`;
    const response = await deps.request(url);
    if (!response.ok) throw new Error('Instance unavailable');
    const native = instanceSchema.parse(await response.json());
    if (native.name !== component.externalId || native.project !== scope.projectId || native.region !== scope.region
      || native.connectionName !== `${scope.projectId}:${scope.region}:${component.externalId}`) throw new Error('Native identity mismatch');
    const username = component.bindings.username ?? 'postgres', database = component.bindings.database ?? 'app';
    if (username !== 'postgres' || !id.safeParse(database).success) throw new Error('Unsupported retained role or database');
    const { state: _, ...identity } = native;
    const target = { provider: 'cloudsql', externalId: native.name, providerScope: scope,
      identityFingerprint: canonicalJsonSha256(identity), username, database: database as string };
    let createPending = false;
    if (component.bindings.provisioningRecovery !== undefined) {
      const marker = z.object({ schemaVersion: z.literal(1), phase: z.literal('instance-operation'), operationId: id,
        targetProject: id, targetId: id, region: id, databaseVersion: z.literal('POSTGRES_15'), instanceCreateTime: z.iso.datetime() }).strict()
        .parse(component.bindings.provisioningRecovery);
      if (marker.targetProject !== native.project || marker.targetId !== native.name || marker.region !== native.region
        || marker.instanceCreateTime !== native.createTime) throw new Error('Original create lifetime changed or unverified');
      const response = await deps.request(`${base}/operations/${marker.operationId}`);
      if (!response.ok) throw new Error('Original creation unavailable');
      const original = operationSchema.parse(await response.json());
      if (original.name !== marker.operationId || original.targetProject !== native.project || original.targetId !== native.name
        || original.operationType !== 'CREATE' || original.error) throw new Error('Original create outcome unverified');
      createPending = original.status !== 'DONE';
    }
    return { base, url, native, target, createPending };
  }
  async function databaseState(current: Awaited<ReturnType<typeof read>>) {
    const response = await deps.request(`${current.url}/databases/${encodeURIComponent(current.target.database)}`);
    if (response.status === 404) return 'absent' as const;
    if (!response.ok) throw new Error('Database state unknown');
    const database = databaseSchema.parse(await response.json());
    if (database.name !== current.target.database || database.instance !== current.native.name || database.project !== current.native.project) throw new Error('Database identity mismatch');
    return 'present' as const;
  }
  async function verifyUser(current: Awaited<ReturnType<typeof read>>) {
    const response = await deps.request(`${current.url}/users`);
    if (!response.ok) throw new Error('User state unknown');
    const users = z.object({ items: z.array(z.object({ name: z.string(), instance: id, project: id, type: z.string().default('BUILT_IN') })),
      nextPageToken: z.string().optional() }).parse(await response.json());
    const matches = users.items.filter(user => user.name === current.target.username);
    if (users.nextPageToken || matches.length !== 1 || matches[0].instance !== current.native.name
      || matches[0].project !== current.native.project || matches[0].type !== 'BUILT_IN') throw new Error('Exact built-in user unavailable');
  }
  function bindings(current: Awaited<ReturnType<typeof read>>, review: DatabaseProvisioningReview, database = review.target.database) {
    const host = `${current.native.name}.${current.native.region}.${current.native.project}`;
    return { provider: 'cloudsql', providerScope: review.target.providerScope, instanceId: current.native.name,
      connectionName: current.native.connectionName, host, port: 5432, username: review.target.username,
      password: review.password, database,
      connectionString: `postgresql://${encodeURIComponent(review.target.username)}:${encodeURIComponent(review.password)}@${host}:5432/${encodeURIComponent(database)}` };
  }
  function operation(value: unknown, current: Awaited<ReturnType<typeof read>>, type: string, password: string, operationId?: string) {
    const result = operationSchema.parse(value);
    if (result.targetProject !== current.native.project || result.targetId !== current.native.name
      || result.operationType !== type || operationId && result.name !== operationId || result.error
      || result.name.includes(password)) throw new Error('Operation unavailable or failed');
    return result;
  }
  return {
    async inspect(input) {
      try {
        const current = await read(input);
        if (current.native.state === 'PENDING_CREATE' || current.createPending) return { state: 'pending', reason: 'Native creation is still running.' };
        if (current.native.state !== 'RUNNABLE') throw new Error('Instance not ready');
        await verifyUser(current);
        const retained = input.component.bindings.password;
        if (retained !== undefined && (typeof retained !== 'string' || !retained)) throw new Error('Malformed retained credential');
        return { state: 'ready', review: { target: current.target, replaceCredential: !retained,
          createDatabase: await databaseState(current) === 'absent', password: retained as string || randomBytes(32).toString('base64url') } };
      } catch { return { state: 'unknown', reason: 'Exact native identity, readiness, user or logical database is unverified.' }; }
    },
    async apply(input) {
      try {
        const current = await read(input), reviewed = input.reviewed;
        if (!equal(current.target, reviewed.target) || current.native.state !== 'RUNNABLE') return { state: 'unknown' };
        if (current.createPending) return { state: 'pending' };
        await verifyUser(current);
        let progress = input.progress;
        const save = async (phase: DatabaseProvisioningProgress['phase'], ids: Partial<DatabaseProvisioningProgress> = {}) => {
          const next = { ...progress, ...ids, phase }; await input.saveProgress(next); progress = next;
        };
        const authenticated = async (database: string) => deps.authenticate(input.environment,
          { ...input.component, bindings: { ...input.component.bindings, ...bindings(current, reviewed, database) } });
        const checkOperation = async (operationId: string, type: string) => {
          const response = await deps.request(`${current.base}/operations/${encodeURIComponent(operationId)}`);
          if (!response.ok) throw new Error('Operation observation unavailable');
          return operation(await response.json(), current, type, reviewed.password, operationId).status;
        };
        if (progress.phase === 'prepared' && reviewed.replaceCredential) {
          // Recheck native lifetime and existing role immediately before mutation.
          if (!equal((await read(input)).target, reviewed.target)) return { state: 'unknown' };
          await verifyUser(current);
          await save('credential-attempted');
          const response = await deps.request(`${current.url}/users?name=${encodeURIComponent(reviewed.target.username)}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: reviewed.target.username, password: reviewed.password }) });
          if (!response.ok) return { state: 'unknown' };
          const ack = operation(await response.json(), current, 'UPDATE_USER', reviewed.password);
          await save('credential-acknowledged', { credentialOperationId: ack.name });
        }
        if (progress.phase === 'credential-acknowledged') {
          if (!progress.credentialOperationId) return { state: 'unknown' };
          if (await checkOperation(progress.credentialOperationId, 'UPDATE_USER') !== 'DONE') return { state: 'pending' };
        }
        if (['prepared', 'credential-attempted', 'credential-acknowledged'].includes(progress.phase)) {
          // A lost reset acknowledgment can only recover by proving the exact
          // privately retained candidate authenticates; never resend the reset.
          if (!await authenticated('postgres')) return { state: 'unknown' };
          await save('credential-verified');
        }
        if (progress.phase === 'credential-verified') {
          if (!equal((await read(input)).target, reviewed.target)) return { state: 'unknown' };
          const present = await databaseState(current);
          if (present === 'absent') {
            if (!reviewed.createDatabase) return { state: 'unknown' };
            await save('database-attempted');
            const response = await deps.request(`${current.url}/databases`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: reviewed.target.database }) });
            if (!response.ok) return { state: 'unknown' };
            const ack = operation(await response.json(), current, 'CREATE_DATABASE', reviewed.password);
            await save('database-acknowledged', { databaseOperationId: ack.name });
          }
        }
        if (progress.phase === 'database-acknowledged') {
          if (!progress.databaseOperationId) return { state: 'unknown' };
          if (await checkOperation(progress.databaseOperationId, 'CREATE_DATABASE') !== 'DONE') return { state: 'pending' };
        }
        if (!['credential-verified', 'database-acknowledged', 'database-verified'].includes(progress.phase)
          || await databaseState(current) !== 'present' || !await authenticated(reviewed.target.database)
          || !equal((await read(input)).target, reviewed.target)) return { state: 'unknown' };
        await save('database-verified');
        return { state: 'complete', bindings: bindings(current, reviewed) };
      } catch { return { state: 'unknown' }; }
    },
  };
}
