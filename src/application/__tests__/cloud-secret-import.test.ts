import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCloudSecretImport } from '../cloud-secret-import.js';
import { parseEnvContent } from '../../utils/env-parser.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { runCli } from '../../interfaces/cli/run.js';

let root: string;
const requestId = '12345678-1234-4234-8234-123456789abc';
const now = () => new Date('2026-09-15T12:00:00Z');
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hv-secret-import-')));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('remote', 'add', 'origin', 'https://github.com/studio/app.git');
  mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(
    path.join(root, '.hypervibe/spec.json'),
    JSON.stringify({
      version: 1,
      project: 'app',
      gitRemoteUrl: 'https://github.com/studio/app.git',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
        },
      },
      secrets: {
        SG_SCRIPT_KEY: {
          ownership: 'delegated',
          principal: 'github:ian',
          environments: ['staging'],
        },
      },
    })
  );
  writeFileSync(path.join(root, '.gitignore'), '/.env.staging\n');
  writeFileSync(path.join(root, '.env.example'), 'SG_SCRIPT_KEY=\n');
  git('add', '.hypervibe/spec.json', '.gitignore', '.env.example');
  git('commit', '-m', 'fixture');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const metadata = {
    schemaVersion: 1,
    requestId,
    repository: 'studio/app',
    environment: 'staging',
    sourceRevision: git('rev-parse', 'HEAD'),
    sourceDigest: createHash('sha256')
      .update(readFileSync(path.join(root, '.hypervibe/spec.json')))
      .digest('hex'),
    keys: ['SG_SCRIPT_KEY'],
  };
  const fetchImpl = vi.fn<typeof fetch>(
    async (_url, options) =>
      new Response(
        JSON.stringify(
          options?.method === 'GET'
            ? metadata
            : {
                ...metadata,
                values: { SG_SCRIPT_KEY: 'secret-fixture' },
                replanRequired: true,
              }
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
  const context = createCommandContext();
  return {
    metadata,
    fetchImpl,
    context,
    importer: createCloudSecretImport({
      context,
      directory: () => root,
      fetchImpl,
      now,
    }),
  };
}

describe('one-time project secret import', () => {
  it.each(['repository', 'environment', 'sourceRevision', 'sourceDigest', 'keys'])(
    'rejects mismatched server %s before POST',
    async (field) => {
      const { importer, metadata, fetchImpl } = setup();
      await importer.run({ action: 'start', requestId, env: 'staging' });
      fetchImpl.mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              ...metadata,
              [field]:
                field === 'keys'
                  ? ['UNDECLARED_KEY']
                  : field === 'sourceRevision'
                    ? 'b'.repeat(40)
                    : field === 'sourceDigest'
                      ? 'b'.repeat(64)
                      : field === 'repository'
                        ? 'foreign/app'
                        : 'production',
            })
          )
      );
      await expect(
        importer.run({ action: 'receive', requestId, env: 'staging', confirm: true })
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('blocks ambiguous multiline input before consumption', async () => {
    const { importer, fetchImpl } = setup();
    await importer.run({ action: 'start', requestId, env: 'staging' });
    writeFileSync(path.join(root, '.env.staging'), 'OTHER="\nSG_SCRIPT_KEY=\n');
    await expect(
      importer.run({ action: 'receive', requestId, env: 'staging', confirm: true })
    ).rejects.toThrow('single-line');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('routes the real CLI command and returns usable references through the shared redaction boundary', async () => {
    const { context, fetchImpl } = setup();
    vi.stubGlobal('fetch', fetchImpl);
    const registry = createCommandRegistry(context);
    let stdout = '';
    const io = {
      writeOut: (value: string) => {
        stdout += value;
      },
      writeErr: () => {},
      readStdin: async () => '',
      confirm: async () => false,
      stdinIsTTY: false,
    };
    await runWithWorkspaceDirectories([root], async () => {
      expect(
        await runCli(
          ['cloud', 'secrets', '--request-id', requestId, '--env', 'staging', '--json'],
          { registry, io, initialize: false }
        )
      ).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        agentInstruction: { action: 'ask_user' },
      });
      stdout = '';
      expect(
        await runCli(
          [
            'cloud',
            'secrets',
            '--action',
            'receive',
            '--request-id',
            requestId,
            '--env',
            'staging',
            '--confirm',
            '--json',
          ],
          { registry, io, initialize: false }
        )
      ).toBe(0);
    });
    expect(JSON.parse(stdout).data.secretRefs).toEqual([
      {
        key: 'SG_SCRIPT_KEY',
        ref: `dotenv:${path.join(root, '.env.staging')}#SG_SCRIPT_KEY`,
      },
    ]);
    expect(stdout).not.toContain('secret-fixture');
  });
  it('keeps the proof encrypted, preflights metadata, writes only the private env file, and never reads twice', async () => {
    const { importer, fetchImpl, context } = setup();
    const started = await importer.run({
      action: 'start',
      requestId,
      env: 'staging',
    });
    expect(started.status).toBe('approval_required');
    expect(started.verificationUrl).toContain('/retrieval-authorizations/new?challenge=');
    expect(fetchImpl).not.toHaveBeenCalled();
    const pending = context.repos.connections.findAllByProvider('hypervibe-secret-import')[0];
    const proof = context.secretStore.decryptObject<{ token: string }>(pending.credentialsEncrypted).token;
    expect(pending.credentialsEncrypted).not.toContain(proof);
    expect(JSON.stringify(started)).not.toContain(proof);
    expect(new URL(started.verificationUrl as string).searchParams.get('challenge')).toBe(createHash('sha256').update(proof).digest('hex'));
    await expect(
      importer.run({ action: 'receive', requestId, env: 'staging' })
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    const receipt = await importer.run({
      action: 'receive',
      requestId,
      env: 'staging',
      confirm: true,
    });
    expect(receipt.status).toBe('imported');
    expect(
      parseEnvContent(readFileSync(path.join(root, '.env.staging'), 'utf8')).SG_SCRIPT_KEY
    ).toBe('secret-fixture');
    expect(statSync(path.join(root, '.env.staging')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toBe('SG_SCRIPT_KEY=\n');
    expect(JSON.stringify(receipt)).not.toContain('secret-fixture');
    const completed = context.repos.connections.findAllByProvider('hypervibe-secret-import')[0];
    const state = context.secretStore.decryptObject<Record<string, unknown>>(completed.credentialsEncrypted);
    expect(state.status).toBe('imported');
    expect(state.token).toBeUndefined();
    expect(state.received).toBeUndefined();
    expect(completed.credentialsEncrypted).not.toContain('secret-fixture');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      (
        await importer.run({
          action: 'receive',
          requestId,
          env: 'staging',
          confirm: true,
        })
      ).status
    ).toBe('imported');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['populated', 'tracked', 'symlink', 'dirty-spec', 'wrong-remote'])(
    'refuses %s before consuming server values',
    async (failure) => {
      const { importer, fetchImpl } = setup();
      await importer.run({ action: 'start', requestId, env: 'staging' });
      const file = path.join(root, '.env.staging');
      if (failure === 'populated') writeFileSync(file, 'SG_SCRIPT_KEY=keep-mine\n');
      if (failure === 'tracked') {
        writeFileSync(file, '');
        git('add', '-f', '.env.staging');
      }
      if (failure === 'symlink') symlinkSync('.env.example', file);
      if (failure === 'dirty-spec') writeFileSync(path.join(root, '.hypervibe/spec.json'), '{}');
      if (failure === 'wrong-remote')
        git('remote', 'set-url', 'origin', 'https://github.com/other/app.git');
      await expect(
        importer.run({
          action: 'receive',
          requestId,
          env: 'staging',
          confirm: true,
        })
      ).rejects.toBeDefined();
      expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    }
  );

  it('does not retry an ambiguous consuming request or expose a server error body', async () => {
    const { importer, fetchImpl, metadata } = setup();
    await importer.run({ action: 'start', requestId, env: 'staging' });
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify(metadata), { status: 200 })
    );
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error('provider-secret-must-stay-private');
    });
    await expect(
      importer.run({
        action: 'receive',
        requestId,
        env: 'staging',
        confirm: true,
      })
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('provider-secret'),
    });
    const calls = fetchImpl.mock.calls.length;
    await expect(
      importer.run({
        action: 'receive',
        requestId,
        env: 'staging',
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('recovers a completed file write when saving the completion receipt fails, without another retrieval', async () => {
    const { importer, fetchImpl, context } = setup();
    await importer.run({ action: 'start', requestId, env: 'staging' });
    const update = context.repos.connections.updateCredentials.bind(context.repos.connections);
    const failure = vi
      .spyOn(context.repos.connections, 'updateCredentials')
      .mockImplementation((id, encrypted) => {
        if (context.secretStore.decryptObject<{ status: string }>(encrypted).status === 'imported')
          throw new Error('simulated local database failure');
        return update(id, encrypted);
      });
    await expect(
      importer.run({
        action: 'receive',
        requestId,
        env: 'staging',
        confirm: true,
      })
    ).rejects.toThrow('simulated');
    expect(
      parseEnvContent(readFileSync(path.join(root, '.env.staging'), 'utf8')).SG_SCRIPT_KEY
    ).toBe('secret-fixture');
    failure.mockRestore();
    expect(
      (
        await importer.run({
          action: 'receive',
          requestId,
          env: 'staging',
          confirm: true,
        })
      ).status
    ).toBe('imported');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retains received values encrypted after a concurrent env edit and resumes only the local write', async () => {
    const { importer, fetchImpl, metadata } = setup();
    await importer.run({ action: 'start', requestId, env: 'staging' });
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify(metadata)));
    fetchImpl.mockImplementationOnce(async () => {
      writeFileSync(path.join(root, '.env.staging'), 'OTHER=keep-this\n');
      return new Response(
        JSON.stringify({
          ...metadata,
          values: { SG_SCRIPT_KEY: 'secret-fixture' },
          replanRequired: true,
        })
      );
    });
    await expect(
      importer.run({
        action: 'receive',
        requestId,
        env: 'staging',
        confirm: true,
      })
    ).rejects.toThrow('changed during retrieval');
    expect(
      (
        await importer.run({
          action: 'receive',
          requestId,
          env: 'staging',
          confirm: true,
        })
      ).status
    ).toBe('imported');
    expect(parseEnvContent(readFileSync(path.join(root, '.env.staging'), 'utf8'))).toEqual({
      OTHER: 'keep-this',
      SG_SCRIPT_KEY: 'secret-fixture',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
