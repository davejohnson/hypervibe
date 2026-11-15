import { z } from 'zod';
import { registerCredentialCapability } from '../../domain/registry/credential-validation.registry.js';
import type { CredentialTracking } from '../../domain/spec/credential.schema.js';

async function read(url: string, headers: Record<string, string>) {
  // Fixed provider origins; credentials are headers only. No redirect forwarding.
  return fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
registerCredentialCapability('stripe-webhook', {
  managementUrl: 'https://dashboard.stripe.com/webhooks',
  async validate() {
    return { result: 'unknown', tested: 'A webhook signing secret requires its exact endpoint/account binding and an optional supplied signed delivery; API-key authentication cannot validate it.' };
  },
});
registerCredentialCapability('anthropic', {
  managementUrl: 'https://platform.claude.com/settings/keys',
  async validate(_descriptor, value) {
    const tested = 'Anthropic models authentication; no application inference request.';
    const response = await read('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': value, 'anthropic-version': '2023-06-01' });
    if (!response.ok) return { result: response.status === 401 || response.status === 403 ? 'failed' : 'unknown', tested };
    const parsed = z.object({ data: z.array(z.object({ id: z.string(), type: z.literal('model') })), has_more: z.boolean() }).safeParse(await response.json());
    return { result: parsed.success ? 'passed' : 'unknown', tested };
  },
});
registerCredentialCapability('sendgrid', {
  managementUrl: 'https://app.sendgrid.com/settings/api_keys',
  async validate(_descriptor, value) {
    const tested = 'SendGrid authentication and reported mail.send scope; no email delivery.';
    const response = await read('https://api.sendgrid.com/v3/scopes', auth(value));
    if (!response.ok) return { result: response.status === 401 || response.status === 403 ? 'failed' : 'unknown', tested };
    const parsed = z.object({ scopes: z.array(z.string()) }).safeParse(await response.json());
    return { result: !parsed.success ? 'unknown' : parsed.data.scopes.includes('mail.send') ? 'passed' : 'failed', tested };
  },
});
registerCredentialCapability('stripe', {
  managementUrl: 'https://dashboard.stripe.com/apikeys',
  async validate(descriptor, value) {
    const tested = 'Stripe authenticated account and balance mode; no payment or webhook operation.';
    if (!descriptor.identity?.accountId || !descriptor.identity.mode) return { result: 'failed', tested };
    const response = await read('https://api.stripe.com/v1/account', auth(value));
    if (!response.ok) return { result: response.status === 401 || response.status === 403 ? 'failed' : 'unknown', tested };
    const account = z.object({ id: z.string().regex(/^acct_/), object: z.literal('account') }).safeParse(await response.json());
    if (!account.success) return { result: 'unknown', tested };
    const expected = descriptor.identity.sandboxId ?? descriptor.identity.accountId;
    if (account.data.id !== expected) return { result: 'failed', tested };
    const balance = await read('https://api.stripe.com/v1/balance', auth(value));
    if (!balance.ok) return { result: 'unknown', tested };
    const mode = z.object({ object: z.literal('balance'), livemode: z.boolean() }).safeParse(await balance.json());
    return { result: !mode.success ? 'unknown' : mode.data.livemode === (descriptor.identity.mode === 'live') ? 'passed' : 'failed', tested, accountId: account.data.id };
  },
});
for (const kind of ['github-package-read', 'github-api-management'] as const) registerCredentialCapability(kind, {
  managementUrl: 'https://github.com/settings/tokens',
  creationUrl: descriptor => {
    // GitHub documents description/scopes prefill for classic PAT creation.
    const url = new URL('https://github.com/settings/tokens/new');
    url.searchParams.set('description', descriptor.label);
    if (kind === 'github-package-read') url.searchParams.set('scopes', 'read:packages');
    return url.toString();
  },
  async validate(descriptor: CredentialTracking, value: string) {
    const tested = kind === 'github-package-read' ? 'GitHub authentication and declared read:packages scope; no package download.' : 'GitHub authentication; repository-management permissions untested.';
    const response = await read('https://api.github.com/user', { ...auth(value), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    if (!response.ok) return { result: response.status === 401 || response.status === 403 ? 'failed' : 'unknown', tested };
    const user = z.object({ login: z.string(), id: z.number().int().positive() }).safeParse(await response.json());
    if (!user.success) return { result: 'unknown', tested };
    if (descriptor.identity && descriptor.identity.accountId !== String(user.data.id)) return { result: 'failed', tested };
    if (kind === 'github-package-read') {
      const scopes = response.headers.get('x-oauth-scopes');
      if (!scopes) return { result: 'unknown', tested };
      if (!scopes.split(',').map(s => s.trim()).some(s => s === 'read:packages' || s === 'write:packages')) return { result: 'failed', tested };
    }
    return { result: 'passed', tested, accountId: String(user.data.id) };
  },
});
