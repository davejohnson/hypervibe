import { describe, expect, it } from 'vitest';
import { awsReleaseDockerfile, awsWebServiceArn, RDS_CA_BUNDLE_URL, webServiceUrl } from '../../adapters/providers/aws/aws-release.client.js';

describe('AWS release image', () => {
  it('adds only the database certificate authorities, and pulls generated bases from ECR Public', () => {
    const dockerfile = awsReleaseDockerfile({ runtime: { kind: 'node', version: '24', installCommand: 'npm ci' } as never, startCommand: 'npm start' });
    expect(dockerfile).toContain('FROM public.ecr.aws/docker/library/node:24-slim');
    expect(dockerfile).toContain(`ADD --chmod=644 ${RDS_CA_BUNDLE_URL} /opt/hypervibe/rds-ca.pem`);
    expect(dockerfile).toContain('ENV NODE_EXTRA_CA_CERTS=/opt/hypervibe/rds-ca.pem');
    // Containers receive secrets from ECS by reference; nothing Lambda-specific is packaged.
    expect(dockerfile).not.toMatch(/lambda|load-secrets/i);
    expect(awsReleaseDockerfile({ repositoryDockerfile: 'FROM node:24\nCMD ["node","app.js"]\n' })).toMatch(/^FROM node:24\nCMD/);
  });
});

describe('AWS web service identity', () => {
  const target = { region: 'us-west-2', accountId: '111122223333', prefix: 'hv-app-dev' };
  it('names a web service inside its own environment cluster, and keeps an exact ARN as given', () => {
    expect(awsWebServiceArn(target, 'hv-app-dev-web')).toBe('arn:aws:ecs:us-west-2:111122223333:service/hv-app-dev/hv-app-dev-web');
    expect(awsWebServiceArn(target, 'arn:aws:ecs:us-west-2:111122223333:service/other/exact')).toBe('arn:aws:ecs:us-west-2:111122223333:service/other/exact');
  });
  it('reads the HTTPS address AWS assigned, never a private one', () => {
    expect(webServiceUrl({ activeConfigurations: [{ ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'hv-app-dev-web.ecs.us-west-2.on.aws' }] }] })).toBe('https://hv-app-dev-web.ecs.us-west-2.on.aws');
    expect(webServiceUrl({ activeConfigurations: [{ ingressPaths: [{ accessType: 'PRIVATE', endpoint: 'internal.example' }] }] })).toBeUndefined();
    expect(webServiceUrl(undefined)).toBeUndefined();
  });
});

describe('AWS teardown spec cleanup', () => {
  it('removes the environment and its secrets, keeping secrets other environments use', async () => {
    const { specWithoutEnvironment } = await import('../engine-shared.js');
    const spec = { secrets: { ONLY: { ownership: 'hypervibe', environments: ['demo'] }, SHARED: { ownership: 'hypervibe', environments: ['demo', 'prod'] }, OTHER: { environments: ['prod'] } } } as never;
    expect(specWithoutEnvironment(spec, 'demo')).toEqual({ environments: { demo: null }, secrets: { ONLY: null, SHARED: { environments: ['prod'] } } });
  });
});

describe('teardown spec cleanup of the project\'s main environment', () => {
  it('leaves a spec that still validates when the removed environment was the canonical one', async () => {
    const { specWithoutEnvironment } = await import('../engine-shared.js');
    const { projectSpecSchema } = await import('../../domain/spec/spec.schema.js');
    const { deepMergeSpec } = await import('../../domain/spec/spec.store.js');
    const environment = { hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { web: { workloadKind: 'web', startCommand: 'npm start' } } };
    const spec = projectSpecSchema.parse({
      version: 1, project: 'app', environments: { staging: environment, production: environment },
      devops: { code: { provider: 'github', scope: 'owner/app' }, ci: { provider: 'github-actions' }, canonicalEnvironment: 'staging' },
    });
    const merged = projectSpecSchema.safeParse(deepMergeSpec(spec, specWithoutEnvironment(spec, 'staging')));
    expect(merged.error?.issues ?? []).toEqual([]);
    expect(merged.data?.devops?.canonicalEnvironment).toBeUndefined();
    expect(Object.keys(merged.data!.environments)).toEqual(['production']);
  });
});
