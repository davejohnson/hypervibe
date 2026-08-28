import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommittedSpecInspectionError,
  MAX_COMMITTED_SPEC_BYTES,
  inspectCommittedProjectSpecV1,
  type CommittedSpecInspectionInputV1,
} from '../../hosted.js';

const REVISION = 'a'.repeat(40);

function sourceBytes(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

function inputFor(
  document: unknown,
  overrides: Partial<CommittedSpecInspectionInputV1> = {}
): CommittedSpecInspectionInputV1 {
  const content = sourceBytes(document);
  return {
    schemaVersion: 1,
    provider: 'github',
    repository: {
      id: '123456',
      path: 'acme/demo',
      remoteIdentity: 'github.com/acme/demo',
    },
    revision: REVISION,
    content,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    ...overrides,
  };
}

function validSpec(): Record<string, unknown> {
  return {
    version: 1,
    project: 'demo',
    gitRemoteUrl: 'git@github.com:acme/demo.git',
    devops: {
      code: {
        provider: 'github',
        scope: 'acme/demo',
      },
      ci: {
        provider: 'github-actions',
      },
    },
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: {
          worker: { workloadKind: 'worker' },
          web: { workloadKind: 'web', public: true, healthCheckPath: '/health' },
        },
        database: { provider: 'railway' },
        domain: 'staging.example.com',
        envVars: { FEATURE_FLAG: 'enabled' },
      },
      production: {
        hosting: { provider: 'cloudrun', region: 'us-west1' },
        services: {
          web: { workloadKind: 'web' },
        },
        envVars: {},
      },
    },
  };
}

function captureInspectionError(run: () => unknown): CommittedSpecInspectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CommittedSpecInspectionError);
    return error as CommittedSpecInspectionError;
  }
  throw new Error('Expected committed spec inspection to fail');
}

describe('committed project spec inspection v1', () => {
  it('returns a deterministic, value-free receipt for the exact committed source', () => {
    const input = inputFor(validSpec());

    const receipt = inspectCommittedProjectSpecV1(input);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: 'accepted',
      source: {
        provider: 'github',
        repository: { id: '123456', path: 'acme/demo' },
        revision: REVISION,
        specPath: '.hypervibe/spec.json',
        sha256: input.contentSha256,
        byteLength: input.content.byteLength,
      },
      project: {
        name: 'demo',
        specVersion: 1,
        remoteIdentityVerified: true,
        declaredProviders: [
          { capability: 'ci', provider: 'github-actions' },
          { capability: 'code', provider: 'github' },
        ],
      },
    });
    expect(receipt.environments.map(({ name }) => name)).toEqual(['production', 'staging']);
    expect(receipt.environments[0]).toMatchObject({
      name: 'production',
      hosting: { provider: 'cloudrun', region: 'us-west1' },
      services: [{ name: 'web', workloadKind: 'web', public: true }],
      publicEndpoints: [],
      declaredProviders: [{ capability: 'hosting', provider: 'cloudrun' }],
    });
    expect(receipt.environments[1]).toMatchObject({
      name: 'staging',
      services: [
        { name: 'web', workloadKind: 'web', public: true },
        { name: 'worker', workloadKind: 'worker', public: false },
      ],
      publicEndpoints: [{ url: 'https://staging.example.com', services: ['web'] }],
      declaredProviders: [
        { capability: 'database', provider: 'railway' },
        { capability: 'hosting', provider: 'railway' },
      ],
    });
    expect(JSON.stringify(receipt)).not.toContain('FEATURE_FLAG');
    expect(JSON.stringify(receipt)).not.toContain('enabled');
  });

  it('accepts a spec without a repository claim while keeping trust in verified source context', () => {
    const spec = validSpec();
    delete spec.gitRemoteUrl;

    const receipt = inspectCommittedProjectSpecV1(inputFor(spec));

    expect(receipt.project.remoteIdentityVerified).toBe(false);
    expect(receipt.source.repository.path).toBe('acme/demo');
  });

  it('rejects source larger than the hosted inspection boundary', () => {
    const content = new Uint8Array(MAX_COMMITTED_SPEC_BYTES + 1);
    const error = captureInspectionError(() => inspectCommittedProjectSpecV1({
      ...inputFor(validSpec()),
      content,
      contentSha256: createHash('sha256').update(content).digest('hex'),
    }));

    expect(error.code).toBe('SOURCE_TOO_LARGE');
    expect(error.details).toEqual({ maxBytes: MAX_COMMITTED_SPEC_BYTES });
  });

  it('rejects bytes that do not match the supplied digest', () => {
    const error = captureInspectionError(() => inspectCommittedProjectSpecV1({
      ...inputFor(validSpec()),
      contentSha256: '0'.repeat(64),
    }));

    expect(error.code).toBe('DIGEST_MISMATCH');
    expect(error.message).not.toContain('FEATURE_FLAG');
  });

  it('rejects invalid JSON and invalid desired-state documents with bounded details', () => {
    const invalidJson = new TextEncoder().encode('{');
    const invalidJsonError = captureInspectionError(() => inspectCommittedProjectSpecV1({
      ...inputFor(validSpec()),
      content: invalidJson,
      contentSha256: createHash('sha256').update(invalidJson).digest('hex'),
    }));
    expect(invalidJsonError.code).toBe('INVALID_JSON');
    expect(invalidJsonError.details).toBeUndefined();

    const invalidSpecError = captureInspectionError(() => inspectCommittedProjectSpecV1(inputFor({
      version: 1,
      project: 'demo',
      environments: { staging: {} },
    })));
    expect(invalidSpecError.code).toBe('INVALID_SPEC');
    expect(invalidSpecError.details).toMatchObject({ issues: expect.any(Array) });
    expect((invalidSpecError.details as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('rejects repository identity mismatches from git and DevOps claims', () => {
    const wrongRemote = validSpec();
    wrongRemote.gitRemoteUrl = 'https://github.com/acme/other.git';
    const remoteError = captureInspectionError(() => inspectCommittedProjectSpecV1(inputFor(wrongRemote)));
    expect(remoteError.code).toBe('REPOSITORY_MISMATCH');

    const wrongScope = validSpec();
    (wrongScope.devops as { code: { scope: string } }).code.scope = 'acme/other';
    const scopeError = captureInspectionError(() => inspectCommittedProjectSpecV1(inputFor(wrongScope)));
    expect(scopeError.code).toBe('REPOSITORY_MISMATCH');
  });

  it('rejects secret-shaped values without echoing them', () => {
    const spec = validSpec();
    const secretValue = `github_pat_${'A'.repeat(40)}`;
    ((spec.environments as Record<string, { envVars: Record<string, string> }>).staging.envVars)
      .GITHUB_TOKEN = secretValue;

    const error = captureInspectionError(() => inspectCommittedProjectSpecV1(inputFor(spec)));

    expect(error.code).toBe('SECRET_CONTENT');
    expect(error.message).not.toContain(secretValue);
    expect(error.details).toEqual({ paths: ['environments.staging.envVars.GITHUB_TOKEN'] });
  });

  it('rejects control characters instead of copying them into a hosted receipt', () => {
    const spec = validSpec();
    spec.project = 'demo\nforged-log-line';

    const error = captureInspectionError(() => inspectCommittedProjectSpecV1(inputFor(spec)));

    expect(error.code).toBe('INVALID_SPEC');
    expect(error.details).toEqual({
      issues: [{ path: 'project', code: 'unsafe_receipt_value' }],
    });
    expect(error.message).not.toContain('forged-log-line');
  });
});
