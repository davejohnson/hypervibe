import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  cacheSpecSchema,
  collaborationSpecSchema,
  deploySpecSchema,
  domainRegistrationSpecSchema,
  envFileSpecSchema,
  environmentSpecSchema,
  githubSpecSchema,
  iosSpecSchema,
  iosTestflightGroupSpecSchema,
  migrationsSpecSchema,
  projectSpecSchema,
  serviceSpecSchema,
} from '../spec.schema.js';

function expectUnknownKeyRejected(result: z.ZodSafeParseResult<unknown>, key: string): void {
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'unrecognized_keys', keys: expect.arrayContaining([key]) }),
  ]));
}

describe('desired-state object strictness', () => {
  it.each([
    ['service', serviceSpecSchema, { startComand: 'npm start' }, 'startComand'],
    ['cache', cacheSpecSchema, { provider: 'railway', engin: 'redis' }, 'engin'],
    ['deploy', deploySpecSchema, { strategy: 'manual', autoDeply: true }, 'autoDeply'],
    ['migrations', migrationsSpecSchema, { mode: 'none', runInDeply: false }, 'runInDeply'],
    ['env file', envFileSpecSchema, { mode: 'off', incldue: [] }, 'incldue'],
    ['domain registration', domainRegistrationSpecSchema, { autoRenw: true }, 'autoRenw'],
    ['TestFlight group', iosTestflightGroupSpecSchema, { testres: [] }, 'testres'],
  ] as const)('rejects unknown %s fields', (_name, schema, value, key) => {
    expectUnknownKeyRejected(schema.safeParse(value), key);
  });

  it('rejects unknown project, environment, and hosting fields', () => {
    const base = {
      version: 1,
      project: 'strict-spec',
      environments: {
        production: { hosting: { provider: 'railway' } },
      },
    };

    expectUnknownKeyRejected(projectSpecSchema.safeParse({ ...base, environmnts: {} }), 'environmnts');
    expectUnknownKeyRejected(projectSpecSchema.safeParse({
      ...base,
      environments: {
        production: { ...base.environments.production, servces: {} },
      },
    }), 'servces');
    expectUnknownKeyRejected(projectSpecSchema.safeParse({
      ...base,
      environments: {
        production: { hosting: { provider: 'railway', regoin: 'iad' } },
      },
    }), 'regoin');
  });

  it('rejects unknown fields in formerly permissive nested specs', () => {
    expectUnknownKeyRejected(collaborationSpecSchema.safeParse({
      issues: { enabled: true, lables: [] },
    }), 'lables');

    expectUnknownKeyRejected(githubSpecSchema.safeParse({
      collaboration: { issues: { enabled: true, lables: [] } },
    }), 'lables');

    expectUnknownKeyRejected(iosSpecSchema.safeParse({
      bundleId: 'com.example.app',
      testflight: { groups: {}, grops: {} },
    }), 'grops');
  });

  it('still applies defaults to valid strict objects', () => {
    expect(environmentSpecSchema.parse({ hosting: { provider: 'railway' } })).toMatchObject({
      hosting: { provider: 'railway' },
      services: {},
    });
  });
});
