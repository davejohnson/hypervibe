import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { EcsExpressAdapter, EcsExpressCredentialsSchema } from '../ecs-express.adapter.js';
import { RdsAdapter, RdsCredentialsSchema } from '../rds.adapter.js';
import { ElastiCacheAdapter, ElastiCacheCredentialsSchema } from '../elasticache.adapter.js';
import { S3StorageAdapter, S3StorageCredentialsSchema } from '../s3.adapter.js';

// Reconstructed AWS responses from official API contracts; only the HTTP
// transport is replaced. Real SDK default/profile credential resolution,
// SigV4 signing, protocol serialization/deserialization and adapters run.
// https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListClusters.html
// https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_DescribeRepositories.html
// https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBInstances.html
// https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeVpcs.html
// https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeServerlessCaches.html
const accountId = '123456789012';
const profile = 'hypervibe-native-contract';
const accessKeyId = 'ASIACONTRACT123456789';
const secretAccessKey = 'synthetic-local-secret-never-persist-or-render';
const sessionToken = 'synthetic-local-session-never-persist-or-render';
const providers = [
  ['ecs', EcsExpressAdapter, EcsExpressCredentialsSchema],
  ['rds', RdsAdapter, RdsCredentialsSchema],
  ['elasticache', ElastiCacheAdapter, ElastiCacheCredentialsSchema],
  ['s3', S3StorageAdapter, S3StorageCredentialsSchema],
] as const;
let directory: string;
let calls: Array<{ hostname: string; action: string; signed: boolean; session: boolean }>;
let observedAccount: string;
let stsStatus: number;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-aws-native-'));
  const credentialsFile = path.join(directory, 'credentials');
  const configFile = path.join(directory, 'config');
  writeFileSync(credentialsFile, `[${profile}]\naws_access_key_id=${accessKeyId}\naws_secret_access_key=${secretAccessKey}\naws_session_token=${sessionToken}\n`, { mode: 0o600 });
  writeFileSync(configFile, `[profile ${profile}]\nregion=us-east-2\n`, { mode: 0o600 });
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile);
  vi.stubEnv('AWS_CONFIG_FILE', configFile);
  vi.stubEnv('AWS_PROFILE', profile);
  vi.stubEnv('AWS_REGION', 'us-east-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', '');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
  calls = [];
  observedAccount = accountId;
  stsStatus = 200;
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async request => {
    const body = String(request.body ?? '');
    const action = new URLSearchParams(body).get('Action') ?? request.headers['x-amz-target']?.split('.').pop() ?? '';
    calls.push({ hostname: request.hostname, action,
      signed: request.headers.authorization?.includes(`Credential=${accessKeyId}/`) === true,
      session: request.headers['x-amz-security-token'] === sessionToken });
    let payload: string;
    if (action === 'GetCallerIdentity') {
      payload = stsStatus === 200
        ? `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${observedAccount}:assumed-role/Hypervibe/session</Arn><UserId>AROEXAMPLE:session</UserId><Account>${observedAccount}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>native-auth-contract</RequestId></ResponseMetadata></GetCallerIdentityResponse>`
        : '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>ExpiredToken</Code><Message>Expired session</Message></Error><RequestId>native-auth-contract</RequestId></ErrorResponse>';
    } else if (action === 'ListClusters') payload = JSON.stringify({ clusterArns: [] });
    else if (action === 'DescribeRepositories') payload = JSON.stringify({ repositories: [] });
    else if (action === 'DescribeDBInstances') payload = '<DescribeDBInstancesResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBInstancesResult><DBInstances/></DescribeDBInstancesResult><ResponseMetadata><RequestId>native-auth-contract</RequestId></ResponseMetadata></DescribeDBInstancesResponse>';
    else if (action === 'DescribeServerlessCaches') payload = '<DescribeServerlessCachesResponse xmlns="http://elasticache.amazonaws.com/doc/2015-02-02/"><DescribeServerlessCachesResult><ServerlessCaches/></DescribeServerlessCachesResult><ResponseMetadata><RequestId>native-auth-contract</RequestId></ResponseMetadata></DescribeServerlessCachesResponse>';
    else if (['DescribeVpcs', 'DescribeSubnets', 'DescribeSecurityGroups'].includes(action)) {
      const field = { DescribeVpcs: 'vpcSet', DescribeSubnets: 'subnetSet', DescribeSecurityGroups: 'securityGroupInfo' }[action]!;
      payload = `<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>native-auth-contract</requestId><${field}/></${action}Response>`;
    } else throw new Error(`Unexpected AWS operation: ${action}`);
    return { response: { statusCode: action === 'GetCallerIdentity' ? stsStatus : 200,
      headers: { 'content-type': payload.startsWith('{') ? 'application/x-amz-json-1.1' : 'text/xml' }, body: Buffer.from(payload) } };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('AWS native hosting and datastore authentication', () => {
  it.each(providers)('%s verifies through the selected native profile and emits only a pinned identity', async (_provider, Adapter) => {
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile });
    const result = await adapter.verify();
    expect(result.success).toBe(true);
    const identity = (adapter as any).getConnectionIdentity();
    expect(identity).toEqual({ accountId, profile });
    expect(JSON.stringify({ result, identity })).not.toMatch(/synthetic-local-/);
    expect(calls.some(call => call.action === 'GetCallerIdentity')).toBe(true);
    expect(calls.every(call => call.signed && call.session)).toBe(true);
    expect(calls.every(call => call.hostname.includes('.us-east-2.'))).toBe(true);
    expect(calls.every(call => /^(GetCallerIdentity|ListClusters|Describe)/.test(call.action))).toBe(true);
    await adapter.disconnect();
  });

  it.each(providers)('%s uses the exact profile region without an AWS_REGION override', async (_provider, Adapter) => {
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_PROFILE', 'different-local-default');
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile });
    expect((await adapter.verify()).success).toBe(true);
    expect(calls.every(call => call.hostname.includes('.us-east-2.'))).toBe(true);
    await adapter.disconnect();
  });

  it.each(providers)('%s retries an uncertain identity read without granting service access first', async (_provider, Adapter) => {
    stsStatus = 503;
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile, accountId });
    expect((await adapter.verify()).success).toBe(false);
    expect(calls.every(call => call.action === 'GetCallerIdentity')).toBe(true);
    stsStatus = 200;
    expect((await adapter.verify()).success).toBe(true);
    await adapter.disconnect();
  });

  it.each(providers)('%s rejects a changed native account before sending service requests', async (_provider, Adapter) => {
    observedAccount = '999999999999';
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile, accountId });
    const result = await adapter.verify();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/account/i);
    expect(calls.every(call => call.action === 'GetCallerIdentity')).toBe(true);
    await adapter.disconnect();
  });

  it.each(providers)('%s keeps the verified account when desired-state placement changes', async (_provider, Adapter) => {
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile });
    expect((await adapter.verify()).success).toBe(true);
    observedAccount = '999999999999';
    if (adapter instanceof S3StorageAdapter) {
      calls = [];
      const result = await adapter.resolveObservationContext('sequence', { id: 'env', projectId: 'sequence', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() }, 'us-west-1');
      expect(result.receipt.success).toBe(false);
      expect(calls.every(call => call.action === 'GetCallerIdentity')).toBe(true);
      await adapter.disconnect();
      return;
    }
    adapter.configureTarget({ region: 'us-west-1' });
    calls = [];
    expect((await adapter.verify()).success).toBe(false);
    expect(calls.every(call => call.action === 'GetCallerIdentity')).toBe(true);
    await adapter.disconnect();
  });

  it.each(providers)('%s preserves an expired native session as an error and performs no service request', async (_provider, Adapter) => {
    stsStatus = 403;
    const adapter = new Adapter();
    await adapter.connect({ authMode: 'default', profile, accountId });
    expect((await adapter.verify()).success).toBe(false);
    expect(calls.every(call => call.action === 'GetCallerIdentity')).toBe(true);
    expect(JSON.stringify((adapter as any).getConnectionIdentity())).not.toMatch(/synthetic-local-/);
    await adapter.disconnect();
  });

  it.each(providers)('%s preserves explicit keys and rejects mixed/partial native credentials', (_provider, _Adapter, schema) => {
    expect(schema.safeParse({ accessKeyId, secretAccessKey, sessionToken }).success).toBe(true);
    expect(schema.safeParse({ authMode: 'default', accessKeyId }).success).toBe(false);
    expect(schema.safeParse({ accessKeyId }).success).toBe(false);
  });
});
