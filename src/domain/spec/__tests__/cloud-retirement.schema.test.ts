import { expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';
const declaration = { id: '3fcd381d-4613-4e68-a6e3-1bda2432ced1', mode: 'disconnect', connectionIds: ['ea58e605-0aa9-41ed-85ba-9244666677d6'], baseUrl: 'https://cloud.example.test' };
const spec = (retirement: unknown) => ({ version: 1, project: 'cleanup', environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, cloudRetirement: retirement } } });
it('preserves the exact durable hosted retirement declaration beside remaining app intent', () => {
  const parsed = projectSpecSchema.parse(spec(declaration));
  expect((parsed.environments.staging as any).cloudRetirement).toEqual(declaration);
});
it.each([
  { ...declaration, token: 'private-value' }, { ...declaration, baseUrl: 'http://cloud.example.test' },
  { ...declaration, baseUrl: 'https://cloud.example.test/path' }, { ...declaration, connectionIds: [] },
  { ...declaration, connectionIds: [...declaration.connectionIds, ...declaration.connectionIds] },
  { ...declaration, mode: 'delete-owned' },
])('rejects unscoped or secret-bearing retirement declarations', retirement => {
  expect(projectSpecSchema.safeParse(spec(retirement)).success).toBe(false);
});
