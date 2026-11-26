/**
 * What the two pause test files share: a disposable local PostgreSQL, and an
 * in-memory Secret Manager answering the real client's requests, so the real
 * secret write path (with what Hypervibe records beside each version) runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export function postgresBin(): string {
  const candidates = [process.env.HYPERVIBE_TEST_POSTGRES_BIN, '/Applications/Postgres.app/Contents/Versions/16/bin'].filter((entry): entry is string => Boolean(entry));
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${version}/bin`);
  const bin = candidates.find((candidate) => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the database pause tests.');
  return bin;
}

export const postgresMajor = (): number => Number(/\(PostgreSQL\) (\d+)/.exec(execFileSync(`${postgresBin()}/postgres`, ['--version'], { encoding: 'utf8' }))?.[1]);

export interface LocalPostgres {
  socket: string;
  boot: pg.Client;
  connect(user: string, password: string | undefined, database: string): Promise<pg.Client>;
  close(client: pg.Client): Promise<void>;
  /** Closes every session a test opened, the superuser's excepted. */
  closeOthers(): Promise<void>;
  /** Stops the server and removes it; true when it was confirmed stopped. */
  stop(): Promise<boolean>;
}

export async function startPostgres(prefix: string): Promise<LocalPostgres> {
  const bin = postgresBin();
  const directory = mkdtempSync(`/tmp/${prefix}-`);
  const socket = path.join(directory, 's');
  mkdirSync(socket);
  const halt = () => {
    if (existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
  };
  process.once('exit', halt);
  execFileSync(`${bin}/initdb`, ['-D', path.join(directory, 'data'), '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(directory, 'data/postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(directory, 'data/pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  const opened = new Set<pg.Client>();
  const connect = async (user: string, password: string | undefined, database: string) => {
    const client = new pg.Client({ host: socket, user, password, database, connectionTimeoutMillis: 10_000 });
    // A session ended by the server must not crash the test process.
    client.on('error', () => {});
    await client.connect();
    opened.add(client);
    return client;
  };
  const close = async (client: pg.Client) => { opened.delete(client); await client.end().catch(() => {}); };
  const boot = await connect('boot', undefined, 'postgres');
  return {
    socket, boot, connect, close,
    closeOthers: async () => { for (const client of [...opened]) if (client !== boot) await close(client); },
    stop: async () => {
      for (const client of [...opened]) await close(client);
      halt();
      const stopped = !existsSync(path.join(directory, 'data/postmaster.pid'));
      rmSync(directory, { recursive: true, force: true });
      return stopped;
    },
  };
}

/** Secret Manager as the real client sees it. `loseNextAnswer` stores the next version and then drops the connection, as a lost acknowledgement does. */
export interface FakeSecretManager {
  state: { secrets: Map<string, { labels: Record<string, string>; versions: string[]; ttl?: string }>; loseNextAnswer: boolean; failNextAccess: boolean; sent: string[];
    /** Runs once, while the next value for this secret is being stored. */
    whileStoring?: { secretId: string; run: () => Promise<void> } };
  answer(input: string | URL, init?: RequestInit): Promise<Response | undefined>;
  json(body: unknown, status?: number): Response;
}

export function fakeSecretManager(gcpProjectId: string): FakeSecretManager {
  const state: FakeSecretManager['state'] = {
    secrets: new Map(),
    loseNextAnswer: false,
    /** The next read of a stored value fails: together with `loseNextAnswer`, a process that died right after Google stored a version. */
    failNextAccess: false,
    /** Every value ever sent to be stored, kept or not. */
    sent: [],
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  /** Answers a request to Secret Manager, or returns undefined for any other host. */
  const answer = async (input: string | URL, init?: RequestInit): Promise<Response | undefined> => {
    const url = new URL(String(input));
    if (url.hostname !== 'secretmanager.googleapis.com') return undefined;
    const method = init?.method ?? 'GET';
    if (url.pathname === `/v1/projects/${gcpProjectId}/secrets` && method === 'POST') {
      const id = url.searchParams.get('secretId')!;
      if (state.secrets.has(id)) return json({}, 409);
      const body = JSON.parse(String(init!.body)) as { labels?: Record<string, string>; ttl?: string };
      state.secrets.set(id, { labels: body.labels ?? {}, versions: [], ...(body.ttl ? { ttl: body.ttl } : {}) });
      return json({ name: `projects/${gcpProjectId}/secrets/${id}`, labels: body.labels ?? {} });
    }
    const parts = new RegExp(`^/v1/projects/${gcpProjectId}/secrets/([^/:]+)(.*)$`).exec(url.pathname);
    if (!parts) return json({}, 404);
    const held = state.secrets.get(parts[1]!);
    const name = `projects/${gcpProjectId}/secrets/${parts[1]}`;
    if (parts[2] === '' && method === 'DELETE') return state.secrets.delete(parts[1]!) ? json({}) : json({}, 404);
    if (parts[2] === ':addVersion' && method === 'POST') {
      if (!held) return json({}, 404);
      const value = Buffer.from((JSON.parse(String(init!.body)) as { payload: { data: string } }).payload.data, 'base64').toString('utf8');
      state.sent.push(value);
      if (state.whileStoring?.secretId === parts[1]) { const { run } = state.whileStoring; state.whileStoring = undefined; await run(); }
      held.versions.push(value);
      if (state.loseNextAnswer) { state.loseNextAnswer = false; throw new TypeError('fetch failed'); }
      return json({ name: `${name}/versions/${held.versions.length}` });
    }
    if (method !== 'GET') throw new Error(`Unexpected ${method} ${url.pathname}`);
    if (!held) return json({}, 404);
    if (parts[2] === '') return json({ name, labels: held.labels });
    if (parts[2] === '/versions/latest') return held.versions.length ? json({ name: `${name}/versions/${held.versions.length}`, state: 'ENABLED' }) : json({}, 404);
    const access = /^\/versions\/([0-9]+|latest):access$/.exec(parts[2]!);
    if (access) {
      // Only the read-back of what was just written asks for "latest"; a pinned version is asked for by number.
      if (state.failNextAccess && access[1] === 'latest') { state.failNextAccess = false; return json({}, 503); }
      const value = held.versions[access[1] === 'latest' ? held.versions.length - 1 : Number(access[1]) - 1];
      return value === undefined ? json({}, 404) : json({ payload: { data: Buffer.from(value).toString('base64') } });
    }
    return json({}, 404);
  };
  return { state, answer, json };
}
