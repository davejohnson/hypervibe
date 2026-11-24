/**
 * A database server can vanish under an open session: removing the app's
 * shared server does exactly that. The PostgreSQL client then emits 'error',
 * which ends the whole process unless something is listening.
 */
import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clients = vi.hoisted(() => [] as Array<import('node:events').EventEmitter & { ended: boolean }>);

vi.mock('@google-cloud/cloud-sql-connector', () => ({
  Connector: class { startLocalProxy = async () => {}; close = () => {}; },
  GoogleAuth: class {},
  IpAddressTypes: { PUBLIC: 'PUBLIC' },
}));
vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Client extends Emitter {
    ended = false;
    constructor() { super(); clients.push(this); }
    connect = async () => {};
    end = async () => { this.ended = true; };
  }
  return { default: { Client } };
});

const { withCloudSqlSession } = await import('../infrastructure-engine-database.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const open = <T>(work: (client: EventEmitter) => Promise<T>) => withCloudSqlSession({}, 'p:r:i', 'user', 'secret', 'postgres', work as never);

afterEach(() => { clients.length = 0; });

describe('a Cloud SQL session whose server goes away', () => {
  it('does not end the process, and the work that was finishing still returns', async () => {
    const result = await open(async (client) => {
      setImmediate(() => client.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })));
      await tick();
      await tick();
      return 'the server was deleted';
    });
    expect(result).toBe('the server was deleted');
    expect(clients[0]!.ended).toBe(true);
  });

  it('reports the lost connection as the reason when the work in flight then fails', async () => {
    const lost = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    await expect(open(async (client) => {
      client.emit('error', lost);
      throw new Error('Client has encountered a connection error and is not queryable');
    })).rejects.toBe(lost);
  });

  it('leaves an ordinary failure of the work as it is', async () => {
    const refused = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(open(async () => { throw refused; })).rejects.toBe(refused);
  });
});
