import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function parse(action: Record<string, unknown>) {
  return projectSpecSchema.safeParse({ version: 1, project: 'security-check', environments: {}, github: { actions: { security: action } } });
}

describe('managed advisory review desired state', () => {
  it('accepts an isolated daily read-only review without application commands or credentials', () => {
    const result = parse({ kind: 'security-review' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.github?.actions.security).toEqual({
      kind: 'security-review', enabled: true, schedule: { cron: '17 5 * * *', timezone: 'UTC' },
      lockfilePaths: ['package-lock.json'], publicPackageNames: [], nodeVersions: [],
    });
  });

  it('accepts explicit monorepo paths, public scoped packages and runtime selectors', () => {
    expect(parse({ kind: 'security-review', lockfilePaths: ['apps/web/package-lock.json'],
      publicPackageNames: ['@public/package', 'express'], nodeVersions: ['24.11.0', '22'] }).success).toBe(true);
  });

  it.each([
    { lockfilePaths: [] }, { lockfilePaths: ['../package-lock.json'] }, { lockfilePaths: ['/tmp/package-lock.json'] },
    { lockfilePaths: ['.env'] }, { lockfilePaths: ['apps/${{secrets.TOKEN}}/package-lock.json'] },
    { lockfilePaths: ['package-lock.json', 'package-lock.json'] },
    { lockfilePaths: ['x'.repeat(225) + '/package-lock.json'] },
    { publicPackageNames: ['https://private.example/pkg'] }, { publicPackageNames: ['@private/pkg\n'] },
    { publicPackageNames: ['express', 'express'] }, { nodeVersions: ['24;curl bad'] },
    { commands: ['npm install'] }, { token: 'do-not-persist' },
  ])('rejects unsafe or unsupported execution configuration: %j', (fields) => {
    expect(parse({ kind: 'security-review', ...fields }).success).toBe(false);
  });
});
