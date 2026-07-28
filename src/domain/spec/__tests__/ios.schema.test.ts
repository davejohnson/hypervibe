import { describe, expect, it } from 'vitest';
import { iosSpecSchema, environmentSpecSchema } from '../spec.schema.js';

describe('iosSpecSchema', () => {
  it('applies defaults', () => {
    const ios = iosSpecSchema.parse({ bundleId: 'com.example.app' });
    expect(ios.platform).toBe('IOS');
    expect(ios.capabilities).toEqual([]);
    expect(ios.testflight).toBeUndefined();
  });

  it('parses a full testflight declaration', () => {
    const ios = iosSpecSchema.parse({
      bundleId: 'com.example.app',
      appName: 'Example',
      capabilities: ['PUSH_NOTIFICATIONS'],
      testflight: {
        groups: {
          'External Testers': {
            publicLinkEnabled: true,
            publicLinkLimit: 100,
            testers: ['a@example.com'],
          },
        },
      },
    });
    const group = ios.testflight!.groups['External Testers'];
    expect(group.internal).toBe(false);
    expect(group.publicLinkLimit).toBe(100);
    expect(group.testers).toEqual(['a@example.com']);
  });

  it('rejects a malformed bundle id', () => {
    expect(iosSpecSchema.safeParse({ bundleId: '.bad id' }).success).toBe(false);
  });

  it('rejects publicLinkLimit without publicLinkEnabled', () => {
    const result = iosSpecSchema.safeParse({
      bundleId: 'com.example.app',
      testflight: { groups: { beta: { publicLinkLimit: 50 } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain('publicLinkLimit requires publicLinkEnabled');
  });

  it('rejects internal groups with a public link', () => {
    const result = iosSpecSchema.safeParse({
      bundleId: 'com.example.app',
      testflight: { groups: { team: { internal: true, publicLinkEnabled: true } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain('internal groups cannot have a public link');
  });

  it('rejects invalid tester emails', () => {
    const result = iosSpecSchema.safeParse({
      bundleId: 'com.example.app',
      testflight: { groups: { beta: { testers: ['not-an-email'] } } },
    });
    expect(result.success).toBe(false);
  });

  it('is optional on the environment spec', () => {
    const env = environmentSpecSchema.parse({ hosting: { provider: 'railway' } });
    expect(env.ios).toBeUndefined();

    const withIos = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      ios: { bundleId: 'com.example.app' },
    });
    expect(withIos.ios?.bundleId).toBe('com.example.app');
  });

  it('parses a gated managed iOS release and rejects unsafe release input', () => {
    const env = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci' },
      ios: {
        bundleId: 'com.example.app',
        testflight: { groups: { beta: {} } },
        release: {
          services: ['web'],
          build: {
            workingDirectory: 'apps/ios',
            command: 'bundle exec fastlane build',
            ipaPath: 'build/Example.ipa',
            requiredSecrets: ['MATCH_PASSWORD'],
          },
          testflight: { groups: ['beta'] },
        },
      },
    });
    expect(env.ios?.release).toMatchObject({
      trigger: 'after-server-deploy',
      services: ['web'],
      build: { workingDirectory: 'apps/ios', ipaPath: 'build/Example.ipa' },
      testflight: {
        groups: ['beta'],
        usesNonExemptEncryption: false,
        scriptPath: 'scripts/hypervibe-ios-release.mjs',
      },
    });

    const unsafe = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci' },
      ios: {
        bundleId: 'com.example.app',
        testflight: { groups: { beta: {} } },
        release: {
          services: ['web'],
          build: {
            command: 'echo ${{ secrets.BAD }}',
            ipaPath: '../Example.ipa',
          },
          testflight: { groups: ['missing'] },
        },
      },
    });
    expect(unsafe.success).toBe(false);
    expect(unsafe.success ? '' : unsafe.error.message).toContain('cannot contain GitHub expression');
    expect(unsafe.success ? '' : unsafe.error.message).toContain('repository-relative');
    expect(unsafe.success ? '' : unsafe.error.message).toContain('not declared');

    const unsafeScript = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci' },
      ios: {
        bundleId: 'com.example.app',
        testflight: { groups: { beta: {} } },
        release: {
          services: ['web'],
          build: { command: 'make ipa', ipaPath: 'Example.ipa' },
          testflight: { groups: ['beta'], scriptPath: '../release.sh' },
        },
      },
    });
    expect(unsafeScript.success).toBe(false);
    expect(unsafeScript.success ? '' : unsafeScript.error.message).toContain('scriptPath');
  });

  it('requires CI branch deploys and known server services for release gates', () => {
    const result = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      ios: {
        bundleId: 'com.example.app',
        testflight: { groups: { beta: {} } },
        release: {
          services: ['api'],
          build: { command: 'make ipa', ipaPath: 'Example.ipa' },
          testflight: { groups: ['beta'] },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('unknown service');
    expect(result.success ? '' : result.error.message).toContain('deploy.strategy');
  });
});
