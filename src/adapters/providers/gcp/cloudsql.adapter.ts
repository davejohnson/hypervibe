import { createPostgresCredentialLifecycle } from '../database/database-credential.js';
import { environmentResourceName } from '../../../domain/services/resource-names.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IDatabaseOperations,
  DatabaseCapabilities,
} from '../../../domain/ports/database.port.js';
import type { IObservableDatabase, ObservedDatabase } from '../../../domain/ports/observe.port.js';
import {
  providerRegistry,
  type DatabaseRuntimeProjection,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  databaseReplicaEnvKey,
} from '../../../domain/services/database-env.js';
import { buildCloudSqlRestoreDrillWorkflow, resolveCloudSqlRestoreDrillSource } from './cloudsql-restore-drill.workflow.js';

// Credentials schema for self-registration
export const CloudSqlCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
});

export type CloudSqlCredentials = z.infer<typeof CloudSqlCredentialsSchema>;

interface CloudSqlInstance {
  name: string;
  project?: string;
  state: string;
  databaseVersion: string;
  ipAddresses?: Array<{
    type: string;
    ipAddress: string;
  }>;
  serverCaCert?: {
    cert: string;
    commonName: string;
    expirationTime: string;
  };
  region?: string;
  connectionName?: string;
  masterInstanceName?: string;
  replicaNames?: string[];
  settings?: {
    settingsVersion?: string;
    tier?: string;
    availabilityType?: string;
    edition?: string;
    userLabels?: Record<string, string>;
    backupConfiguration?: {
      startTime?: string;
      enabled?: boolean;
      pointInTimeRecoveryEnabled?: boolean;
      transactionLogRetentionDays?: number;
      backupRetentionSettings?: {
        retentionUnit?: string;
        retainedBackups?: number;
      };
    };
  };
}

interface CloudSqlOperation {
  name?: string;
  targetProject?: string;
  targetId?: string;
  status?: string;
  error?: {
    errors?: Array<{ code?: string; message?: string }>;
  };
}

interface CloudSqlInstanceList {
  items?: CloudSqlInstance[];
  nextPageToken?: string;
}

interface CloudSqlBackup {
  name: string;
  description?: string;
  sourceInstance?: string;
  type?: string;
  backupKind?: string;
  state?: string;
  databaseVersion?: string;
  location?: string;
  instanceDeletionTime?: string;
  expiryTime?: string;
  ttlDays?: string | number;
  maxChargeableBytes?: string;
}

interface CloudSqlBackupList {
  backups?: CloudSqlBackup[];
  nextPageToken?: string;
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

function databaseRuntimeString(
  bindings: Record<string, unknown>,
  key: string
): string | undefined {
  const value = bindings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloudSqlSocketDatabaseUrl(params: {
  username?: string;
  password?: string;
  database?: string;
  socketHost: string;
}): string | undefined {
  if (!params.username || !params.password || !params.database) return undefined;
  return `postgresql://${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}@/${encodeURIComponent(params.database)}?host=${encodeURIComponent(params.socketHost)}`;
}

function cloudSqlReplicaBindings(
  bindings: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const resilience = bindings.resilience;
  if (!resilience || typeof resilience !== 'object' || Array.isArray(resilience)) return {};
  const replicas = (resilience as Record<string, unknown>).replicas;
  if (!replicas || typeof replicas !== 'object' || Array.isArray(replicas)) return {};
  return replicas as Record<string, Record<string, unknown>>;
}

function projectCloudSqlDatabaseRuntime(
  component: Component,
  standard: DatabaseRuntimeProjection
): DatabaseRuntimeProjection {
  const bindings = component.bindings as Record<string, unknown>;
  const envVars = { ...standard.envVars };
  const username = databaseRuntimeString(bindings, 'username');
  const password = databaseRuntimeString(bindings, 'password');
  const database = databaseRuntimeString(bindings, 'database');
  const connectionName = databaseRuntimeString(bindings, 'connectionName');
  const socketHost = connectionName
    ? `/cloudsql/${connectionName}`
    : databaseRuntimeString(bindings, 'host');
  const socketUrl = socketHost
    ? cloudSqlSocketDatabaseUrl({ username, password, database, socketHost })
    : undefined;

  if (socketUrl) {
    envVars.DATABASE_URL = socketUrl;
    envVars.DIRECT_URL = socketUrl;
  }

  const replicas = Object.entries(cloudSqlReplicaBindings(bindings))
    .sort(([left], [right]) => left.localeCompare(right));
  const replicaConnectionNames = replicas
    .map(([, replica]) => databaseRuntimeString(replica, 'connectionName'))
    .filter((value): value is string => Boolean(value));
  if (connectionName) {
    const connectionNames = [connectionName, ...replicaConnectionNames].join(',');
    envVars.CLOUD_SQL_CONNECTION_NAME = connectionNames;
    envVars.INSTANCE_CONNECTION_NAME = connectionNames;
  }
  if (socketHost) {
    envVars.DATABASE_HOST = socketHost;
    envVars.DB_HOST = socketHost;
    envVars.PGHOST = socketHost;
  }
  for (const [name, replica] of replicas) {
    const replicaConnectionName = databaseRuntimeString(replica, 'connectionName');
    const replicaUrl = replicaConnectionName
      ? cloudSqlSocketDatabaseUrl({
        username,
        password,
        database,
        socketHost: `/cloudsql/${replicaConnectionName}`,
      })
      : databaseRuntimeString(replica, 'connectionUrl');
    if (replicaUrl) {
      envVars[databaseReplicaEnvKey(name)] = replicaUrl;
      if (replicas.length === 1) envVars.DATABASE_READ_URL = replicaUrl;
    }
  }

  return { envVars, connectionUrl: standard.connectionUrl };
}

export class CloudSqlAdapter implements IDatabaseOperations, IObservableDatabase {
  readonly name = 'cloudsql';

  readonly credentialLifecycle = createPostgresCredentialLifecycle(() => this, {
    rotate: async (_component, target, replacement) => {
      if (!this.credentials || !replacement) return { state: 'blocked' };
      const projectId = this.credentials.projectId;
      const token = await this.getAccessToken();
      const url = new URL(`https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(target.externalId)}/users`);
      url.searchParams.set('name', target.username);
      const response = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: target.username, password: replacement }) });
      if (!response.ok) return { state: 'unknown' };
      const operation = await response.json() as { name?: string; targetProject?: string; targetId?: string; status?: string; error?: unknown };
      if (!operation.name || !/^[A-Za-z0-9_-]+$/.test(operation.name) || operation.targetProject !== projectId || operation.targetId !== target.externalId || operation.error) return { state: 'unknown' };
      if (operation.status !== 'DONE') await this.waitForOperation(token, operation.name, 'database password update', { targetProject: projectId, targetId: target.externalId });
      return { state: 'acknowledged', operationId: operation.name };
    },
  });

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false, // Cloud SQL Auth Proxy recommended
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: CloudSqlCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private temporaryConnectors = new Map<string, { connector: Connector; directory: string }>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as CloudSqlCredentials;
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId } = this.credentials;

      // A token exchange succeeds even for a service account with zero roles;
      // probe the SQL Admin API so verification proves real access.
      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances?maxResults=1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 403) {
          return {
            success: false,
            error: [
              'Cloud SQL Admin API probe failed with 403.',
              `Grant roles/cloudsql.viewer and roles/cloudsql.client to serviceAccount:${this.serviceAccountCreds.client_email} on project ${projectId};`,
              'also grant roles/cloudsql.admin if Hypervibe should provision or delete databases,',
              'and make sure the sqladmin.googleapis.com API is enabled (hv_connections provider="cloudrun" action="prepare" enables it).',
              `Original error: ${text}`,
            ].join(' '),
          };
        }
        return {
          success: false,
          error: `Cloud SQL Admin API probe failed: ${response.status} ${text}`,
        };
      }

      return {
        success: true,
        email: this.serviceAccountCreds.client_email,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    for (const temporary of this.temporaryConnectors.values()) {
      temporary.connector.close();
      await rm(temporary.directory, { recursive: true, force: true }).catch(() => {});
    }
    this.temporaryConnectors.clear();
    this.credentials = null;
    this.serviceAccountCreds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.credentials) {
      return null;
    }
    this.assertComponentScope(component);

    const bindings = component.bindings as {
      connectionUrl?: string;
      connectionString?: string;
      username?: string;
      password?: string;
      database?: string;
      port?: number | string;
    };

    // Prefer a live public IP lookup. Early Cloud SQL bindings stored a
    // provider-internal placeholder host that is useful inside Cloud Run but
    // not directly reachable by local Hypervibe db_query.
    let liveInstance: CloudSqlInstance | null | undefined;
    if (component.externalId) {
      try {
        liveInstance = await this.getInstance(component.externalId);
      } catch {
        // A stored URL can remain usable while the control-plane read is
        // temporarily unavailable. Scope checks still happen outside this
        // fallback so another project/region can never be selected silently.
      }
      if (liveInstance) {
        this.assertComponentScope(component, liveInstance);
        if (liveInstance.ipAddresses) {
          const publicIp = liveInstance.ipAddresses.find((ip) => ip.type === 'PRIMARY');
          if (publicIp) {
            const port = Number(bindings.port ?? (component.type === 'postgres' ? 5432 : 3306));
            const username = bindings.username;
            const password = bindings.password;
            const database = bindings.database;
            if (username && password && database) {
              return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${publicIp.ipAddress}:${port}/${encodeURIComponent(database)}`;
            }
          }
        }
      }
    }

    return bindings.connectionUrl ?? bindings.connectionString ?? null;
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.credentials || !this.serviceAccountCreds) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (applicationPort !== 5432) {
      throw new Error(`Cloud SQL PostgreSQL access requires application port 5432, received ${applicationPort}.`);
    }
    this.assertComponentScope(component);

    const bindings = component.bindings as Record<string, unknown>;
    const instanceName = component.externalId
      ?? (typeof bindings.instanceId === 'string' ? bindings.instanceId : undefined);
    const providerScope = bindings.providerScope && typeof bindings.providerScope === 'object' && !Array.isArray(bindings.providerScope)
      ? bindings.providerScope as Record<string, unknown>
      : undefined;
    const connectionRegion = typeof providerScope?.region === 'string'
      ? providerScope.region
      : this.credentials.region;
    const connectionName = typeof bindings.connectionName === 'string'
      ? bindings.connectionName
      : instanceName ? `${this.credentials.projectId}:${connectionRegion}:${instanceName}` : undefined;
    if (!connectionName) {
      throw new Error('Cloud SQL component is missing its instance connection name.');
    }
    this.assertConnectionNameScope(connectionName, instanceName, component);

    const storedUrl = typeof bindings.connectionUrl === 'string'
      ? bindings.connectionUrl
      : typeof bindings.connectionString === 'string' ? bindings.connectionString : undefined;
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = storedUrl ? new URL(storedUrl) : undefined;
    } catch {
      parsedUrl = undefined;
    }
    const username = typeof bindings.username === 'string' ? bindings.username : parsedUrl?.username;
    const password = typeof bindings.password === 'string' ? bindings.password : parsedUrl?.password;
    const database = typeof bindings.database === 'string'
      ? bindings.database
      : parsedUrl?.pathname.replace(/^\//, '');
    if (!username || !password || !database) {
      throw new Error('Cloud SQL bindings are missing the database username, password, or database name.');
    }

    const auth = new GoogleAuth({
      credentials: this.serviceAccountCreds,
      scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
    });
    const connector = new Connector({ auth });
    const directory = await mkdtemp(path.join(tmpdir(), 'hv-cloudsql-'));
    const socketPath = path.join(directory, '.s.PGSQL.5432');
    try {
      await connector.startLocalProxy({
        instanceConnectionName: connectionName,
        ipType: IpAddressTypes.PUBLIC,
        listenOptions: { path: socketPath },
      });
      const releaseToken = randomUUID();
      this.temporaryConnectors.set(releaseToken, { connector, directory });
      const authPart = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
      return {
        connectionUrl: `postgresql://${authPart}@localhost/${encodeURIComponent(database)}?host=${encodeURIComponent(directory)}`,
        source: 'private_connector',
        temporary: true,
        releaseToken,
      };
    } catch (error) {
      connector.close();
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    _component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!access.releaseToken) {
      throw new Error('Temporary Cloud SQL access is missing its cleanup token.');
    }
    const temporary = this.temporaryConnectors.get(access.releaseToken);
    if (!temporary) return;
    temporary.connector.close();
    await rm(temporary.directory, { recursive: true, force: true });
    this.temporaryConnectors.delete(access.releaseToken);
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.credentials || !component.externalId) {
      return { status: 'unknown' };
    }

    try {
      this.assertComponentScope(component);
      const instance = await this.getInstance(component.externalId);
      if (!instance) {
        return { status: 'unknown', message: 'Instance not found' };
      }
      this.assertComponentScope(component, instance);

      const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error'> = {
        RUNNABLE: 'running',
        PENDING_CREATE: 'provisioning',
        MAINTENANCE: 'running',
        FAILED: 'error',
        SUSPENDED: 'stopped',
        PENDING_DELETE: 'stopped',
        UNKNOWN_STATE: 'unknown' as 'running',
      };

      return {
        status: statusMap[instance.state] || 'unknown',
        message: instance.state,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (component?.externalId) {
      this.assertComponentScope(component);
      const instance = await this.getInstance(component.externalId);
      if (!instance) return null;
      this.assertComponentScope(component, instance);
      return {
        provider: this.name,
        engine: 'postgres',
        externalId: instance.name || component.externalId,
        providerScope: this.instanceProviderScope(instance),
        name: instance.name || component.externalId,
        status: this.normalizedInstanceStatus(instance.state),
        resilience: await this.observeResilience(instance, component),
      };
    }

    // Backward-compatible discovery for components created before resourceName.
    for (const type of ['postgres'] as const) {
      const instanceName = this.sanitizeName(options?.resourceName || environmentResourceName(type, environment));
      const instance = await this.getInstance(instanceName);
      if (!instance) {
        continue;
      }

      return {
        provider: this.name,
        engine: type,
        externalId: instance.name || instanceName,
        providerScope: this.instanceProviderScope(instance),
        name: instance.name || instanceName,
        status: this.normalizedInstanceStatus(instance.state),
        resilience: await this.observeResilience(instance, component),
      };
    }

    return null;
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const selected = request.id ?? request.name;
    if (selected) {
      const instance = await this.getInstance(selected);
      return {
        observation: instance ? 'present' : 'absent',
        resource: 'database',
        project: { id: this.credentials.projectId },
        databases: instance ? [this.inspectedDatabase(instance)] : [],
        ...(instance ? {} : { [request.id ? 'id' : 'name']: selected }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/instances?maxResults=${request.limit}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL instance inventory failed: ${response.status} ${body}`);
    }
    const page = await response.json() as CloudSqlInstanceList;
    const databases = (page.items ?? [])
      .slice(0, request.limit)
      .map((instance) => this.inspectedDatabase(instance));
    return {
      observation: databases.length > 0 ? 'present' : 'absent',
      resource: 'database',
      project: { id: this.credentials.projectId },
      databases,
      truncated: Boolean(page.nextPageToken) || (page.items?.length ?? 0) > request.limit,
      partial: false,
    };
  }

  async inspectBackupResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const selectedId = request.id?.trim();
    if (selectedId) {
      const backup = await this.getBackup(selectedId);
      return {
        observation: backup ? 'present' : 'absent',
        resource: 'backup',
        project: { id: this.credentials.projectId },
        backups: backup ? [this.inspectedBackup(backup)] : [],
        ...(backup ? {} : { id: selectedId }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/backups?pageSize=${request.limit}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL backup inventory failed: ${response.status} ${body}`);
    }
    const page = await response.json() as CloudSqlBackupList;
    const candidates = (page.backups ?? []).filter((backup) => (
      !request.name || backup.name === request.name || this.lastPathSegment(backup.name) === request.name
    ));
    const backups = candidates.slice(0, request.limit).map((backup) => this.inspectedBackup(backup));
    const incompleteNameSearch = Boolean(request.name && page.nextPageToken);
    return {
      observation: incompleteNameSearch
        ? 'unknown'
        : request.name && backups.length > 1
        ? 'ambiguous'
        : backups.length > 0 ? 'present' : 'absent',
      resource: 'backup',
      project: { id: this.credentials.projectId },
      backups,
      ...(request.name ? { name: request.name } : {}),
      truncated: Boolean(page.nextPageToken) || candidates.length > request.limit,
      partial: incompleteNameSearch,
    };
  }

  // Helper methods

  private componentInstanceName(component: Component): string | undefined {
    const bindings = component.bindings as Record<string, unknown>;
    return component.externalId
      ?? (typeof bindings.instanceId === 'string' && bindings.instanceId.length > 0
        ? bindings.instanceId
        : undefined);
  }

  private instanceProviderScope(instance: CloudSqlInstance): Record<string, string> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return {
      projectId: this.credentials.projectId,
      ...(instance.region ? { region: instance.region } : {}),
    };
  }

  private inspectedDatabase(instance: CloudSqlInstance): Record<string, unknown> {
    return {
      id: instance.name,
      name: instance.name,
      engine: instance.databaseVersion.startsWith('POSTGRES')
        ? 'postgres'
        : instance.databaseVersion.toLowerCase(),
      databaseVersion: instance.databaseVersion,
      status: this.normalizedInstanceStatus(instance.state),
      state: instance.state,
      ...(instance.region ? { region: instance.region } : {}),
      ...(instance.connectionName ? { connectionName: instance.connectionName } : {}),
      ...(instance.masterInstanceName ? { primaryId: instance.masterInstanceName } : {}),
      providerScope: this.instanceProviderScope(instance),
    };
  }

  private assertComponentScope(component: Component, instance?: CloudSqlInstance): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    const instanceName = this.componentInstanceName(component);
    const projectId = typeof scope?.projectId === 'string' && scope.projectId.trim().length > 0
      ? scope.projectId
      : undefined;
    if (instanceName && !projectId) {
      throw new Error(
        `Cloud SQL binding ${instanceName} is missing its durable GCP project scope; re-import or re-plan the database before using it.`
      );
    }
    if (projectId && projectId !== this.credentials.projectId) {
      throw new Error(`Cloud SQL binding belongs to project ${projectId}, not connected project ${this.credentials.projectId}.`);
    }
    if (instance && typeof scope?.region === 'string' && instance.region !== scope.region) {
      throw new Error(`Cloud SQL instance ${instance.name} is in region ${instance.region ?? 'unknown'}, not bound region ${scope.region}.`);
    }
  }

  private assertConnectionNameScope(
    connectionName: string,
    instanceName: string | undefined,
    component: Component
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const parts = connectionName.split(':');
    if (
      parts.length !== 3
      || parts[0] !== this.credentials.projectId
      || (instanceName !== undefined && parts[2] !== instanceName)
    ) {
      throw new Error(
        `Cloud SQL connection name ${connectionName} does not match connected project ${this.credentials.projectId}${instanceName ? ` and bound instance ${instanceName}` : ''}.`
      );
    }
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    if (typeof scope?.region === 'string' && parts[1] !== scope.region) {
      throw new Error(
        `Cloud SQL connection name ${connectionName} is in region ${parts[1]}, not bound region ${scope.region}.`
      );
    }
  }

  private async observeResilience(
    primary: CloudSqlInstance,
    component?: Component | null
  ): Promise<NonNullable<ObservedDatabase['resilience']>> {
    const bindings = component?.bindings as Record<string, unknown> | undefined;
    const resilience = bindings?.resilience && typeof bindings.resilience === 'object' && !Array.isArray(bindings.resilience)
      ? bindings.resilience as Record<string, unknown>
      : {};
    const boundReplicas = resilience.replicas && typeof resilience.replicas === 'object' && !Array.isArray(resilience.replicas)
      ? resilience.replicas as Record<string, Record<string, unknown>>
      : {};
    const boundNameByExternalId = new Map(
      Object.entries(boundReplicas).flatMap(([name, binding]) =>
        typeof binding.externalId === 'string' ? [[binding.externalId, name] as const] : []
      )
    );
    const replicas = [] as NonNullable<NonNullable<ObservedDatabase['resilience']>['replicas']>;
    for (const replicaName of primary.replicaNames ?? []) {
      const replica = await this.getInstance(replicaName);
      if (!replica) {
        throw new Error(`Cloud SQL listed read replica ${replicaName}, but its exact identity could not be observed.`);
      }
      const logicalName = replica.settings?.userLabels?.['hypervibe-replica']
        ?? boundNameByExternalId.get(replica.name);
      replicas.push({
        ...(logicalName ? { name: logicalName } : {}),
        externalId: replica.name,
        status: this.normalizedInstanceStatus(replica.state),
        ...(replica.region ? { region: replica.region } : {}),
        ...(replica.settings?.tier ? { tier: replica.settings.tier } : {}),
        ...(this.instanceConnectionName(replica) ? { connectionName: this.instanceConnectionName(replica) } : {}),
      });
    }
    const backup = primary.settings?.backupConfiguration;
    const availability = primary.settings?.availabilityType === 'REGIONAL'
      ? 'regional'
      : primary.settings?.availabilityType === 'ZONAL'
        ? 'zonal'
        : 'unknown';
    return {
      availability,
      backupPolicy: {
        enabled: backup?.enabled === true,
        pitrEnabled: backup?.pointInTimeRecoveryEnabled === true,
        ...(typeof backup?.backupRetentionSettings?.retainedBackups === 'number'
          ? { retainedBackups: backup.backupRetentionSettings.retainedBackups }
          : {}),
        ...(typeof backup?.transactionLogRetentionDays === 'number'
          ? { pitrRetentionDays: backup.transactionLogRetentionDays }
          : {}),
      },
      replicas,
    };
  }

  private instanceConnectionName(instance: CloudSqlInstance): string | undefined {
    if (instance.connectionName) return instance.connectionName;
    if (!this.credentials || !instance.region || !instance.name) return undefined;
    return `${this.credentials.projectId}:${instance.region}:${instance.name}`;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.serviceAccountCreds.client_email,
      sub: this.serviceAccountCreds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    };

    const jwt = await this.createJwt(header, payload, this.serviceAccountCreds.private_key);

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 60) * 1000);

    return this.accessToken!;
  }

  private async createJwt(
    header: Record<string, string>,
    payload: Record<string, unknown>,
    privateKey: string
  ): Promise<string> {
    const encoder = new TextEncoder();

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    const pemContents = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\n/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(unsignedToken)
    );

    const signatureB64 = this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    return `${unsignedToken}.${signatureB64}`;
  }

  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async getInstance(instanceName: string): Promise<CloudSqlInstance | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const { projectId } = this.credentials;

    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(instanceName)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud SQL API error: ${response.status} ${text}`);
    }

    const instance = (await response.json()) as CloudSqlInstance;
    if (!instance.name || instance.name !== instanceName) {
      throw new Error(
        `Cloud SQL exact lookup for ${instanceName} returned ${instance.name || 'an instance without an identity'}.`
      );
    }
    return instance;
  }

  private isBackupResourceName(name: string): boolean {
    if (!this.credentials) return false;
    const prefix = `projects/${this.credentials.projectId}/backups/`;
    return name.startsWith(prefix) && name.length > prefix.length && !name.slice(prefix.length).includes('/');
  }

  private async getBackup(name: string): Promise<CloudSqlBackup | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (!this.isBackupResourceName(name)) {
      throw new Error(`Cloud SQL backup id must be scoped as projects/${this.credentials.projectId}/backups/{backup}.`);
    }
    const token = await this.getAccessToken();
    const response = await fetch(`https://sqladmin.googleapis.com/v1/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL backup lookup failed: ${response.status} ${body}`);
    }
    return await response.json() as CloudSqlBackup;
  }

  private inspectedBackup(backup: CloudSqlBackup): Record<string, unknown> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return {
      id: backup.name,
      name: this.lastPathSegment(backup.name),
      providerScope: { projectId: this.credentials.projectId },
      sourceInstance: backup.sourceInstance ?? null,
      type: backup.type ?? null,
      backupKind: backup.backupKind ?? null,
      state: backup.state ?? null,
      databaseVersion: backup.databaseVersion ?? null,
      location: backup.location ?? null,
      instanceDeletionTime: backup.instanceDeletionTime ?? null,
      expiryTime: backup.expiryTime ?? null,
      ttlDays: backup.ttlDays ?? null,
      maxChargeableBytes: backup.maxChargeableBytes ?? null,
      cleanupSupported: Boolean(backup.instanceDeletionTime),
    };
  }

  private lastPathSegment(value: string): string {
    return value.split('/').filter(Boolean).at(-1) ?? value;
  }

  private normalizedInstanceStatus(
    state?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown'> = {
      RUNNABLE: 'running',
      PENDING_CREATE: 'provisioning',
      MAINTENANCE: 'running',
      FAILED: 'error',
      SUSPENDED: 'stopped',
      PENDING_DELETE: 'stopped',
    };
    return statusMap[state ?? ''] ?? 'unknown';
  }

  private async waitForOperation(token: string, operationName: string, description: string, expected?: { targetProject: string; targetId: string }): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    const operationUrl = operationName.includes('/operations/')
      ? `https://sqladmin.googleapis.com/v1/${operationName}`
      : `https://sqladmin.googleapis.com/v1/projects/${projectId}/operations/${encodeURIComponent(operationName)}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(
        operationUrl,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud SQL ${description} operation lookup failed: ${response.status} ${text}`);
      }

      const operation = await response.json() as CloudSqlOperation;
      if (expected && (operation.name !== operationName || operation.targetProject !== expected.targetProject || operation.targetId !== expected.targetId)) {
        throw new Error('Cloud SQL operation completion did not match the reviewed database.');
      }
      const status = (operation.status ?? '').toUpperCase();
      if (status === 'DONE') {
        if (operation.error?.errors?.length) {
          throw new Error(`Cloud SQL ${description} operation failed: ${operation.error.errors.map((entry) => entry.message ?? entry.code ?? 'unknown').join('; ')}`);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Cloud SQL ${description} operation did not finish before timeout`);
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudsql',
    displayName: 'GCP Cloud SQL',
    category: 'database',
    credentialsSchema: CloudSqlCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    maturity: {
      lifecycle: {
        database: {
          status: 'planned',
          reason: 'Infrastructure is moving to OpenTofu. Authentication and operational tools remain available.',
        },
      },
    },
    orchestration: {
      databaseRestoreDrill: {
        resolveSource: resolveCloudSqlRestoreDrillSource,
        buildWorkflow: buildCloudSqlRestoreDrillWorkflow,
      },
    },
  },
  inspection: {
    resources: ['database', 'backup'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId'],
      },
      backup: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId'],
        collectionKey: 'backups',
      },
    },
    inspect: (adapter, request) => request.resource === 'backup'
      ? (adapter as CloudSqlAdapter).inspectBackupResources(request)
      : (adapter as CloudSqlAdapter).inspectDatabaseResources(request),
  },
  databaseRuntime: {
    project: projectCloudSqlDatabaseRuntime,
  },
  factory: async (credentials) => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
});
