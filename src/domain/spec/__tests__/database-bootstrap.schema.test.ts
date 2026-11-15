import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../spec.schema.js';

const image = `ghcr.io/example/app@sha256:${'a'.repeat(64)}`;
const environment = {
  hosting: { provider: 'railway' }, services: { web: {}, worker: { workloadKind: 'worker' } },
  migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
  database: { provider: 'railway', freshInitialization: { id: 'fresh-production', discardExistingData: true,
    target: { externalId: 'database-service', providerScope: { projectId: 'project', environmentId: 'production' } },
    bootstrap: { service: 'web', image },
  } },
};

describe('fresh database schema bootstrap declaration', () => {
  it('accepts an explicitly reviewed immutable app image while keeping durable migration configuration', () => {
    const parsed = environmentSpecSchema.safeParse(environment);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.migrations?.command).toBe('npm run migrate');
      expect(parsed.data.database?.seedCommand).toBeUndefined();
      expect(parsed.data.database?.freshInitialization?.bootstrap).toEqual({ service: 'web', image });
    }
  });
  it.each(['ghcr.io/example/app:latest', 'ghcr.io/example/app:source-sha', 'https://user:secret@example.com/image'])(
    'rejects mutable or credential-bearing image input: %s', selectedImage => {
      expect(environmentSpecSchema.safeParse({ ...environment, database: { ...environment.database,
        freshInitialization: { ...environment.database.freshInitialization, bootstrap: { service: 'web', image: selectedImage } },
      } }).success).toBe(false);
    });
  it('requires the selected application service to be declared', () => {
    expect(environmentSpecSchema.safeParse({ ...environment, database: { ...environment.database,
      freshInitialization: { ...environment.database.freshInitialization, bootstrap: { service: 'missing', image } },
    } }).success).toBe(false);
  });
});
