import { describe, expect, it } from 'vitest';

const runtimeUrl = new URL('../../../../templates/ios/hypervibe-ios-release.mjs', import.meta.url);
const runtime = await import(runtimeUrl.href) as {
  parseReleaseConfig: (env: Record<string, string>, cwd: string) => {
    ipaPath: string;
    groups: string[];
    privateKey: string;
    submitForBetaReview: boolean;
  };
  buildAltoolArgs: (config: Record<string, unknown>) => string[];
  groupNeedsExplicitBuildAssignment: (group: Record<string, unknown>) => boolean;
  buildNeedsComplianceUpdate: (build: Record<string, unknown>, desired: boolean) => boolean;
  buildReleaseManifest: (
    config: Record<string, unknown>,
    evidence: Record<string, unknown>,
    app: { id: string },
    build: { id: string },
    releasedAt: string
  ) => Record<string, any>;
};

const validEnvironment = {
  APP_STORE_CONNECT_KEY_ID: 'KEY123',
  APP_STORE_CONNECT_ISSUER_ID: 'issuer-id',
  APP_STORE_CONNECT_PRIVATE_KEY: 'private\\nkey',
  HYPERVIBE_BUNDLE_ID: 'com.example.app',
  HYPERVIBE_IPA_PATH: 'build/App.ipa',
  HYPERVIBE_BUILD_NUMBER: '42',
  HYPERVIBE_MARKETING_VERSION: '1.2.0',
  HYPERVIBE_TESTFLIGHT_GROUPS: '["Internal","External"]',
  HYPERVIBE_USES_NON_EXEMPT_ENCRYPTION: 'false',
  HYPERVIBE_SUBMIT_BETA_REVIEW: 'true',
  HYPERVIBE_ENVIRONMENT: 'production',
  HYPERVIBE_RELEASE_SHA: 'a'.repeat(40),
  GITHUB_REPOSITORY: 'owner/repo',
};

describe('managed iOS release runtime', () => {
  it('parses the gated release contract without exposing the private key in altool arguments', () => {
    const config = runtime.parseReleaseConfig(validEnvironment, '/repo');
    expect(config.ipaPath).toBe('/repo/build/App.ipa');
    expect(config.groups).toEqual(['Internal', 'External']);
    expect(config.privateKey).toBe('private\nkey');
    expect(config.submitForBetaReview).toBe(true);

    const args = runtime.buildAltoolArgs(config as unknown as Record<string, unknown>);
    expect(args.slice(0, 5)).toEqual(['altool', '--upload-app', '--type', 'ios', '--file']);
    expect(args).not.toContain(config.privateKey);
  });

  it('rejects ambiguous groups and abbreviated release SHAs', () => {
    expect(() => runtime.parseReleaseConfig({
      ...validEnvironment,
      HYPERVIBE_TESTFLIGHT_GROUPS: '["Beta","beta"]',
    }, '/repo')).toThrow(/duplicate/);
    expect(() => runtime.parseReleaseConfig({
      ...validEnvironment,
      HYPERVIBE_RELEASE_SHA: 'abc1234',
    }, '/repo')).toThrow(/40-character/);
  });

  it('skips explicit assignment for groups that already receive all builds', () => {
    expect(runtime.groupNeedsExplicitBuildAssignment({
      attributes: { isInternalGroup: true, hasAccessToAllBuilds: true },
    })).toBe(false);
    expect(runtime.groupNeedsExplicitBuildAssignment({
      attributes: { isInternalGroup: false, hasAccessToAllBuilds: false },
    })).toBe(true);
  });

  it('does not rewrite immutable export compliance after App Store Connect records it', () => {
    expect(runtime.buildNeedsComplianceUpdate({
      attributes: { usesNonExemptEncryption: false },
    }, false)).toBe(false);
    expect(runtime.buildNeedsComplianceUpdate({ attributes: {} }, false)).toBe(true);
    expect(() => runtime.buildNeedsComplianceUpdate({
      attributes: { usesNonExemptEncryption: true },
    }, false)).toThrow(/does not match/);
  });

  it('builds mobile evidence only from matching server evidence', () => {
    const config = runtime.parseReleaseConfig(validEnvironment, '/repo') as unknown as Record<string, unknown>;
    const evidence = {
      version: 2,
      environment: 'production',
      server: { repository: 'owner/repo', sha: 'a'.repeat(40) },
      services: ['web'],
    };
    const manifest = runtime.buildReleaseManifest(
      config,
      evidence,
      { id: 'app-1' },
      { id: 'build-1' },
      '2026-07-30T00:00:00.000Z'
    );
    expect(manifest.mobile.sha).toBe('a'.repeat(40));
    expect(manifest.server.sha).toBe(manifest.mobile.sha);
    expect(manifest.app.testflightGroups).toEqual(['Internal', 'External']);

    expect(() => runtime.buildReleaseManifest(
      config,
      { ...evidence, version: 1 },
      { id: 'app-1' },
      { id: 'build-1' },
      '2026-07-30T00:00:00.000Z'
    )).toThrow(/no longer matches/);

    expect(() => runtime.buildReleaseManifest(
      config,
      { ...evidence, server: { ...evidence.server, sha: 'b'.repeat(40) } },
      { id: 'app-1' },
      { id: 'build-1' },
      '2026-07-30T00:00:00.000Z'
    )).toThrow(/no longer matches/);
  });
});
