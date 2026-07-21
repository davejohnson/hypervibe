import { randomUUID } from 'crypto';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { IProviderAdapter, TemporaryDatabaseAccess } from '../ports/provider.port.js';
import { adapterFactory } from './adapter.factory.js';
import { isExternallyUsableDatabaseUrl, resolveExternalDatabaseUrl } from './database-ops.service.js';

const componentRepo = new ComponentRepository();
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const CLEANUP_RETRY_DELAYS_MS = [0, 100, 300] as const;
const FAILED_CLEANUP_RETRY_MS = 5_000;

export type DatabaseAccessMode = 'existing' | 'private_connector' | 'ephemeral_proxy';
export type DatabaseAccessCleanupStatus = 'no_op' | 'deferred' | 'completed' | 'failed';

export interface DatabaseAccessCleanup {
  status: DatabaseAccessCleanupStatus;
  safeResourceId?: string;
  warning?: string;
}

export interface DatabaseAccessLease {
  id: string;
  provider: string;
  mode: DatabaseAccessMode;
  createdByInvocation: boolean;
  expiresAt?: string;
  safeResourceId?: string;
  withConnection<T>(operation: (connectionUrl: string) => Promise<T>): Promise<T>;
  release(): Promise<DatabaseAccessCleanup>;
}

export type DatabaseAccessAcquireResult =
  | { ok: true; lease: DatabaseAccessLease }
  | {
    ok: false;
    code: 'no_database' | 'no_external_access' | 'provider_error';
    error: string;
    provider?: string;
    resourceCreated: boolean | 'unknown';
    cleanup: 'not_needed' | 'completed' | 'unknown';
    hint?: string;
  };

interface SharedLease {
  key: string;
  id: string;
  provider: string;
  access: TemporaryDatabaseAccess;
  adapter: IProviderAdapter;
  environment: Environment;
  component: Component;
  references: number;
  expiresAt: number;
  cleanupFailed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accessMode(access: TemporaryDatabaseAccess): DatabaseAccessMode {
  if (access.source === 'private_connector') return 'private_connector';
  return access.temporary ? 'ephemeral_proxy' : 'existing';
}

function noopLease(connectionUrl: string, provider: string): DatabaseAccessLease {
  const id = randomUUID();
  let released = false;
  const cleanup: DatabaseAccessCleanup = { status: 'no_op' };
  return {
    id,
    provider,
    mode: 'existing',
    createdByInvocation: false,
    async withConnection<T>(operation: (url: string) => Promise<T>): Promise<T> {
      if (released) throw new Error('Database access lease has already been released.');
      return operation(connectionUrl);
    },
    async release(): Promise<DatabaseAccessCleanup> {
      released = true;
      return cleanup;
    },
  };
}

/**
 * Coordinates operation-scoped provider access inside this Hypervibe process.
 * A target has at most one Hypervibe-owned proxy and concurrent queries share
 * it by reference count. Failed cleanup stays registered and is retried before
 * another lease is created, plus once more on a short timer.
 */
export class DatabaseAccessLeaseCoordinator {
  private readonly shared = new Map<string, SharedLease>();
  private readonly locks = new Map<string, Promise<void>>();

  async acquire(params: {
    key: string;
    provider: string;
    adapter: IProviderAdapter;
    environment: Environment;
    component: Component;
    create: () => Promise<TemporaryDatabaseAccess>;
    ttlMs?: number;
  }): Promise<DatabaseAccessLease> {
    return this.withLock(params.key, async () => {
      let current = this.shared.get(params.key);
      if (current?.cleanupFailed && current.references === 0) {
        const cleanup = await this.cleanupShared(current, false);
        if (cleanup.status === 'failed') {
          throw new Error(`Previous database access cleanup is still pending for ${cleanup.safeResourceId ?? 'the provider resource'}.`);
        }
        current = undefined;
      }

      if (current) {
        current.references += 1;
        current.expiresAt = Math.max(current.expiresAt, Date.now() + (params.ttlMs ?? DEFAULT_LEASE_TTL_MS));
        this.scheduleExpiry(current);
        return this.invocationLease(current, false);
      }

      const access = await params.create();
      if (!isExternallyUsableDatabaseUrl(access.connectionUrl)) {
        if (access.temporary && params.adapter.releaseTemporaryDatabaseAccess) {
          await params.adapter.releaseTemporaryDatabaseAccess(params.environment, params.component, access);
        }
        throw new Error(`${params.provider} returned database access that is not externally reachable.`);
      }

      if (!access.temporary) {
        return noopLease(access.connectionUrl, params.provider);
      }

      const shared: SharedLease = {
        key: params.key,
        id: randomUUID(),
        provider: params.provider,
        access,
        adapter: params.adapter,
        environment: params.environment,
        component: params.component,
        references: 1,
        expiresAt: Date.now() + (params.ttlMs ?? DEFAULT_LEASE_TTL_MS),
        cleanupFailed: false,
      };
      this.shared.set(params.key, shared);
      this.scheduleExpiry(shared);
      return this.invocationLease(shared, true);
    });
  }

  activeLeaseCount(): number {
    return this.shared.size;
  }

  resetForTests(): void {
    for (const lease of this.shared.values()) {
      if (lease.timer) clearTimeout(lease.timer);
    }
    this.shared.clear();
    this.locks.clear();
  }

  private invocationLease(shared: SharedLease, createdByInvocation: boolean): DatabaseAccessLease {
    let released = false;
    let cleanupResult: DatabaseAccessCleanup | undefined;
    return {
      id: shared.id,
      provider: shared.provider,
      mode: accessMode(shared.access),
      createdByInvocation,
      expiresAt: new Date(shared.expiresAt).toISOString(),
      safeResourceId: shared.access.releaseToken,
      async withConnection<T>(operation: (url: string) => Promise<T>): Promise<T> {
        if (released) throw new Error('Database access lease has already been released.');
        return operation(shared.access.connectionUrl);
      },
      release: async (): Promise<DatabaseAccessCleanup> => {
        if (released) return cleanupResult ?? { status: 'no_op' };
        released = true;
        cleanupResult = await this.releaseReference(shared.key, shared.id);
        return cleanupResult;
      },
    };
  }

  private async releaseReference(key: string, leaseId: string): Promise<DatabaseAccessCleanup> {
    return this.withLock(key, async () => {
      const shared = this.shared.get(key);
      if (!shared || shared.id !== leaseId) return { status: 'completed' };
      shared.references = Math.max(0, shared.references - 1);
      if (shared.references > 0) {
        return { status: 'deferred', safeResourceId: shared.access.releaseToken };
      }
      return this.cleanupShared(shared, true);
    });
  }

  private async cleanupShared(shared: SharedLease, scheduleRetry: boolean): Promise<DatabaseAccessCleanup> {
    if (!shared.adapter.releaseTemporaryDatabaseAccess) {
      shared.cleanupFailed = true;
      return {
        status: 'failed',
        safeResourceId: shared.access.releaseToken,
        warning: 'Provider does not expose temporary database access cleanup.',
      };
    }

    for (const retryDelay of CLEANUP_RETRY_DELAYS_MS) {
      if (retryDelay > 0) await delay(retryDelay);
      try {
        await shared.adapter.releaseTemporaryDatabaseAccess(shared.environment, shared.component, shared.access);
        if (shared.timer) clearTimeout(shared.timer);
        this.shared.delete(shared.key);
        return { status: 'completed', safeResourceId: shared.access.releaseToken };
      } catch {
        // Retry with the bounded delays above. Provider errors are intentionally
        // not copied into model-visible or audit-safe metadata.
      }
    }

    shared.cleanupFailed = true;
    if (scheduleRetry) this.scheduleExpiry(shared, FAILED_CLEANUP_RETRY_MS);
    return {
      status: 'failed',
      safeResourceId: shared.access.releaseToken,
      warning: 'Temporary database access cleanup failed after bounded retries and is registered for another in-process cleanup attempt.',
    };
  }

  private scheduleExpiry(shared: SharedLease, overrideDelayMs?: number): void {
    if (shared.timer) clearTimeout(shared.timer);
    const waitMs = overrideDelayMs ?? Math.max(1, shared.expiresAt - Date.now());
    shared.timer = setTimeout(() => {
      void this.reconcile(shared.key, shared.id);
    }, waitMs);
    shared.timer.unref?.();
  }

  private async reconcile(key: string, leaseId: string): Promise<void> {
    await this.withLock(key, async () => {
      const shared = this.shared.get(key);
      if (!shared || shared.id !== leaseId) return;
      if (Date.now() < shared.expiresAt) {
        this.scheduleExpiry(shared);
        return;
      }
      // Queries have a much shorter database-level timeout. Once the lease TTL
      // is reached, treat any surviving reference as abandoned and remove the
      // public access instead of extending exposure indefinitely.
      shared.references = 0;
      await this.cleanupShared(shared, true);
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

export const databaseAccessLeaseCoordinator = new DatabaseAccessLeaseCoordinator();

export function acquireExistingDatabaseAccess(connectionUrl: string, provider = 'database'): DatabaseAccessLease {
  return noopLease(connectionUrl, provider);
}

export async function acquireManagedDatabaseAccess(
  project: Project,
  environment: Environment,
  serviceName?: string
): Promise<DatabaseAccessAcquireResult> {
  const component = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
  const bindings = component?.bindings as Record<string, unknown> | undefined;
  const provider = typeof bindings?.provider === 'string'
    ? bindings.provider
    : typeof environment.platformBindings.provider === 'string'
      ? environment.platformBindings.provider
      : undefined;

  const existing = await resolveExternalDatabaseUrl(project, environment, serviceName);
  if (existing) {
    return { ok: true, lease: noopLease(existing, provider ?? 'database') };
  }
  if (!component) {
    return {
      ok: false,
      code: 'no_database',
      error: `No postgres component is tracked for ${environment.name}.`,
      resourceCreated: false,
      cleanup: 'not_needed',
      hint: 'Apply a spec with a database first, or pass connectionUrl/connectionName explicitly.',
    };
  }
  if (!provider) {
    return {
      ok: false,
      code: 'no_external_access',
      error: 'The tracked postgres component has no provider binding for database access.',
      resourceCreated: false,
      cleanup: 'not_needed',
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
  const adapter = adapterResult.adapter;
  if (
    !adapterResult.success
    || !adapter
    || !adapter.capabilities.supportsTemporaryDatabaseAccess
    || typeof adapter.acquireTemporaryDatabaseAccess !== 'function'
    || typeof adapter.releaseTemporaryDatabaseAccess !== 'function'
  ) {
    return {
      ok: false,
      code: adapterResult.success ? 'no_external_access' : 'provider_error',
      error: adapterResult.error ?? `${provider} does not support operation-scoped database access.`,
      provider,
      resourceCreated: false,
      cleanup: 'not_needed',
      hint: 'Use a verified database connection or a provider that supports private or ephemeral diagnostic access.',
    };
  }

  try {
    const lease = await databaseAccessLeaseCoordinator.acquire({
      key: `${provider}:${environment.id}:${component.id}:5432`,
      provider,
      adapter,
      environment,
      component,
      create: () => adapter.acquireTemporaryDatabaseAccess!(environment, component, 5432),
    });
    return { ok: true, lease };
  } catch (error) {
    return {
      ok: false,
      code: 'provider_error',
      error: `Failed to acquire operation-scoped database access from ${provider}: ${error instanceof Error ? error.message : String(error)}`,
      provider,
      resourceCreated: 'unknown',
      cleanup: 'unknown',
      hint: 'Inspect the managed database and provider connection with hv_inspect before retrying.',
    };
  }
}
