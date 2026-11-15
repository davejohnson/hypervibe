import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import * as awsBackend from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import * as setup from '../aws-setup.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { planInfrastructureEngine } from '../infrastructure-engine.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-aws-outside-keys-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'aws-outside-keys', defaultPlatform: 'aws' });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'aws', scope: project.name, credentialsEncrypted: getSecretStore().encryptObject({
    accessKeyId: 'test-access-key-1234', secretAccessKey: 'test-secret-key-for-aws-fixture-only',
    roleArn: 'arn:aws:iam::123456789012:role/hypervibe/hypervibe-deploy-fixture', accountId: '123456789012', region: 'us-west-2',
  }) });
  connections.updateStatus(connection.id, 'verified');
  vi.spyOn(awsBackend, 'awsEngineAuthentication').mockResolvedValue({ env: {
    AWS_ACCESS_KEY_ID: 'test-access-key', AWS_SECRET_ACCESS_KEY: 'test-secret-key', AWS_SESSION_TOKEN: 'test-session',
  }, redact: [] });
  vi.spyOn(setup, 'awsAccessCurrent').mockResolvedValue('current');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name,
    environments: { testing: { hosting: { provider: 'aws', engine: 'opentofu' }, services: { web: {} } } },
    secrets: { ACME_API_KEY: { ownership: 'delegated', principal: 'owner@example.com', environments: ['testing'] } },
  });
  return { ctx, project, spec };
}

describe('AWS outside-key collection continuation', () => {
  it('returns missing keys for shared launch collection after Parameter Store confirms absence', async () => {
    const f = fixture();
    const reads: string[] = [];
    vi.spyOn(SSMClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof GetParameterCommand)) throw new Error('Planning cannot write parameters.');
      reads.push(command.input.Name!);
      throw new ParameterNotFound({ message: 'Missing parameter', $metadata: { httpStatusCode: 400 } });
    });
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'testing' });
    expect(planned).toMatchObject({ blocked: [expect.stringContaining('ACME_API_KEY')], missingOutsideKeys: ['ACME_API_KEY'] });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^\/hypervibe\/[^/]+\/ACME_API_KEY$/);
  });

  it('does not request collection when Parameter Store could not be read', async () => {
    const f = fixture();
    vi.spyOn(SSMClient.prototype, 'send').mockRejectedValue(Object.assign(new Error('Read denied'), { name: 'AccessDeniedException' }));
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'testing' });
    expect(planned).toMatchObject({ blocked: [expect.stringContaining('could not be read')] });
    expect(planned).not.toHaveProperty('missingOutsideKeys');
  });
});
