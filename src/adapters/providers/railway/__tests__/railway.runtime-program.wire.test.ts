import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { RAILWAY_RUNTIME_PROGRAM } from '../railway-runtime-evidence.js';

// Synthetic PostgreSQL v3 peer; real application pg client in the exact emitted
// Node program. Official message formats and AuthenticationOk semantics:
// https://www.postgresql.org/docs/17/protocol-message-formats.html
// Trust must not establish password proof: https://www.postgresql.org/docs/17/auth-trust.html
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstring = (value: string) => Buffer.from(`${value}\0`);
const packet = (code: string, ...body: Buffer[]) => { const b = Buffer.concat(body); return Buffer.concat([Buffer.from(code), i32(b.length + 4), b]); };
const ready = () => packet('Z', Buffer.from('I'));
const complete = (command: string) => packet('C', cstring(command));

it.each(['trust', 'password', 'rejected'] as const)('executes deployed authentication with a real pg client: %s', async method => {
  const sockets = new Set<Socket>(), statements: string[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0), startup = true;
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const total = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (pending.length < total) break;
        const message = pending.subarray(0, total); pending = pending.subarray(total);
        if (startup) {
          startup = false;
          socket.write(method === 'trust' ? Buffer.concat([packet('R', i32(0)), ready()]) : packet('R', i32(3)));
          continue;
        }
        const code = message.toString('utf8', 0, 1), body = message.subarray(5);
        if (code === 'p') {
          expect(body.toString()).toBe('synthetic-password\0');
          socket.write(method === 'rejected' ? packet('E', cstring('SFATAL'), cstring('C28P01'), cstring('Mrejected'), Buffer.from([0])) : Buffer.concat([packet('R', i32(0)), ready()]));
        } else if (code === 'Q') {
          const sql = body.toString().replace(/\0$/, ''); statements.push(sql);
          if (sql.startsWith('SELECT session_user')) {
            const column = (name: string) => Buffer.concat([cstring(name), i32(0), i16(0), i32(25), i16(-1), i32(-1), i16(0)]);
            const values = ['app', 'app', 'appdb'].flatMap(value => [i32(Buffer.byteLength(value)), Buffer.from(value)]);
            socket.write(Buffer.concat([packet('T', i16(3), ...['username', 'active_user', 'database'].map(column)), packet('D', i16(3), ...values), complete('SELECT 1'), ready()]));
          } else socket.write(Buffer.concat([complete(sql), ready()]));
        } else if (code === 'X') socket.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  try {
    const target = { projectId: 'project', environmentId: 'environment', serviceId: 'service', deploymentId: 'deployment' };
    const child = spawn(process.execPath, ['-'], { cwd: process.cwd(), env: {
      PATH: process.env.PATH, DATABASE_URL: `postgresql://app:synthetic-password@127.0.0.1:${port}/appdb`,
      RAILWAY_PROJECT_ID: target.projectId, RAILWAY_ENVIRONMENT_ID: target.environmentId,
      RAILWAY_SERVICE_ID: target.serviceId, RAILWAY_DEPLOYMENT_ID: target.deploymentId, RAILWAY_REPLICA_ID: 'replica',
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Program exited ${code}: ${errors}`))); });
    child.stdin.end(`${RAILWAY_RUNTIME_PROGRAM}\nmain(${JSON.stringify({ target, nonce: 'nonce', keys: ['DATABASE_URL'], authentication: { username: 'app', database: 'appdb' } })});\n`);
    await done;
    const result = JSON.parse(output);
    expect(result).toMatchObject(method === 'trust' ? { state: 'unknown' } : { state: 'verified', authentication: method === 'password' ? 'authenticated' : 'rejected' });
    expect(output).not.toContain('synthetic-password');
    expect(statements.every(sql => ['BEGIN READ ONLY', 'SELECT session_user AS username, current_user AS active_user, current_database() AS database', 'ROLLBACK'].includes(sql))).toBe(true);
  } finally { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); }
});
