// Documented Cloud Run v2 response shapes, exercised through the emitted release process.
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run
import { readFileSync, writeFileSync } from 'node:fs';
const location = process.env.HV_FIXTURE;
const data = JSON.parse(readFileSync(location, 'utf8'));
const record = event => { data.events.push(event); writeFileSync(location, JSON.stringify(data)); };
globalThis.fetch = async (raw, options = {}) => {
  const url = new URL(raw);
  if (url.hostname === 'web.example.test') { record('health ' + url.pathname); return new Response('healthy'); }
  if (url.origin !== 'https://run.googleapis.com' || options.headers.Authorization !== 'Bearer fixture-google-token') throw new Error('Unexpected API surface');
  const path = url.pathname.replace('/v2/', '');
  const name = path.split('/executions')[0].replace(/:run$/, '');
  const value = data.workloads[name];
  if (!value) return Response.json({}, { status: 404 });
  if (options.method === 'PATCH') {
    const update = JSON.parse(options.body);
    if (update.etag !== value.etag) return Response.json({}, { status: 412 });
    if (name.includes('/jobs/')) {
      if (url.search) throw new Error('Unexpected job update mask');
    } else if (url.searchParams.get('updateMask') !== 'template.containers') throw new Error('Overbroad resource update');
    value.template = { ...value.template, ...update.template }; value.etag += '-new';
    record('patch ' + name.split('/').pop()); return Response.json({ done: true });
  }
  if (path.endsWith(':run')) {
    if (JSON.parse(options.body).etag !== value.etag) return Response.json({}, { status: 412 });
    record('run migrations');
    return Response.json({ done: true, response: { name: name + '/executions/one', job: name, template: value.template.template,
      completionTime: '2026-04-05T10:00:00Z', succeededCount: data.migrationFails ? 0 : 1, failedCount: data.migrationFails ? 1 : 0 } });
  }
  if (path.endsWith('/executions')) return Response.json({ executions: [] });
  record('get ' + name.split('/').pop()); return Response.json(value);
};
