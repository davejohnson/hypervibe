import { z } from 'zod';
import { lookup } from 'dns/promises';
import pg from 'pg';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IDatabaseAdapter,
  DatabaseCapabilities,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const SupabaseCredentialsSchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  organizationId: z.string().optional(),
});

export type SupabaseCredentials = z.infer<typeof SupabaseCredentialsSchema>;

const SUPABASE_API_URL = 'https://api.supabase.com/v1';
const { Client } = pg;

interface SupabaseProject {
  id: string;
  name: string;
  organization_id: string;
  region: string;
  status: string;
  database?: {
    host: string;
    port: number;
    name: string;
    user: string;
    password?: string;
  };
}

export class SupabaseAdapter implements IDatabaseAdapter {
  readonly name = 'supabase';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: true,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: true,
  };

  private credentials: SupabaseCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as SupabaseCredentials;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      // List organizations to verify token
      const response = await this.request<Array<{ id: string; name: string }>>('GET', '/organizations');
      if (response.length > 0) {
        return { success: true, email: `Organization: ${response[0].name}` };
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (type !== 'postgres') {
      const emptyComponent: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component: emptyComponent,
        receipt: {
          success: false,
          message: `Supabase only supports PostgreSQL. Requested type: ${type}`,
        },
      };
    }

    try {
      // Get organization ID
      let orgId = this.credentials.organizationId;
      if (!orgId) {
        const orgs = await this.request<Array<{ id: string }>>('GET', '/organizations');
        if (orgs.length === 0) {
          throw new Error('No organizations found');
        }
        orgId = orgs[0].id;
      }

      // Create project name from environment
      const projectName = options?.databaseName || `${environment.name}-db`;
      const dbPassword = this.generatePassword();

      // Create Supabase project
      const project = await this.request<SupabaseProject>('POST', '/projects', {
        organization_id: orgId,
        name: projectName,
        region: options?.region || 'us-east-1',
        plan: options?.size || 'free',
        db_pass: dbPassword,
      });

      // Build connection URLs
      // Supabase provides both direct and pooled connections
      const host = project.database?.host || `db.${project.id}.supabase.co`;
      const port = project.database?.port || 5432;
      const user = project.database?.user || 'postgres';
      const password = project.database?.password || dbPassword;
      const database = project.database?.name || 'postgres';

      const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      const encodedDatabase = encodeURIComponent(database);
      const directUrl = `postgresql://${auth}@${host}:${port}/${encodedDatabase}`;
      const pooledUrl = `postgresql://${auth}@${host}:6543/${encodedDatabase}?pgbouncer=true`;
      const readiness = await this.waitForDatabaseReadiness(project.id, host, directUrl);

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'postgres',
        bindings: {
          connectionString: directUrl,
          host,
          port,
          username: user,
          password,
          database,
          provider: 'supabase',
          instanceId: project.id,
          pooledUrl,
        },
        externalId: project.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: readiness.ready
            ? `Created Supabase project: ${project.name}`
            : `Created Supabase project: ${project.name}; database is still becoming reachable`,
          data: {
            projectId: project.id,
            region: project.region,
            ready: readiness.ready,
            status: readiness.status,
            attempts: readiness.attempts,
            ...(readiness.error ? { readinessError: readiness.error } : {}),
          },
        },
        connectionUrl: directUrl,
        envVars: {
          DATABASE_URL: directUrl,
          DIRECT_URL: directUrl,
          DATABASE_POOLER_URL: pooledUrl,
          DATABASE_SSL: 'true',
          PGHOST: host,
          PGPORT: String(port),
          PGUSER: user,
          PGPASSWORD: password,
          PGDATABASE: database,
        },
      };
    } catch (error) {
      const emptyComponent: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component: emptyComponent,
        receipt: {
          success: false,
          message: 'Failed to provision Supabase project',
          error: String(error),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.credentials) {
      return null;
    }

    const bindings = component.bindings as { connectionString?: string };
    if (bindings.connectionString) {
      return bindings.connectionString;
    }

    // Fetch from API if not stored
    if (component.externalId) {
      try {
        const project = await this.request<SupabaseProject>(
          'GET',
          `/projects/${component.externalId}`
        );
        if (project.database) {
          const { host, port, user, password, name } = project.database;
          return `postgresql://${user}:${password}@${host}:${port}/${name}`;
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }

    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }

    try {
      await this.request('DELETE', `/projects/${component.externalId}`);
      return {
        success: true,
        message: `Deleted Supabase project: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Supabase project',
        error: String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.credentials || !component.externalId) {
      return { status: 'unknown' };
    }

    try {
      const project = await this.request<SupabaseProject>(
        'GET',
        `/projects/${component.externalId}`
      );

      const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error'> = {
        ACTIVE_HEALTHY: 'running',
        ACTIVE_UNHEALTHY: 'error',
        COMING_UP: 'provisioning',
        GOING_DOWN: 'stopped',
        INACTIVE: 'stopped',
        INIT_FAILED: 'error',
        PAUSED: 'stopped',
        PAUSING: 'stopped',
        REMOVED: 'stopped',
        RESTORING: 'provisioning',
        UNKNOWN: 'unknown' as 'running',
      };

      return {
        status: statusMap[project.status] || 'unknown',
        message: project.status,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  // Helper methods

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${SUPABASE_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase API error: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async waitForDatabaseReadiness(
    projectId: string,
    host: string,
    connectionUrl: string
  ): Promise<{ ready: boolean; attempts: number; status?: string; error?: string }> {
    const maxAttempts = Number(process.env.HYPERVIBE_SUPABASE_READY_ATTEMPTS ?? 20);
    const delayMs = Number(process.env.HYPERVIBE_SUPABASE_READY_DELAY_MS ?? 15000);
    let lastStatus: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const latest = await this.request<SupabaseProject>('GET', `/projects/${projectId}`);
        lastStatus = latest.status;
        await lookup(host);
        const client = new Client({
          connectionString: connectionUrl,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 10000,
        });
        try {
          await client.connect();
          await client.query('select 1');
          return { ready: true, attempts: attempt, status: lastStatus };
        } finally {
          await client.end().catch(() => {});
        }
      } catch (error) {
        lastError = this.formatError(error);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      ready: false,
      attempts: maxAttempts,
      status: lastStatus,
      error: lastError,
    };
  }

  private formatError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const causeRecord = cause as Record<string, unknown>;
      const details = [causeRecord.code, causeRecord.errno, causeRecord.syscall, causeRecord.hostname]
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .join(' ');
      return details ? `${error.message} (${details})` : error.message;
    }
    return error.message;
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'supabase',
    displayName: 'Supabase',
    category: 'database',
    credentialsSchema: SupabaseCredentialsSchema,
    setupHelpUrl: 'https://supabase.com/dashboard/account/tokens',
  },
  factory: (credentials) => {
    const adapter = new SupabaseAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
