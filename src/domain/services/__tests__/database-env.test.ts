import { describe, expect, it } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import { buildDatabaseEnvVarsFromComponent } from '../database-env.js';

describe('database read replica environment wiring', () => {
  it('projects named and single-replica read URLs without exposing them outside env sync', () => {
    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'primary-1',
      bindings: {
        provider: 'cloudsql',
        connectionName: 'project:us-central1:primary-1',
        username: 'app',
        password: 'secret',
        database: 'app',
        resilience: {
          replicas: {
            analytics: { connectionName: 'project:us-west1:replica-1', externalId: 'replica-1' },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    const env = buildDatabaseEnvVarsFromComponent(component).envVars;
    expect(env.CLOUD_SQL_CONNECTION_NAME).toBe('project:us-central1:primary-1,project:us-west1:replica-1');
    expect(env.DATABASE_READ_URL_ANALYTICS).toContain('%2Fcloudsql%2Fproject%3Aus-west1%3Areplica-1');
    expect(env.DATABASE_READ_URL).toBe(env.DATABASE_READ_URL_ANALYTICS);
    expect(env.DATABASE_URL).toContain('%2Fcloudsql%2Fproject%3Aus-central1%3Aprimary-1');
  });

  it('omits the ambiguous default read URL when multiple replicas are declared', () => {
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1', createdAt: now, updatedAt: now,
      bindings: {
        provider: 'cloudsql', connectionName: 'p:r:primary', username: 'app', password: 'secret', database: 'app',
        resilience: { replicas: { east: { connectionName: 'p:e:east' }, west: { connectionName: 'p:w:west' } } },
      },
    };
    const env = buildDatabaseEnvVarsFromComponent(component).envVars;
    expect(env.DATABASE_READ_URL).toBeUndefined();
    expect(env.DATABASE_READ_URL_EAST).toBeTruthy();
    expect(env.DATABASE_READ_URL_WEST).toBeTruthy();
  });
});
