import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { secretDestinationSchema } from '../../domain/ports/secret-destination.port.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

// Reconstructed from the upstream security contract, not a live denial-of-service
// reproduction: https://github.com/colinhacks/zod/commit/a0ebf97
// Oversized constrained collections must stop before validating each element.
describe('schema resource bounds', () => {
  it('rejects an oversized collection before accumulating element issues', () => {
    const schema = z.object({ entries: z.array(z.string()).max(4) });
    const result = schema.safeParse({ entries: [1, 2, 3, 4, 5] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Oversized collection was accepted.');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({
      code: 'too_big', path: ['entries'],
    });
  });

  it('does not run element refinements past the declared collection bound', () => {
    let inspected = 0;
    const schema = z.array(z.string().refine(() => { inspected += 1; return true; })).max(1);

    expect(schema.safeParse(['one', 'two']).success).toBe(false);
    expect(inspected).toBe(0);
    expect(schema.parse(['one'])).toEqual(['one']);
    expect(inspected).toBe(1);
  });

  it('preserves the established GUID grammar for retained Azure destinations', () => {
    // Zod's migration guide distinguishes the former GUID-shaped uuid parser
    // from v4's stricter RFC variant checks: https://zod.dev/v4/changelog
    // This is a compatibility fixture, not evidence of a live Azure identity.
    const retained = {
      provider: 'azure-key-vault', tenantId: '11111111-1111-1111-1111-111111111111',
      subscriptionId: '22222222-2222-2222-2222-222222222222', resourceGroup: 'example',
      vaultName: 'example-vault', secretName: 'example-secret',
    };
    expect(secretDestinationSchema.safeParse(retained).success).toBe(true);
    expect(secretDestinationSchema.safeParse({ ...retained, tenantId: 'not-a-guid' }).success).toBe(false);
  });

  it('keeps optional desired-state defaults absent until their section is declared', () => {
    const spec = { version: 1, project: 'schema-compatibility', github: {},
      environments: { production: { hosting: { provider: 'railway' } } } };
    const parsed = projectSpecSchema.parse(spec);
    expect(parsed).not.toHaveProperty('collaboration');
    expect(parsed.environments.production).not.toHaveProperty('envFile');
    expect(projectSpecSchema.parse({ ...spec, environments: { production: {
      ...spec.environments.production, envFile: {},
    } } }).environments.production?.envFile).toEqual({ mode: 'runtime', include: [], exclude: [] });
  });
});
