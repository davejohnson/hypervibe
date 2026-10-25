import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { collaborationSpecSchema, projectSpecSchema } from '../domain/spec/spec.schema.js';
import { credentialFieldsFromSchema } from '../domain/services/connection-guidance.js';

// Compatibility requirements come from ARCHITECTURE.md: omitted desired-state
// features do not silently become new intent; reviews remain explicitly opt-in.
// Zod's migration guide documents the changed default/optional behavior:
// https://zod.dev/v4/changelog#default-updates
// https://zod.dev/v4/changelog#defaults-applied-within-optional-fields

describe('Zod migration compatibility', () => {
  it('retains omitted optional intent and the legacy normalized spec shape', () => {
    expect(projectSpecSchema.parse({
      version: 1, project: 'sample',
      environments: { production: { hosting: { provider: 'railway' } } },
    })).toEqual({
      version: 1, project: 'sample', secrets: {},
      environments: {
        production: { hosting: { provider: 'railway' }, services: {}, email: { enabled: false }, envVars: {} },
      },
    });
  });

  it('still parses nested defaults without enabling mandatory reviews', () => {
    expect(collaborationSpecSchema.parse(undefined)).toEqual({
      provider: 'github', enabled: true,
      issues: { enabled: true, labels: [], templates: true },
      pullRequests: {
        targetBranch: 'main', requirePr: true, requireReview: false, requiredReviewers: 1,
        dismissStaleReviews: false, requireCodeOwnerReviews: false,
        requireStatusChecks: false, statusChecks: [], strictStatusChecks: true, enforceAdmins: false,
      },
      collaborators: [],
    });
  });

  it('keeps safe field guidance for refined and wrapped provider credentials', () => {
    const credentials = z.object({
      token: z.string().min(1),
      mode: z.enum(['read', 'write']).default('read').optional(),
    }).refine(value => value.token.length > 0).brand<'CredentialInput'>();
    expect(credentialFieldsFromSchema(credentials)).toEqual([
      { name: 'token', label: 'Token', required: true, sensitive: true, inputKind: 'secret' },
      { name: 'mode', label: 'Mode', required: false, sensitive: false, inputKind: 'choice', options: ['read', 'write'] },
    ]);
  });
});
