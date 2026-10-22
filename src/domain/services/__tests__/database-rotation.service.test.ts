import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { databaseRotationActionSchema, replaceDatabaseBindingPassword, rotationGenerationPending } from '../database-rotation.service.js';

// Orchestration invariants from the owner's request: changing a host variable
// cannot establish issuer rotation. Provider transport evidence is tested in
// the Supabase adapter suite, not inferred from these synthetic bindings.
describe('database credential rotation invariants', () => {
  it('updates every credential-bearing URL while preserving endpoint identity', () => {
    const bindings = { provider: 'supabase', password: 'old',
      connectionString: 'postgresql://postgres:old@db.example.test:5432/postgres?sslmode=require',
      pooledUrl: 'postgresql://postgres:old@db.example.test:6543/postgres?pgbouncer=true',
      providerScope: { organizationId: 'org', region: 'region' } };
    const next = replaceDatabaseBindingPassword(bindings, 'old', 'new:secret@value');
    expect(next.password).toBe('new:secret@value');
    for (const key of ['connectionString', 'pooledUrl'] as const) {
      const before = new URL(bindings[key]);
      const after = new URL(String(next[key]));
      expect(decodeURIComponent(after.password)).toBe('new:secret@value');
      expect([after.host, after.username, after.pathname, after.search]).toEqual([before.host, before.username, before.pathname, before.search]);
    }
    expect(bindings.password).toBe('old');
  });
  it('blocks an unaccounted-for password alias instead of overwriting it', () => {
    expect(() => replaceDatabaseBindingPassword({ password: 'old', connectionUrl: 'postgresql://postgres:other@db.example.test/postgres' }, 'old', 'new')).toThrow();
  });
  it('does not treat issuer acceptance as completed consumer distribution', () => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'rotation', environments: { production: {
      hosting: { provider: 'railway' }, services: {}, database: { provider: 'supabase', engine: 'postgres',
        credentialRotation: { generation: 2, consumers: 'environment-only', destinations: 'trusted' } },
    } } }).environments.production;
    expect(rotationGenerationPending(spec, { credentialRotation: { generation: 2, phase: 'issuer-verified' } })).toBe(true);
    expect(rotationGenerationPending(spec, { credentialRotation: { generation: 2, phase: 'installed' } })).toBe(false);
  });
  it('requires exact confirmable isolated action authority', () => {
    const action = { id: 'database-rotation:component:2', type: 'update', resource: { kind: 'database', name: 'postgres', provider: 'supabase' },
      verified: true, requiresConfirm: true, reason: 'Replace database login password', metadata: { operation: 'databasePasswordRotate',
        componentId: 'component', generation: 2, environmentFingerprint: 'a'.repeat(64), bindingsFingerprint: 'b'.repeat(64),
        target: { provider: 'supabase', resourceId: 'ref', providerScope: { organizationId: 'org', region: 'region' }, username: 'postgres', database: 'postgres', endpoints: [{kind: 'direct', host: 'db.ref.supabase.co', port: 5432, username:'postgres',database:'postgres',expectedRole:'postgres'}] },
        services: ['web'] } };
    expect(databaseRotationActionSchema.safeParse(action).success).toBe(true);
    expect(databaseRotationActionSchema.safeParse({ ...action, requiresConfirm: false }).success).toBe(false);
    expect(databaseRotationActionSchema.safeParse({ ...action, resource: { ...action.resource, kind: 'service' } }).success).toBe(false);
  });
});
