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
  if (options.headers.Authorization !== 'Bearer fixture-google-token') throw new Error('Missing Google credential');
  if (url.origin === 'https://artifactregistry.googleapis.com') {
    const scope = 'projects/target-project/locations/us-central1/repositories/hypervibe/packages/production-gcp-web';
    const path = url.pathname.replace('/v1/', '');
    if (options.method === 'POST') {
      const id = url.searchParams.get('tagId');
      const { version } = JSON.parse(options.body);
      if (path !== scope + '/tags' || !/^hv-migration-[a-f0-9]{64}$/.test(id) || !version.startsWith(scope + '/versions/sha256:')) return Response.json({}, { status: 400 });
      const name = path + '/' + id;
      data.claims ??= {};
      if (data.claims[name]) return Response.json({}, { status: 409 });
      data.claims[name] = { name, version };
      record('reserve migration');
      return Response.json(data.claims[name]);
    }
    return data.claims?.[path] ? Response.json(data.claims[path]) : Response.json({}, { status: 404 });
  }
  if (url.origin !== 'https://run.googleapis.com') throw new Error('Unexpected API surface');
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
    if (name.includes('/jobs/')) {
      if (data.raceCommand) { value.template.template.containers[0].args = ['-lc', 'unreviewed']; value.etag += '-raced'; }
      if (data.raceContainer) { value.template.template.containers.push({ image: 'other' }); value.etag += '-raced'; }
    }
    if (data.failRollout && name.includes('/services/')) { data.failRollout = false; record('rollout failed'); return Response.json({}, { status: 503 }); }
    record('patch ' + name.split('/').pop()); return Response.json({ done: true });
  }
  if (path.endsWith(':run')) {
    const { etag, overrides } = JSON.parse(options.body);
    if (etag !== value.etag) return Response.json({}, { status: 412 });
    const override = overrides.containerOverrides[0];
    if (overrides.containerOverrides.length !== 1 || override.name !== value.template.template.containers[0].name || Object.keys(override).some(k => !['name', 'env'].includes(k))) return Response.json({}, { status: 400 });
    const template = structuredClone(value.template.template);
    template.containers[0].env.push(...override.env);
    data.executions ??= [];
    const execution = { name: name + '/executions/prod-migrate-' + (data.executions.length + 1), job: name, template, uid: '44444444-4444-4444-8444-' + String(data.executions.length + 1).padStart(12, '0'),
      taskCount: 1, completionTime: '2026-04-05T10:00:00Z', succeededCount: data.migrationFails ? 0 : 1, failedCount: data.migrationFails ? 1 : 0,
      conditions: [{ type: 'Completed', state: data.migrationFails ? 'CONDITION_FAILED' : 'CONDITION_SUCCEEDED' }] };
    if (!data.lostUnproven) data.executions.push(execution);
    record('run migrations');
    if (data.loseResponse || data.lostUnproven) throw new Error('Lost response after provider accepted command');
    return Response.json({ done: true, response: execution });
  }
  if (path.endsWith('/executions')) return Response.json({ executions: data.executions ?? [] });
  if (path.includes('/executions/')) {
    const execution = data.executions?.find(e => e.name === path);
    return execution ? Response.json(execution) : Response.json({}, { status: 404 });
  }
  record('get ' + name.split('/').pop()); return Response.json(value);
};
