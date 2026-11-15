import type { ProjectSpec } from '../spec/spec.schema.js';
import type { CredentialTracking } from '../spec/credential.schema.js';
import type { Component } from '../entities/component.entity.js';
import type { DatabaseCredentialTarget } from '../ports/database-credential.port.js';
import { buildDatabaseEnvVarsFromComponent } from './database-env.js';
import { replaceDatabasePassword } from './database-credential-value.js';

export function credentialRuntimeServices(spec: ProjectSpec, environment: string, variable: string, descriptor?: CredentialTracking): string[] {
  const desired = spec.environments[environment];
  if (!desired) return [];
  if (descriptor?.runtimeConsumers) {
    const names = descriptor.runtimeConsumers.filter(consumer => consumer.environment === environment && consumer.variable === variable).map(consumer => consumer.service);
    if (names.some(name => !desired.services[name])) throw new Error('A credential consumer names an undeclared service.');
    return [...new Set(names)].sort();
  }
  if (descriptor?.stripeWebhook) {
    const webhook = desired.payments?.stripe?.webhooks[descriptor.stripeWebhook.webhook];
    return descriptor.stripeWebhook.environment === environment && webhook?.envVar === variable ? [webhook.service] : [];
  }
  return Object.keys(desired.services).sort();
}

/** Private templates are frozen inside the encrypted plan, never in metadata. */
export type CredentialConsumerTemplate = { format: 'database-url' | 'reference'; value: string };
export function databaseConsumerTemplate(value: string, component: Component, target: DatabaseCredentialTarget): CredentialConsumerTemplate {
  const projection = buildDatabaseEnvVarsFromComponent(component).envVars;
  if (value.startsWith('${{')) {
    if (!Object.values(projection).includes(value)) throw new Error('The runtime reference does not belong to the reviewed database component.');
    return { format: 'reference', value };
  }
  const parsed = new URL(value);
  const identity = (url: URL) => `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}/${decodeURIComponent(url.username)}`;
  const allowed = new Set([`${target.connection.host}:${target.connection.port}/${target.database}/${target.username}`]);
  for (const candidate of [...Object.values(component.bindings), ...Object.values(projection)]) {
    if (typeof candidate === 'string' && /^postgres(?:ql)?:\/\//.test(candidate)) allowed.add(identity(new URL(candidate)));
  }
  if (!allowed.has(identity(parsed)) || decodeURIComponent(parsed.pathname.slice(1)) !== target.database) throw new Error('The runtime URL belongs to a different database endpoint or user.');
  replaceDatabasePassword(value, 'validation-only', { username: decodeURIComponent(parsed.username), database: target.database });
  return { format: 'database-url', value };
}
export function credentialConsumerValue(value: string, template?: CredentialConsumerTemplate): string {
  if (!template) return value;
  if (template.format === 'reference') return template.value;
  const url = new URL(template.value);
  return replaceDatabasePassword(template.value, value, { username: decodeURIComponent(url.username), database: decodeURIComponent(url.pathname.slice(1)) });
}
