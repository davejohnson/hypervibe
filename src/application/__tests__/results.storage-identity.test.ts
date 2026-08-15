import { describe, expect, it } from 'vitest';
import { commandSuccess, formatCommandEnvelope } from '../results.js';
import type { ObservedStorage } from '../../domain/ports/observe.port.js';

describe('storage identity result formatting', () => {
  it('shows the provider resource id beside its environment scope', () => {
    const output = formatCommandEnvelope(commandSuccess({
      provider: 'railway',
      mode: 'storage',
      observed: {
        storage: [{
          provider: 'railway',
          kind: 'object',
          externalId: 'bucket-documents',
          instanceScope: { projectId: 'railway-project', environmentId: 'railway-production' },
          name: 'documents',
          status: 'ready',
          objectCount: 52,
          sizeBytes: 48_744_788,
        }],
        completeness: 'complete',
      },
    }));

    expect(output).toContain('Storage: 1');
    expect(output).toContain('resource bucket-documents');
    expect(output).toContain('scope projectId=railway-project / environmentId=railway-production');
  });

  it('shows opaque provider-native identity scope fields', () => {
    const storage = {
      provider: 's3',
      kind: 'object',
      externalId: 'documents-production',
      instanceScope: { accountId: 'aws-account', region: 'us-west-2' },
      name: 'documents',
      status: 'ready',
    } satisfies ObservedStorage;

    const output = formatCommandEnvelope(commandSuccess({ observed: { storage: [storage] } }));

    expect(output).toContain('resource documents-production');
    expect(output).toContain('scope accountId=aws-account / region=us-west-2');
  });
});
