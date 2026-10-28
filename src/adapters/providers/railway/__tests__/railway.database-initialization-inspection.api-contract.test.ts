import { createHash } from 'node:crypto';
import { executeSync, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { railwayHttpFixture, schema, projectId, productionId, stagingId } from './railway-http.fixture.js';

const image = `ghcr.io/example/application@sha256:${'a'.repeat(64)}`;
const password = 'synthetic-private-password';
const databaseUrl = `postgresql://postgres:${password}@database.railway.internal:5432/app`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function setup(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const hiddenVariableKeys: string[] = [];
  let variableState = new Map<string, Record<string, string>>();
  const f = await railwayHttpFixture({ renderVariableReferences: true, ...options,
    responseOverride: request => {
      const override = options.responseOverride?.(request);
      if (override) return override;
      if (!request.query.includes('DatabaseInitializationVariableKeys')) return undefined;
      const document = parse(request.query);
      expect(validate(schema, document).map(error => error.message)).toEqual([]);
      // Metadata can reveal keys whose sealed values are unavailable. It is
      // deliberately held independently of the value maps used by the client.
      const nodes = [...variableState.entries()].filter(([scope]) => scope.endsWith(`/${stagingId}`))
        .flatMap(([scope, values]) => Object.keys(values).map(name => ({
          id: `${scope}-${name}`, name, serviceId: scope.split('/')[0],
        })));
      nodes.push(...hiddenVariableKeys.map(name => ({ id: `hidden-${name}`, name, serviceId: 'web-id' })));
      const start = request.variables.after ? Number(request.variables.after) : 0;
      const end = start + (options.pageSize ?? 100);
      return Response.json(executeSync({ schema, document, variableValues: request.variables,
        rootValue: { environment: () => ({ id: stagingId, projectId,
          variables: () => ({ edges: nodes.slice(start, end).map(node => ({ node })),
            pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } }),
        }) },
      }));
    },
  });
  variableState = f.variables;
  const db = f.addService('database-id', 'database', stagingId);
  db.instances.get(stagingId)!.activeDeployments = [{ id: 'initialized-db-deployment' }];
  db.instances.get(stagingId)!.latestDeployment = { id: 'initialized-db-deployment', status: 'SUCCESS' };
  f.deployments.set('initialized-db-deployment', { id: 'initialized-db-deployment', projectId,
    environmentId: stagingId, serviceId: 'database-id', snapshotId: 'db-snapshot', status: 'SUCCESS',
    deploymentStopped: false });
  const app = f.addService('web-id', 'application', stagingId);
  app.instances.get(stagingId)!.source = { image };
  app.instances.get(stagingId)!.latestDeployment = { id: 'failed-app-deployment', status: 'FAILED' };
  Object.assign(f.environment.platformBindings, { provider: 'railway', services: { web: { serviceId: 'web-id' } } });
  const volume = f.addVolume('database-id', stagingId, '/var/lib/postgresql/data');
  f.variables.set(`database-id/${stagingId}`, {
    POSTGRES_PASSWORD: password, POSTGRES_USER: 'postgres', POSTGRES_DB: 'app',
    PGUSER: '${{POSTGRES_USER}}', PGDATABASE: '${{POSTGRES_DB}}', PGPASSWORD: '${{POSTGRES_PASSWORD}}',
    PGHOST: '${{RAILWAY_PRIVATE_DOMAIN}}', PGPORT: '5432', RAILWAY_PRIVATE_DOMAIN: 'database.railway.internal',
    DATABASE_URL: 'postgresql://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST}}:${{PGPORT}}/${{PGDATABASE}}',
    DIRECT_URL: '${{DATABASE_URL}}',
  });
  f.variables.set(`web-id/${stagingId}`, {
    DATABASE_URL: '${{database.DATABASE_URL}}', DIRECT_URL: '${{database.DIRECT_URL}}',
    POSTGRES_DB_URL: '${{database.DATABASE_URL}}', NODE_ENV: 'production',
    unrelatedMailSecret: 'must-not-be-copied',
  });
  const source = { provider: 'railway', primaryExternalId: 'database-id',
    providerScope: { projectId, environmentId: stagingId },
    resourceIdentity: { volumeId: volume.id, volumeInstanceId: String(volume.instance.id) } };
  const input = { environment: f.environment,
    completedInitialization: { target: { provider: 'railway', externalId: 'database-id', providerScope: source.providerScope },
      storageId: volume.id, storageInstanceId: String(volume.instance.id), deploymentId: 'initialized-db-deployment' },
    sourceServiceName: 'web', expectedImage: image,
    databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' }, approvedVariables: { NODE_ENV: 'production' } };
  const inspect = async (override = {}) => {
    const port = (f.adapter as unknown as { databaseInitialization?: { inspect(value: unknown): Promise<any> } }).databaseInitialization;
    if (!port) throw new Error('Database initialization inspection is unsupported.');
    return port.inspect({ ...input, ...override });
  };
  return { ...f, input, source, inspect, app, db, volume, hiddenVariableKeys };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// The real graphql-request client is executed against the pinned official SDL.
// Variable maps are opaque scalars: the existing fixture independently models
// documented native references from synthetic state, not our submitted request.
// A configured immutable app image can exist alongside a failed app deployment.
// No provider mutation, SQL authentication or successful app release is claimed.
describe('Railway private bootstrap inspection', () => {
  it('binds exact native references and fresh generation while leaving SQL and app deployment unchecked', async () => {
    const f = await setup({ pageSize: 1 });
    const result = await f.inspect();
    expect(result).toMatchObject({ source: f.source, image, sourceServiceId: 'web-id',
      sourceInstanceId: `instance-web-id-${stagingId}`, databaseDeploymentId: 'initialized-db-deployment',
      approvedVariables: { NODE_ENV: 'production' },
      variableReferences: [
        { sourceServiceId: 'database-id', variableName: 'DATABASE_URL', targetName: 'DATABASE_URL' },
        { sourceServiceId: 'database-id', variableName: 'DIRECT_URL', targetName: 'DIRECT_URL' },
        { sourceServiceId: 'database-id', variableName: 'DATABASE_URL', targetName: 'POSTGRES_DB_URL' },
      ],
      verification: { rawReferences: 'verified', configuredValues: 'matched', sqlAuthentication: 'unchecked',
        deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' },
      privateConfiguration: { keys: ['DATABASE_URL', 'DIRECT_URL', 'POSTGRES_DB_URL'],
        expectedHashes: { DATABASE_URL: digest(databaseUrl), DIRECT_URL: digest(databaseUrl), POSTGRES_DB_URL: digest(databaseUrl) },
        authentication: { username: 'postgres', database: 'app' } },
    });
    const { privateConfiguration: _private, ...publicReview } = result;
    for (const secret of [password, databaseUrl, digest(databaseUrl), 'must-not-be-copied']) {
      expect(JSON.stringify(publicReview)).not.toContain(secret);
    }
    expect(JSON.stringify(result)).not.toContain('must-not-be-copied');
    expect(f.mutations).toEqual([]);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['DATABASE_URL', 'POSTGRES_DB_URL'])('rejects a copied %s even when all configured values match', async key => {
    const f = await setup();
    f.variables.get(`web-id/${stagingId}`)![key] = databaseUrl;
    await expect(f.inspect()).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it.each(['PGHOST', 'PGPASSWORD', 'PGSSLMODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED'])
    ('rejects present application override %s before stripping it', async key => {
      const f = await setup();
      f.variables.get(`web-id/${stagingId}`)![key] = '';
      await expect(f.inspect()).rejects.toThrow();
      expect(f.mutations).toEqual([]);
    });

  it('does not infer absent connection overrides from omitted sealed values', async () => {
    const f = await setup();
    f.hiddenVariableKeys.push('NODE_OPTIONS');
    await expect(f.inspect()).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('rejects changed image, scope, volume and volume-instance before planning a task', async () => {
    const f = await setup();
    for (const override of [
      { expectedImage: image.replace('a'.repeat(64), 'b'.repeat(64)) },
      { completedInitialization: { ...f.input.completedInitialization,
        target: { ...f.input.completedInitialization.target, providerScope: { projectId, environmentId: productionId } } } },
      { completedInitialization: { ...f.input.completedInitialization, storageId: 'other-volume' } },
      { completedInitialization: { ...f.input.completedInitialization, storageInstanceId: 'old-generation' } },
    ]) await expect(f.inspect(override)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('requires the acknowledged initialization deployment to remain the sole active database deployment', async () => {
    const f = await setup();
    // Latest SUCCESS does not establish current activation or drainage.
    f.db.instances.get(stagingId)!.activeDeployments = [{ id: 'stale-db-deployment' }];
    await expect(f.inspect()).rejects.toThrow();
    f.db.instances.get(stagingId)!.activeDeployments = [{ id: 'initialized-db-deployment' }, { id: 'stale-db-deployment' }];
    await expect(f.inspect()).rejects.toThrow();
    f.db.instances.get(stagingId)!.activeDeployments = [{ id: 'initialized-db-deployment' }];
    f.deployments.get('initialized-db-deployment')!.deploymentStopped = true;
    await expect(f.inspect()).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('rejects unresolved, malformed, public or conflicting intended connection configuration', async () => {
    const f = await setup();
    const values = f.variables.get(`database-id/${stagingId}`)!;
    for (const value of ['${{MISSING_URL}}', 'not-a-postgres-url', databaseUrl.replace('database.railway.internal', 'public.example'),
      databaseUrl + '?user=other-user', databaseUrl + '?sslmode=require&sslmode=disable']) {
      values.DATABASE_URL = value;
      await expect(f.inspect()).rejects.toThrow();
    }
    values.DATABASE_URL = databaseUrl;
    values.DIRECT_URL = databaseUrl.replace('/app', '/other_database');
    await expect(f.inspect()).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('requires declared aliases to preserve their exact canonical reference and selected NODE_ENV', async () => {
    const f = await setup();
    const app = f.variables.get(`web-id/${stagingId}`)!;
    // Resolved values match, but the declared upstream dependency differs.
    app.POSTGRES_DB_URL = '${{database.DIRECT_URL}}';
    await expect(f.inspect()).rejects.toThrow();
    app.POSTGRES_DB_URL = '${{database.DATABASE_URL}}';
    app.NODE_ENV = 'development';
    await expect(f.inspect()).rejects.toThrow();
    await expect(f.inspect({ approvedVariables: { UNRELATED_MAIL_SECRET: 'must-not-be-copied' } })).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('retains transitive issuer reference definitions even when their configured URL remains unchanged', async () => {
    const f = await setup();
    const issuer = f.variables.get(`database-id/${stagingId}`)!;
    issuer.CUSTOM_DB_PASSWORD = '${{POSTGRES_PASSWORD}}';
    issuer.DATABASE_URL = issuer.DATABASE_URL!.replace('${{PGPASSWORD}}', '${{CUSTOM_DB_PASSWORD}}');
    const before = await f.inspect();
    expect(before.privateConfiguration.issuerDefinitions.CUSTOM_DB_PASSWORD).toBe('${{POSTGRES_PASSWORD}}');
    issuer.CUSTOM_DB_PASSWORD = '${{PGPASSWORD}}';
    const after = await f.inspect();
    expect(after.privateConfiguration.expectedHashes).toEqual(before.privateConfiguration.expectedHashes);
    expect(after.privateConfiguration.issuerDefinitions).not.toEqual(before.privateConfiguration.issuerDefinitions);
    expect(f.mutations).toEqual([]);
  });

  it('keeps provider errors value-free and makes no mutation on unknown reads', async () => {
    const f = await setup({ responseOverride: request => request.query.includes('DatabaseInitializationVariables')
      ? Response.json({ errors: [{ message: databaseUrl }] }, { status: 500 }) : undefined });
    const message = await f.inspect().then(() => 'unexpected-success', error => String(error));
    expect(message).not.toBe('unexpected-success');
    expect(message).not.toContain(databaseUrl);
    expect(message).not.toContain(password);
    expect(f.mutations).toEqual([]);
  });
});
