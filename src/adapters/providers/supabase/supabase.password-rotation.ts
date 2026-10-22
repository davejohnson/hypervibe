import type { Component } from '../../../domain/entities/component.entity.js';
import { databaseCredentialRotationTargetSchema, databaseRotationTargetsMatch,
  type DatabaseCredentialRotationTarget, type DatabasePasswordEndpoint,
  type IDatabasePasswordRotation } from '../../../domain/ports/database-password-rotation.port.js';
import { verifyPostgresPassword } from '../../../domain/services/postgres-password-verification.service.js';

class RotationHttpError extends Error {
  constructor(readonly status: number) { super('Supabase rotation request did not succeed.'); }
}
type Authorization = { accessToken: string; scope: { organizationId: string; region: string } };
const invalidTarget = () => new Error('Supabase password rotation requires an exact verified project, login and bound endpoint set.');

function endpoint(value: unknown, kind: 'direct' | 'pooled'): DatabasePasswordEndpoint {
  if (typeof value !== 'string') throw invalidTarget();
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash
    || !parsed.username || !parsed.pathname || parsed.pathname === '/') throw invalidTarget();
  return { kind, host: parsed.hostname, port: Number(parsed.port || 5432),
    username: decodeURIComponent(parsed.username), database: decodeURIComponent(parsed.pathname.slice(1)), expectedRole: 'postgres' };
}
const sameEndpoint = (left: DatabasePasswordEndpoint, right: DatabasePasswordEndpoint) =>
  left.host === right.host && left.port === right.port && left.username === right.username && left.database === right.database;

/** Native issuer operation; contains no runtime or CI mutations and no retries. */
export class SupabasePasswordRotation implements IDatabasePasswordRotation {
  readonly strategy = 'replace-in-place' as const;
  constructor(private readonly authorize: (component: Component) => Promise<Authorization>) {}

  private async request(authorization: Authorization, method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://api.supabase.com/v1${path}`, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${authorization.accessToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new RotationHttpError(response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw invalidTarget();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1024 * 1024) { controller.abort(); throw invalidTarget(); }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { clearTimeout(timer); }
  }

  async observeTarget(component: Component): Promise<DatabaseCredentialRotationTarget> {
    try {
      const ref = component.externalId;
      const binding = component.bindings;
      if (component.type !== 'postgres' || !ref || !/^[a-z]{20}$/.test(ref)
        || binding.provider !== 'supabase' || binding.instanceId !== ref
        || binding.username !== 'postgres' || binding.database !== 'postgres' || binding.port !== 5432) throw invalidTarget();
      const authorization = await this.authorize(component);
      const raw = await this.request(authorization, 'GET', `/projects/${ref}`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidTarget();
      const project = raw as Record<string, unknown>;
      const database = project.database as { host?: unknown } | undefined;
      if (project.id !== ref || project.ref !== ref || project.organization_id !== authorization.scope.organizationId
        || project.region !== authorization.scope.region || project.status !== 'ACTIVE_HEALTHY'
        || !database || database.host !== `db.${ref}.supabase.co` || binding.host !== database.host) throw invalidTarget();
      const direct: DatabasePasswordEndpoint = { kind: 'direct', host: database.host as string, port: 5432,
        username: 'postgres', database: 'postgres', expectedRole: 'postgres' };
      const urls = [binding.connectionString, binding.connectionUrl].filter(value => value !== undefined);
      if (urls.length === 0 || urls.some(value => !sameEndpoint(endpoint(value, 'direct'), direct))) throw invalidTarget();
      const endpoints = [direct];
      if (binding.pooledUrl !== undefined) {
        const boundPool = endpoint(binding.pooledUrl, 'pooled');
        let matches: DatabasePasswordEndpoint[];
        if (boundPool.host === direct.host) {
          const pool = await this.request(authorization, 'GET', `/projects/${ref}/config/database/pgbouncer`);
          if (!pool || typeof pool !== 'object' || Array.isArray(pool)) throw invalidTarget();
          const observed = endpoint((pool as Record<string, unknown>).connection_string, 'pooled');
          matches = sameEndpoint(observed, boundPool) && boundPool.port === 6543 && boundPool.username === 'postgres' ? [observed] : [];
        } else {
          const pools = await this.request(authorization, 'GET', `/projects/${ref}/config/database/pooler`);
          if (!Array.isArray(pools) || pools.length > 64) throw invalidTarget();
          matches = [];
          for (const pool of pools) {
            if (!pool || typeof pool !== 'object' || !['PRIMARY', 'READ_REPLICA'].includes(pool.database_type)) throw invalidTarget();
            const observed = endpoint(pool.connection_string, 'pooled');
            if (pool.database_type === 'PRIMARY' && sameEndpoint(observed, boundPool)) matches.push(observed);
          }
          if (!boundPool.host.endsWith('.pooler.supabase.com') || boundPool.username !== `postgres.${ref}`
            || ![5432, 6543].includes(boundPool.port)) throw invalidTarget();
        }
        if (matches.length !== 1 || boundPool.database !== 'postgres') throw invalidTarget();
        endpoints.push(boundPool);
      }
      return databaseCredentialRotationTargetSchema.parse({ provider: 'supabase', resourceId: ref,
        providerScope: authorization.scope, username: 'postgres', database: 'postgres', endpoints });
    } catch { throw invalidTarget(); }
  }

  async replacePassword(input: Parameters<IDatabasePasswordRotation['replacePassword']>[0]): ReturnType<IDatabasePasswordRotation['replacePassword']> {
    if (!databaseCredentialRotationTargetSchema.safeParse(input.target).success
      || typeof input.replacementPassword !== 'string' || input.replacementPassword.length < 32
      || input.replacementPassword.length > 256 || /[\u0000-\u001f]/.test(input.replacementPassword)) {
      return { status: 'rejected', mutationAttempted: false, reason: 'invalid_input' };
    }
    let authorization: Authorization;
    try {
      if (!databaseRotationTargetsMatch(await this.observeTarget(input.component), input.target)) throw invalidTarget();
      authorization = await this.authorize(input.component);
    } catch { return { status: 'rejected', mutationAttempted: false, reason: 'identity_changed' }; }
    try {
      const response = await this.request(authorization, 'PATCH', `/projects/${input.target.resourceId}/database/password`,
        { password: input.replacementPassword });
      if (!response || typeof response !== 'object' || Array.isArray(response)
        || typeof (response as Record<string, unknown>).message !== 'string') throw invalidTarget();
      return { status: 'acknowledged', mutationAttempted: true };
    } catch (error) {
      const rejected = error instanceof RotationHttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
      return { status: rejected ? 'rejected' : 'unknown', mutationAttempted: true,
        reason: rejected ? 'provider_rejected' : 'outcome_unknown' };
    }
  }

  async verifyPassword(input: Parameters<IDatabasePasswordRotation['verifyPassword']>[0]): ReturnType<IDatabasePasswordRotation['verifyPassword']> {
    try {
      if (!databaseCredentialRotationTargetSchema.safeParse(input.target).success
        || !databaseRotationTargetsMatch(await this.observeTarget(input.component), input.target)) throw invalidTarget();
      const endpoints = [];
      for (const target of input.target.endpoints) endpoints.push({ kind: target.kind, ...await verifyPostgresPassword(target, input.password) });
      const status = endpoints.every(endpoint => endpoint.status === 'accepted') ? 'accepted'
        : endpoints.every(endpoint => endpoint.status === 'rejected') ? 'rejected' : 'unknown';
      return { status, endpoints, existingSessions: 'unchecked' };
    } catch { return { status: 'unknown', endpoints: [], existingSessions: 'unchecked' }; }
  }
}
