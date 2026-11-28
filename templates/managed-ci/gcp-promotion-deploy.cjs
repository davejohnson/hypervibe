'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// The job never checks out application code. Only reviewed configuration and validated release evidence reach this program.
function promote(contract, candidate, env) {
  const temporary = mkdtempSync(join(env.RUNNER_TEMP, 'hv-promotion-'));
  try {
    const auth = join(temporary, 'registry.json'); const digestFile = join(temporary, 'digest');
    const release = join(temporary, 'release.mjs');
    writeFileSync(release, Buffer.from(env.RELEASE_PROGRAM, 'base64'), { mode: 0o600 });
    const targets = contract.services.map(service => {
      const images = candidate.deployments.filter(item => item.name === service.name);
      if (images.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(images[0].sourceImage.split('@')[1]) || images[0].sourceImage !== 'ghcr.io/' + contract.repository.toLowerCase() + '@' + images[0].sourceImage.split('@')[1]
        || images[0].image !== service.image + '@' + images[0].sourceImage.split('@')[1]) throw new Error('Invalid per-workload promotion image.');
      return { ...service, ...images[0] };
    });
    const migration = contract.releaseCommand;
    const migrationImage = migration && targets.find(item => item.name === migration.service)?.image;
    if (migration && !migrationImage) throw new Error('No staged migration image.');
    const job = migration && { resource: migration.job, kind: 'jobs', image: migrationImage, uid: migration.uid, command: migration.command };
    const run = (item, extra = {}) => execFileSync(process.execPath, [release, item.resource, item.image, item.healthPath || '', item.kind,
      Buffer.from(item.startCommand?.trim() || '').toString('base64')], { stdio: 'inherit', env: { PATH: env.PATH, GCP_PROJECT: contract.gcpProjectId, GCP_REGION: contract.region,
        GCP_PROJECT_NUMBER: contract.provider.split('/')[1], GCP_TOKEN: env.GCP_TOKEN, HYPERVIBE_RESOURCE_UID: item.uid, HYPERVIBE_HEALTH_STRICT: item.strictHealth ? '1' : '0', ...(item.command && { HYPERVIBE_MIGRATION_COMMAND: item.command }), ...extra } });
    for (const item of [...(job ? [job] : []), ...targets]) run(item, { HYPERVIBE_PREFLIGHT: '1' });
    const skopeo = (args, input) => execFileSync('skopeo', args, { input, env: { PATH: env.PATH, HOME: temporary }, maxBuffer: 16 * 1024 * 1024 });
    skopeo(['login', '--authfile', auth, '--username', env.GITHUB_ACTOR, '--password-stdin', 'ghcr.io'], env.GH_PACKAGES_TOKEN);
    skopeo(['login', '--authfile', auth, '--username', 'oauth2accesstoken', '--password-stdin', contract.region + '-docker.pkg.dev'], env.GCP_TOKEN);
    for (const item of targets) {
      const [repository, digest] = item.image.split('@');
      skopeo(['copy', '--authfile', auth, '--all', '--preserve-digests', '--digestfile', digestFile,
        'docker://' + item.sourceImage, 'docker://' + repository + ':promoted-' + digest.slice(7)]);
      const manifest = skopeo(['inspect', '--authfile', auth, '--raw', 'docker://' + item.image]);
      if (readFileSync(digestFile, 'utf8').trim() !== digest || 'sha256:' + createHash('sha256').update(manifest).digest('hex') !== digest) {
        throw new Error('The promoted registry manifest differs from staging. No workloads were switched.');
      }
    }
    if (job) run(job, { HYPERVIBE_RUN_JOB: '1' });
    for (const item of targets) run(item);
    for (const item of targets) run(item, { HYPERVIBE_VERIFY_IMAGE: '1' });
    const receipt = { version: 1, repository: contract.repository, environment: contract.environment, workflowSha: env.GITHUB_SHA,
      runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), source: candidate.source, gcpProjectId: contract.gcpProjectId, region: contract.region,
      services: targets.map(({ name, resource, kind, image, uid }) => ({ name, resource, kind, image, uid })) };
    writeFileSync(join(env.RUNNER_TEMP, 'promotion.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { promote };
