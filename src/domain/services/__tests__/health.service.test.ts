import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import {
  joinUrl,
  normalizeBaseUrl,
  resolveHealthEnvironment,
  resolveHealthService,
  resolveServiceBaseUrl,
  runHttpCheck,
} from '../health.service.js';

const DEFAULT_CHECK = {
  method: 'GET' as const,
  timeoutMs: 20000,
  followRedirects: false,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  bodyPreviewBytes: 2048,
};

describe('health.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-health-service-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCloudRunProject(url = 'https://web.example.run.app') {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({
      name: 'health-project',
      defaultPlatform: 'cloudrun',
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: {
            serviceId: 'health-project-production-web',
            url,
          },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        workloadKind: 'web',
        startCommand: 'npm start',
        healthCheckPath: '/api/health',
      },
      envVarSpec: {},
    });
    return project;
  }

  it('checks the stored service health path and root route', async () => {
    const project = createCloudRunProject();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://web.example.run.app/api/health') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://web.example.run.app/') {
        return new Response('', {
          status: 302,
          headers: { location: '/login', 'set-cookie': 'sid=secret; HttpOnly; Secure; SameSite=Lax' },
        });
      }
      throw new Error(`Unexpected health check request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const environment = resolveHealthEnvironment(project.id, 'production');
    expect(environment).not.toBeNull();
    const service = resolveHealthService(project.id, 'web');
    expect(service).not.toBeNull();

    const baseUrl = resolveServiceBaseUrl(environment!, service!.name);
    expect(baseUrl).toBe('https://web.example.run.app');

    const healthPath = service!.buildConfig.healthCheckPath ?? '/';
    const checks = await Promise.all([
      runHttpCheck({ ...DEFAULT_CHECK, name: 'health', url: joinUrl(baseUrl!, healthPath) }),
      runHttpCheck({ ...DEFAULT_CHECK, name: 'root', url: joinUrl(baseUrl!, '/') }),
    ]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      name: 'health',
      url: 'https://web.example.run.app/api/health',
      ok: true,
      status: 200,
      json: { ok: true },
    });
    expect(checks[1]).toMatchObject({
      name: 'root',
      url: 'https://web.example.run.app/',
      ok: true,
      status: 302,
    });
    expect(checks[1].setCookie?.headers).toEqual([
      'sid=***; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('checks an explicit URL without requiring a project', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const check = await runHttpCheck({
      ...DEFAULT_CHECK,
      name: 'health',
      url: 'https://example.com/api/health?ready=true',
    });

    expect(check).toMatchObject({
      name: 'health',
      url: 'https://example.com/api/health?ready=true',
      ok: true,
      status: 200,
      bodyPreview: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api/health?ready=true', expect.any(Object));
  });

  it('returns no base URL when no service URL is stored', () => {
    const project = createCloudRunProject('');

    const environment = resolveHealthEnvironment(project.id);
    expect(environment?.name).toBe('production');
    const service = resolveHealthService(project.id);
    expect(service?.name).toBe('web');

    expect(resolveServiceBaseUrl(environment!, service!.name)).toBeNull();
  });

  it('normalizes hosts and joins paths', () => {
    expect(normalizeBaseUrl('web.example.run.app/')).toBe('https://web.example.run.app');
    expect(joinUrl('https://web.example.run.app', 'api/health')).toBe('https://web.example.run.app/api/health');
  });
});
