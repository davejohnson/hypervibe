import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { operatorOutputPrerequisiteKeys } from '../operator-application.service.js';
import { providerRegistry } from '../../registry/provider.registry.js';
describe('operator output prerequisites', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-output-prerequisite-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('does not prepare a private destination for an unregistered output role', async () => {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun' });
    vi.spyOn(providerRegistry, 'getOperatorApplication').mockReturnValue({ privateOutputRoles: [] } as any);
    await expect(operatorOutputPrerequisiteKeys(project, 'test', { environments: { test: { hosting: { provider: 'cloudrun' }, operatorApplications: {
      azure: { provider: 'microsoft-entra', outputs: { 'client-secret': 'AZURE_CLIENT_SECRET' } },
    } } } } as any)).rejects.toThrow(/operator application/i);
  });
  it('selects only declared output destinations before any private credentials are issued', async () => {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun' });
    vi.spyOn(providerRegistry, 'getOperatorApplication').mockReturnValue({ privateOutputRoles: ['secret-key'] } as any);
    vi.spyOn(providerRegistry, 'getOperatorOutputDelivery').mockReturnValue({ providers: ['gcp-secret-manager'] } as any);
    expect(await operatorOutputPrerequisiteKeys(project, 'test', { environments: { test: { hosting: { provider: 'cloudrun' }, operatorApplications: {
      captcha: { provider: 'google-recaptcha', outputs: { 'secret-key': 'CAPTCHA_SECRET' } },
    }, secretDestinations: { CAPTCHA_SECRET: { destination: { provider: 'gcp-secret-manager' } }, UNRELATED: { destination: { provider: 'gcp-secret-manager' } } } } } } as any)).toEqual(['CAPTCHA_SECRET']);
  });
});
