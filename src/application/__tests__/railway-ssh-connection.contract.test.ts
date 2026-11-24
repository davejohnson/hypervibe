import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import { runCli } from '../../interfaces/cli/run.js';
import { createCommandContext } from '../context.js';

const scope = 'owner/app';
const projectId = 'b2564955-4fd6-4158-881c-a0d6e8095b13';
// Released Railway readers recognize the flat file fields and discard unknown keys.
const legacyReader = z.object({ apiToken: z.string().min(1), workspaceId: z.string().optional(), teamId: z.string().optional(),
  sshIdentityFile: z.string().startsWith('/').optional(), sshKnownHostsFile: z.string().startsWith('/').optional() });
const primary = { apiToken: 'synthetic-private-railway-token', workspaceId: 'workspace-1', teamId: 'legacy-team', storedMetadata: 'existing' };
const connections = new ConnectionRepository();
const audit = new AuditRepository();
let root: string;
let paths: { sshIdentityFile: string; sshKnownHostsFile: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hv-railway-ssh-'));
  paths = { sshIdentityFile: join(root, 'identity'), sshKnownHostsFile: join(root, 'known_hosts') };
  for (const file of Object.values(paths)) writeFileSync(file, 'synthetic fixture', { mode: 0o600 });
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(root, 'test.db')).migrate();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected HTTP request'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

function existing(selectedScope: string | null, status: 'verified' | 'failed' = 'verified', saved: Record<string, unknown> = primary) {
  const connection = connections.create({ provider: 'railway', scope: selectedScope,
    credentialsEncrypted: getSecretStore().encryptObject(saved) });
  audit.create({ action: 'connection.created', resourceType: 'connection', resourceId: connection.id,
    details: { credentialsSource: 'env', credentialsRef: 'env:ORIGINAL_RAILWAY_TOKEN' } });
  return connections.updateStatus(connection.id, status)!;
}

async function attach(supplied: Record<string, unknown>, selectedScope: string | null = scope) {
  const ref = join(root, 'paths.json');
  writeFileSync(ref, JSON.stringify(supplied), { mode: 0o600 });
  return connectionCommand(['--action', 'add', '--credentials-ref', `file:${ref}`], selectedScope);
}

async function connectionCommand(args: string[], selectedScope: string | null) {
  let stdout = '';
  const code = await runCli(['connections', '--provider', 'railway', ...args,
    ...(selectedScope ? ['--scope', selectedScope] : []), '--json'], { initialize: false, io: {
    writeOut: text => { stdout += text; }, writeErr: text => { throw new Error(text); },
    readStdin: async () => '', confirm: async () => false, stdinIsTTY: false,
  } });
  expect(stdout).not.toContain(primary.apiToken);
  for (const file of Object.values(paths)) expect(stdout).not.toContain(file);
  return { code, result: JSON.parse(stdout) };
}

describe('attach local SSH files to a verified Railway connection', () => {
  it.each([scope, null])('saves the SSH settings on the selected connection (%s)', async selectedScope => {
    const before = existing(selectedScope);
    const neighbors = [existing('owner/other'), existing(selectedScope ? null : scope)];
    const [created] = audit.findByResource('connection', before.id);
    const update = selectedScope === null ? { ...paths, sshProjectId: projectId } : paths;
    const { code, result } = await attach(update, selectedScope);
    expect(result).toMatchObject({ ok: true, data: { status: 'verified', updatedCredentialKeys: Object.keys(update),
      message: expect.stringContaining('Saved the Railway SSH file paths') } });
    expect(code).toBe(0);
    const stored = connections.findById(before.id)!;
    expect(stored).toMatchObject({ provider: 'railway', scope: selectedScope, status: 'verified', lastVerifiedAt: before.lastVerifiedAt });
    const saved = getSecretStore().decryptObject(stored.credentialsEncrypted);
    expect(saved).toEqual(selectedScope === null ? { ...primary, projectSsh: update } : { ...primary, ...paths });
    expect(legacyReader.parse(saved)).toEqual(legacyReader.parse(selectedScope === null ? primary : { ...primary, ...paths }));
    const events = audit.findByResource('connection', before.id);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(created);
    expect(events).toContainEqual(expect.objectContaining({ action: 'connection.credentials.updated',
      details: expect.objectContaining({ credentialKeys: Object.keys(update), credentialsSource: 'file' }) }));
    for (const file of Object.values(paths)) expect(JSON.stringify(events)).not.toContain(file);
    for (const neighbor of neighbors) expect(connections.findById(neighbor.id)).toEqual(neighbor);
  });

  it.each(['missing identity', 'missing host file', 'extra field', 'invalid project ID', 'absent file', 'relative path', 'unsafe permissions'])('rejects %s without saving a partial update', async reason => {
    const before = existing(scope);
    const supplied: Record<string, unknown> = { ...paths };
    if (reason === 'missing identity') delete supplied.sshIdentityFile;
    if (reason === 'missing host file') delete supplied.sshKnownHostsFile;
    if (reason === 'extra field') supplied.workspaceId = 'different-workspace';
    if (reason === 'invalid project ID') supplied.sshProjectId = 'project-name';
    if (reason === 'absent file') supplied.sshKnownHostsFile = join(root, 'missing');
    if (reason === 'relative path') supplied.sshIdentityFile = 'identity';
    if (reason === 'unsafe permissions') chmodSync(paths.sshIdentityFile, 0o644);
    const { code, result } = await attach(supplied);
    expect(code).toBe(1);
    expect(result.ok).toBe(false);
    expect(connections.findById(before.id)).toEqual(before);
    expect(audit.findByAction('connection.credentials.updated')).toEqual([]);
  });

  it.each([null, 'owner/*'])('requires a native project restriction when attaching files to shared access (%s)', async selectedScope => {
    const before = existing(selectedScope);
    expect((await attach(paths, selectedScope)).code).toBe(1);
    expect(connections.findById(before.id)).toEqual(before);
    expect(audit.findByAction('connection.credentials.updated')).toEqual([]);
  });

  it.each([{}, { sshProjectId: 'e58e9438-03a9-4617-a72e-80b29d75ded7' }])('keeps existing shared SSH access when a new project restriction would change its reach', async restriction => {
    const before = existing(null, 'verified', { ...primary, ...paths, ...restriction });
    expect((await attach({ ...paths, sshProjectId: projectId }, null)).code).toBe(1);
    expect(connections.findById(before.id)).toEqual(before);
    expect(audit.findByAction('connection.credentials.updated')).toEqual([]);
  });

  it('retains the project restriction when refreshing just the file paths on an exact scope', async () => {
    const before = existing(scope, 'verified', { ...primary, ...paths, sshProjectId: projectId });
    expect((await attach(paths)).code).toBe(0);
    expect(getSecretStore().decryptObject(connections.findById(before.id)!.credentialsEncrypted)).toEqual({ ...primary, projectSsh: { ...paths, sshProjectId: projectId } });
  });

  it('upgrades the initial flat shared representation once when the same project settings are supplied again', async () => {
    const settings = { ...paths, sshProjectId: projectId };
    const original = existing(null, 'verified', { ...primary, ...settings });
    const initialAudit = audit.findByResource('connection', original.id);
    expect(legacyReader.parse({ ...primary, ...settings })).toMatchObject(paths);
    expect((await attach(settings, null)).code).toBe(0);
    const migrated = connections.findById(original.id)!;
    const saved = getSecretStore().decryptObject(migrated.credentialsEncrypted);
    expect(saved).toEqual({ ...primary, projectSsh: settings });
    expect(legacyReader.parse(saved)).toEqual(legacyReader.parse(primary));
    const events = audit.findByResource('connection', original.id);
    expect(events).toHaveLength(initialAudit.length + 1);
    expect(events).toEqual(expect.arrayContaining(initialAudit));
    expect((await attach(settings, null)).code).toBe(0);
    expect(connections.findById(original.id)).toEqual(migrated);
    expect(audit.findByResource('connection', original.id)).toEqual(events);
  });

  it.each([true, false])('keeps full credential replacement compatible with legacy readers (restricted=%s)', async restricted => {
    const before = existing(null, 'verified', { ...primary, ...paths });
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true, workspaceId: 'discovered' });
    const apiToken = 'synthetic-replacement-token';
    const settings = restricted ? { ...paths, sshProjectId: projectId } : paths;
    expect((await attach({ apiToken, ...settings }, null)).code).toBe(0);
    const saved = getSecretStore().decryptObject(connections.findById(before.id)!.credentialsEncrypted);
    expect(saved).toEqual({ apiToken, workspaceId: 'discovered', ...(restricted ? { projectSsh: settings } : paths) });
    expect(legacyReader.parse(saved)).toEqual({ apiToken, workspaceId: 'discovered', ...(!restricted ? paths : {}) });
  });

  it('uses the scoped connection updated by the CLI for the native project SSH preflight', async () => {
    const context = createCommandContext();
    const project = context.repos.projects.create({ name: 'app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/app.git' });
    const otherProjectId = 'e58e9438-03a9-4617-a72e-80b29d75ded7';
    existing(null, 'verified', { ...primary, ...paths, sshProjectId: otherProjectId });
    existing(scope);
    expect((await attach({ ...paths, sshProjectId: projectId })).code).toBe(0);
    const connected = await context.adapterFactory.getHostingAdapterByName('railway', project);
    expect(connected.success).toBe(true);
    const inspection = connected.adapter?.privateMigrationSourceInspection;
    expect(inspection).toBeDefined();
    expect(await inspection!.hasTrustedAccess(projectId, 'inspect')).toBe(true);
    expect(await inspection!.hasTrustedAccess(otherProjectId, 'inspect')).toBe(false);
  });

  it.each(['absent', 'failed'])('requires verified access at the exact scope when its connection is %s', async status => {
    existing(null);
    existing('owner/*');
    if (status === 'failed') existing(scope, 'failed');
    const before = connections.findAllByProvider('railway');
    expect((await attach(paths)).code).toBe(1);
    expect(connections.findAllByProvider('railway')).toEqual(before);
    expect(audit.findByAction('connection.credentials.updated')).toEqual([]);
  });

  it('preserves a concurrent primary rotation between the local file checks and the update', async () => {
    const before = existing(scope);
    const rotated = { ...primary, apiToken: 'synthetic-concurrently-rotated' };
    const update = ConnectionRepository.prototype.updateVerifiedCredentialsIfUnchanged;
    vi.spyOn(ConnectionRepository.prototype, 'updateVerifiedCredentialsIfUnchanged')
      .mockImplementationOnce(function (this: ConnectionRepository, ...args: Parameters<typeof update>) {
        this.updateCredentials(before.id, getSecretStore().encryptObject(rotated));
        this.updateStatus(before.id, 'verified');
        return update.call(this, ...args);
      });
    expect((await attach(paths)).code).toBe(1);
    const stored = connections.findById(before.id)!;
    expect(getSecretStore().decryptObject(stored.credentialsEncrypted)).toEqual(rotated);
    expect(audit.findByAction('connection.credentials.updated')).toEqual([]);
  });

  it('cannot restore the flat SSH paths from a delayed workspace lookup after the CLI upgrades their storage', async () => {
    const settings = { ...paths, sshProjectId: projectId };
    const before = existing(null, 'verified', { apiToken: primary.apiToken, ...settings });
    const verify = () => connectionCommand(['--action', 'verify'], null);
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockImplementationOnce(async () => {
      expect((await attach(settings, null)).code).toBe(0);
      return { success: true, workspaceId: 'discovered' };
    }).mockResolvedValue({ success: true, workspaceId: 'discovered' });
    const stale = await verify();
    expect(stale.code).toBe(1);
    expect(stale.result.error.message).toContain('changed');
    const updated = connections.findById(before.id)!;
    expect(updated.lastVerifiedAt).toEqual(before.lastVerifiedAt);
    expect(getSecretStore().decryptObject(updated.credentialsEncrypted)).toEqual({ apiToken: primary.apiToken, projectSsh: settings });
    expect(audit.findByAction('connection.verified')).toHaveLength(0);
    expect(audit.findByAction('connection.credentials.updated')).toHaveLength(1);
    expect((await verify()).code).toBe(0);
    const current = connections.findById(before.id)!;
    expect(getSecretStore().decryptObject(current.credentialsEncrypted)).toEqual({ apiToken: primary.apiToken, projectSsh: settings, workspaceId: 'discovered' });
    expect(audit.findByAction('connection.verified')).toHaveLength(1);
  });

  it.each(['success', 'failure', 'exception'])('discards a delayed verification %s after a full credential rotation', async outcome => {
    const before = existing(scope, 'verified', { apiToken: primary.apiToken });
    const replacement = { apiToken: 'synthetic-replacement', workspaceId: 'new-workspace' };
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockImplementationOnce(async () => {
      expect((await attach(replacement)).code).toBe(0);
      if (outcome === 'exception') throw new Error('simulated old failure');
      return outcome === 'success' ? { success: true, workspaceId: 'old-workspace' } : { success: false, error: 'simulated old failure' };
    }).mockResolvedValue({ success: true, workspaceId: replacement.workspaceId });
    const stale = await connectionCommand(['--action', 'verify'], scope);
    expect(stale.result.error?.message).toContain('changed');
    const current = connections.findById(before.id)!;
    expect(current.status).toBe('verified');
    expect(getSecretStore().decryptObject(current.credentialsEncrypted)).toEqual(replacement);
    expect(audit.findByAction('connection.failed')).toHaveLength(0);
    expect(audit.findByAction('connection.verified')).toHaveLength(1);
  });

  it('rolls back workspace enrichment and status if the verification audit cannot be recorded', async () => {
    const before = existing(scope, 'failed', { apiToken: primary.apiToken });
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true, workspaceId: 'discovered' });
    vi.spyOn(AuditRepository.prototype, 'create').mockImplementationOnce(() => { throw new Error('simulated audit failure'); });
    const response = await connectionCommand(['--action', 'verify'], scope);
    expect(response.code).toBe(1);
    expect(response.result.error.message).toContain('could not be saved');
    expect(connections.findById(before.id)).toEqual(before);
    expect(audit.findByResource('connection', before.id)).toHaveLength(1);
  });
});
