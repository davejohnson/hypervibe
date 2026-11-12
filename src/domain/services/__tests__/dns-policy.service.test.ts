import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { resolveDnsPolicy, type DnsPolicyInput } from '../dns-policy.service.js';

const dns = { provider: 'cloudflare' as const, zone: { id: 'cf-zone-123', name: 'example.com', accountId: 'cf-account-123' } };
const environment = (overrides = {}) => environmentSpecSchema.parse({
  hosting: { provider: 'aws-ecs' }, domain: 'app.example.com', ...overrides,
});
const verified: NonNullable<DnsPolicyInput['legacyOwnership']> = {
  state: 'verified', hostname: 'app.example.com', recordIds: ['cf-record-123'],
  identity: { provider: 'cloudflare', zoneId: 'cf-zone-123', zoneName: 'example.com', scope: { accountId: 'cf-account-123' } },
};

describe('DNS authority and security policy', () => {
  it('does not infer Cloudflare authority from an old hostname alone', () => {
    expect(resolveDnsPolicy({ environmentSpec: environment() })).toMatchObject({ state: 'unmanaged' });
  });

  it.each([
    { state: 'unknown' as const },
    { ...verified, hostname: 'other.example.com' },
    { ...verified, recordIds: [] },
    { ...verified, identity: { ...verified.identity, scope: {} } },
  ])('does not infer legacy management from incomplete or different evidence', (legacyOwnership) => {
    const result = resolveDnsPolicy({ environmentSpec: environment(), legacyOwnership });
    expect(result.state).toBe('blocked');
    expect(result).not.toHaveProperty('identity');
  });

  it('keeps exact legacy Cloudflare ownership and legacy proxy intent', () => {
    expect(resolveDnsPolicy({ environmentSpec: environment(), legacyOwnership: verified, securityObservation: { proxy: true } })).toMatchObject({
      state: 'ready', source: 'legacy-owned', identity: verified.identity, policy: { proxy: 'on' },
    });
    expect(resolveDnsPolicy({ environmentSpec: environment({ domainProxy: false }), legacyOwnership: verified }))
      .toMatchObject({ state: 'ready', policy: { proxy: 'off' } });
  });

  it('preserves observed Cloudflare proxying when existing records have no new proxy intent', () => {
    const input = { environmentSpec: environment({ dns }), existingIdentity: verified.identity };
    expect(resolveDnsPolicy(input).state).toBe('blocked');
    expect(resolveDnsPolicy({ ...input, securityObservation: { proxy: true } }))
      .toMatchObject({ state: 'ready', policy: { proxy: 'on' } });
    expect(resolveDnsPolicy({ ...input, securityObservation: { proxy: false } }))
      .toMatchObject({ state: 'ready', policy: { proxy: 'off' } });
    const unsupported = resolveDnsPolicy({ ...input, securityObservation: { proxy: true }, capabilities: { proxy: false } });
    expect(unsupported.state).toBe('blocked');
    expect(unsupported.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dns_proxy_unsupported' })]));
  });

  it('requires observed proxy state before adopting an existing Cloudflare record', () => {
    const environmentSpec = environment({ dns: { ...dns, adoptRecords: [
      { id: 'cf-record-123', name: 'app.example.com', type: 'CNAME', values: ['old.example.net'] },
    ] } });
    expect(resolveDnsPolicy({ environmentSpec }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { proxy: true } }))
      .toMatchObject({ state: 'ready', policy: { proxy: 'on' } });
  });

  it('keeps public hostname intent independent from hosting and requires HTTPS readiness separately', () => {
    expect(resolveDnsPolicy({ environmentSpec: environment({ dns }) })).toMatchObject({
      state: 'ready', source: 'explicit', identity: verified.identity,
      policy: { exposure: 'public', tls: 'required', dnssec: 'preserve', caa: 'preserve', proxy: 'off', wildcard: 'deny' },
      checks: { tls: 'pending', dnssec: 'unknown', caa: 'unknown' },
    });
  });

  it('blocks automatic migration of already owned DNS to another zone or provider', () => {
    const replacement = { provider: 'aws', zone: { id: 'Z0123456789', name: 'example.com', accountId: '123456789012' } };
    const result = resolveDnsPolicy({ environmentSpec: environment({ dns: replacement }), existingIdentity: verified.identity });
    expect(result.state).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dns_migration_requires_workflow' })]));
  });

  it('preserves current DNSSEC and CAA by default without pretending they were observed', () => {
    const result = resolveDnsPolicy({ environmentSpec: environment({ dns }),
      securityObservation: { dnssec: 'disabled', caa: { state: 'known', issuers: ['digicert.com'] } } });
    expect(result).toMatchObject({ state: 'ready', checks: { dnssec: 'preserved', caa: 'preserved' } });
    expect(result.policy?.caa).toBe('preserve');
  });

  it('accepts required DNSSEC only when existing signing and public validation are verified', () => {
    const environmentSpec = environment({ dns: { ...dns, policy: { dnssec: 'required' } } });
    expect(resolveDnsPolicy({ environmentSpec }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { dnssec: 'disabled' } }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { dnssec: 'enabled' } }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { dnssec: 'enabled', dnssecValidation: 'validated' } }))
      .toMatchObject({ state: 'ready', checks: { dnssec: 'satisfied' } });
  });

  it('blocks unsupported CAA changes and accepts independently observed exact policy', () => {
    const environmentSpec = environment({ dns: { ...dns, policy: { caa: { issuers: ['letsencrypt.org'] } } } });
    expect(resolveDnsPolicy({ environmentSpec }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { caa: { state: 'known', issuers: ['digicert.com'] } } }).state).toBe('blocked');
    expect(resolveDnsPolicy({ environmentSpec, securityObservation: { caa: { state: 'known', issuers: ['letsencrypt.org'] } } }))
      .toMatchObject({ state: 'ready', checks: { caa: 'satisfied' } });
  });

  it.each([
    [{ exposure: 'private' }, 'dns_private_zone_unsupported'],
    [{ tls: 'disabled' }, 'dns_plaintext_unsupported'],
    [{ wildcard: 'allow' }, 'dns_wildcard_unsupported'],
  ])('blocks desired controls that the selected workflow cannot enforce', (policy, code) => {
    const result = resolveDnsPolicy({ environmentSpec: environment({ dns: { ...dns, policy } }) });
    expect(result.state).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it('does not let a legacy proxy flag enable unsupported provider behavior', () => {
    const result = resolveDnsPolicy({ environmentSpec: environment({ domainProxy: true,
      dns: { provider: 'aws', zone: { id: 'Z0123456789', name: 'example.com', accountId: '123456789012' } } }) });
    expect(result.state).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dns_proxy_unsupported' })]));
  });
});
