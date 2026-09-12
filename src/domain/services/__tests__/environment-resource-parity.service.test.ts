import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { environmentResourceWarnings } from '../environment-resource-parity.service.js';

const web = { workloadKind: 'web', startCommand: 'npm start' };
const base = { hosting: { provider: 'railway' }, services: { web } };
const bucket = { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['web'] };
function spec(environments: Record<string, unknown>) {
  return projectSpecSchema.parse({ version: 1, project: 'resource-parity-app', environments });
}

describe('environmentResourceWarnings', () => {
  it('identifies missing background workloads, datastores, buckets, queues, domain, and email without mutating the spec', () => {
    const input = spec({ production: {
      ...base,
      services: { web, worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
        reminders: { workloadKind: 'cron', startCommand: 'npm run reminders', cronSchedule: '0 * * * *' } },
      database: { provider: 'railway' }, cache: { provider: 'railway' },
      storage: { uploads: bucket }, queues: { notifications: {} },
      domain: 'production.example.test', email: { enabled: true },
    }, staging: base });
    const before = structuredClone(input);
    const warnings = environmentResourceWarnings(input);
    expect(warnings).toHaveLength(1);
    for (const resource of ['service:worker', 'service:reminders', 'database', 'cache', 'storage:uploads', 'queue:notifications', 'custom-domain', 'email']) {
      expect(warnings[0]).toContain(resource);
    }
    expect(warnings[0]).toContain('only in "production"');
    expect(warnings[0]).toContain('declared resources, not live state');
    expect(input).toEqual(before);
  });

  it('compares every release environment, reports either direction, and scopes a plan to its target', () => {
    const input = spec({
      staging: { ...base, services: { web, reports: web } },
      production: base,
      review: { ...base, services: { web, console: web } },
      local: { ...base, services: { localOnly: web } },
      repository: { hosting: { provider: 'unconfigured' } },
    });
    const warnings = environmentResourceWarnings(input);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((warning) => warning.includes('only in "staging": service:reports'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('localOnly');
    expect(warnings.join('\n')).not.toContain('repository');
    expect(environmentResourceWarnings(input, 'production')).toHaveLength(2);
    expect(environmentResourceWarnings(input, 'local')).toEqual([]);
    const reversed = { ...input, environments: Object.fromEntries(Object.entries(input.environments).reverse()) };
    expect(environmentResourceWarnings(reversed)).toEqual(warnings);
  });

  it('ignores expected differences in env values, hosts, sender identities, regions, and capacity', () => {
    const environment = {
      ...base, services: { web, api: web },
      database: { provider: 'railway' }, cache: { provider: 'railway', size: 'small' },
      storage: { uploads: { ...bucket, injectInto: ['web', 'api'] } },
      domain: 'production.example.test', envVars: { PRIVATE_INPUT: 'production-secret-marker' },
      email: { enabled: true, sender: { address: 'owner@production.example.test' } },
      messaging: { provider: 'twilio', services: ['web', 'api'], service: { name: 'production-sms' },
        sender: { phoneNumberSid: `PN${'1'.repeat(32)}` } },
    };
    const input = spec({ production: environment, staging: {
      ...environment, hosting: { provider: 'railway', region: 'different-region' },
      services: { api: web, web: { ...web, public: true } },
      cache: { provider: 'railway', size: 'smaller' },
      storage: { uploads: { ...bucket, region: 'iad', injectInto: ['api', 'web'] } },
      domain: 'staging.example.test', envVars: { PRIVATE_INPUT: 'staging-secret-marker' },
      email: { enabled: true, sender: { address: 'owner@staging.example.test' } },
      messaging: { provider: 'twilio', services: ['api', 'web'], service: { name: 'staging-sms' },
        sender: { phoneNumberSid: `PN${'2'.repeat(32)}` } },
    } });
    expect(environmentResourceWarnings(input)).toEqual([]);
    expect(environmentResourceWarnings(spec({ staging: base }))).toEqual([]);
  });

  it('reports different workload definitions and providers without including command or environment values', () => {
    const input = spec({
      production: { ...base, services: { web: { ...web, startCommand: 'private-command-marker' } },
        database: { provider: 'railway' }, envVars: { TOKEN: 'private-env-marker' } },
      staging: { ...base, hosting: { provider: 'cloudrun' },
        services: { web: { workloadKind: 'worker', startCommand: 'npm run worker' } },
        database: { provider: 'cloudsql' } },
    });
    const warnings = environmentResourceWarnings(input);
    expect(warnings[0]).toContain('different definitions: database, hosting, service:web');
    expect(warnings.join('\n')).not.toContain('private-command-marker');
    expect(warnings.join('\n')).not.toContain('private-env-marker');
  });

  it('notices a missing SMS sender and missing inbound email, not just the integration flag', () => {
    const messaging = { provider: 'twilio', services: ['web'], service: { name: 'sms' } };
    const input = spec({
      production: { ...base, domain: 'production.example.test',
        messaging: { ...messaging, sender: { phoneNumberSid: `PN${'1'.repeat(32)}` } },
        email: { enabled: true, inbound: { hostname: 'inbound.production.example.test', service: 'web' } } },
      staging: { ...base, domain: 'staging.example.test', messaging, email: { enabled: true } },
    });
    expect(environmentResourceWarnings(input)[0]).toContain('only in "production": email:inbound, messaging:sender');
  });

  it('detects schedule and bucket consumer changes while ignoring consumer order', () => {
    const services = { web, api: web, reminders: {
      workloadKind: 'cron', startCommand: 'npm run reminders', cronSchedule: '0 * * * *',
    } };
    const input = spec({
      production: { ...base, services, storage: { uploads: bucket } },
      staging: { ...base, services: { ...services, reminders: { ...services.reminders, cronSchedule: '0 0 * * *' } },
        storage: { uploads: { ...bucket, injectInto: ['api'] } } },
    });
    expect(environmentResourceWarnings(input)[0]).toContain('different definitions: service:reminders, storage:uploads');
  });
});
