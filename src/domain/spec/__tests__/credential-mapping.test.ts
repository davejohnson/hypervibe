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
