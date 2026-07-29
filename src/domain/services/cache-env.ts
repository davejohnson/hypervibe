import type { Component } from '../entities/component.entity.js';

export const CACHE_ENV_KEYS = ['REDIS_URL'] as const;

function stringBinding(bindings: Record<string, unknown>, key: string): string | undefined {
  const value = bindings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildCacheEnvVarsFromComponent(
  component: Component
): { envVars: Record<string, string>; connectionUrl?: string } {
  if (component.type !== 'redis') {
    return { envVars: {} };
  }
  const bindings = component.bindings as Record<string, unknown>;
  const connectionUrl = stringBinding(bindings, 'connectionUrl')
    ?? stringBinding(bindings, 'connectionString');
  return {
    envVars: connectionUrl ? { REDIS_URL: connectionUrl } : {},
    connectionUrl,
  };
}
