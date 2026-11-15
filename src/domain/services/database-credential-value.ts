import type { Component } from '../entities/component.entity.js';
import type { DatabaseCredentialTarget } from '../ports/database-credential.port.js';

export function replaceDatabasePassword(value: string, replacement: string, identity: { username: string; database: string }): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== identity.username
    || decodeURIComponent(url.pathname.slice(1)) !== identity.database
    || [...url.searchParams.keys()].some(key => ['password', 'user', 'username', 'database', 'dbname'].includes(key.toLowerCase()))) throw new Error('Database connection identity does not match the reviewed credential.');
  const parts = value.match(/^((?:postgres|postgresql):\/\/[^@/:]+:)[^@]*(@.+)$/);
  if (!parts || !replacement || replacement.includes('\0')) throw new Error('Database connection identity or replacement is invalid.');
  return `${parts[1]}${encodeURIComponent(replacement)}${parts[2]}`;
}

export function replaceDatabaseCredentialBindings(component: Component, password: string, target: DatabaseCredentialTarget): Record<string, unknown> {
  const bindings: Record<string, unknown> = { ...component.bindings, password };
  for (const key of ['connectionString', 'connectionUrl', 'directUrl', 'pooledUrl', 'DATABASE_URL', 'DIRECT_URL']) {
    const value = bindings[key];
    if (typeof value === 'string' && /^postgres(?:ql)?:\/\//.test(value)) {
      // Provider poolers can use a qualified login name. Preserve that exact
      // existing endpoint/user while changing only this accepted user's password.
      const parsed = new URL(value);
      const login = decodeURIComponent(parsed.username);
      if (login !== target.username && !login.startsWith(`${target.username}.`)) throw new Error('Stored database URL belongs to another user.');
      bindings[key] = replaceDatabasePassword(value, password, { username: login, database: target.database });
    }
  }
  return bindings;
}
