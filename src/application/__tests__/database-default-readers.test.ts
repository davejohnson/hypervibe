import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Keep this public boundary free of provider bootstrap: hosted inspection must
// interpret a committed spec even when the consumer never creates an adapter.
import { inspectCommittedProjectSpecV1 } from '../../hosted.js';
import { readRepoSpecFile } from '../../domain/spec/repo-spec-file.js';
import { environmentSpecSchema, projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { environmentDeploymentContractHash, environmentDeploymentContractHashForApply } from '../../domain/services/deployment-contract.service.js';

function document(host: string, database: Record<string, unknown> = {}) {
  return { version: 1, project: 'defaults', gitRemoteUrl: 'https://github.com/acme/defaults',
    environments: { production: { hosting: { provider: host }, services: { web: {} }, database } } };
}

function inspect(raw: string) {
  const content = new TextEncoder().encode(raw);
  return inspectCommittedProjectSpecV1({ schemaVersion: 1, provider: 'github',
    repository: { id: '123456', path: 'acme/defaults', remoteIdentity: 'github.com/acme/defaults' },
    revision: 'a'.repeat(40), content, contentSha256: createHash('sha256').update(content).digest('hex') });
}

describe('database defaults at committed and local spec boundaries', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([
    ['railway', 'railway'], ['cloudrun', 'cloudsql'], ['ecs', 'rds'], ['azure-container-apps', 'azure-postgres'],
  ])('interprets the same %s database declaration in every parser', (host, expected) => {
    const raw = JSON.stringify(document(host));
    root = mkdtempSync(join(tmpdir(), 'hv-database-default-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '.hypervibe'));
    const specPath = join(root, '.hypervibe/spec.json');
    writeFileSync(specPath, raw);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const receipt = inspect(raw);
    expect(receipt.environments[0].declaredProviders).toContainEqual({ capability: 'database', provider: expected });
    const local = readRepoSpecFile(root)!;
    const parsed = projectSpecSchema.parse(JSON.parse(raw));
    expect(local.spec).toEqual(parsed);
    expect(environmentSpecSchema.parse(JSON.parse(raw).environments.production)).toEqual(parsed.environments.production);
    expect(parsed.environments.production.database?.provider).toBe(expected);
    // Parsing defaults must not rewrite committed bytes or alter CI's raw hash.
    expect(local.document).toEqual(JSON.parse(raw));
    expect(readFileSync(specPath, 'utf8')).toBe(raw);
    expect(environmentDeploymentContractHashForApply(parsed, 'production'))
      .toBe(environmentDeploymentContractHash(JSON.parse(raw), 'production'));
  });

  it('preserves an explicitly selected database and its settings', () => {
    const input = document('cloudrun', { provider: 'railway', engine: 'postgres' });
    expect(projectSpecSchema.parse(input).environments.production.database).toMatchObject(input.environments.production.database!);
    expect(inspect(JSON.stringify(input)).environments[0].declaredProviders)
      .toContainEqual({ capability: 'database', provider: 'railway' });
  });

  it('leaves an environment without a database declaration alone', () => {
    const input = document('railway');
    delete (input.environments.production as { database?: unknown }).database;
    expect(projectSpecSchema.parse(input).environments.production.database).toBeUndefined();
    expect(inspect(JSON.stringify(input)).environments[0].features).not.toContain('database');
  });

  it.each([
    ['unknown-host', undefined], ['railway', null], ['cloudrun', ''], ['ecs', 1],
  ])('rejects unresolved or invalid %s database provider %s', (host, provider) => {
    const input = document(host as string, { provider });
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });
});
