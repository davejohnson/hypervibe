import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DATABASE_INITIALIZATION_AUTH_COMMAND_HASH, DATABASE_INITIALIZATION_CONFIG_VARIABLE,
  DATABASE_INITIALIZATION_RECEIPT_PREFIX, buildDatabaseInitializationCommand,
  parseDatabaseInitializationReceipt, parseDatabaseInitializationRequest,
  type DatabaseInitializationRequest,
} from '../database-initialization-program.js';

const execute = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const request = (): DatabaseInitializationRequest => ({ version: 1, executionId: 'initialization-contract-1',
  mode: 'authenticate', commandHash: DATABASE_INITIALIZATION_AUTH_COMMAND_HASH,
  keys: ['DATABASE_URL', 'POSTGRES_DB_URL'], expectedHashes: { DATABASE_URL: hash('private-url'), POSTGRES_DB_URL: hash('private-url') },
  authentication: { username: 'private-login', database: 'private-database' } });
const receipt = () => ({ version: 1, executionId: request().executionId, mode: 'authenticate',
  commandHash: request().commandHash, authentication: 'authenticated', migration: 'unchecked' });
const line = (value: unknown) => `${DATABASE_INITIALIZATION_RECEIPT_PREFIX}${JSON.stringify(value)}`;

describe('private initialization program contract', () => {
  it('accepts only the finite request, complete aliases and exact migration command authority', () => {
    const selected = request();
    expect(parseDatabaseInitializationRequest(selected)).toEqual(selected);
    expect(parseDatabaseInitializationRequest({ ...selected, expectedHashes: { DATABASE_URL: hash('private-url') } })).toBeNull();
    expect(parseDatabaseInitializationRequest({ ...selected, keys: ['POSTGRES_DB_URL'] })).toBeNull();
    expect(parseDatabaseInitializationRequest({ ...selected, keys: ['DATABASE_URL', 'DATABASE_URL'] })).toBeNull();
    for (const key of ['PGHOST', 'NODE_OPTIONS', 'NODE_ENV', 'HYPERVIBE_DATABASE_TASK_CONFIG', 'RAILWAY_SERVICE_ID']) {
      expect(parseDatabaseInitializationRequest({ ...selected, keys: ['DATABASE_URL', key],
        expectedHashes: { DATABASE_URL: hash('private-url'), [key]: hash('private-url') } })).toBeNull();
    }
    expect(parseDatabaseInitializationRequest({ ...selected, sql: 'DELETE FROM customer' })).toBeNull();
    expect(parseDatabaseInitializationRequest({ ...selected, authentication: { ...selected.authentication, password: 'never-accepted' } })).toBeNull();
    const migration = { command: 'npm run db:migrate', timeoutMs: 1_000 };
    expect(parseDatabaseInitializationRequest({ ...selected, mode: 'migrate', migration, commandHash: hash(migration.command) }))
      .toMatchObject({ mode: 'migrate', migration });
    expect(parseDatabaseInitializationRequest({ ...selected, mode: 'migrate', migration })).toBeNull();
    expect(parseDatabaseInitializationRequest({ ...selected, migration })).toBeNull();
  });

  it('requires one exact standalone correlated finite receipt, with consistent outcomes', () => {
    expect(parseDatabaseInitializationReceipt(line(receipt()), request())).toEqual(receipt());
    for (const output of [
      line({ ...receipt(), executionId: 'other-task' }), line({ ...receipt(), commandHash: hash('other-command') }),
      line({ ...receipt(), mode: 'migrate' }), line({ ...receipt(), password: 'secret-echo' }),
      line({ ...receipt(), migration: 'completed' }), line({ ...receipt(), exitCode: 0 }),
      line({ ...receipt(), authentication: 'trust' }), `${line(receipt())}\n${line(receipt())}`,
      `prefix ${line(receipt())}`, ` ${line(receipt())}`, `${line(receipt())} `, `${line(receipt())} trailing`,
      `${DATABASE_INITIALIZATION_RECEIPT_PREFIX}{\n"version":1\n}`,
    ]) expect(parseDatabaseInitializationReceipt(output, request())).toBeNull();
  });

  it('keeps private configuration out of the fixed start command and refuses Node injection before startup', async () => {
    const command = buildDatabaseInitializationCommand();
    for (const value of [request().authentication.username, request().authentication.database,
      ...Object.values(request().expectedHashes), 'private-url']) expect(command).not.toContain(value);
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      const result = await execute('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH,
        [DATABASE_INITIALIZATION_CONFIG_VARIABLE]: JSON.stringify(request()), [key]: 'private-invalid-override' } })
        .then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    }
  });

  it('executes the emitted private-config reader and returns only a correlated unknown for an invalid URL', async () => {
    const selected = request();
    const result = await execute('/bin/sh', ['-c', buildDatabaseInitializationCommand()], { env: { PATH: process.env.PATH,
      DATABASE_URL: 'private-url', POSTGRES_DB_URL: 'private-url', [DATABASE_INITIALIZATION_CONFIG_VARIABLE]: JSON.stringify(selected) } })
      .then(value => ({ ...value, code: 0 }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }));
    expect(result.code).not.toBe(0); expect(result.stderr).toBe('');
    expect(parseDatabaseInitializationReceipt(result.stdout.trimEnd(), selected)).toMatchObject({ authentication: 'unknown', migration: 'unchecked' });
    for (const secret of ['private-url', 'private-login', 'private-database', ...Object.values(selected.expectedHashes)]) expect(result.stdout).not.toContain(secret);
  });
});
