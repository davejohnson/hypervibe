import { expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

const consumer = { environment: 'production', service: 'web', variable: 'API_KEY' };
function specification(consumers: unknown[]) {
  return { version: 1, project: 'credential-mapping', secrets: { API_KEY: {
    ownership: 'delegated', principal: 'user:owner', environments: ['production'],
    credential: { role: 'application-api', label: 'Application API', purpose: 'Application requests', kind: 'opaque', source: 'env:PRIVATE_INPUT', runtimeConsumers: consumers },
  } }, environments: { production: { hosting: { provider: 'railway' }, services: { web: {}, worker: {} } } } };
}

// Independent requirement: exact reviewed consumer mappings cannot silently
// discard an environment, alias or service because its name is misspelled.
it.each([
  { ...consumer, environment: 'missing' },
  { ...consumer, service: 'missing' },
  { ...consumer, variable: 'UNDECLARED_ALIAS' },
  { ...consumer, format: 'database-url' },
])('rejects an invalid exact credential consumer: %j', invalid => {
  expect(projectSpecSchema.safeParse(specification([invalid])).success).toBe(false);
});
it('rejects duplicate consumer coordinates while accepting an exact service subset', () => {
  expect(projectSpecSchema.safeParse(specification([consumer, consumer])).success).toBe(false);
  expect(projectSpecSchema.safeParse(specification([consumer])).success).toBe(true);
});

// Independent boundaries: a contributor's native version is reference-only,
// while credential rotation reads one source and may update selected consumers.
// Combining them cannot silently widen web-only authority to the worker.
it.each([
  { provider: 'aws-secrets', region: 'us-east-1', accountId: '123456789012', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:production-api-AbCdEf' },
  { provider: 'azure-key-vault', tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: '22222222-2222-4222-8222-222222222222', resourceGroup: 'synthetic', vaultName: 'synthetic-vault', secretName: 'production-api' },
  { provider: 'gcp-secret-manager', projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'production-api' },
])('rejects native $provider destinations combined with credential source/consumer authority', destination => {
  const spec = specification([consumer]);
  Object.assign(spec.environments.production, { secretDestinations: { API_KEY: { destination } } });
  const result = projectSpecSchema.safeParse(spec);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({
    path: ['environments', 'production', 'secretDestinations', 'API_KEY'],
    message: expect.stringMatching(/credential.*native|native.*credential/i),
  })]));
});
