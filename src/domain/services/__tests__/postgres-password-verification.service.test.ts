import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyPostgresPassword } from '../postgres-password-verification.service.js';

describe('fresh PostgreSQL password evidence', () => {
  it('refuses malformed endpoints without attempting authentication or exposing passwords', async () => {
    const result = await verifyPostgresPassword({ kind: 'direct', host: '', port: 5432,
      username: 'postgres', database: 'postgres', expectedRole: 'postgres' }, 'secret-sentinel');
    expect(result).toEqual({ status: 'unknown', reason: 'invalid_target' });
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });
});

// Real local PostgreSQL authentication, not a fake Client. PostgreSQL documents
// 28P01 as invalid_password; transport failures and surviving sessions do not
// establish password revocation. https://www.postgresql.org/docs/current/errcodes-appendix.html
describe('PostgreSQL new and old password proofs (real server, TLS)', () => {
  const execute = promisify(execFile);
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let ca: string;
  let port: number;
  let admin: Client;
  let started = false;
  const endpoint = () => ({ kind: 'direct' as const, host: 'localhost', port,
    username: 'rotation_user', database: 'postgres', expectedRole: 'rotation_user' });
  beforeAll(async () => {
    env = process.env;
    try { await execute('initdb', ['--version']); } catch {
      const versions = (await readdir('/usr/lib/postgresql')).sort((a, b) => Number(b) - Number(a));
      env = { ...process.env, PATH: `${join('/usr/lib/postgresql', versions[0], 'bin')}:${process.env.PATH}` };
    }
    directory = await mkdtemp(join(tmpdir(), 'hvb-auth-'));
    const reserve = createServer();
    await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
    port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
    await execute('initdb', ['-D', join(directory, 'data'), '-U', 'rotation_admin', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale'], { env });
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.crt')]);
    await chmod(join(directory, 'server.key'), 0o600);
    ca = await readFile(join(directory, 'server.crt'), 'utf8');
    await writeFile(join(directory, 'data', 'postgresql.conf'), `listen_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = '${directory}'\nssl = on\nssl_cert_file = '${join(directory, 'server.crt')}'\nssl_key_file = '${join(directory, 'server.key')}'\n`);
    await execute('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-w', 'start'], { env });
    started = true;
    admin = new Client({ host: directory, port, user: 'rotation_admin', database: 'postgres' });
    await admin.connect();
    await admin.query("CREATE ROLE rotation_user LOGIN PASSWORD 'previous-password'");
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('verifies fresh new acceptance and old rejection without claiming established sessions are revoked', async () => {
    const oldSession = new Client({ host: 'localhost', port, user: 'rotation_user', database: 'postgres',
      password: 'previous-password', ssl: { ca, rejectUnauthorized: true } });
    await oldSession.connect();
    try {
      expect(await verifyPostgresPassword(endpoint(), 'previous-password', { ca })).toEqual({ status: 'accepted' });
      expect(await verifyPostgresPassword(endpoint(), 'replacement-password', { ca })).toEqual({ status: 'rejected', reason: 'password_rejected' });
      await admin.query("ALTER ROLE rotation_user PASSWORD 'replacement-password'");
      expect(await verifyPostgresPassword(endpoint(), 'replacement-password', { ca })).toEqual({ status: 'accepted' });
      expect(await verifyPostgresPassword(endpoint(), 'previous-password', { ca })).toEqual({ status: 'rejected', reason: 'password_rejected' });
      expect((await oldSession.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    } finally { await oldSession.end(); }
  });
  it('keeps TLS failures and wrong SQL identity unknown instead of accepting or rejecting a password', async () => {
    expect(await verifyPostgresPassword(endpoint(), 'replacement-password')).toEqual({ status: 'unknown', reason: 'authentication_unknown' });
    expect(await verifyPostgresPassword({ ...endpoint(), expectedRole: 'someone_else' }, 'replacement-password', { ca }))
      .toEqual({ status: 'unknown', reason: 'identity_mismatch' });
  });
  it('refuses inherited PostgreSQL startup options rather than changing the reviewed login', async () => {
    vi.stubEnv('PGOPTIONS', '-c search_path=unreviewed');
    try {
      expect(await verifyPostgresPassword(endpoint(), 'replacement-password', { ca }))
        .toEqual({ status: 'unknown', reason: 'invalid_target' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('does not impose session settings in the transaction-pooler startup packet', async () => {
    // Supabase's timeout contract excludes transaction-mode session settings:
    // https://supabase.com/docs/guides/database/postgres/timeouts
    // Intercept only the actual TLS transport; node-postgres serializes startup.
    const key = await readFile(join(directory, 'server.key'));
    let startup: Record<string, string> = {};
    const server = createServer(socket => {
      socket.once('data', initial => {
        expect(initial.readInt32BE(4)).toBe(80877103);
        socket.write('S');
        const secure = new TLSSocket(socket, { isServer: true, key, cert: ca });
        secure.on('error', () => {});
        secure.once('data', data => {
          const fields = data.subarray(8).toString('utf8').split('\0');
          for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i]) startup[fields[i]] = fields[i + 1];
          secure.destroy();
        });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      await verifyPostgresPassword({ ...endpoint(), kind: 'pooled', port: (server.address() as { port: number }).port }, 'candidate', { ca });
      expect(startup.user).toBe('rotation_user');
      expect(startup).not.toHaveProperty('statement_timeout');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
