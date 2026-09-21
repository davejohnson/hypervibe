import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, projectSpecSchema, serviceSpecSchema } from '../spec.schema.js';

// Independent product requirement: HYPERVIBE_ credentials belong to
// orchestration/CI, never to hosted application runtime.
describe('reserved Hypervibe runtime namespace', () => {
  it('rejects explicit runtime values without echoing them in validation errors', () => {
    const result = environmentSpecSchema.safeParse({ hosting: { provider: 'railway' }, envVars: { HYPERVIBE_CUSTOM_SECRET: 'private-value' } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).not.toContain('private-value');
  });
  it('rejects database aliases into the reserved namespace', () => {
    expect(serviceSpecSchema.safeParse({ databaseEnvAliases: { HYPERVIBE_DATABASE_URL: 'DATABASE_URL' } }).success).toBe(false);
  });
  it('rejects generated secrets with reserved runtime names', () => {
    const result = projectSpecSchema.safeParse({ version: 1, project: 'app', environments: { production: { hosting: { provider: 'railway' } } },
      secrets: { HYPERVIBE_SESSION_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['production'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('HYPERVIBE_');
  });
  it('permits explicit removal of a previously leaked reserved key', () => {
    expect(environmentSpecSchema.safeParse({ hosting: { provider: 'railway' }, removeEnvVars: ['HYPERVIBE_CUSTOM_SECRET'] }).success).toBe(true);
  });
  it.each([{ environments: ['production'] }, { environments: [] }])('restricts delegated runtime destinations $environments while allowing CI-only use', ({ environments }) => {
    const result = projectSpecSchema.safeParse({ version: 1, project: 'app', github: { enabled: true }, environments: { production: { hosting: { provider: 'railway' } } },
      secrets: { HYPERVIBE_REPORTING_TOKEN: { principal: 'email:owner@example.com', environments, githubActions: { repository: true } } },
    });
    expect(result.success).toBe(environments.length === 0);
    if (environments.length && !result.success) expect(result.error.message).toContain('HYPERVIBE_');
  });
});
