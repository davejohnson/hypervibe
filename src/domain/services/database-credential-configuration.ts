import { isDeepStrictEqual } from 'node:util';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseCredentialConfiguration, DatabaseCredentialConfigurationLifecycle, DatabaseCredentialLifecycle } from '../ports/database-credential.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import { databaseConsumerTemplate, credentialConsumerValue, type CredentialConsumerTemplate } from './credential-runtime-consumers.js';
import { readHostingEnvVars, syncHostingEnvVars } from './hosting-env.service.js';
import { adapterFactory } from './adapter.factory.js';
import { buildDatabaseEnvVarsFromComponent } from './database-env.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

type Template = CredentialConsumerTemplate & { resolved?: string };
type PrivateReview = { kind: 'composed-database-configuration'; templates: Record<string, Record<string, Template>>;
  before: Record<string, Record<string, string>>; attempted: string[]; acknowledged: string[]; writeOnlyKeys?: Record<string, string[]>;
  receipts?: Record<string, Record<string, unknown>> };
const values = (review: DatabaseCredentialConfiguration) => review.privateState as unknown as PrivateReview;
export function composedDatabaseConfiguration(review: DatabaseCredentialConfiguration): boolean { return review.privateState?.kind === 'composed-database-configuration'; }
/** Called only after every selected key has matched readback or an exact accepted
 * write. Provider rollout/version evidence is retained per consumer, not shared
 * across services that happen to use the same credential. */
export function databaseConfigurationRolloutData(review: DatabaseCredentialConfiguration, service: string): Record<string, unknown> {
  const consumer = review.consumers.find(candidate => candidate.service === service);
  if (!consumer) throw new Error('The reviewed database consumer is unavailable.');
  const state = composedDatabaseConfiguration(review) ? values(review) : undefined;
  return { ...(state?.receipts?.[service] ?? {}), runtimeRolloutRequired: true, services: [service],
    configurationUpdated: true, credentialKeys: Object.keys(consumer.envVarHashes),
    credentialValueEvidence: state?.writeOnlyKeys?.[service]?.length ? 'acknowledgement' : 'readback' };
}
function expected(template: Template, replacement: string) {
  return template.format === 'reference' && template.resolved
    ? credentialConsumerValue(replacement, { format: 'database-url', value: template.resolved })
    : credentialConsumerValue(replacement, template);
}
export function retargetDatabaseConfiguration(review: DatabaseCredentialConfiguration, replacement: string): DatabaseCredentialConfiguration {
  const state = values(review);
  return { ...review, consumers: review.consumers.map(consumer => ({ ...consumer,
    envVarHashes: Object.fromEntries(Object.entries(state.templates[consumer.service]).map(([key, template]) => [key, hashEnvValue(expected(template, replacement))])),
  })) };
}
export function sameDatabaseConfigurationAuthority(a: DatabaseCredentialConfiguration, b: DatabaseCredentialConfiguration): boolean {
  return isDeepStrictEqual({ issuerNames: a.issuerNames, consumers: a.consumers }, { issuerNames: b.issuerNames, consumers: b.consumers });
}

/** The application composes native issuer ownership with existing selected-key
 * hosting readers/writers. Private review/progress stays in the encrypted plan. */
export function composeDatabaseCredentialConfiguration(project: Project, port: DatabaseCredentialLifecycle,
  persist: () => void = () => {}, desired?: ProjectSpec['environments'][string], retryUncertain = false): DatabaseCredentialConfigurationLifecycle {
  const services = new ServiceRepository();
  const serviceFor = (name: string) => {
    const matches = services.findByProjectId(project.id).filter(service => service.name === name);
    if (matches.length !== 1) throw new Error('The exact database consumer service is unavailable.');
    return matches[0];
  };
  const read = async (environment: Parameters<DatabaseCredentialConfigurationLifecycle['inspect']>[0], name: string, preserveReferences: boolean, required: string[] = []) => {
    const result = await readHostingEnvVars({ project, environment, service: serviceFor(name), preserveReferences });
    if (result.success && required.every(key => typeof result.variables[key] === 'string')) return { variables: result.variables, writeOnly: [] as string[] };
    if (!result.success || required.some(key => typeof result.variables[key] !== 'string' && !result.unresolvedKeys?.includes(key))) throw new Error('Database consumer source configuration is absent or unknown.');
    const bound = parseHostingBindings(environment);
    const connection = await adapterFactory.getProviderAdapter(bound.provider!, project);
    const adapter = connection.success ? connection.adapter : undefined;
    if (!adapter || adapter.capabilities.credentialValueEvidence !== 'acknowledgement' || !adapter.observe) throw new Error('Database consumer configuration is unknown.');
    const observed = await adapter.observe(environment);
    const id = bound.services?.[name]?.serviceId ?? bound.services?.[name]?.jobName;
    const matches = observed.services.filter(service => service.name === name && service.externalId === id);
    if (!observed.projectExists || observed.partial || observed.provider !== bound.provider || observed.projectId !== bound.projectId
      || bound.environmentId && observed.environmentId !== bound.environmentId || matches.length !== 1
      || required.some(key => !matches[0].envVarKeys.includes(key))) throw new Error('The exact write-only database consumer is absent or unknown.');
    const variables = result.variables;
    return { variables, writeOnly: required.filter(key => typeof variables[key] !== 'string') };
  };
  const configuration: DatabaseCredentialConfigurationLifecycle = {
    async inspect(environment, component, target, replacement, required) {
      const state: PrivateReview = { kind: 'composed-database-configuration', templates: {}, before: {}, attempted: [], acknowledged: [], writeOnlyKeys: {} };
      const bindings = parseHostingBindings(environment);
      const consumers: DatabaseCredentialConfiguration['consumers'] = [];
      for (const [name, keys] of Object.entries(required)) {
        const externalId = bindings.services?.[name]?.serviceId ?? bindings.services?.[name]?.jobName;
        if (!externalId) throw new Error('The exact database consumer binding is missing.');
        const reading = await read(environment, name, true, keys);
        const variables = reading.variables; state.writeOnlyKeys![name] = reading.writeOnly;
        state.templates[name] = {}; state.before[name] = {};
        for (const key of keys) {
          const sourceKey = desired?.services[name]?.databaseEnvAliases?.[key] ?? key;
          const value = variables[key] ?? (reading.writeOnly.includes(key) ? buildDatabaseEnvVarsFromComponent(component).envVars[sourceKey] : undefined);
          if (!value) throw new Error('A declared database alias is missing.');
          const template = databaseConsumerTemplate(value, component, target);
          if (template.format === 'reference') {
            const resolved = (await read(environment, name, false, [key])).variables[key];
            databaseConsumerTemplate(resolved, component, target);
            state.templates[name][key] = { ...template, resolved };
          } else state.templates[name][key] = template;
          state.before[name][key] = hashEnvValue(value);
        }
        consumers.push({ service: name, externalId, envVarHashes: {} });
      }
      return retargetDatabaseConfiguration({ issuerNames: ['DATABASE_AUTHENTICATION'], consumers, privateState: state as unknown as Record<string, unknown> }, replacement);
    },
    async observe(environment, component, target, replacement, review) {
      try {
        const issuer = await port.inspectIssuer!(environment, component, target, replacement);
        const state = values(review); let references: 'match' | 'different' | 'unknown' = 'match';
        for (const consumer of review.consumers) {
          const reading = await read(environment, consumer.service, true, Object.keys(state.templates[consumer.service]));
          const variables = reading.variables;
          for (const [key, template] of Object.entries(state.templates[consumer.service])) {
            if (state.writeOnlyKeys?.[consumer.service]?.includes(key)) {
              if (!reading.writeOnly.includes(key)) return { issuer, references: 'unknown' };
              if (!state.acknowledged.includes(consumer.service)) references = 'different';
              continue;
            }
            const current = variables[key];
            if (typeof current !== 'string' || ![state.before[consumer.service][key], hashEnvValue(credentialConsumerValue(replacement, template))].includes(hashEnvValue(current))) return { issuer, references: 'unknown' };
            if (template.format === 'reference') {
              if (current !== template.value) return { issuer, references: 'unknown' };
              const resolved = (await read(environment, consumer.service, false, [key])).variables[key];
              if (hashEnvValue(resolved ?? '') !== consumer.envVarHashes[key]) references = 'different';
            } else if (hashEnvValue(current) !== consumer.envVarHashes[key]) references = 'different';
          }
        }
        return { issuer, references };
      } catch { return { issuer: 'unknown', references: 'unknown' }; }
    },
    async synchronize(environment, component, target, replacement, review) {
      const state = values(review);
      const finalized = await port.finalize!(environment, component, target, replacement);
      if (finalized.state !== 'acknowledged') return finalized;
      for (const consumer of review.consumers) {
        const reading = await read(environment, consumer.service, true, Object.keys(state.templates[consumer.service]));
        const variables = reading.variables;
        const updates: Record<string, string> = {};
        for (const [key, template] of Object.entries(state.templates[consumer.service])) {
          const desired = credentialConsumerValue(replacement, template);
          if (state.writeOnlyKeys?.[consumer.service]?.includes(key)) {
            if (!reading.writeOnly.includes(key)) return { state: 'blocked' };
            if (!state.acknowledged.includes(consumer.service)) updates[key] = desired;
            continue;
          }
          if (variables[key] === desired) continue;
          if (hashEnvValue(variables[key] ?? '') !== state.before[consumer.service][key]) return { state: 'blocked' };
          if (template.format !== 'reference') updates[key] = desired;
        }
        if (!Object.keys(updates).length) continue;
        if (state.attempted.includes(consumer.service) && !retryUncertain) return { state: 'unknown' };
        state.attempted.push(consumer.service); persist();
        const receipt = await syncHostingEnvVars({ project, environment, service: serviceFor(consumer.service), vars: updates, requireCredentialUpdate: true });
        if (receipt.success) {
          const data = receipt.data ?? {};
          // Keep only non-secret native activation evidence; never retain an
          // arbitrary provider response or apply another consumer's receipt.
          (state.receipts ??= {})[consumer.service] = Object.fromEntries(
            ['credentialUpdateActivation', 'deploymentId', 'deploymentIds', 'configurationVersion', 'rolloutBaseline']
              .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
          state.acknowledged.push(consumer.service); persist();
        }
        const after = await read(environment, consumer.service, true, Object.keys(updates));
        if (!receipt.success || Object.entries(updates).some(([key, value]) => !after.writeOnly.includes(key) && after.variables[key] !== value)) return { state: 'unknown' };
      }
      return { state: 'acknowledged' };
    },
  };
  return configuration;
}
