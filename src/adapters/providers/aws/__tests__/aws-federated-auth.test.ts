import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsFederatedCredentialProvider } from '../aws-federated-auth.js';

// Reconstructed official STS Query response contract, through real SDK transport.
// The JWT is synthetic: tests do not establish live Google signature/AWS trust acceptance.
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html
const accountId = '123456789012', region = 'us-west-2', roleId = 'AROATESTWRITER123456789';
const roleArn = `arn:aws:iam::${accountId}:role/writer`;
const subject = '123456789012345678901', audience = 'https://hypervibe.dev/installations/test/writer';
function token(overrides = {}) { return ['e30', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: subject, azp: subject,
  aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })).toString('base64url'), 'synthetic-signature'].join('.'); }
function fixture(options: { roleId?: string; expiration?: string; token?: string } = {}) {
  const requests: Array<{ operation: string; query: Record<string, string>; authorization?: string }> = [];
  const handler = { handle: async (request: any) => {
    const query = Object.fromEntries(new URLSearchParams(request.body));
    const operation = query.Action;
    requests.push({ operation, query, authorization: request.headers.authorization });
    const expiration = options.expiration ?? new Date(Date.now() + 900000).toISOString();
    const uid = options.roleId ?? roleId;
    const body = operation === 'AssumeRoleWithWebIdentity'
      ? `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIATESTTRANSIENT</AccessKeyId><SecretAccessKey>synthetic-secret</SecretAccessKey><SessionToken>synthetic-session</SessionToken><Expiration>${expiration}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${accountId}:assumed-role/writer/hypervibe-cloud</Arn><AssumedRoleId>${uid}:hypervibe-cloud</AssumedRoleId></AssumedRoleUser><Audience>${audience}</Audience><SubjectFromWebIdentityToken>${subject}</SubjectFromWebIdentityToken><Provider>accounts.google.com</Provider></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`
      : `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${accountId}:assumed-role/writer/hypervibe-cloud</Arn><UserId>${uid}:hypervibe-cloud</UserId><Account>${accountId}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
    return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(body) } };
  } };
  const provider = createAwsFederatedCredentialProvider({ accountId, region, roleArn, roleId, audience, hostSubject: subject,
    getGoogleIdToken: async () => options.token ?? token() }, { requestHandler: handler });
  return { requests, provider };
}
describe('AWS Google federation (reconstructed serialized STS boundary)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses unsigned web identity, exact scope,900-second sessions and verifies actual caller identity', async () => {
    // STS must receive the exact issued token even if transport crosses a second.
    // Regenerating a JWT in the assertion changes its exp claim independently.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => { const current = now; now += 1000; return current; });
    const suppliedToken = token();
    const f = fixture({ token: suppliedToken }); const credentials = await f.provider(AbortSignal.timeout(1000));
    expect(credentials.expiration.getTime()).toBeGreaterThan(Date.now());
    expect(f.requests.map(item => item.operation)).toEqual(['AssumeRoleWithWebIdentity', 'GetCallerIdentity']);
    expect(f.requests[0].authorization).toBeUndefined();
    expect(f.requests[0].query).toMatchObject({ RoleArn: roleArn, DurationSeconds: '900', WebIdentityToken: suppliedToken });
    expect(f.requests[0].query.ExternalId).toBeUndefined();
  });
  it('rejects same-name role replacement and expired credentials', async () => {
    await expect(fixture({ roleId: 'AROADIFFERENT123456789' }).provider(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'scope_mismatch' });
    await expect(fixture({ expiration: '2020-01-01T00:00:00Z' }).provider(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects another Google principal or audience before sending the token', async () => {
    for (const claims of [{ sub: '999999999999999999999' }, { aud: 'https://unrelated.example' }]) {
      const f = fixture({ token: token(claims) });
      await expect(f.provider(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'scope_mismatch' });
      expect(f.requests).toEqual([]);
    }
  });
});
