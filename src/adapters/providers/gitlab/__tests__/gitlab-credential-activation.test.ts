import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGitLabReleaseEvidenceRuntime } from '../gitlab-ci.lifecycle.js';
import { buildFlyPortableRuntime } from '../../fly/fly-ci.recipe.js';

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function execute(operations: unknown, deployments: unknown[], priorEvidence: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-gitlab-credential-evidence-')); dirs.push(directory);
  const sha = 'a'.repeat(40), program = 'b'.repeat(64), contract = 'c'.repeat(64);
  writeFileSync(path.join(directory, 'finalize.mjs'), buildGitLabReleaseEvidenceRuntime());
  writeFileSync(path.join(directory, '.hypervibe-deploy-sha'), sha);
  writeFileSync(path.join(directory, '.hypervibe-release.json'), JSON.stringify({ version: 1, provider: 'fly', repository: 'https://gitlab.com/acme/app', environment: 'production', sha, programFingerprint: program, deployments, ...priorEvidence }));
  const result = spawnSync(process.execPath, ['finalize.mjs'], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    CI_PROJECT_ID: '42', CI_PIPELINE_ID: '20', CI_JOB_ID: '200', CI_COMMIT_SHA: sha,
    HYPERVIBE_RELEASE_PROVIDER: 'fly', HYPERVIBE_REPOSITORY: 'https://gitlab.com/acme/app', HYPERVIBE_ENVIRONMENT: 'production',
    HYPERVIBE_PROGRAM_FINGERPRINT: program, HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT: contract,
    HYPERVIBE_RELEASE_SERVICES: '["web"]', HYPERVIBE_RELEASE_PROVIDER_IDENTITY: '{}', HYPERVIBE_RELEASE_PROVIDER_RESOURCES: '[]',
    HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'false', HYPERVIBE_CREDENTIAL_OPERATIONS: JSON.stringify(operations),
  } });
  return { result, evidence: JSON.parse(readFileSync(path.join(directory, '.hypervibe-release.json'), 'utf8')) };
}

// Execute the emitted program, not a parallel handwritten finalizer. The
// independent requirement binds activation to the exact returned deployment.
it('joins only the reviewed credential operation and exact provider deployment', () => {
  const { result, evidence } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine' } }, [{ serviceId: 'bound-machine', deploymentId: 'new-instance' }]);
  expect(result.status, result.stderr).toBe(0);
  expect(evidence.credentialActivation).toEqual({ version: 1, operations: [{ service: 'web', operationId: 'plan-one', serviceId: 'bound-machine', deploymentIds: ['new-instance'] }] });
});
it('drops an inherited activation claim when this run received no reviewed operations', () => {
  const deployments = [{ serviceId: 'bound-machine', deploymentId: 'new-instance', url: 'https://app.example' }];
  const { result, evidence } = execute({}, deployments, { services: ['web'], credentialActivation: { version: 1, operations: [
    { service: 'web', operationId: 'unreviewed-old-operation', serviceId: 'bound-machine', deploymentIds: ['old-instance'], value: 'private-material' },
  ] } });
  expect(result.status, result.stderr).toBe(0);
  expect(evidence).not.toHaveProperty('credentialActivation');
  expect(evidence.deployments).toEqual(deployments);
  expect(evidence.services).toEqual(['web']);
  expect(JSON.stringify(evidence)).not.toMatch(/unreviewed-old-operation|private-material/);
});
it('replaces inherited activation only with fresh reviewed joins while preserving deployment metadata', () => {
  const deployments = [{ serviceId: 'bound-machine', deploymentId: 'new-instance', url: 'https://app.example' }];
  const { result, evidence } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine' } }, deployments,
    { services: ['web'], credentialActivation: { version: 1, operations: [{ value: 'private-material' }] } });
  expect(result.status, result.stderr).toBe(0);
  expect(evidence.credentialActivation).toEqual({ version: 1, operations: [
    { service: 'web', operationId: 'plan-one', serviceId: 'bound-machine', deploymentIds: ['new-instance'] },
  ] });
  expect(evidence.deployments).toEqual(deployments);
  expect(evidence.services).toEqual(['web']);
  expect(JSON.stringify(evidence)).not.toContain('private-material');
});
it('does not assign an unrelated or missing native deployment to the reviewed operation', () => {
  const { result, evidence } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine' } }, [{ serviceId: 'other-machine', deploymentId: 'other-instance' }]);
  expect(result.status, result.stderr).toBe(0);
  expect(evidence.credentialActivation).toEqual({ version: 1, operations: [] });
});
it('rejects extra fields in credential operation input instead of copying values to release evidence', () => {
  const { result } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine', value: 'private-material' } }, [{ serviceId: 'bound-machine', deploymentId: 'new-instance' }]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain('private-material');
});

// Fly's native contract requires min_secrets_version: a fresh Machine instance
// alone may still load cached secrets. The provider producer must attest that
// the reviewed version was passed to the exact Machine mutation.
// https://community.fly.io/t/flyctl-update-for-managing-secrets/25878/1
it('retains the exact native configuration version attested by the deployment producer', () => {
  const { result, evidence } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine', configurationVersion: 42 } },
    [{ serviceId: 'bound-machine', deploymentId: 'new-instance', configurationVersion: 42 }]);
  expect(result.status, result.stderr).toBe(0);
  expect(evidence.credentialActivation.operations).toEqual([{ service: 'web', operationId: 'plan-one', serviceId: 'bound-machine', deploymentIds: ['new-instance'], configurationVersion: 42 }]);
});
it.each([undefined, 41, 43])('rejects deployment evidence for configuration version %s when the accepted version is 42', version => {
  const { result } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine', configurationVersion: 42 } },
    [{ serviceId: 'bound-machine', deploymentId: 'new-instance', ...(version !== undefined ? { configurationVersion: version } : {}) }]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Credential deployment configuration version differs');
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '42'])('rejects invalid configuration version %s', version => {
  const { result } = execute({ web: { operationId: 'plan-one', serviceId: 'bound-machine', configurationVersion: version } },
    [{ serviceId: 'bound-machine', deploymentId: 'new-instance', configurationVersion: version }]);
  expect(result.status).not.toBe(0);
});

it.each([0, 42])('executes the Fly deployment producer and finalizer with reviewed configuration version %s', configurationVersion => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-fly-credential-producer-')); dirs.push(directory);
  const sha = 'a'.repeat(40), digest = `sha256:${'d'.repeat(64)}`, image = `registry.fly.io/bound-app@${digest}`;
  const serviceId = `flyapp:v1:${Buffer.from(JSON.stringify({ version: 1, organizationSlug: 'acme', appId: 'app-id', appName: 'bound-app', machineId: 'machine-id' })).toString('base64url')}`;
  const operations = { web: { operationId: 'plan-one', serviceId, ...(configurationVersion !== undefined ? { configurationVersion } : {}) } };
  writeFileSync(path.join(directory, '.hypervibe-deploy-sha'), sha);
  writeFileSync(path.join(directory, '.hypervibe-image-uri'), 'registry.gitlab.com/acme/app:build');
  writeFileSync(path.join(directory, '.hypervibe-docker'), `#!${process.execPath}\nif (process.argv.includes('inspect')) process.stdout.write(${JSON.stringify(JSON.stringify([image]))});\n`, { mode: 0o700 });
  writeFileSync(path.join(directory, 'deploy.mjs'), buildFlyPortableRuntime());
  writeFileSync(path.join(directory, 'transport.mjs'), `let config = { image: 'old-image', metadata: { hypervibe_managed: 'true' } }; let instance = 'old-instance';
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.machines.dev') throw new Error('Wrong provider origin');
  if (url.pathname === '/v1/apps/bound-app') return Response.json({ id: 'app-id', name: 'bound-app', organization: { slug: 'acme' } });
  if (url.pathname === '/v1/apps/bound-app/machines') return Response.json([{ id: 'machine-id', instance_id: instance, config }]);
  if (url.pathname === '/v1/apps/bound-app/machines/machine-id') {
    if (init.method === 'POST') { const body = JSON.parse(init.body); if (body.current_version !== 'old-instance') throw new Error('Wrong concurrency identity');
      if (body.min_secrets_version !== ${configurationVersion === undefined ? 'undefined' : configurationVersion}) throw new Error('Machine may activate cached credentials');
      config = body.config; instance = 'new-instance'; }
    return Response.json({ id: 'machine-id', instance_id: instance, state: 'started', checks: [{status:'passing'}], image_ref: { digest: ${JSON.stringify(digest)} }, config });
  }
  throw new Error('Unexpected request');
};`);
  const result = spawnSync(process.execPath, ['--import', './transport.mjs', 'deploy.mjs'], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    FLY_API_TOKEN: 'private-token', FLY_ORGANIZATION_SLUG: 'acme', FLY_SERVICE_BINDINGS_JSON: JSON.stringify([serviceId]), FLY_REGISTRY_APP: 'bound-app',
    CI_REGISTRY: 'registry.gitlab.com', CI_REGISTRY_USER: 'user', CI_REGISTRY_PASSWORD: 'private-token',
    HYPERVIBE_REPOSITORY: 'https://gitlab.com/acme/app', HYPERVIBE_ENVIRONMENT: 'production', HYPERVIBE_PROGRAM_FINGERPRINT: 'b'.repeat(64),
    HYPERVIBE_CREDENTIAL_OPERATIONS: JSON.stringify(operations),
  } });
  expect(result.status, result.stderr).toBe(0);
  const produced = JSON.parse(readFileSync(path.join(directory, '.hypervibe-release.json'), 'utf8'));
  expect(produced.deployments).toMatchObject([{ serviceId, deploymentId: 'new-instance', image, digest }]);
  const finalized = execute(operations, produced.deployments);
  expect(finalized.result.status, finalized.result.stderr).toBe(0);
  expect(finalized.evidence.credentialActivation.operations[0].deploymentIds).toEqual(['new-instance']);
  expect(finalized.evidence.credentialActivation.operations[0].configurationVersion).toBe(configurationVersion);
});
