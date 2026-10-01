import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudSqlRestoreDrillScript } from '../cloudsql-restore-drill.workflow.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sensitive = 'provider-echoed-secret-value';
type Scenario = 'rejected' | 'uncertain' | 'operation-failed' | 'wrong-operation' | 'wrong-target' | 'wrong-project'
  | 'wrong-source' | 'wrong-clone-response' | 'null-absence' | 'label-failed' | 'label-failed-clone-type' | 'password-failed' | 'invalid-credentials';

/** Reconstructed official REST examples, not recorded responses or live evidence:
 * https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr
 * https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/operations
 * A successful PITR returns CREATE (the clone guide also documents CLONE), the
 * destination targetId/project, and an operation name; DONE can contain errors.
 * Only transport is replaced. The emitted script itself runs with real Node
 * signing and temporary-file I/O; imports are supplied as AsyncFunction inputs.
 */
async function execute(scenario: Scenario) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-drill-contract-'));
  const summaryPath = path.join(directory, 'summary.md');
  const calls: { method: string; pathname: string; body?: unknown }[] = [];
  let targetName = '';
  let cloneExists = false;
  let deleteRequested = false;
  let labels: Record<string, string> = {};
  let stdout = '';
  const processFixture = {
    env: {
      HYPERVIBE_DRILL_CONFIG_B64: Buffer.from(JSON.stringify({ projectId: 'project', region: 'us-central1',
        sourceInstanceId: 'primary', sourceConnectionName: 'project:us-central1:primary', databaseName: 'app',
        verificationQuery: 'SELECT 1', restoreLagMinutes: 10, retainFailedInstanceDays: 3 })).toString('base64'),
      HYPERVIBE_DRILL_CREDENTIALS: scenario === 'invalid-credentials' ? sensitive : JSON.stringify({ project_id: 'project', client_email: 'test@project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    stdout: { write: (value: string) => { stdout += value; } },
    exitCode: 0,
  };
  const operation = (name: string, status: string, type: string) => ({ name, status, operationType: type,
    targetId: targetName, targetProject: 'project' });
  const transport = async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';
    if (parsed.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-token' });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, pathname: parsed.pathname, ...(body ? { body } : {}) });
    if (parsed.pathname === '/v1/projects/project/instances') return Response.json({ items: [] });
    if (parsed.pathname === '/v1/projects/project/instances/primary') return Response.json({
      name: scenario === 'wrong-source' ? 'other-primary' : 'primary', project: 'project', region: 'us-central1', connectionName: 'project:us-central1:primary', state: 'RUNNABLE',
      settings: { backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true } },
    });
    if (parsed.pathname.endsWith('/primary/clone')) {
      expect(method).toBe('POST');
      expect(body).toEqual({ cloneContext: { destinationInstanceName: expect.stringMatching(/^hv-drill-/), pointInTime: expect.any(String) } });
      targetName = body.cloneContext.destinationInstanceName;
      cloneExists = true;
      if (scenario === 'rejected') return Response.json({ error: { message: sensitive } }, { status: 409 });
      if (scenario === 'uncertain') throw new Error(sensitive);
      return Response.json(operation('clone-1', 'PENDING', scenario === 'label-failed-clone-type' ? 'CLONE' : 'CREATE'));
    }
    if (parsed.pathname.endsWith('/operations/clone-1')) {
      const result = operation(scenario === 'wrong-operation' ? 'other-op' : 'clone-1', 'DONE', scenario === 'label-failed-clone-type' ? 'CLONE' : 'CREATE');
      if (scenario === 'wrong-target') result.targetId = 'other-instance';
      if (scenario === 'wrong-project') result.targetProject = 'other-project';
      return Response.json({ ...result, ...(scenario === 'operation-failed' ? { error: { errors: [{ code: 'FAILED', message: sensitive }] } } : {}) });
    }
    if (parsed.pathname.endsWith('/operations/delete-1')) return Response.json(operation('delete-1', 'DONE', 'DELETE'));
    if (parsed.pathname.endsWith('/operations/label-1')) return Response.json(operation('label-1', 'DONE', 'UPDATE'));
    if (parsed.pathname.includes('/instances/hv-drill-')) {
      if (method === 'PATCH') {
        if (scenario !== 'password-failed') return Response.json({ error: { message: sensitive } }, { status: 403 });
        labels = body.settings.userLabels;
        return Response.json(operation('label-1', 'PENDING', 'UPDATE'));
      }
      if (method === 'PUT') {
        expect(parsed.search).toBe('?name=postgres');
        expect(body).toEqual({ name: 'postgres', password: expect.any(String) });
        return Response.json({ error: { message: sensitive } }, { status: 403 });
      }
      if (method === 'DELETE') { cloneExists = false; deleteRequested = true; return Response.json(operation('delete-1', 'PENDING', 'DELETE')); }
      if (scenario === 'null-absence' && deleteRequested) return Response.json(null);
      return cloneExists ? Response.json({ name: scenario === 'wrong-clone-response' ? 'hv-drill-unrelated' : targetName, project: 'project', region: 'us-central1',
        state: 'RUNNABLE', settings: { settingsVersion: '1', userLabels: labels } }) : new Response('', { status: 404 });
    }
    throw new Error(`Unexpected request ${method} ${parsed.pathname}`);
  };
  try {
    await new AsyncFunction('crypto', 'fs', 'os', 'path', 'process', 'fetch',
      cloudSqlRestoreDrillScript().replace(/^import .*;$/gm, ''))(crypto, fs, os, path, processFixture, transport);
    return { calls, summary: await fs.readFile(summaryPath, 'utf8'), stdout, exitCode: processFixture.exitCode };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

describe('Cloud SQL emitted restore drill transport boundary', () => {
  it('does not expose a credential prefix in malformed JSON diagnostics', async () => {
    await expect(execute('invalid-credentials')).rejects.not.toThrow('provider-e');
  });

  it.each(['rejected', 'uncertain', 'operation-failed', 'wrong-operation', 'wrong-target', 'wrong-project'] as const)(
    'does not mutate an unlabeled instance without terminal correlated creation: %s', async scenario => {
      const result = await execute(scenario);
      expect(result.exitCode).toBe(1);
      expect(result.calls.filter(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method))).toEqual([]);
      expect(result.stdout).not.toContain('disposition=created');
    });

  it.each(['label-failed', 'label-failed-clone-type'] as const)('cleans the exact newly created unlabeled clone after labeling fails: %s', async scenario => {
    const result = await execute(scenario);
    expect(result.exitCode).toBe(1);
    expect(result.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(result.stdout).toContain('disposition=deleted');
    expect(result.summary).toContain('unlabeled temporary clone');
  });

  it.each(['wrong-source', 'wrong-clone-response'] as const)('rejects wrong instance response identity before mutation: %s', async scenario => {
    const result = await execute(scenario);
    expect(result.calls.filter(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method))).toEqual([]);
    if (scenario === 'wrong-source') expect(result.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it('does not treat HTTP 200 null as provider-confirmed absence after deletion', async () => {
    const result = await execute('null-absence');
    expect(result.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(result.stdout).not.toContain('disposition=deleted');
    expect(result.stdout).toContain('disposition=cleanup-failed');
  });

  it('retains the labeled clone after an uncertain password update without retrying or touching the source', async () => {
    const result = await execute('password-failed');
    expect(result.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(result.calls.filter(call => call.method === 'DELETE')).toEqual([]);
    expect(result.stdout).toContain('disposition=retained');
    expect(result.summary + result.stdout).not.toContain(sensitive);
    expect(result.exitCode).toBe(1);
  });

  it.each(['rejected', 'uncertain', 'operation-failed', 'label-failed'] as const)(
    'does not put raw provider errors into logs or summary: %s', async scenario => {
      const result = await execute(scenario);
      expect(result.summary + result.stdout).not.toContain(sensitive);
    });
});
