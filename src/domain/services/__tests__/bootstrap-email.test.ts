import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Service } from '../../entities/service.entity.js';
import type { IHostingAdapter } from '../../ports/hosting.port.js';
import type { Receipt } from '../../ports/provider.port.js';
import { setupBootstrapEmail } from '../bootstrap-email.js';

const FULL_SETUP_SCOPES = [
  'mail.send',
  'whitelabel.read',
  'whitelabel.create',
  'whitelabel.update',
  'user.email.read',
  'user.email.create',
  'user.email.update',
];

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-bootstrap-email-'));
  initializeDatabase(path.join(tempDir, 'hypervibe.db'));
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedSendGridConnection(apiKey = 'SG.test-key') {
  const repo = new ConnectionRepository();
  const conn = repo.create({
    provider: 'sendgrid',
    credentialsEncrypted: getSecretStore().encryptObject({ apiKey }),
  });
  repo.updateStatus(conn.id, 'verified');
}

function seedFixture(projectName: string, serviceNames: string[]): {
  environment: Environment;
  workloads: Service[];
} {
  const project = new ProjectRepository().create({ name: projectName, defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project-1',
      environmentId: 'rail-env-1',
      services: {},
    },
  });
  const serviceRepo = new ServiceRepository();
  const workloads = serviceNames.map((name) =>
    serviceRepo.create({
      projectId: project.id,
      name,
      buildConfig: { builder: 'nixpacks' },
      envVarSpec: {},
    })
  );
  return { environment, workloads };
}

function createHostingAdapter(setEnvVars: IHostingAdapter['setEnvVars']): IHostingAdapter {
  return {
    name: 'railway',
    capabilities: {
      supportedBuilders: ['nixpacks'],
      supportsAutoWiring: true,
      supportsHealthChecks: true,
      supportsCronSchedule: false,
      supportsReleaseCommand: true,
      supportsMultiEnvironment: true,
      managedTls: true,
      supportsAutoScaling: false,
      supportsObserve: false,
    },
    async connect() {},
    async verify() {
      return { success: true };
    },
    async ensureProject() {
      return { success: true, message: 'bound' };
    },
    async deploy() {
      throw new Error('not used');
    },
    setEnvVars,
  };
}

describe('setupBootstrapEmail', () => {
  it('records guidance without failing when no SendGrid connection exists', async () => {
    const { environment, workloads } = seedFixture('bootstrap-email-no-conn-app', ['web']);
    const setEnvVars = vi.fn<IHostingAdapter['setEnvVars']>();

    const summary: Record<string, unknown> = {};
    const result = await setupBootstrapEmail({
      workloads,
      environment,
      hostingAdapter: createHostingAdapter(setEnvVars),
      scopeHints: [],
      summary,
    });

    expect(result.failure).toBeUndefined();
    expect(summary.sendgridApiKeySynced).toBe(false);
    expect(summary.sendgridApiKeySyncError).toContain('No SendGrid connection found');
    expect(setEnvVars).not.toHaveBeenCalled();
  });

  it('returns a failure with the missing scopes when the API key cannot complete setup', async () => {
    seedSendGridConnection();
    const { environment, workloads } = seedFixture('bootstrap-email-scopes-app', ['web']);
    // mail.send only: both domain-authentication and sender-verification
    // scope groups are missing, so setupEmail must hard-stop.
    vi.spyOn(SendGridAdapter.prototype, 'getScopes').mockResolvedValue(['mail.send']);
    const setEnvVars = vi.fn<IHostingAdapter['setEnvVars']>();

    const summary: Record<string, unknown> = {};
    const result = await setupBootstrapEmail({
      workloads,
      environment,
      hostingAdapter: createHostingAdapter(setEnvVars),
      scopeHints: [],
      summary,
    });

    expect(result.failure).toBeDefined();
    expect(result.failure?.success).toBe(false);
    expect(result.failure?.summary.sendgridApiKeySynced).toBe(false);
    expect(result.failure?.summary.sendgridApiKeySyncError).toContain(
      'SendGrid API key is valid but cannot complete setupEmail'
    );
    expect(result.failure?.summary.sendgridMissingScopes).toEqual({
      domainAuthentication: ['whitelabel.read', 'whitelabel.create', 'whitelabel.update'],
      senderVerification: ['user.email.read', 'user.email.create', 'user.email.update'],
    });
    expect(setEnvVars).not.toHaveBeenCalled();
  });

  it('syncs SENDGRID_API_KEY to every workload when scopes are sufficient', async () => {
    seedSendGridConnection('SG.happy-key');
    const { environment, workloads } = seedFixture('bootstrap-email-happy-app', ['web', 'worker']);
    vi.spyOn(SendGridAdapter.prototype, 'getScopes').mockResolvedValue(FULL_SETUP_SCOPES);

    const setEnvVarCalls: Array<{ serviceName: string; vars: Record<string, string> }> = [];
    const setEnvVars = vi.fn(async (_environment: Environment, service: Service, vars: Record<string, string>): Promise<Receipt> => {
      setEnvVarCalls.push({ serviceName: service.name, vars });
      return { success: true, message: 'vars synced' };
    });

    const summary: Record<string, unknown> = {};
    const result = await setupBootstrapEmail({
      workloads,
      environment,
      hostingAdapter: createHostingAdapter(setEnvVars),
      scopeHints: [],
      summary,
    });

    expect(result.failure).toBeUndefined();
    expect(summary.sendgridApiKeySynced).toBe(true);
    expect(summary.sendgridApiKeySyncError).toBeUndefined();
    expect(setEnvVarCalls).toEqual([
      { serviceName: 'web', vars: { SENDGRID_API_KEY: 'SG.happy-key' } },
      { serviceName: 'worker', vars: { SENDGRID_API_KEY: 'SG.happy-key' } },
    ]);
  });

  it('records per-workload sync failures in sendgridApiKeySyncError', async () => {
    seedSendGridConnection();
    const { environment, workloads } = seedFixture('bootstrap-email-sync-failure-app', ['web', 'worker']);
    vi.spyOn(SendGridAdapter.prototype, 'getScopes').mockResolvedValue(FULL_SETUP_SCOPES);

    const setEnvVars = vi.fn(async (_environment: Environment, service: Service): Promise<Receipt> => {
      if (service.name === 'worker') {
        return { success: false, message: 'failed', error: 'Railway rejected the variable update' };
      }
      return { success: true, message: 'vars synced' };
    });

    const summary: Record<string, unknown> = {};
    const result = await setupBootstrapEmail({
      workloads,
      environment,
      hostingAdapter: createHostingAdapter(setEnvVars),
      scopeHints: [],
      summary,
    });

    expect(result.failure).toBeUndefined();
    expect(summary.sendgridApiKeySynced).toBe(false);
    expect(summary.sendgridApiKeySyncError).toBe('worker: Railway rejected the variable update');
    expect(setEnvVars).toHaveBeenCalledTimes(2);
  });
});
