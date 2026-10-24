import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDeployEnvFile } from '../deploy-env-file.js';
import { resolveSecretValueRef } from '../secret-value-ref.js';
import { parseCredentialRef } from '../../../application/credential-reference.js';

// User contract: named environments do not inherit base credentials. Sharing
// must be explicit in the environment file and resolve at each input boundary.
describe('explicit environment credential inputs', () => {
  let root: string;
  const write = (name: string, content: string) => writeFileSync(path.join(root, name), content, { mode: 0o600 });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hv-env-isolation-'));
    execFileSync('git', ['init', '--quiet'], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    write('.gitignore', '.env\n.env.*\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([true, false])('never falls back to base credentials when the staging file is absent (sync=%s)', syncEnvSpecific => {
    write('.env', 'RECAPTCHA_SECRET_KEY=production-only-secret\n');
    const result = loadDeployEnvFile({ startDir: root, envName: 'staging', syncEnvSpecific });
    expect(result?.vars ?? {}).toEqual({});
    expect(JSON.stringify(result)).not.toContain('production-only-secret');
    if (existsSync(path.join(root, '.env.staging'))) {
      expect(readFileSync(path.join(root, '.env.staging'), 'utf8')).not.toContain('production-only-secret');
    }
  });

  it('never appends missing base secrets to an existing environment file', () => {
    write('.env', 'RECAPTCHA_SECRET_KEY=production-only-secret\nSENDGRID_API_KEY=base-sendgrid\n');
    const staging = 'SENDGRID_API_KEY=staging-sendgrid\n';
    write('.env.staging', staging);
    expect(loadDeployEnvFile({ startDir: root, envName: 'staging' })?.vars).toEqual({ SENDGRID_API_KEY: 'staging-sendgrid' });
    expect(readFileSync(path.join(root, '.env.staging'), 'utf8')).toBe(staging);
  });

  it('resolves an explicit reference relative to its containing environment file without copying it', () => {
    write('.env', 'SHARED_APPLICATION_TOKEN=deliberately-shared-value\nUNUSED_SECRET=not-selected\n');
    const staging = 'APP_TOKEN=dotenv:./.env#SHARED_APPLICATION_TOKEN\n';
    write('.env.staging', staging);
    expect(loadDeployEnvFile({ startDir: root, envName: 'staging' })?.vars).toEqual({ APP_TOKEN: 'deliberately-shared-value' });
    expect(readFileSync(path.join(root, '.env.staging'), 'utf8')).toBe(staging);
  });

  it('uses the same explicit reference for delegated secret and connection imports', async () => {
    write('.env', 'SHARED_APPLICATION_TOKEN=deliberately-shared-value\n');
    write('.env.staging', 'APP_TOKEN=dotenv:./.env#SHARED_APPLICATION_TOKEN\n');
    const ref = `dotenv:${path.join(root, '.env.staging')}#APP_TOKEN`;
    await expect(resolveSecretValueRef(ref)).resolves.toBe('deliberately-shared-value');
    await expect(parseCredentialRef('sendgrid', ref, 'apiKey')).resolves.toEqual({ apiKey: 'deliberately-shared-value' });
    await expect(parseCredentialRef('sendgrid', `dotenv:${path.join(root, '.env.staging')}`, undefined, { apiKey: 'APP_TOKEN' }))
      .resolves.toEqual({ apiKey: 'deliberately-shared-value' });
  });

  it.each(['MISSING', 'EMPTY'])('rejects a reference to a %s value instead of deploying the reference text', key => {
    write('.env', 'EMPTY=\nUNRELATED_SECRET=never-print-me\n');
    write('.env.staging', `APP_TOKEN=dotenv:./.env#${key}\n`);
    expect(() => loadDeployEnvFile({ startDir: root, envName: 'staging' })).toThrow(/missing|empty|not found/i);
  });

  it('rejects a reference cycle', () => {
    write('.env', 'SHARED_TOKEN=dotenv:./.env.staging#APP_TOKEN\n');
    write('.env.staging', 'APP_TOKEN=dotenv:./.env#SHARED_TOKEN\n');
    expect(() => loadDeployEnvFile({ startDir: root, envName: 'staging' })).toThrow(/cycle|circular/i);
  });

  it('does not let runtime references rename control-plane credentials', () => {
    write('.env', 'HYPERVIBE_GITHUB_TOKEN=control-plane-secret\n');
    write('.env.staging', 'APP_TOKEN=dotenv:./.env#HYPERVIBE_GITHUB_TOKEN\n');
    expect(() => loadDeployEnvFile({ startDir: root, envName: 'staging' })).toThrow(/provider|control.plane|reserved/i);
  });

  it('does not resolve excluded delegated slots or unrelated references', () => {
    write('.env.staging', 'DELEGATED_SECRET=dotenv:./missing-file#SECRET\nUNUSED_VALUE=dotenv:./missing-file#SECRET\nAPP_TOKEN=staging-token\n');
    const result = loadDeployEnvFile({ startDir: root, envName: 'staging', excludeKeys: ['DELEGATED_SECRET'] });
    expect(result?.vars).toEqual({ APP_TOKEN: 'staging-token' });
  });
});
