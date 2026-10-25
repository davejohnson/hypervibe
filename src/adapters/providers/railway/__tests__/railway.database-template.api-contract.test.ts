import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { postgresTemplate, productionId, projectId, railwayHttpFixture, stagingId } from './railway-http.fixture.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { buildDatabaseEnvVarsFromComponent } from '../../../../domain/services/database-env.js';

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Independent evidence: recorded public postgres template and pinned official
// CLI add/deploy/workflow sources in test/provider-contracts/railway. Only HTTP
// transport is replaced. GraphQL requests/responses execute the pinned SDL;
// nested SerializedTemplateConfig semantics come from the recorded template.
describe('Railway official database template provisioning', () => {
  it('pins the independently recorded public template instead of silently refreshing opaque JSON during tests', () => {
    const source = JSON.parse(readFileSync('test/provider-contracts/railway/postgres-template.source.json', 'utf8'));
    const bytes = readFileSync('test/provider-contracts/railway/postgres-template.recorded.json');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.fixtureSha256);
    expect(source.evidenceKind).toBe('recorded-public-response');
  });
  it('uses the provider database template with its volume, icon and references instead of a generic image service', async () => {
    const fixture = await railwayHttpFixture({ renderVariableReferences: true });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt, JSON.stringify({ result, errors: fixture.contractErrors, queries: fixture.requests.map(r => r.query) })).toMatchObject({ success: true });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
    const input = fixture.mutations[0].args.input;
    expect(input).toMatchObject({ projectId, environmentId: stagingId, templateId: postgresTemplate.id });
    const expected = structuredClone(postgresTemplate.serializedConfig);
    for (const service of Object.values(expected.services) as any[]) {
      for (const variable of Object.values(service.variables) as any[]) variable.value = variable.defaultValue;
    }
    expect(input.serializedConfig).toEqual(expected);
    expect(result.component).toMatchObject({ externalId: 'staging-Postgres', bindings: {
      providerScope: { projectId, environmentId: stagingId }, pluginName: 'Postgres',
      resourceKind: 'service', volumeId: expect.any(String),
    } });
    expect(JSON.stringify(result)).not.toContain('synthetic-provider-generated-password');
    for (const service of [...fixture.services.values()].filter(service => service.id.startsWith('production-'))) {
      expect([...service.instances.keys()]).toEqual([productionId]);
    }
    expect(fixture.contractErrors).toEqual([]);
  });

  it('overwrites a stale variable value with the public default like the pinned official CLI', async () => {
    // deploy.rs reads defaultValue, then assigns value. It does not treat a
    // previous value inside public serializedConfig as a caller override.
    const altered = structuredClone(postgresTemplate);
    const service: any = Object.values(altered.serializedConfig.services)[0];
    service.variables.POSTGRES_USER.value = 'synthetic-stale-user';
    const fixture = await railwayHttpFixture({ renderVariableReferences: true,
      responseOverride: ({ query }) => query.includes('query PostgresTemplate')
        ? Response.json({ data: { template: altered } }) : undefined });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(true);
    const submitted: any = Object.values(fixture.mutations[0].args.input.serializedConfig.services)[0];
    expect(submitted.variables.POSTGRES_USER.value).toBe(service.variables.POSTGRES_USER.defaultValue);
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('does not claim completion when the template workflow completes without persistent storage', async () => {
    const fixture = await railwayHttpFixture({ templateWithoutVolume: true, renderVariableReferences: true });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('staging-Postgres');
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('retains an uncertain template creation without falling back to a generic service or claiming ownership by name', async () => {
    const fixture = await railwayHttpFixture({ dropTemplateDeployResponse: true });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings.unresolvedMutation).toMatchObject({
      resourceKind: 'database', operation: 'create', providerScope: { projectId, environmentId: stagingId },
    });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('wires application URLs as references to keys the official database actually provides, through provision and later projection', async () => {
    const fixture = await railwayHttpFixture({ renderVariableReferences: true });
    const adapter = createRailwayDatabaseAdapter({ hostingAdapter: fixture.adapter,
      envRepo: { findById: () => fixture.environment } });
    const result = await adapter.provision('postgres', fixture.environment);
    expect(result.receipt, JSON.stringify(result.receipt)).toMatchObject({ success: true });
    expect(result.envVars).toEqual({ DATABASE_URL: '${{Postgres.DATABASE_URL}}', DIRECT_URL: '${{Postgres.DATABASE_URL}}' });
    expect(buildDatabaseEnvVarsFromComponent(result.component).envVars).toEqual(result.envVars);
    expect(JSON.stringify(result)).not.toContain('synthetic-provider-generated-password');
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it.each(['extra-resource', 'copied-password', 'wrong-data-path', 'no-volume', 'second-service'])('rejects unsafe template shape %s before mutation', async (variant) => {
    const altered = structuredClone(postgresTemplate);
    const service: any = Object.values(altered.serializedConfig.services)[0];
    if (variant === 'extra-resource') altered.serializedConfig.buckets = { unexpected: {} };
    if (variant === 'copied-password') service.variables.DATABASE_URL.defaultValue = 'postgresql://${{PGUSER}}:copied-password@${{PGHOST}}:5432/${{PGDATABASE}}';
    if (variant === 'wrong-data-path') service.variables.PGDATA.defaultValue = '/ephemeral/pgdata';
    if (variant === 'no-volume') service.volumeMounts = {};
    if (variant === 'second-service') altered.serializedConfig.services.extra = structuredClone(service);
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('query PostgresTemplate')
      ? Response.json({ data: { template: altered } }) : undefined });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(fixture.mutations).toEqual([]);
  });

  it.each([
    ['TCP proxy', { tcpProxies: { '5432': {} } }],
    ['service domain', { serviceDomains: { 'postgres.up.railway.app': { port: 5432 } } }],
    ['custom domain', { customDomains: { 'postgres.example.test': { port: 5432 } } }],
    ['unreviewed networking', { syntheticUnknownNetworking: {} }],
    ['malformed networking', []],
    ['null networking', null],
  ])('rejects template %s before deployment can create public access', async (_label, networking) => {
    // The user requires no automatic public database access. The recorded
    // official PostgreSQL template has networking: {}, while the pinned CLI
    // passes this opaque JSON through unchanged (database-template-source.json).
    // Official CLI config/mod.rs:1645 and :2660-2687 at b62467ef1b5303e3e340283ed96425dcf9612993
    // independently identify nonempty tcpProxies as public database exposure:
    // https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/commands/config/mod.rs#L1645
    // The unknown/malformed cases are synthetic rejection probes, not claims
    // that Railway accepts those shapes or that all networking is public.
    const altered = structuredClone(postgresTemplate);
    const service: any = Object.values(altered.serializedConfig.services)[0];
    service.networking = networking;
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('query PostgresTemplate')
      ? Response.json({ data: { template: altered } }) : undefined });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(fixture.mutations.map(({ field }) => field)).toEqual([]);
    expect(result.receipt.success).toBe(false);
  });

  it.each([undefined, {}, { tcpProxies: {}, serviceDomains: {}, customDomains: {} }])(
    'preserves template provisioning without public endpoints (%j)', async (networking) => {
      const altered = structuredClone(postgresTemplate);
      const service: any = Object.values(altered.serializedConfig.services)[0];
      if (networking === undefined) delete service.networking;
      else service.networking = networking;
      const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('query PostgresTemplate')
        ? Response.json({ data: { template: altered } }) : undefined });
      const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
      expect(result.receipt.success).toBe(true);
      expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
    }
  );

  it.each(['Running', 'NotFound', 'Error'] as const)('retains recovery without claiming completion for workflow %s', async (status) => {
    const fixture = await railwayHttpFixture({ templateWorkflowStatus: status });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.bindings).toMatchObject({ unresolvedMutation: { operation: 'create' },
      databaseTemplate: { workflowId: 'template-workflow' } });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('preserves an acknowledged creation when a later workflow read is denied', async () => {
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('query DatabaseTemplateWorkflow')
      ? Response.json({ errors: [{ message: 'Synthetic read denied' }] }, { status: 403 }) : undefined });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.bindings.unresolvedMutation).toMatchObject({ operation: 'create' });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('uses the newly correlated provider name for references, preserving the existing production database', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    fixture = await railwayHttpFixture({ responseOverride: ({ query }) => {
      if (query.includes('query DatabaseTemplateServices') && fixture?.services.has('staging-Postgres')) {
        fixture.services.get('staging-Postgres')!.name = 'Postgres-2';
      }
      return undefined;
    } });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings.pluginName).toBe('Postgres-2');
    expect(buildDatabaseEnvVarsFromComponent(result.component).envVars.DIRECT_URL).toBe('${{Postgres-2.DATABASE_URL}}');
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it.each([
    ['opening brace', 'Postgres{'], ['closing brace', 'Postgres}'], ['dollar', 'Postgres$'],
    ['newline', 'Postgres\n2'], ['control', 'Postgres\u00002'],
  ])('retains creation without emitting references for a provider name containing %s', async (_label, name) => {
    // The pinned GraphQL name is String. These are malformed-response
    // counterexamples, not claims that Railway permits these names live.
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    fixture = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) => {
      if (query.includes('query DatabaseTemplateServices') && fixture?.services.has('staging-Postgres')) {
        fixture.services.get('staging-Postgres')!.name = name;
      }
      return undefined;
    } });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('staging-Postgres');
    expect(() => buildDatabaseEnvVarsFromComponent(result.component)).toThrow(/name|reference/i);
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('does not accept copied issuer passwords even when the rendered URL and persistent mount work', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    fixture = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) => {
      if (query.includes('query DatabaseTemplateWorkflow')) {
        const variables = fixture.variables.get('staging-Postgres/' + stagingId)!;
        variables.PGPASSWORD = variables.POSTGRES_PASSWORD;
      }
      return undefined;
    } });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('staging-Postgres');
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('does not accept database URL definitions that differ from the reviewed native template', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    fixture = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) => {
      if (query.includes('query DatabaseTemplateWorkflow')) {
        fixture.variables.get('staging-Postgres/' + stagingId)!.DATABASE_URL =
          'postgresql://postgres:${{POSTGRES_PASSWORD}}@other.railway.internal:5432/other';
      }
      return undefined;
    } });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('staging-Postgres');
    expect(result.component.bindings.volumeId).toEqual(expect.any(String));
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['templateDeployV2']);
  });

  it('blocks an invalid recorded URL source rather than silently choosing a different alias', async () => {
    const fixture = await railwayHttpFixture({ renderVariableReferences: true });
    const created = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    created.component.bindings.directUrlVariable = 'UNREVIEWED_URL_SOURCE';
    expect(() => buildDatabaseEnvVarsFromComponent(created.component)).toThrow('URL variable');
  });
});
