import { describe, expect, it } from 'vitest';
import { collectOutsideKeys, engineOutsideKeys, type EngineSecretStore } from '../engine-secrets.js';
import { engineEnvironmentProblems, missingOutsideKeysMessage } from '../infrastructure-engine.js';

// Issue #601: a fresh OpenTofu environment could not get the keys an outside service issues.
// Declaring them blocked the launch, and not declaring them blocked the paste page.
const spec = {
  secrets: {
    ACME_API_KEY: { ownership: 'delegated', environments: ['staging'] },
    STRIPE_SECRET_KEY: { ownership: 'delegated', environments: ['staging', 'production'] },
    JWT_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['staging'] },
    PROD_ONLY_KEY: { ownership: 'delegated', environments: ['production'] },
  },
  environments: {
    staging: { hosting: { provider: 'cloudrun', engine: 'opentofu', region: 'us-central1' }, services: {}, envVars: {} },
  },
} as never;

function memoryStore(present: string[]): EngineSecretStore & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    name: 'Test store', written,
    observe: async (key) => (present.includes(key) || key in written ? 'present' : 'absent'),
    write: async (key, value) => { written[key] = value; return undefined; },
  };
}

describe('outside keys on OpenTofu environments', () => {
  it('lets an environment declare keys an outside service issues', () => {
    expect(engineEnvironmentProblems(spec, 'staging').join('\n')).not.toMatch(/externally supplied/);
  });

  it('counts declared and migrated keys for this environment only, never generated ones', () => {
    expect(engineOutsideKeys(spec, 'staging', ['SENDGRID_API_KEY'])).toEqual(['ACME_API_KEY', 'SENDGRID_API_KEY', 'STRIPE_SECRET_KEY']);
  });

  it('stops a plan with the one command that collects every missing key', () => {
    expect(missingOutsideKeysMessage('staging', ['ACME_API_KEY', 'STRIPE_SECRET_KEY']))
      .toBe('staging needs 2 keys Hypervibe cannot create: ACME_API_KEY, STRIPE_SECRET_KEY. Run hv_secrets action="collect" env="staging" to add them all on one local page (hv_launch does this itself), then plan again.');
  });

  it('collects every missing key on one page, straight into the environment\'s store', async () => {
    const store = memoryStore(['STRIPE_SECRET_KEY']);
    let url = '';
    const pending = collectOutsideKeys({} as never, { project: { id: 'p1', name: 'app' } as never, spec, environmentName: 'staging', store,
      waitMs: 10_000, openBrowser: (opened) => { url = opened; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const target = new URL(url);
    const page = await (await fetch(url)).text();
    expect(page).toContain('ACME_API_KEY');
    expect(page).not.toContain('STRIPE_SECRET_KEY');
    const nonce = target.pathname.split('/').pop()!;
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: target.origin },
      body: new URLSearchParams({ nonce, save: 'ACME_API_KEY', 'value:ACME_API_KEY': 'sk-test' }).toString() });
    await expect(pending).resolves.toEqual({ status: 'collected', keys: ['ACME_API_KEY'] });
    expect(store.written).toEqual({ ACME_API_KEY: 'sk-test' });
  });

  it('has nothing to ask for once every key has a value, and refuses keys the environment does not declare', async () => {
    const params = { project: { id: 'p1', name: 'app' } as never, spec, environmentName: 'staging', store: memoryStore(['ACME_API_KEY', 'STRIPE_SECRET_KEY']) };
    await expect(collectOutsideKeys({} as never, params)).resolves.toEqual({ status: 'collected', keys: [] });
    await expect(collectOutsideKeys({} as never, { ...params, keys: ['PROD_ONLY_KEY'] })).resolves.toMatchObject({ status: 'blocked' });
  });
});

describe('outside keys already in the repository', () => {
  it('prefers .env.<environment>, falls back to the shared .env, and skips values that only work locally', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { localKeyValues } = await import('../engine-secrets.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-keys-'));
    fs.writeFileSync(path.join(dir, '.env'), 'ACME_API_KEY=shared\nSTRIPE_SECRET_KEY=sk_shared\nWEBHOOK_URL=http://localhost:3000/hook\n');
    fs.writeFileSync(path.join(dir, '.env.staging'), 'ACME_API_KEY=staging-only\n');
    expect(localKeyValues(dir, 'staging', ['ACME_API_KEY', 'STRIPE_SECRET_KEY', 'WEBHOOK_URL', 'MISSING']))
      .toEqual({ ACME_API_KEY: { value: 'staging-only', file: '.env.staging' }, STRIPE_SECRET_KEY: { value: 'sk_shared', file: '.env' } });
    // Another environment has no file of its own, so the shared .env serves it too.
    expect(localKeyValues(dir, 'production', ['ACME_API_KEY'])).toEqual({ ACME_API_KEY: { value: 'shared', file: '.env' } });
  });

  it('saves a value from the file with one click, without putting it on the page', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-keys-'));
    fs.writeFileSync(path.join(dir, '.env'), 'ACME_API_KEY=from-the-file\n');
    const store = memoryStore(['STRIPE_SECRET_KEY']);
    let url = '';
    const pending = collectOutsideKeys({} as never, { project: { id: 'p2', name: 'app' } as never, spec, environmentName: 'staging', store, sourceDirectory: dir,
      waitMs: 10_000, openBrowser: (opened) => { url = opened; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const page = await (await fetch(url)).text();
    expect(page).toContain('Use the value in .env');
    expect(page).not.toContain('from-the-file');
    const target = new URL(url);
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: target.origin },
      body: new URLSearchParams({ nonce: target.pathname.split('/').pop()!, fromfile: 'ACME_API_KEY' }).toString() });
    await expect(pending).resolves.toEqual({ status: 'collected', keys: ['ACME_API_KEY'] });
    expect(store.written).toEqual({ ACME_API_KEY: 'from-the-file' });
  });
});
