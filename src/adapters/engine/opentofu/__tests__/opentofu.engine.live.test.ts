/**
 * Runs the real pinned OpenTofu binary. Skipped unless HYPERVIBE_TOFU_BINARY
 * points at tofu 1.13.9. Uses only the built-in terraform_data resource, so it
 * needs no cloud account; the Cloud Run validation step downloads the pinned
 * Google provider and verifies its checksum.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { EngineConfiguration, EngineStateIdentity, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { buildCloudRunConfiguration, gcpEngineBackend } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { engineStatePaths, loadOrCreateStatePassphrase } from '../workspace.js';

const binary = process.env.HYPERVIBE_TOFU_BINARY;
const SECRET = 'hv-representative-secret-7f3a9c';
const cipher = { encrypt: (v: string) => Buffer.from(v).toString('base64'), decrypt: (v: string) => Buffer.from(v, 'base64').toString() };

const builtinBackend: InfrastructureEngineBackend = {
  provider: 'test', engine: 'opentofu', capabilities: ['hosting'], providerRequirements: {},
  buildConfiguration: () => { throw new Error('unused'); },
  buildAuthenticationProbe: () => { throw new Error('unused'); },
};

function config(resources: Record<string, Record<string, unknown>>): EngineConfiguration {
  return {
    files: {
      'main.tf.json': {
        variable: { secret: { type: 'string', sensitive: true } },
        resource: { terraform_data: resources },
      },
    },
    resources: Object.fromEntries(Object.keys(resources).map((name) => [
      `terraform_data.${name}`, { actionId: `service:${name}`, kind: 'service' as const, name },
    ])),
  };
}

const auth = { env: { TF_VAR_secret: SECRET }, redact: [SECRET] };

describe.skipIf(!binary)('OpenTofu engine (live binary)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-engine-'));
  const engine = new OpenTofuEngine({ binary: binary!, cipher, dataDir, pluginCacheDir: path.join(dataDir, 'plugins'), timeoutMs: 300_000 });
  const state: EngineStateIdentity = { provider: 'test', projectId: 'p1', environmentId: 'e1', partition: 'environment' };
  const paths = engineStatePaths(state, dataDir);
  fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });

  it('validates generated Cloud Run configuration against the pinned Google provider', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      services: [{
        logicalName: 'web', resourceName: 'web-staging', workload: 'web',
        initialImage: `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'web-runtime@demo-project.iam.gserviceaccount.com', public: true,
        env: { NODE_ENV: 'production' }, secretEnv: { API_KEY: { secretId: 'web-api-key', version: '3' } }, healthCheckPath: '/health',
      }],
    });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('plans, applies, reaches noop and rejects a stale saved plan, with secrets encrypted at rest', async () => {
    const configuration = config({ app: { input: '${var.secret}' } });
    const first = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-1' });
    if (!first.ok) throw new Error(first.error);
    expect(first.blockers).toEqual([]);
    expect(first.actions.map((a) => [a.id, a.type])).toEqual([['service:app', 'create']]);
    expect(fs.readFileSync(first.planFile).includes(SECRET)).toBe(false);

    const segment = first.actions[0]!.metadata!.engineSegment as any;
    const applied = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-1', segment, approvedAddresses: segment.addresses });
    expect(applied.outcomes).toEqual({ 'terraform_data.app': 'succeeded' });

    const stateBytes = fs.readFileSync(paths.statePath, 'utf8');
    expect(stateBytes).not.toContain(SECRET);
    expect(stateBytes).not.toContain('terraform_data');
    expect(fs.readdirSync(paths.backups)).toHaveLength(0); // no prior state to back up on first apply

    const second = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-2' });
    if (!second.ok) throw new Error(second.error);
    expect(second.actions.map((a) => a.type)).toEqual(['noop']);
    expect(second.actions[0]!.metadata).toBeUndefined();

    const replay = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-1', segment, approvedAddresses: segment.addresses });
    expect(replay.outcomes['terraform_data.app']).not.toBe('succeeded');
    expect(replay.diagnostics.join('\n')).toMatch(/stale|plan/i);
    expect(replay.diagnostics.join('\n')).not.toContain(SECRET);
    expect(fs.readdirSync(paths.backups)).toHaveLength(1);
  }, 300_000);

  it('rejects a tampered saved plan and partial approval without starting', async () => {
    const configuration = config({ app: { input: '${var.secret}' }, extra: { input: 'x' } });
    const planned = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-3' });
    if (!planned.ok) throw new Error(planned.error);
    const segment = planned.actions.find((a) => a.id === 'service:extra')!.metadata!.engineSegment as any;
    const partial = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-3', segment, approvedAddresses: [] });
    expect(partial.diagnostics[0]).toMatch(/approved/);
    fs.appendFileSync(planned.planFile, 'x');
    const tampered = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-3', segment, approvedAddresses: segment.addresses });
    expect(tampered).toEqual({ outcomes: { 'terraform_data.extra': 'not_started' }, diagnostics: ['The saved engine plan changed after review. Re-run hv_plan.'] });
  }, 300_000);

  it('reports partial failure per address', async () => {
    const failing = { input: 'boom', provisioner: [{ 'local-exec': { command: 'exit 1' } }] };
    const configuration = config({ app: { input: '${var.secret}' }, good: { input: 'ok' }, bad: failing });
    const planned = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-4' });
    if (!planned.ok) throw new Error(planned.error);
    const addresses = planned.actions.flatMap((a) => ((a.metadata?.engineSegment as any)?.addresses ?? []) as string[]);
    const segment = { ...(planned.actions.find((a) => a.metadata)!.metadata!.engineSegment as any), addresses };
    const result = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-4', segment, approvedAddresses: addresses });
    expect(result.outcomes).toMatchObject({ 'terraform_data.good': 'succeeded', 'terraform_data.bad': 'failed' });
  }, 300_000);

  it('refuses to mint a new key for existing state', () => {
    fs.renameSync(paths.passphraseFile, `${paths.passphraseFile}.bak`);
    expect(() => loadOrCreateStatePassphrase(paths, cipher)).toThrow(/Restore passphrase\.enc/);
    fs.renameSync(`${paths.passphraseFile}.bak`, paths.passphraseFile);
  });
});
