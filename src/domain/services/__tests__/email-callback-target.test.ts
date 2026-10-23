import { describe, expect, it } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { resolveEmailCallbackTarget } from '../email-callback-target.js';

const domain = 'staging.example.com';
const path = '/webhooks/sendgrid/inbound';
const target = { service: 'web', path };
const spec = () => environmentSpecSchema.parse({ hosting: { provider: 'railway' }, domain,
  services: { web: {}, worker: { workloadKind: 'worker', public: false } } });
const environment = (): Environment => ({
  id: 'local-staging', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
  platformBindings: {
    provider: 'railway', projectId: 'native-project', environmentId: 'native-staging',
    services: { web: { serviceId: 'native-web', url: 'https://web-provider.example.net' },
      worker: { serviceId: 'native-worker', url: 'https://worker-provider.example.net' } },
    domainDns: { name: domain, providerDomainId: 'native-domain', serviceName: 'web',
      serviceId: 'native-web', environmentId: 'native-staging' },
  },
});
const pending = { domainActionId: `domain:${domain}`, blockedReason: 'email_callback_domain_pending' };

// Product requirement: callbacks use the exact bound declared public endpoint;
// an unresolved domain must not silently move delivery to a provider hostname.
// These pure ownership tests do not prove DNS, TLS or provider reachability.
describe('email callback target ownership', () => {
  it('selects the exact bound declared domain even when the provider URL differs', () => {
    expect(resolveEmailCallbackTarget(environment(), spec(), target))
      .toEqual({ url: `https://${domain}${path}`, domainActionId: `domain:${domain}` });
  });

  it('allows a known domain attachment without a redundant legacy customDomains list or provider URL', () => {
    const env = environment();
    env.platformBindings.services = { web: { serviceId: 'native-web' } };
    expect(resolveEmailCallbackTarget(env, spec(), target).url).toBe(`https://${domain}${path}`);
  });

  it.each(['environment', 'domain', 'project', 'environmentId', 'service'] as const)(
    'defers domain-backed bootstrap when the %s identity is missing', missing => {
      const env = environment();
      if (missing === 'domain') delete env.platformBindings.domainDns;
      if (missing === 'project') delete env.platformBindings.projectId;
      if (missing === 'environmentId') delete env.platformBindings.environmentId;
      if (missing === 'service') env.platformBindings.services = {};
      expect(resolveEmailCallbackTarget(missing === 'environment' ? null : env, spec(), target)).toEqual(pending);
    });

  it.each(['name', 'serviceName', 'serviceId', 'environmentId', 'providerDomainId'] as const)(
    'does not select the domain with a wrong or missing %s', field => {
      const env = environment();
      (env.platformBindings.domainDns as Record<string, unknown>)[field] = field === 'providerDomainId' ? '' : 'other-owner';
      expect(resolveEmailCallbackTarget(env, spec(), target)).toEqual(pending);
    });

  it('rejects a different hosting provider and an unobserved creation acknowledgement', () => {
    const env = environment();
    env.platformBindings.provider = 'vercel';
    expect(resolveEmailCallbackTarget(env, spec(), target)).toEqual(pending);
    env.platformBindings.provider = 'railway';
    (env.platformBindings.domainDns as Record<string, unknown>).creationAcknowledged = true;
    expect(resolveEmailCallbackTarget(env, spec(), target)).toEqual(pending);
  });

  it('defers ambiguous declared-domain ownership', () => {
    const desired = environmentSpecSchema.parse({ ...spec(), services: { web: {}, other: {} } });
    expect(resolveEmailCallbackTarget(environment(), desired, target)).toEqual(pending);
  });

  it('retains provider endpoints without a declared domain', () => {
    const desired = spec();
    delete desired.domain;
    expect(resolveEmailCallbackTarget(environment(), desired, target)).toEqual({ url: `https://web-provider.example.net${path}` });
  });

  it('preserves existing HTTP provider URL semantics for the readiness checker to classify', () => {
    const desired = spec();
    delete desired.domain;
    const env = environment();
    env.platformBindings.services = { web: { serviceId: 'native-web', url: 'http://web-provider.example.net' } };
    expect(resolveEmailCallbackTarget(env, desired, target)).toEqual({ url: `http://web-provider.example.net${path}` });
  });

  it('does not assign the domain to a different receiver', () => {
    expect(resolveEmailCallbackTarget(environment(), spec(), { ...target, service: 'worker' }))
      .toEqual({ url: `https://worker-provider.example.net${path}` });
  });

  it('preserves provider endpoints when the domain belongs to the load balancer lifecycle', () => {
    const desired = environmentSpecSchema.parse({ ...spec(), services: { web: {}, other: {} },
      loadBalancer: { provider: 'cloudflare', services: ['web', 'other'] } });
    expect(resolveEmailCallbackTarget(environment(), desired, target)).toEqual({ url: `https://web-provider.example.net${path}` });
  });

  it.each(['https://user:private@example.net', 'https://example.net?private=token', 'https://example.net#private',
    'https://example.net\\@other.example.net', 'javascript:alert(1)', 'not a URL'])(
    'does not expose or use unsafe provider base %s', url => {
      const env = environment();
      env.platformBindings.services = { web: { serviceId: 'native-web', url } };
      const desired = spec();
      delete desired.domain;
      expect(resolveEmailCallbackTarget(env, desired, target).url).toBeUndefined();
    });

  it.each(['//other.example.net/hook', '/\\other.example.net/hook', 'https://other.example.net/hook',
    '/hook?secret=token', '/hook#private'])(
    'rejects a callback path that could change authority or carry private URL fields: %s', unsafePath => {
      expect(resolveEmailCallbackTarget(environment(), spec(), { ...target, path: unsafePath }).url).toBeUndefined();
    });
});
