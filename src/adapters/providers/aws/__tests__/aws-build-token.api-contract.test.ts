import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { awsImageTag, buildImage } from '../aws-release.client.js';
import { buildAwsBuildConfiguration } from '../tofu/aws-engine.config.js';

const base = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-demo', environmentId: 'env1', parameterPath: '/hypervibe/env1/' };
// Reconstructed success from AWS CodeBuild StartBuild/EnvironmentVariable and ECR DescribeImages contracts.
// Only HTTP transport is replaced: SDK serialization, signing and response decoding remain real.
describe('CodeBuild private package token HTTP contract', () => {
  it.each([undefined, '/hypervibe/env1/NODE_AUTH_TOKEN'])('sends only native parameter references (%s)', async (packageTokenParameter) => {
    const requests: Array<{ hostname: string; body: string }> = [];
    let reads = 0;
    const digest = `sha256:${'d'.repeat(64)}`;
    const handler = { handle: async (request: { hostname: string; body?: unknown; headers: Record<string, string> }) => {
      const body = typeof request.body === 'string' ? request.body : request.body instanceof Uint8Array ? Buffer.from(request.body).toString() : '';
      requests.push({ hostname: request.hostname, body });
      const action = request.headers['x-amz-target'];
      const result = action?.endsWith('DescribeImages') ? (++reads === 1 ? {} : { imageDetails: [{ imageDigest: digest }] })
        : action?.endsWith('StartBuild') ? { build: { id: 'hv-app-demo-images:build1', buildStatus: 'SUCCEEDED' } } : {};
      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify(result)]) } };
    } };
    const result = await buildImage({ ...base, ...(packageTokenParameter ? { packageTokenParameter } : {}), credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } },
      { commitSha: 'a'.repeat(40), archive: Buffer.from('source') }, { requestHandler: handler });
    expect(result).toMatchObject({ imageUri: expect.stringContaining(digest) });
    const build = JSON.parse(requests.find((request) => request.hostname.startsWith('codebuild.'))!.body);
    expect(build.environmentVariablesOverride.filter((item: { name: string }) => item.name === 'NPM_TOKEN')).toEqual(packageTokenParameter ? [{ name: 'NPM_TOKEN', type: 'PARAMETER_STORE', value: packageTokenParameter }] : []);
    expect(build.environmentVariablesOverride).toContainEqual({ name: 'IMAGE_TAG', value: awsImageTag('a'.repeat(40)), type: 'PLAINTEXT' });
  });

  it.each([false, true])('executes the generated build command without placing the token in arguments (%s)', (hasToken) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hv-build-command-'));
    try {
      writeFileSync(path.join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE"\n', { mode: 0o755 });
      const config = buildAwsBuildConfiguration({ ...base, packageTokenKey: 'NPM_TOKEN' });
      const file = config.files['builds.tf.json'] as any;
      const buildspec = JSON.parse(file.resource.aws_codebuild_project.images.source[0].buildspec.replace(/\$\$\{/g, '${'));
      execFileSync('/bin/sh', ['-c', buildspec.phases.build.commands.join('\n')], { env: { PATH: directory, CAPTURE: path.join(directory, 'args'), REGISTRY: 'registry/app', IMAGE_TAG: 'commit', ...(hasToken ? { NPM_TOKEN: 'private-token-sentinel' } : {}) } });
      const args = readFileSync(path.join(directory, 'args'), 'utf8');
      expect(args).not.toContain('private-token-sentinel');
      expect(args.includes('id=npm_token,env=NPM_TOKEN')).toBe(hasToken);
      expect(args).not.toContain('--build-arg');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
