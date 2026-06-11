import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import {
  updateServiceInDesiredState,
  removeServiceFromDesiredState,
  serviceBindingFor,
  removeServiceBinding,
} from '../spec.service.js';

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-spec-mutations-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
});

const DESIRED = {
  environmentName: 'production',
  services: ['web'],
  crons: {
    cron: { schedule: '*/5 * * * *', command: 'npm run cron' },
  },
};

describe('updateServiceInDesiredState', () => {
  it('updates a cron schedule and command from build config', () => {
    const next = updateServiceInDesiredState(DESIRED, 'cron', 'cron', {
      workloadKind: 'cron',
      startCommand: 'npm run nightly',
      cronSchedule: '0 3 * * *',
    });
    expect(next).toMatchObject({
      crons: { cron: { schedule: '0 3 * * *', command: 'npm run nightly' } },
    });
  });

  it('returns undefined when no desired state exists', () => {
    expect(updateServiceInDesiredState(undefined, 'cron', 'cron', {})).toBeUndefined();
  });
});

describe('removeServiceFromDesiredState', () => {
  it('removes the service from both services and crons', () => {
    const next = removeServiceFromDesiredState(DESIRED, 'cron')!;
    expect(next.crons).toEqual({});
    expect(next.services).toEqual(['web']);

    const webGone = removeServiceFromDesiredState(DESIRED, 'web')!;
    expect(webGone.services).toEqual([]);
  });
});

describe('service bindings', () => {
  it('finds and removes a service binding on the environment', () => {
    const project = new ProjectRepository().create({ name: 'binding-app' });
    const envRepo = new EnvironmentRepository();
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          cron: { serviceId: 'gcp-project-cron-schedule', resourceType: 'scheduledJob' },
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });

    const binding = serviceBindingFor(environment, 'cron');
    expect(binding).toMatchObject({ serviceId: 'gcp-project-cron-schedule' });

    removeServiceBinding(environment.id, environment, 'cron');
    const reloaded = envRepo.findById(environment.id)!;
    const services = reloaded.platformBindings.services as Record<string, unknown>;
    expect(services.cron).toBeUndefined();
    expect(services.web).toBeDefined();
  });
});
