import { createRequire } from 'module';
import vm from 'vm';
import { SignatureV4 } from '@smithy/signature-v4';
import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { LOAD_SECRETS_SOURCE } from '../../adapters/providers/aws/runtime/load-secrets.js';
import { awsReleaseDockerfile, lambdaErrorType, LAMBDA_WEB_ADAPTER_IMAGE, RDS_CA_BUNDLE_URL } from '../infrastructure-engine-aws-release.js';

describe('AWS release image', () => {
  it('adds the web adapter and secrets loader, and pulls generated bases from ECR Public', () => {
    const dockerfile = awsReleaseDockerfile({ runtime: { kind: 'node', version: '24', installCommand: 'npm ci' } as never, startCommand: 'npm start' });
    expect(dockerfile).toContain('FROM public.ecr.aws/docker/library/node:24-slim');
    expect(dockerfile).toContain(`COPY --from=${LAMBDA_WEB_ADAPTER_IMAGE} /lambda-adapter /opt/extensions/lambda-adapter`);
    expect(dockerfile).toContain('COPY .hypervibe-aws/load-secrets.cjs /opt/hypervibe/load-secrets.cjs');
    expect(dockerfile).toContain(`ADD --chmod=644 ${RDS_CA_BUNDLE_URL} /opt/hypervibe/rds-ca.pem`);
    expect(dockerfile).toContain('ENV NODE_EXTRA_CA_CERTS=/opt/hypervibe/rds-ca.pem');
    expect(awsReleaseDockerfile({ repositoryDockerfile: 'FROM node:24\nCMD ["node","app.js"]\n' })).toMatch(/^FROM node:24\nCMD/);
  });
});

describe('AWS release health', () => {
  it('treats a function URL\'s Lambda error body as a failed start, not a healthy 200', async () => {
    const json = { 'content-type': 'application/json' };
    expect(await lambdaErrorType(new Response('{"errorType":"Runtime.ExitError","errorMessage":"exit status 1"}', { status: 200, headers: json }))).toBe('Runtime.ExitError');
    expect(await lambdaErrorType(new Response('{"errorType":"ValidationError"}', { status: 200, headers: json }))).toBeUndefined();
    expect(await lambdaErrorType(new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }))).toBeUndefined();
  });
});

describe('Lambda secrets loader', () => {
  it('signs Parameter Store reads exactly as the AWS SDK does and maps names to variables', async () => {
    const env = { HV_SECRETS_FETCH: '1', HYPERVIBE_PARAMETER_PATH: '/hypervibe/env1/', AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', AWS_SESSION_TOKEN: 'session' };
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let output = '';
    const fixed = new Date('2026-11-11T12:00:00.000Z');
    const pages = [{ Parameters: [{ Name: '/hypervibe/env1/DATABASE_URL', Value: 'postgres://x' }], NextToken: 'n' }, { Parameters: [{ Name: '/hypervibe/env1/API_KEY', Value: 'k' }] }];
    const done = new Promise<void>((resolve) => {
      vm.runInNewContext(LOAD_SECRETS_SOURCE, {
        require: createRequire(import.meta.url), __filename: '/opt/hypervibe/load-secrets.cjs', JSON, Object,
        Date: class extends Date { constructor() { super(fixed); } },
        process: { env, stdout: { write: (text: string) => { output = text; resolve(); } }, stderr: { write: (text: string) => { output = text; resolve(); } }, exit: () => undefined },
        fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
          requests.push({ url, headers: init.headers, body: init.body });
          return { ok: true, status: 200, text: async () => JSON.stringify(pages[requests.length - 1]) };
        },
      });
    });
    await done;
    expect(JSON.parse(output)).toEqual({ DATABASE_URL: 'postgres://x', API_KEY: 'k' });
    expect(requests).toHaveLength(2);

    const signer = new SignatureV4({ service: 'ssm', region: 'us-west-2', sha256: NodeSha256 as never,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN } });
    const first = requests[0]!;
    const signed = await signer.sign({
      method: 'POST', protocol: 'https:', hostname: 'ssm.us-west-2.amazonaws.com', path: '/', body: first.body,
      headers: { host: 'ssm.us-west-2.amazonaws.com', 'content-type': first.headers['content-type']!, 'x-amz-target': 'AmazonSSM.GetParametersByPath' },
    }, { signingDate: fixed });
    const signature = (value: string) => /Signature=([0-9a-f]{64})/.exec(value)?.[1];
    expect(signature(first.headers.authorization!)).toBe(signature(String(signed.headers.authorization)));
  });
});

class NodeSha256 {
  private readonly hash: crypto.Hash | crypto.Hmac;
  constructor(secret?: string | Uint8Array) { this.hash = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256'); }
  update(data: string | Uint8Array) { this.hash.update(data); }
  async digest() { return new Uint8Array(this.hash.digest()); }
}

describe('AWS teardown spec cleanup', () => {
  it('removes the environment and its secrets, keeping secrets other environments use', async () => {
    const { specWithoutEnvironment } = await import('../infrastructure-engine-aws.js');
    const spec = { secrets: { ONLY: { ownership: 'hypervibe', environments: ['demo'] }, SHARED: { ownership: 'hypervibe', environments: ['demo', 'prod'] }, OTHER: { environments: ['prod'] } } } as never;
    expect(specWithoutEnvironment(spec, 'demo')).toEqual({ environments: { demo: null }, secrets: { ONLY: null, SHARED: { environments: ['prod'] } } });
  });
});
