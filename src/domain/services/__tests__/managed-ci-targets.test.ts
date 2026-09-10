import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { managedCiEnvironmentBindings } from '../managed-ci-targets.js';

describe('managed CI provider resource identity', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-ci-bindings-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });
  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    { binding: { serviceId: 'service-id', workloadKind: 'cron' }, desired: 'cron', type: 'service', id: 'service-id' },
    { binding: { serviceId: 'service-id' }, desired: 'cron', type: 'service', id: 'service-id' },
    { binding: { serviceId: 'scoped-id', jobName: 'job-name', resourceType: 'scheduledJob', workloadKind: 'cron' }, desired: 'cron', type: 'job', id: 'job-name' },
    { binding: { serviceId: 'job-id', resourceType: 'scheduledJob' }, desired: 'cron', type: 'job', id: 'job-id' },
    { binding: { serviceId: 'service-id', workloadKind: 'worker' }, desired: 'cron', type: null, id: null },
    { binding: { jobName: 'job-name', resourceType: 'scheduledJob' }, desired: 'worker', type: null, id: null },
    { binding: { jobName: 'job-name', resourceType: 'scheduledJob', workloadKind: 'worker' }, desired: undefined, type: null, id: null },
  ] as const)('maps $binding with desired $desired to $type', ({ binding, desired, type, id }) => {
    const project = new ProjectRepository().create({ name: 'bound-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({
      projectId: project.id, name: 'staging',
      platformBindings: { services: { task: binding } },
    });
    const result = managedCiEnvironmentBindings(project.id, 'staging', desired ? { task: desired } : undefined);
    expect(result.releaseResources).toEqual(type ? [{
      logicalName: 'task', workloadKind: desired, providerResourceType: type, providerResourceId: id,
    }] : []);
  });
});
