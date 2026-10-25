import { Duplex } from 'node:stream';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { createPostgresCredentialLifecycle } from '../database-credential.js';
import type { IDatabaseAdapter } from '../../../../domain/ports/database.port.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

// A synthetic PostgreSQL v3 wire peer, following the official message formats:
// https://www.postgresql.org/docs/17/protocol-message-formats.html
// The real pg client serializes startup/password, extended bind parameters and
// SQL, and parses authentication failures and lost transaction acknowledgments.
// This validates transport behavior; it does not pretend to execute a PG server.
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstring = (s: string) => Buffer.from(`${s}\0`);
const packet = (code: string, ...body: Buffer[]) => { const b = Buffer.concat(body); return Buffer.concat([Buffer.from(code), i32(b.length + 4), b]); };
type ServerState = { password: string; changes: number; sql: string[]; bindings: string[]; loseCommit: boolean };
class PgPeer extends Duplex {
  private startup = true;
  private pending = Buffer.alloc(0);
  private password?: string;
  private altered = false;
  constructor(private readonly state: ServerState) { super(); }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  connect() { queueMicrotask(() => this.emit('connect')); return this; }
  _read() {}
  private response(...messages: Buffer[]) { queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.concat(messages)); }); }
  private ready() { return packet('Z', Buffer.from('I')); }
  private complete(command: string) { return packet('C', cstring(command)); }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    this.pending = Buffer.concat([this.pending, chunk]);
    try {
      while (this.pending.length >= (this.startup ? 4 : 5)) {
        const length = this.pending.readInt32BE(this.startup ? 0 : 1);
        const total = length + (this.startup ? 0 : 1);
        if (this.pending.length < total) break;
        const message = this.pending.subarray(0, total); this.pending = this.pending.subarray(total);
        if (this.startup) { this.startup = false; this.response(packet('R', i32(3))); continue; }
        this.message(message.toString('utf8', 0, 1), message.subarray(5));
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  private message(code: string, body: Buffer) {
    if (code === 'p') {
      if (body.toString('utf8').replace(/\0$/, '') !== this.state.password) {
        this.response(packet('E', cstring('SFATAL'), cstring('C28P01'), cstring('Minvalid password'), Buffer.from([0])));
      } else this.response(packet('R', i32(0)), packet('K', i32(123), i32(456)), this.ready());
    } else if (code === 'Q') {
      const sql = body.toString('utf8').replace(/\0$/, ''); this.state.sql.push(sql);
      if (sql.startsWith('SELECT session_user')) {
        const column = (name: string) => Buffer.concat([cstring(name), i32(0), i16(0), i32(25), i16(-1), i32(-1), i16(0)]);
        this.response(packet('T', i16(2), column('username'), column('database')), packet('D', i16(2), i32(3), Buffer.from('app'), i32(5), Buffer.from('appdb')), this.complete('SELECT 1'), this.ready());
      } else if (sql.startsWith('DO ')) {
        if (!sql.includes('ALTER ROLE %I PASSWORD %L') || !this.password) throw new Error('Unexpected password statement');
        this.altered = true; this.response(this.complete('DO'), this.ready());
      } else if (sql === 'COMMIT') {
        if (this.altered) { this.state.password = this.password!; this.state.changes++; }
        if (this.state.loseCommit) this.destroy();
        else this.response(this.complete('COMMIT'), this.ready());
      } else this.response(this.complete(sql), this.ready());
    } else if (code === 'P') {
      const start = body.indexOf(0) + 1; const end = body.indexOf(0, start);
      this.state.sql.push(body.toString('utf8', start, end)); this.response(packet('1'));
    } else if (code === 'B') {
      let offset = body.indexOf(0) + 1; offset = body.indexOf(0, offset) + 1;
      const formats = body.readInt16BE(offset); offset += 2 + formats * 2;
      const count = body.readInt16BE(offset); offset += 2;
      if (count !== 1) throw new Error('Expected exactly one bound password');
      const length = body.readInt32BE(offset); offset += 4;
      this.password = body.toString('utf8', offset, offset + length); this.state.bindings.push(this.password);
      this.response(packet('2'));
    } else if (code === 'D') this.response(packet('n'));
    else if (code === 'E') this.response(this.complete('SELECT 1'));
    else if (code === 'S') this.response(this.ready());
    else if (code === 'X') this.destroy();
    else if (code !== 'H') throw new Error('Unexpected PostgreSQL frontend message');
  }
}

afterEach(() => vi.restoreAllMocks());
function setup(loseCommit = false) {
  const state: ServerState = { password: 'previous-password', changes: 0, sql: [], bindings: [], loseCommit };
  const RealClient = pg.Client;
  vi.spyOn(pg, 'Client').mockImplementation(function (config: any) { return new RealClient({ ...config, stream: () => new PgPeer(state) }); } as any);
  const environment = { id: 'local-env', name: 'production', projectId: 'local-project', platformBindings: {} } as Environment;
  const component: Component = { id: 'component', environmentId: environment.id, externalId: 'native-db', type: 'postgres', createdAt: new Date(), updatedAt: new Date(),
    bindings: { provider: 'postgres-wire', providerScope: { account: 'account' }, username: 'app', database: 'appdb', connectionString: 'postgresql://app:previous-password@db.example/appdb' } };
  const adapter = { name: 'postgres-wire', capabilities: { supportedDatabases: ['postgres'] },
    observeDatabase: async () => ({ provider: 'postgres-wire', externalId: 'native-db', engine: 'postgres', status: 'running' }),
    getConnectionUrl: async () => component.bindings.connectionString,
  } as unknown as IDatabaseAdapter;
  return { state, environment, component, port: createPostgresCredentialLifecycle(() => adapter) };
}

it('serializes the actual password change and independently authenticates a fresh connection', async () => {
  const f = setup();
  const target = await f.port.inspect(f.environment, f.component, { environment: 'production', component: 'component', username: 'app', database: 'appdb' });
  const replacement = "frozen ' @ / password";
  expect(await f.port.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'rejected' });
  expect(await f.port.rotate(f.environment, f.component, target, replacement)).toEqual({ state: 'acknowledged' });
  expect(f.state.password).toBe(replacement); expect(f.state.changes).toBe(1);
  expect(f.state.sql.join('\n')).not.toContain(replacement); expect(f.state.bindings).toEqual([replacement]);
  expect(await f.port.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'authenticated' });
  expect(await f.port.probe(f.environment, f.component, target, 'previous-password')).toMatchObject({ state: 'rejected' });
});

it('reports a lost COMMIT as unknown and recovers through fresh authentication without resetting again', async () => {
  const f = setup(true);
  const target = await f.port.inspect(f.environment, f.component, { environment: 'production', component: 'component', username: 'app', database: 'appdb' });
  expect(await f.port.rotate(f.environment, f.component, target, 'frozen-next')).toEqual({ state: 'unknown' });
  expect(await f.port.probe(f.environment, f.component, target, 'frozen-next')).toMatchObject({ state: 'authenticated' });
  expect(f.state.changes).toBe(1);
});
