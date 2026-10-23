import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { iosSpecSchema, environmentSpecSchema, projectSpecSchema } from '../spec.schema.js';
import { buildIosReleaseWorkflow } from '../../services/ios-release-workflow.service.js';

function renderedBuildSecretEnvironment(name: string, signing: 'project' | 'match'): Record<string, string> {
  const ios = iosSpecSchema.parse({
    bundleId: 'com.example.staging', testflight: { groups: { beta: {} } },
    release: {
      services: ['web'], signing: { provider: signing }, testflight: { groups: ['beta'] },
      build: { command: 'make ipa', ipaPath: 'App.ipa', credentialsEnvironment: 'production', requiredSecrets: [name] },
    },
  });
  const rendered = buildIosReleaseWorkflow({
    provider: 'railway', providerName: 'Railway', serverWorkflowPath: '.github/workflows/deploy-staging.yml', ios,
    target: {
      environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true,
      serviceNames: ['web'], providerServiceIds: ['web-id'], programFingerprint: 'a'.repeat(64),
      releaseTarget: {
        scope: { providerProjectId: 'project', providerEnvironmentId: 'staging' }, bindingsFingerprint: 'b'.repeat(64),
        resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-id' }],
      },
    },
  })!;
  return parse(rendered.files[0].content).jobs.build.steps.find((step: { name?: string }) => step.name === 'Build signed IPA').env;
}

describe('iosSpecSchema', () => {
  // GitHub references secret names case-insensitively, including environment secrets.
  // https://docs.github.com/en/actions/reference/security/secrets
  const reservedBuildKeys = [
    'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_PRIVATE_KEY',
    'MATCH_GIT_URL', 'MATCH_PASSWORD', 'MATCH_GIT_BASIC_AUTHORIZATION',
  ];
  it.each(reservedBuildKeys.flatMap(key => [key.toLowerCase(), key.slice(0, 1) + key.slice(1).toLowerCase()]))(
    'rejects reserved key %s before rendering a build with production credentials', name => {
      expect(() => renderedBuildSecretEnvironment(name, 'match')).toThrow('reserved for the Hypervibe-managed release boundary');
    }
  );

  it.each(['MATCH_GIT_URL', 'MATCH_PASSWORD', 'MATCH_GIT_BASIC_AUTHORIZATION'].flatMap(key => [key, key.toLowerCase()]))(
    'keeps explicitly requested project-owned signing key %s available to the build', name => {
      expect(renderedBuildSecretEnvironment(name, 'project')).toEqual({ [name]: '${{ secrets.' + name + ' }}' });
    }
  );

  it('preserves ordinary mixed-case build secret names', () => {
    expect(renderedBuildSecretEnvironment('Build_token', 'match')).toEqual({ Build_token: '${{ secrets.Build_token }}' });
  });

  it('reserves the managed build-number handoff against project secret overrides', () => {
    const result = iosSpecSchema.safeParse({
      bundleId: 'com.example.app',
      testflight: { groups: { beta: {} } },
      release: {
        services: ['web'],
        build: { command: 'make ipa', ipaPath: 'Example.ipa', requiredSecrets: ['HYPERVIBE_BUILD_NUMBER'] },
        testflight: { groups: ['beta'] },
      },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('HYPERVIBE_BUILD_NUMBER is reserved');
  });

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
            requiredSecrets: ['SENTRY_AUTH_TOKEN'],
          },
          signing: { provider: 'match', gitBranch: 'main' },
          testflight: { groups: ['beta'] },
        },
      },
    });
    expect(env.ios?.release).toMatchObject({
      trigger: 'after-server-deploy',
      services: ['web'],
      build: { workingDirectory: 'apps/ios', ipaPath: 'build/Example.ipa' },
      signing: { provider: 'match', gitBranch: 'main' },
      testflight: {
        groups: ['beta'],
        usesNonExemptEncryption: false,
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
          testflight: { groups: ['beta'], scriptPath: 'scripts/custom-release.mjs' },
        },
      },
    });
    expect(unsafeScript.success).toBe(false);
    expect(unsafeScript.success ? '' : unsafeScript.error.message).toContain('managed by Hypervibe');

    const leakedSigningSecret = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci' },
      ios: {
        bundleId: 'com.example.app',
        testflight: { groups: { beta: {} } },
        release: {
          services: ['web'],
          build: {
            command: 'make ipa',
            ipaPath: 'Example.ipa',
            requiredSecrets: ['MATCH_PASSWORD', 'APP_STORE_CONNECT_PRIVATE_KEY'],
          },
          signing: { provider: 'match' },
          testflight: { groups: ['beta'] },
        },
      },
    });
    expect(leakedSigningSecret.success).toBe(false);
    expect(leakedSigningSecret.success ? '' : leakedSigningSecret.error.message).toContain(
      'reserved for the Hypervibe-managed release boundary'
    );
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


describe('iOS release selection and promotion', () => {
  const ios = () => ({
    bundleId: 'com.example.app', testflight: { groups: { beta: {} } },
    release: { services: ['api'], build: { command: 'make ipa', ipaPath: 'App.ipa', inputs: ['apps/ios', 'shared'] }, testflight: { groups: ['beta'] } },
  });
  it('accepts explicit mobile inputs and rejects globs, traversal, and empty lists', () => {
    expect(iosSpecSchema.safeParse(ios()).success).toBe(true);
    for (const inputs of [[], ['../ios'], ['apps/**'], ['/ios'], ['!web']]) {
      const value = ios(); value.release.build.inputs = inputs;
      expect(iosSpecSchema.safeParse(value).success).toBe(false);
    }
  });
  it('promotes only from a compatible existing app with a manual target', () => {
    const environment = () => ({ hosting: { provider: 'railway' }, services: { api: {} }, deploy: { strategy: 'branch', trigger: 'ci' }, ios: ios() });
    const value = { version: 1, project: 'example', environments: { staging: environment(), production: environment() } };
    Object.assign(value.environments.production.ios.release, { promoteFrom: 'staging', trigger: 'manual' });
    expect(projectSpecSchema.safeParse(value).success).toBe(true);
    value.environments.staging.ios.bundleId = 'com.example.other';
    expect(projectSpecSchema.safeParse(value).success).toBe(false);
  });
});

describe('iOS build credential environment', () => {
  const declaration = (credentialsEnvironment?: unknown) => ({
    bundleId: 'com.example.app', testflight: { groups: { beta: {} } },
    release: {
      services: ['web'],
      build: { command: 'make ipa', ipaPath: 'App.ipa', ...(credentialsEnvironment === undefined ? {} : { credentialsEnvironment }) },
      testflight: { groups: ['beta'] },
    },
  });
  it('preserves omission rather than introducing a source environment default', () => {
    expect(iosSpecSchema.parse(declaration()).release?.build).not.toHaveProperty('credentialsEnvironment');
  });
  it.each(['production', 'Apple signing / shared', 'a'.repeat(255)])('accepts the static environment %s', name => {
    expect(iosSpecSchema.parse(declaration(name)).release?.build).toHaveProperty('credentialsEnvironment', name);
  });
  it.each(['', '   ', ' leading', 'trailing ', 'a'.repeat(256), '${{ github.ref }}', 'prefix-${{ vars.ENV }}', 'line\nfeed', 'tab\tname', 'nul\0name', 'delete\x7fname', 'control\x85name', null, 123])('rejects an invalid environment %#', name => {
    expect(iosSpecSchema.safeParse(declaration(name)).success).toBe(false);
  });
});
