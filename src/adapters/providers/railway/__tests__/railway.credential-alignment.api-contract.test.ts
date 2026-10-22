import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectId, productionId, stagingId, railwayHttpFixture } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const password = 'synthetic:p@ss/%word';
const stalePassword = 'synthetic-stale-password';
const uri = (secret = password, host = 'postgres-db.railway.internal', database = 'app') =>
  `postgresql://postgres:${encodeURIComponent(secret)}@${host}:5432/${database}`;

async function setup(options: {
  databaseFirst?: boolean;
  responseOverride?: NonNullable<Parameters<typeof railwayHttpFixture>[0]>['responseOverride'];
} = {}) {
  const fixture = await railwayHttpFixture({ responseOverride: options.responseOverride });
  const addDatabase = () => {
    const database = fixture.addService('staging-db', 'postgres-db', stagingId);
    database.instances.get(stagingId)!.source = { image: 'postgres:16' };
  };
  if (options.databaseFirst) addDatabase();
  fixture.addService('staging-web', 'web', stagingId);
  if (!options.databaseFirst) addDatabase();
  fixture.environment.platformBindings.services = { web: { serviceId: 'staging-web' } };
  fixture.variables.set(`staging-db/${stagingId}`, {
    POSTGRES_PASSWORD: password, DATABASE_URL: uri(), DATABASE_PRIVATE_URL: uri(),
  });
  fixture.variables.set(`staging-web/${stagingId}`, { DATABASE_URL: uri() });
  return fixture;
}

async function inspect(fixture: Awaited<ReturnType<typeof setup>>) {
  const observed = await fixture.adapter.observe(fixture.environment);
  const alignment = observed.databases[0]?.credentialAlignment;
  expect(fixture.contractErrors).toEqual([]);
  expect(fixture.mutations).toEqual([]);
  const output = JSON.stringify(observed);
  for (const secret of [password, stalePassword, uri(), uri(stalePassword), encodeURIComponent(password)]) {
    expect(output).not.toContain(secret);
  }
  expect(alignment).toBeDefined();
  expect(JSON.stringify(alignment)).not.toContain(createHash('sha256').update(uri()).digest('hex'));
  return { observed, alignment: alignment! };
}

// The real graphql-request client executes against the pinned official SDL.
// EnvironmentVariables is opaque: credential values below are synthetic
// counterexamples, not recorded Railway responses or proof of SQL authentication.
describe('Railway configured database credential alignment', () => {
  it('distinguishes stale issuer URLs from consumers that match those stale URLs', async () => {
    const fixture = await setup();
    fixture.variables.set(`staging-db/${stagingId}`, {
      POSTGRES_PASSWORD: password, DATABASE_URL: uri(stalePassword), DATABASE_PRIVATE_URL: uri(),
    });
    fixture.variables.set(`staging-web/${stagingId}`, { DATABASE_URL: uri(stalePassword) });
    const { alignment } = await inspect(fixture);
    expect(alignment).toEqual({
      basis: 'configured-variable-values', authentication: 'unverified',
      issuer: { comparisons: [
        { source: 'DATABASE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'mismatch' } },
        { source: 'DATABASE_PRIVATE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'match' } },
      ] },
      consumers: [{ name: 'web', externalId: 'staging-web', source: 'DATABASE_URL', issuerSource: 'DATABASE_URL',
        credentialComparison: { result: 'match' }, target: { result: 'match' } }],
    });
    const reads = fixture.requests.filter(request => request.query.includes('query GetVariables'));
    expect(reads.map(request => request.variables)).toEqual([
      { projectId, serviceId: 'staging-web', environmentId: stagingId },
      { projectId, serviceId: 'staging-db', environmentId: stagingId },
    ]);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.requests.some(request => request.variables.environmentId === productionId)).toBe(false);
  });

  it.each([false, true])('finds stale app credentials regardless of database-first order (%s)', async databaseFirst => {
    const fixture = await setup({ databaseFirst });
    fixture.variables.set(`staging-web/${stagingId}`, { DATABASE_URL: uri(stalePassword) });
    const { alignment } = await inspect(fixture);
    expect(alignment.issuer.comparisons[0]).toEqual({ source: 'DATABASE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'match' } });
    expect(alignment.consumers[0]).toMatchObject({
      credentialComparison: { result: 'mismatch' }, target: { result: 'match' },
    });
    expect(fixture.requests.filter(request => request.query.includes('query GetVariables'))).toHaveLength(2);
  });

  it('decodes credentials and compares endpoint/database separately', async () => {
    const fixture = await setup();
    fixture.variables.set(`staging-web/${stagingId}`, {
      DATABASE_URL: `postgres://%70ostgres:${encodeURIComponent(password)}@postgres-db.railway.internal/app`,
    });
    let result = await inspect(fixture);
    expect(result.alignment.consumers[0]).toMatchObject({ credentialComparison: { result: 'match' }, target: { result: 'match' } });
    fixture.variables.set(`staging-web/${stagingId}`, { DATABASE_URL: uri(password, 'other.railway.internal', 'other') });
    result = await inspect(fixture);
    expect(result.alignment.consumers[0]).toMatchObject({ credentialComparison: { result: 'match' }, target: { result: 'mismatch' } });
  });

  it.each([
    [undefined, 'missing'],
    ['${{postgres-db.DATABASE_URL}}', 'unresolved_reference'],
    ['not-a-database-url', 'malformed'],
    ['postgresql://postgres:%xx@postgres-db.railway.internal/app', 'malformed'],
    [uri() + '?sslmode=require', 'unsupported_url_options'],
    [uri() + '?password=other', 'unsupported_url_options'],
    [uri() + '?host=other', 'unsupported_url_options'],
  ])('preserves unknown for unusable consumer values (%s)', async (value, reason) => {
    const fixture = await setup();
    fixture.variables.set(`staging-web/${stagingId}`, value === undefined ? {} : { DATABASE_URL: value });
    const { alignment } = await inspect(fixture);
    expect(alignment.consumers[0]).toMatchObject({
      credentialComparison: { result: 'unknown', reason }, target: { result: 'unknown', reason },
    });
  });

  it('preserves unknown for missing and unresolved issuer inputs', async () => {
    const fixture = await setup();
    fixture.variables.set(`staging-db/${stagingId}`, {
      POSTGRES_PASSWORD: '${{shared.POSTGRES_PASSWORD}}', DATABASE_URL: uri(),
      DATABASE_PRIVATE_URL: '${{postgres-db.DATABASE_URL}}',
    });
    let result = await inspect(fixture);
    expect(result.alignment.issuer.comparisons).toEqual([
      { source: 'DATABASE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'unknown', reason: 'unresolved_reference' } },
      { source: 'DATABASE_PRIVATE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'unknown', reason: 'unresolved_reference' } },
    ]);
    fixture.variables.set(`staging-db/${stagingId}`, {});
    result = await inspect(fixture);
    expect(result.alignment.issuer.comparisons[0].comparison).toEqual({ result: 'unknown', reason: 'missing' });
    expect(result.alignment.consumers[0].credentialComparison).toEqual({ result: 'unknown', reason: 'missing' });
  });

  it.each(['staging-db', 'staging-web'])('keeps denied %s reads unknown without echoing provider errors', async serviceId => {
    const fixture = await setup({ responseOverride: request => {
      if (request.query.includes('query GetVariables') && request.variables.serviceId === serviceId) {
        return Response.json({ errors: [{ message: `Denied ${uri()} ${password}` }] }, { status: 403 });
      }
      return undefined;
    } });
    const { alignment } = await inspect(fixture);
    if (serviceId === 'staging-db') {
      expect(alignment.issuer.comparisons[0].comparison).toEqual({ result: 'unknown', reason: 'read_failed' });
    }
    expect(alignment.consumers[0].credentialComparison).toEqual({ result: 'unknown', reason: 'read_failed' });
  });

  it('includes only exactly bound consumers and does not invent alignment across stale environment bindings', async () => {
    const fixture = await setup();
    fixture.addService('staging-unbound', 'other-web', stagingId);
    fixture.variables.set(`staging-unbound/${stagingId}`, { DATABASE_URL: uri() });
    let result = await inspect(fixture);
    expect(result.alignment.consumers.map((consumer: { externalId: string }) => consumer.externalId)).toEqual(['staging-web']);
    fixture.requests.length = 0;
    fixture.environment.platformBindings.environmentId = 'stale-environment';
    result = await inspect(fixture);
    expect(result.alignment.issuer.comparisons[0].comparison).toEqual({ result: 'unknown', reason: 'scope_unverified' });
    expect(fixture.requests.some(request => request.query.includes('query GetVariables')
      && request.variables.serviceId === 'staging-db')).toBe(false);
  });

  it('reuses each bound consumer read and distinguishes username drift', async () => {
    const fixture = await setup();
    fixture.addService('staging-worker', 'worker', stagingId);
    fixture.environment.platformBindings.services = {
      web: { serviceId: 'staging-web' }, worker: { serviceId: 'staging-worker' },
    };
    fixture.variables.set(`staging-worker/${stagingId}`, { DATABASE_URL: uri().replace('//postgres:', '//other:') });
    const { alignment } = await inspect(fixture);
    expect(alignment.consumers).toHaveLength(2);
    expect(alignment.consumers[1]).toMatchObject({
      name: 'worker', credentialComparison: { result: 'mismatch' }, target: { result: 'match' },
    });
    expect(fixture.requests.filter(request => request.query.includes('query GetVariables'))
      .map(request => request.variables.serviceId).sort()).toEqual(['staging-db', 'staging-web', 'staging-worker']);
    expect(fixture.requests).toHaveLength(6);
  });
});
