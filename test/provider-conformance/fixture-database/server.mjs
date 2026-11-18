import http from 'node:http';
import pg from 'pg';

// One file, two roles: `node server.mjs` serves HTTP, `node server.mjs worker` writes a heartbeat.
// Both use the DATABASE_URL Hypervibe injects, so a passing check proves each workload reaches the database.
const role = process.argv[2] === 'worker' ? 'worker' : 'web';

function pool() {
  const url = new URL(process.env.DATABASE_URL);
  // Encrypted, but the certificate is not verified: this throwaway app carries no provider CA bundle.
  url.search = '';
  return new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10_000 });
}

const database = process.env.DATABASE_URL ? pool() : undefined;

async function beat(who) {
  await database.query('CREATE TABLE IF NOT EXISTS conformance_heartbeat (role text PRIMARY KEY, at timestamptz NOT NULL)');
  await database.query('INSERT INTO conformance_heartbeat (role, at) VALUES ($1, now()) ON CONFLICT (role) DO UPDATE SET at = now()', [who]);
}

if (role === 'worker') {
  const tick = () => beat('worker').catch(() => undefined);
  tick();
  setInterval(tick, 15_000);
} else {
  const port = Number(process.env.PORT || 8080);
  http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const body = { service: 'hypervibe-provider-conformance', revision: process.env.CONFORMANCE_APP_REVISION || 'unknown', database: false, worker: false };
    try {
      await beat('web');
      const fresh = await database.query("SELECT 1 FROM conformance_heartbeat WHERE role = 'worker' AND at > now() - interval '2 minutes'");
      body.database = true;
      body.worker = fresh.rowCount === 1;
    } catch {
      // Errors can carry connection details; the booleans are the whole answer.
    }
    response.end(JSON.stringify(body));
  }).listen(port, '0.0.0.0');
}
