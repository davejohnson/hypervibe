import type { Component } from '../entities/component.entity.js';

/** Runtime keys owned by a declared database component. */
export const DATABASE_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'DATABASE_SSL',
  'DATABASE_POOLER_URL',
  'DATABASE_PORT',
  'DB_PORT',
  'PGPORT',
  'DATABASE_USER',
  'DB_USER',
  'PGUSER',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'PGPASSWORD',
  'DATABASE_NAME',
  'DB_NAME',
  'PGDATABASE',
] as const;

function stringBinding(bindings: Record<string, unknown>, key: string): string | undefined {
  const value = bindings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function portBinding(bindings: Record<string, unknown>, fallback: number): string {
  const value = bindings.port;
  return typeof value === 'number' || typeof value === 'string' ? String(value) : String(fallback);
}

function socketDatabaseUrl(params: {
  username?: string;
  password?: string;
  database?: string;
  socketHost: string;
}): string | undefined {
  if (!params.username || !params.password || !params.database) {
    return undefined;
  }

  return `postgresql://${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}@/${encodeURIComponent(params.database)}?host=${encodeURIComponent(params.socketHost)}`;
}

export function buildDatabaseEnvVarsFromComponent(component: Component): { envVars: Record<string, string>; connectionUrl?: string } {
  const bindings = component.bindings as Record<string, unknown>;
  const envVars: Record<string, string> = {};
  const provider = stringBinding(bindings, 'provider');
  const connectionUrl = stringBinding(bindings, 'connectionUrl') ?? stringBinding(bindings, 'connectionString');

  if (provider === 'railway') {
    const pluginName = stringBinding(bindings, 'pluginName');
    if (pluginName) {
      envVars.DATABASE_URL = '${{' + pluginName + '.DATABASE_URL}}';
      envVars.DIRECT_URL = '${{' + pluginName + '.DATABASE_PRIVATE_URL}}';
      return { envVars, connectionUrl };
    }
  }

  const username = stringBinding(bindings, 'username');
  const password = stringBinding(bindings, 'password');
  const database = stringBinding(bindings, 'database');
  const port = portBinding(bindings, 5432);

  if (provider === 'cloudsql') {
    const connectionName = stringBinding(bindings, 'connectionName');
    const socketHost = connectionName ? `/cloudsql/${connectionName}` : stringBinding(bindings, 'host');
    const socketUrl = socketHost
      ? socketDatabaseUrl({ username, password, database, socketHost })
      : undefined;
    const url = socketUrl ?? connectionUrl;

    if (url) {
      envVars.DATABASE_URL = url;
      envVars.DIRECT_URL = url;
    }
    if (connectionName) {
      envVars.CLOUD_SQL_CONNECTION_NAME = connectionName;
      envVars.INSTANCE_CONNECTION_NAME = connectionName;
    }
    if (socketHost) {
      envVars.DATABASE_HOST = socketHost;
      envVars.DB_HOST = socketHost;
      envVars.PGHOST = socketHost;
    }
  } else {
    if (connectionUrl) {
      envVars.DATABASE_URL = connectionUrl;
      envVars.DIRECT_URL = connectionUrl;
    }
    const host = stringBinding(bindings, 'host');
    if (host) {
      envVars.DATABASE_HOST = host;
      envVars.DB_HOST = host;
      envVars.PGHOST = host;
    }
    if (provider === 'supabase') {
      envVars.DATABASE_SSL = 'true';
    }
  }

  if (stringBinding(bindings, 'pooledUrl')) {
    envVars.DATABASE_POOLER_URL = stringBinding(bindings, 'pooledUrl')!;
  }
  envVars.DATABASE_PORT = port;
  envVars.DB_PORT = port;
  envVars.PGPORT = port;
  if (username) {
    envVars.DATABASE_USER = username;
    envVars.DB_USER = username;
    envVars.PGUSER = username;
  }
  if (password) {
    envVars.DATABASE_PASSWORD = password;
    envVars.DB_PASSWORD = password;
    envVars.PGPASSWORD = password;
  }
  if (database) {
    envVars.DATABASE_NAME = database;
    envVars.DB_NAME = database;
    envVars.PGDATABASE = database;
  }

  return { envVars, connectionUrl };
}
