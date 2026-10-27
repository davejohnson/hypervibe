import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteAdapter, getDb } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { OperatorCredentialCustody } from '../operator-credential-custody.js';

describe('private operator credential custody', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-custody-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  function fixture() {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun' } });
    const context = { projectId: project.id, environmentId: environment.id, installationId: randomUUID(), intentDigest: 'a'.repeat(64), provider: 'github-app' as const };
    return { ctx, context, store: new OperatorCredentialCustody(context) };
  }
  it('keeps browser codes encrypted and atomically permits one consumption across restart', () => {
    const f = fixture(), expiresAt = new Date(Date.now() + 600_000).toISOString();
    let started = f.store.createBrowser({ attemptId: randomUUID(), expiresAt, state: 's'.repeat(43), launch: 'l'.repeat(43) });
    expect(f.store.stageCode(started, 's'.repeat(43), 'synthetic-before-handoff-code')).toBe(false);
    started = f.store.issueForm(started)!;
    expect(f.store.stageCode(started, 's'.repeat(43), 'synthetic-one-time-manifest-code')).toBe(true);
    expect(f.store.stageCode(started, 's'.repeat(43), 'synthetic-replay-code')).toBe(false);
    const rows = JSON.stringify(getDb().prepare('SELECT credentials_encrypted FROM connections').all());
    expect(rows).not.toContain('synthetic-one-time-manifest-code'); expect(rows).not.toContain('s'.repeat(43));
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    const restarted = new OperatorCredentialCustody(f.context), staged = restarted.read()!;
    expect(staged.state.phase).toBe('code-staged');
    const first = restarted.consumeCode(staged), second = f.store.consumeCode(staged);
    expect(first).toEqual({ code: 'synthetic-one-time-manifest-code' }); expect(second).toBeNull();
    expect(restarted.read()!.state).toMatchObject({ phase: 'conversion-started' }); expect(restarted.read()!.state).not.toHaveProperty('code');
    const consumed = restarted.read()!;
    expect(restarted.stageCode(consumed, 's'.repeat(43), 'synthetic-one-time-manifest-code')).toBe(true);
    expect(restarted.stageCode(consumed, 's'.repeat(43), 'synthetic-different-code')).toBe(false);
    expect(restarted.consumeCode(consumed)).toBeNull(); expect(restarted.read()!.cipher).toBe(consumed.cipher);
  });
  it('rejects wrong state, expired callbacks and changed source authority without changing custody', () => {
    const f = fixture(), started = f.store.createBrowser({ attemptId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 's'.repeat(43), launch: 'l'.repeat(43) });
    expect(f.store.stageCode(started, 'wrong', 'synthetic-code')).toBe(false);
    expect(f.store.stageCode(started, 's'.repeat(43), 'synthetic-code', Date.now() + 120_000)).toBe(false);
    expect(() => new OperatorCredentialCustody({ ...f.context, intentDigest: 'b'.repeat(64) }).read()).toThrow(/custody/i);
    expect(f.store.read()!.state.phase).toBe('awaiting-browser');
  });
  it('keeps native outputs encrypted until every immutable delivery receipt is durable', () => {
    const f = fixture(), store = new OperatorCredentialCustody({ ...f.context, provider: 'google-recaptcha' });
    let saved = store.storeCredentials(null, { 'secret-key': 'synthetic-private-provider-secret' }, { siteKey: 'public-site-key' })!;
    expect(JSON.stringify(getDb().prepare('SELECT * FROM connections').all())).not.toContain('synthetic-private-provider-secret');
    const attemptId = randomUUID();
    saved = store.updateDelivery(saved, 'RECAPTCHA_SECRET_KEY', { attemptId, status: 'attempted' })!;
    expect(store.eraseDeliveredCredentials(saved, ['RECAPTCHA_SECRET_KEY'])).toBeNull();
    expect(store.updateDelivery(saved, 'RECAPTCHA_SECRET_KEY', { attemptId: randomUUID(), status: 'attempted' })).toBeNull();
    const reference = { destination: { provider: 'gcp-secret-manager' as const, projectId: 'operator-test', projectNumber: '123456789012', secretId: 'captcha-secret' }, version: '1' };
    saved = store.updateDelivery(saved, 'RECAPTCHA_SECRET_KEY', { attemptId, status: 'delivered', reference })!;
    expect(store.updateDelivery(saved, 'RECAPTCHA_SECRET_KEY', { attemptId, status: 'uncertain' })).toBeNull();
    const completed = store.eraseDeliveredCredentials(saved, ['RECAPTCHA_SECRET_KEY'])!;
    expect(completed.state).toMatchObject({ phase: 'delivered', identity: { siteKey: 'public-site-key' }, deliveries: { RECAPTCHA_SECRET_KEY: { reference } } });
    expect(completed.state).not.toHaveProperty('credentials');
    expect(store.storeCredentials(null, { 'secret-key': 'synthetic-replacement' }, { siteKey: 'replacement' })).toBeNull();
  });
});
