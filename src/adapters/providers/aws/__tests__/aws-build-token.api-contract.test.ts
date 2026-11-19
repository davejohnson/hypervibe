import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { awsImageTag, buildImage } from '../aws-release.client.js';
import { buildAwsBuildConfiguration } from '../tofu/aws-engine.config.js';

const base = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-demo', environmentId: 'env1', parameterPath: '/hypervibe/env1/' };
// Frozen from the pre-#717 project at cbf056a5. A new generator cannot certify a project already installed in AWS.
const installedBuildspec = JSON.stringify({
  version: '0.2', phases: {
    pre_build: { commands: ['aws ecr get-login-password | docker login --username AWS --password-stdin "${REGISTRY%%/*}"'] },
    build: { commands: ['if [ -n "${NPM_TOKEN:-}" ]; then set -- --secret id=npm_token,env=NPM_TOKEN; else set --; fi; docker build "$@" --platform linux/amd64 -f "${DOCKERFILE:-Dockerfile}" -t "$REGISTRY:$IMAGE_TAG" .', 'docker push "$REGISTRY:$IMAGE_TAG"'] },
  },
});
function projectFixture(webCommands: boolean) {
  const config = buildAwsBuildConfiguration({ ...base, webCommands });
  const file = config.files['builds.tf.json'] as any;
  return { arn: `arn:aws:codebuild:${base.region}:${base.accountId}:project/${base.prefix}-images`,
    serviceRole: `arn:aws:iam::${base.accountId}:role/hypervibe/app/${base.prefix}-build`,
    tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hv-environment', value: base.environmentId }],
    source: { type: 'S3', location: `${base.prefix}-build-${base.accountId}/source.zip`, buildspec: !webCommands ? installedBuildspec : file.resource.aws_codebuild_project.images.source[0].buildspec.replace(/\$\$\{/g, '${') },
    environment: { type: 'LINUX_CONTAINER', privilegedMode: true, environmentVariables: [{ name: 'REGISTRY', value: `${base.accountId}.dkr.ecr.${base.region}.amazonaws.com/${base.prefix}` }] } };
}
// Reconstructed success from AWS CodeBuild StartBuild/EnvironmentVariable and ECR DescribeImages contracts.
// Only HTTP transport is replaced: SDK serialization, signing and response decoding remain real.
describe('CodeBuild private package token HTTP contract', () => {
  it('reuses the existing immutable default image without contacting CodeBuild or S3', async () => {
    const actions: string[] = [];
    const digest = `sha256:${'d'.repeat(64)}`;
    const handler = { handle: async (request: { body: string; headers: Record<string, string> }) => {
      actions.push(request.headers['x-amz-target']);
      const tag = JSON.parse(request.body).imageIds[0].imageTag;
      expect(tag).toBe(`${'a'.repeat(40)}-hv3`);
      return { response: { statusCode: 200, headers: {}, body: Readable.from([JSON.stringify({ imageDetails: [{ imageTags: [tag], imageDigest: digest }] })]) } };
    } };
    const result = await buildImage({ ...base, credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } },
      { commitSha: 'a'.repeat(40), archive: Buffer.from('source') }, { requestHandler: handler });
    expect(result).toMatchObject({ imageUri: expect.stringContaining(digest) });
    expect(actions).toHaveLength(1);
  });

  it.each(['legacy', 'unreadable', 'different project', 'different registry', 'unknown buildspec'])('stops a web override before upload or paid build on a %s project', async condition => {
    const requests: string[] = [];
    const handler = { handle: async (request: { method: string; headers: Record<string, string> }) => {
      const action = request.headers['x-amz-target'] ?? request.method;
      requests.push(action);
      let statusCode = 200;
      let response: unknown = {};
      if (action.endsWith('DescribeImages')) { statusCode = 400; response = { __type: 'ImageNotFoundException' }; }
      if (action.endsWith('BatchGetProjects')) {
        if (condition === 'unreadable') { statusCode = 403; response = { __type: 'AccessDeniedException' }; }
        else {
          const project = projectFixture(condition !== 'legacy');
          if (condition === 'different project') project.arn += '-other';
          if (condition === 'different registry') project.environment.environmentVariables[0]!.value += '-other';
          if (condition === 'unknown buildspec') project.source.buildspec = 'buildspec.yml';
          response = { projects: [project] };
        }
      }
      return { response: { statusCode, headers: {}, body: Readable.from([JSON.stringify(response)]) } };
    } };
    const result = await buildImage({ ...base, webCommands: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } },
      { commitSha: 'a'.repeat(40), archive: Buffer.from('source') }, { requestHandler: handler });
    expect(requests.some(action => action.endsWith('BatchGetProjects'))).toBe(true);
    expect(requests.some(action => action === 'PUT' || action.endsWith('StartBuild'))).toBe(false);
    expect(result).toHaveProperty('error', expect.stringMatching(/build project/i));
  });

  it('builds just the missing web variant when the original commit is already cached', async () => {
    const sha = 'a'.repeat(40);
    let started = false;
    let build: { environmentVariablesOverride?: { name: string; value: string }[] } = {};
    const handler = { handle: async (request: { body: string; headers: Record<string, string> }) => {
      const action = request.headers['x-amz-target'];
      let data: unknown = {};
      let statusCode = 200;
      if (action?.endsWith('DescribeImages')) {
        const tag = JSON.parse(request.body).imageIds[0].imageTag;
        if (tag === sha + '-hv3') data = { imageDetails: [{ imageTags: [tag], imageDigest: 'sha256:' + 'd'.repeat(64) }] };
        else if (started) data = { imageDetails: [{ imageTags: [tag], imageDigest: 'sha256:' + 'e'.repeat(64) }] };
        else { data = { __type: 'ImageNotFoundException' }; statusCode = 400; }
      } else if (action?.endsWith('BatchGetProjects')) data = { projects: [projectFixture(true)] };
      else if (action?.endsWith('StartBuild')) { build = JSON.parse(request.body); started = true; data = { build: { id: 'project:build', buildStatus: 'SUCCEEDED' } }; }
      return { response: { statusCode, headers: {}, body: Readable.from([JSON.stringify(data)]) } };
    } };
    const result = await buildImage({ ...base, webCommands: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } },
      { commitSha: sha, archive: Buffer.from('source') }, { requestHandler: handler });
    expect(result).toMatchObject({ imageUri: expect.stringContaining('d'.repeat(64)), webImageUri: expect.stringContaining('e'.repeat(64)) });
    expect(build.environmentVariablesOverride).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SKIP_DEFAULT_IMAGE', value: '1' }), expect.objectContaining({ name: 'WEB_IMAGE_TAG', value: sha + '-hv-web1' }),
    ]));
  });

  it('keeps the deployed no-override buildspec as-is', () => {
    const config = buildAwsBuildConfiguration(base).files['builds.tf.json'] as any;
    expect(config.resource.aws_codebuild_project.images.source[0].buildspec.replace(/\$\$\{/g, '${')).toBe(installedBuildspec);
  });

  it.each([undefined, '/hypervibe/env1/NODE_AUTH_TOKEN'])('sends only native parameter references (%s)', async (packageTokenParameter) => {
    const requests: Array<{ action?: string; body: string }> = [];
    let reads = 0;
    const digest = `sha256:${'d'.repeat(64)}`;
    const handler = { handle: async (request: { hostname: string; body?: unknown; headers: Record<string, string> }) => {
      const body = typeof request.body === 'string' ? request.body : request.body instanceof Uint8Array ? Buffer.from(request.body).toString() : '';
      const action = request.headers['x-amz-target'];
      requests.push({ action, body });
      const miss = action?.endsWith('DescribeImages') && ++reads === 1;
      const result = miss ? { __type: 'ImageNotFoundException' }
        : action?.endsWith('DescribeImages') ? { imageDetails: [{ imageDigest: digest, imageTags: [JSON.parse(body).imageIds[0].imageTag] }] }
        : action?.endsWith('BatchGetProjects') ? { projects: [projectFixture(false)] }
        : action?.endsWith('StartBuild') ? { build: { id: 'hv-app-demo-images:build1', buildStatus: 'SUCCEEDED' } } : {};
      return { response: { statusCode: miss ? 400 : 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify(result)]) } };
    } };
    const result = await buildImage({ ...base, ...(packageTokenParameter ? { packageTokenParameter } : {}), credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } },
      { commitSha: 'a'.repeat(40), archive: Buffer.from('source') }, { requestHandler: handler });
    expect(result).toMatchObject({ imageUri: expect.stringContaining(digest) });
    const build = JSON.parse(requests.find((request) => request.action?.endsWith('StartBuild'))!.body);
    expect(build.environmentVariablesOverride.filter((item: { name: string }) => item.name === 'NPM_TOKEN')).toEqual(packageTokenParameter ? [{ name: 'NPM_TOKEN', type: 'PARAMETER_STORE', value: packageTokenParameter }] : []);
    expect(build.environmentVariablesOverride).toContainEqual({ name: 'IMAGE_TAG', value: awsImageTag('a'.repeat(40)), type: 'PLAINTEXT' });
  });

  it.each([[false, false, false], [true, true, false], [true, true, true]])('preserves the source image and limits the web entrypoint change to its own tag (web %s, token %s, cached default %s)', (webCommands, hasToken, cachedDefault) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hv-build-command-'));
    try {
      const original = 'FROM scratch\nONBUILD RUN false\nENTRYPOINT ["/init"]\nCMD ["serve"]\n';
      writeFileSync(path.join(directory, 'Dockerfile'), original);
      writeFileSync(path.join(directory, 'docker'), [
        '#!/bin/sh', 'echo "$@" >> args',
        'if [ "$1" = build ]; then while [ "$1" != -t ]; do shift; done; cp Dockerfile "${2##*:}.recipe"; fi',
      ].join('\n'), { mode: 0o755 });
      const commands: string[] = JSON.parse(projectFixture(webCommands).source.buildspec).phases.build.commands;
      execFileSync('/bin/sh', ['-ec', commands.join('\n')], { cwd: directory, env: {
        PATH: `${directory}:${process.env.PATH}`, REGISTRY: 'registry/app', IMAGE_TAG: 'original', SKIP_DEFAULT_IMAGE: cachedDefault ? '1' : '0',
        ...(webCommands ? { WEB_IMAGE_TAG: 'web' } : {}), ...(hasToken ? { NPM_TOKEN: 'private-token-sentinel' } : {}),
      } });
      const args = readFileSync(path.join(directory, 'args'), 'utf8');
      expect(args).not.toContain('private-token-sentinel');
      expect(args.includes('id=npm_token,env=NPM_TOKEN')).toBe(hasToken);
      expect(args).not.toContain('--build-arg');
      expect(args.includes('push registry/app:original')).toBe(!cachedDefault);
      expect(args.includes('push registry/app:web')).toBe(webCommands);
      if (!cachedDefault) expect(readFileSync(path.join(directory, 'original.recipe'), 'utf8')).toBe(original);
      if (webCommands) expect(readFileSync(path.join(directory, 'web.recipe'), 'utf8')).toBe(original + '\nENTRYPOINT []\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.runIf(process.env.HV_TEST_LOCAL_DOCKER === '1' || (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux'))(
    'builds both real Docker image configurations with an inherited entrypoint and an ONBUILD trigger', () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'hv-aws-image-config-'));
      const repository = `hv-aws-fixture-${randomUUID()}`;
      try {
        writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\nCOPY file /file\nENTRYPOINT ["/init"]\nCMD ["serve"]\nONBUILD RUN false\n');
        writeFileSync(path.join(directory, 'file'), 'test');
        const commands: string[] = JSON.parse(projectFixture(true).source.buildspec).phases.build.commands;
        const shell = [
          'docker() { if [ "$1" = build ]; then shift; command docker build --network=none "$@"; else test "$1" = push; fi; }',
          ...commands,
        ].join('\n');
        execFileSync('/bin/sh', ['-ec', shell], { cwd: directory, env: { ...process.env, DOCKER_BUILDKIT: '1', REGISTRY: repository, IMAGE_TAG: 'original', WEB_IMAGE_TAG: 'web' }, stdio: 'pipe' });
        for (const tag of ['original', 'web']) {
          const config = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config}}', `${repository}:${tag}`], { encoding: 'utf8' }));
          expect(config.Entrypoint ?? []).toEqual(tag === 'original' ? ['/init'] : []);
          if (tag === 'original') expect(config.Cmd).toEqual(['serve']);
          expect(config.OnBuild).toEqual(['RUN false']);
        }
      } finally {
        spawnSync('docker', ['image', 'rm', `${repository}:original`, `${repository}:web`], { stdio: 'ignore' });
        rmSync(directory, { recursive: true, force: true });
      }
    }, 90_000);

});
