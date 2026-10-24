import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDotenvValues, resolveDotenvValue } from '../dotenv-value.js';
import { loadDeployEnvFile } from '../../domain/services/deploy-env-file.js';
import { resolveSecretValueRef } from '../../domain/services/secret-value-ref.js';
import { parseCredentialRef } from '../../application/credential-reference.js';

describe('explicit whole-value dotenv references', () => {
  let root: string;
  const write = (name: string, content: string) => writeFileSync(path.join(root, name), content, { mode: 0o600 });
  const selected = () => path.join(root, '.env.staging');

  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'hv-dotenv-reference-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves each relative hop from its containing file and preserves the reference files', () => {
    mkdirSync(path.join(root, 'shared'));
    write('.env.staging', 'APP_TOKEN="dotenv:./shared/values.env#TOKEN"\n');
    write('shared/values.env', 'TOKEN=dotenv:../.env#SHARED_TOKEN\n');
    write('.env', 'SHARED_TOKEN=private-example-value\n');
    expect(resolveDotenvValue(selected(), 'APP_TOKEN')).toBe('private-example-value');
    expect(readFileSync(selected(), 'utf8')).toContain('dotenv:./shared/values.env#TOKEN');
  });

  it('keeps non-reference values literal without shell interpolation or secret-manager evaluation', () => {
    write('.env.staging', 'APP_TOKEN="${TOKEN} $(not-a-command) vault://secret/path#value"\n');
    expect(resolveDotenvValue(selected(), 'APP_TOKEN')).toBe('${TOKEN} $(not-a-command) vault://secret/path#value');
  });

  it('detects a cycle even when a path uses relative aliases', () => {
    mkdirSync(path.join(root, 'shared'));
    write('.env.staging', 'APP_TOKEN=dotenv:./shared/../.env.staging#APP_TOKEN\n');
    expect(() => resolveDotenvValue(selected(), 'APP_TOKEN')).toThrow(/cycle/);
  });

  it('bounds acyclic reference chains', () => {
    write('.env.staging', Array.from({ length: 18 }, (_, index) =>
      `KEY_${index}=${index === 17 ? 'private-value' : `dotenv:./.env.staging#KEY_${index + 1}`}`
    ).join('\n'));
    expect(() => resolveDotenvValue(selected(), 'KEY_0')).toThrow(/depth/);
  });

  it.each(['directory', 'symlink'])('rejects a %s reference target across all input boundaries', async kind => {
    write('real.env', 'TOKEN=private-value\n');
    const target = path.join(root, 'unsafe.env');
    if (kind === 'directory') mkdirSync(target);
    else symlinkSync(path.join(root, 'real.env'), target);
    write('.env.staging', 'APP_TOKEN=dotenv:./unsafe.env#TOKEN\n');
    expect(() => loadDeployEnvFile({ envFile: selected() })).toThrow(/regular file/);
    await expect(resolveSecretValueRef(`dotenv:${selected()}#APP_TOKEN`)).rejects.toThrow(/regular file/);
    await expect(parseCredentialRef('sendgrid', `dotenv:${selected()}#APP_TOKEN`, 'apiKey')).rejects.toThrow(/regular file/);
  });

  it('rejects a symlinked outer file before reading any of its values', () => {
    write('real.env', 'APP_TOKEN=private-value\n');
    symlinkSync(path.join(root, 'real.env'), selected());
    expect(() => readDotenvValues(selected())).toThrow(/regular file/);
  });

  it.each([
    'dotenv:./missing-secret-value#TOKEN',
    'dotenv:./private-secret-value',
    'dotenv:./.env#INVALID-private-secret-value',
  ])('does not echo rejected reference values in diagnostics', reference => {
    write('.env.staging', `APP_TOKEN=${reference}\n`);
    let message = '';
    try { resolveDotenvValue(selected(), 'APP_TOKEN'); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain(reference);
  });

  it.each(['missing', 'empty', 'cycle', 'malformed', 'control-plane'])(
    'does not echo a secret-shaped valid identifier from a nested %s reference', failure => {
      const fragment = failure === 'control-plane' ? 'HYPERVIBE_sk_test_private_value' : 'sk_test_private_value';
      write('.env.staging', `APP_TOKEN=dotenv:./.env#${fragment}\n`);
      const values: Record<string, string> = {
        missing: 'UNRELATED=value\n',
        empty: `${fragment}=\n`,
        cycle: `${fragment}=dotenv:./.env#${fragment}\n`,
        malformed: `${fragment}=dotenv:./.env\n`,
        'control-plane': `${fragment}=provider-secret\n`,
      };
      write('.env', values[failure]);
      let message = '';
      try { loadDeployEnvFile({ envFile: selected() }); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe('');
      expect(message).not.toContain(fragment);
      expect(message).not.toContain('provider-secret');
    }
  );

  it('rejects empty values at delegated and connection import boundaries', async () => {
    write('.env.staging', 'APP_TOKEN=dotenv:./.env#TOKEN\n');
    write('.env', 'TOKEN="  "\nOTHER_SECRET=private-value\n');
    await expect(resolveSecretValueRef(`dotenv:${selected()}#APP_TOKEN`)).rejects.toThrow(/empty/);
    await expect(parseCredentialRef('sendgrid', `dotenv:${selected()}`, undefined, { apiKey: 'APP_TOKEN' }))
      .rejects.toThrow(/empty/);
  });

  it('denies a control-plane source hidden behind another runtime reference', () => {
    write('.env.staging', 'APP_TOKEN=dotenv:./.env#SHARED_TOKEN\n');
    write('.env', 'SHARED_TOKEN=dotenv:./.env#NODE_AUTH_TOKEN\nNODE_AUTH_TOKEN=provider-secret\n');
    expect(() => loadDeployEnvFile({ envFile: selected() })).toThrow(/control-plane/);
  });

  it('applies runtime local-value filtering after reference resolution', () => {
    write('.env.staging', 'APP_URL=dotenv:./.env#SHARED_URL\n');
    write('.env', 'SHARED_URL=http://localhost:3000\n');
    const result = loadDeployEnvFile({ envFile: selected() });
    expect(result?.vars).toEqual({});
    expect(result?.localValueKeys).toEqual(['APP_URL']);
  });

  it('does not resolve irrelevant malformed references when importing selected connection fields', async () => {
    write('.env.staging', 'APP_TOKEN=literal-token\nUNUSED_SECRET=dotenv:./missing#TOKEN\n');
    await expect(parseCredentialRef('sendgrid', `dotenv:${selected()}`, undefined, { apiKey: 'APP_TOKEN' }))
      .resolves.toEqual({ apiKey: 'literal-token' });
  });
});
