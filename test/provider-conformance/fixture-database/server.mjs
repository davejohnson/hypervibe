import http from 'node:http';
import pg from 'pg';

// One file, four roles. `node server.mjs` serves HTTP; `worker` writes a heartbeat for as long as it runs;
// `scheduled` writes one heartbeat and exits; `ondemand` finishes queued jobs. All use the DATABASE_URL
// Hypervibe injects, so a passing check proves each workload ran and reached the database.
const role = ['worker', 'scheduled', 'ondemand'].includes(process.argv[2]) ? process.argv[2] : 'web';

function pool() {
  // Google Cloud hands the app a socket inside the container (`?host=/cloudsql/...`), which has no TLS of its own.
  if (/[?&]host=%2F|[?&]host=\//.test(process.env.DATABASE_URL)) return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10_000 });
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

async function recent(who, minutes) {
  const fresh = await database.query('SELECT 1 FROM conformance_heartbeat WHERE role = $1 AND at > now() - make_interval(mins => $2)', [who, minutes]);
  return fresh.rowCount === 1;
}

const jobsTable = "CREATE TABLE IF NOT EXISTS conformance_jobs (id bigserial PRIMARY KEY, status text NOT NULL, run_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz)";

/** Queues one job unless one is waiting or was finished in the last two minutes; true when one finished in the last five. */
async function onDemandWork() {
  await database.query(jobsTable);
  const done = await database.query("SELECT (max(done_at) > now() - interval '2 minutes') AS just, (max(done_at) > now() - interval '5 minutes') AS lately FROM conformance_jobs WHERE status = 'done'");
  const queued = await database.query("SELECT 1 FROM conformance_jobs WHERE status = 'queued' LIMIT 1");
  if (!queued.rowCount && done.rows[0].just !== true) await database.query("INSERT INTO conformance_jobs (status) VALUES ('queued')");
  return done.rows[0].lately === true;
}

/** Writes a file with the workload's own identity and reads it back. No keys are involved on any cloud. */
async function storageRoundTrip() {
  const text = `conformance ${Date.now()}`;
  if (process.env.OBJECT_STORAGE_PROVIDER === 's3') {
    const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});
    const at = { Bucket: process.env.OBJECT_STORAGE_BUCKET, Key: 'conformance.txt' };
    await s3.send(new PutObjectCommand({ ...at, Body: text }));
    return await (await s3.send(new GetObjectCommand(at))).Body.transformToString() === text;
  }
  if (process.env.OBJECT_STORAGE_PROVIDER === 'azureblob') {
    const identity = new URL(process.env.IDENTITY_ENDPOINT);
    identity.searchParams.set('resource', 'https://storage.azure.com/');
    identity.searchParams.set('api-version', '2019-08-01');
    identity.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
    const token = (await (await fetch(identity, { headers: { 'X-IDENTITY-HEADER': process.env.IDENTITY_HEADER }, signal: AbortSignal.timeout(10_000) })).json()).access_token;
    const blob = `${process.env.AZURE_STORAGE_BLOB_ENDPOINT}${process.env.AZURE_STORAGE_CONTAINER_NAME}/conformance.txt`;
    const headers = { authorization: `Bearer ${token}`, 'x-ms-version': '2021-08-06' };
    const put = await fetch(blob, { method: 'PUT', headers: { ...headers, 'x-ms-blob-type': 'BlockBlob', 'content-type': 'text/plain' }, body: text, signal: AbortSignal.timeout(10_000) });
    if (put.status !== 201) return false;
    const got = await fetch(blob, { headers, signal: AbortSignal.timeout(10_000) });
    return got.status === 200 && await got.text() === text;
  }
  if (process.env.OBJECT_STORAGE_PROVIDER === 'gcs') {
    const token = (await (await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10_000) })).json()).access_token;
    const bucket = encodeURIComponent(process.env.OBJECT_STORAGE_BUCKET);
    const headers = { authorization: `Bearer ${token}` };
    const object = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/conformance.txt`;
    const put = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=conformance.txt`,
      { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: text, signal: AbortSignal.timeout(10_000) });
    if (put.status !== 200) return false;
    const got = await fetch(`${object}?alt=media`, { headers, signal: AbortSignal.timeout(10_000) });
    const same = got.status === 200 && await got.text() === text;
    // Google Cloud has no teardown that empties a bucket, and refuses to delete one that holds a file.
    const removed = await fetch(object, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
    return same && [204, 404].includes(removed.status);
  }
  return false;
}

if (role === 'worker') {
  const tick = () => beat('worker').catch(() => undefined);
  tick();
  setInterval(tick, 15_000);
} else if (role === 'scheduled') {
  // One run of the schedule: record it and stop, so the platform sees a finished job.
  beat('scheduled').then(() => process.exit(0), () => process.exit(1));
} else if (role === 'ondemand') {
  // Runs only while the platform sees queued work. Each job takes one pass.
  const work = () => database.query(jobsTable)
    .then(() => database.query("UPDATE conformance_jobs SET status = 'done', done_at = now() WHERE status = 'queued'")).catch(() => undefined);
  work();
  setInterval(work, 5_000);
} else {
  const port = Number(process.env.PORT || 8080);
  http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const body = { service: 'hypervibe-provider-conformance', revision: process.env.CONFORMANCE_APP_REVISION || 'unknown',
      // How this process was started: through the image's own entrypoint or not, and with which first argument.
      entrypoint: process.env.CONFORMANCE_ENTRYPOINT === '1', startedWith: process.argv[2] ?? null,
      database: false, worker: false, scheduled: false, onDemand: false, storage: false };
    // Errors can carry connection details; the booleans are the whole answer.
    try {
      await beat('web');
      body.database = true;
      body.worker = await recent('worker', 2);
      body.scheduled = await recent('scheduled', 5);
      body.onDemand = await onDemandWork();
    } catch { /* reported as false */ }
    try { body.storage = await storageRoundTrip(); } catch { /* reported as false */ }
    response.end(JSON.stringify(body));
  }).listen(port, '0.0.0.0');
}
