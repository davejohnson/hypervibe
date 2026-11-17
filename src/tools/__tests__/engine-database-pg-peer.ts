import { Duplex } from 'node:stream';
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = (s: string) => Buffer.from(`${s}\0`);
const packet = (code: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(code), i32(body.length + 4), body]); };
/** Synthetic PostgreSQL v3 messages from https://www.postgresql.org/docs/17/protocol-message-formats.html. No TLS or SQL engine is emulated. */
export class EngineDatabasePgPeer extends Duplex {
  private startup = true;
  constructor(private readonly state: { sql: string[]; password?: string; startup?: string; ended: boolean }) { super(); }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  connect() { queueMicrotask(() => this.emit('connect')); return this; }
  _read() {}
  private reply(...messages: Buffer[]) { queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.concat(messages)); }); }
  _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    try {
      if (this.startup) { this.startup = false; this.state.startup = chunk.toString('utf8', 8); this.reply(packet('R', i32(3))); }
      else {
        const code = chunk.toString('utf8', 0, 1); const text = chunk.toString('utf8', 5).replace(/\0$/, '');
        if (code === 'p') { this.state.password = text; this.reply(packet('R', i32(0)), packet('K', i32(1), i32(2)), packet('Z', Buffer.from('I'))); }
        else if (code === 'Q') {
          this.state.sql.push(text);
          if (text.startsWith('SELECT')) {
            const column = Buffer.concat([string('answer'), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)]);
            this.reply(packet('T', i16(1), column), packet('D', i16(1), i32(2), Buffer.from('42')), packet('C', string('SELECT 1')), packet('Z', Buffer.from('T')));
          } else this.reply(packet('C', string(text)), packet('Z', Buffer.from('T')));
        } else if (code === 'X') { this.state.ended = true; this.destroy(); }
        else throw new Error('Unexpected PostgreSQL test message.');
      }
      done();
    } catch (error) { done(error as Error); }
  }
}
