import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkKnownSecret, KNOWN_SECRETS } from '../local-secret-page.js';

const credential = 'synthetic-credential-for-local-redirect-test';
const endpoints = {
  ANTHROPIC_API_KEY: 'https://api.anthropic.com/v1/models',
  OPENAI_API_KEY: 'https://api.openai.com/v1/models',
  STRIPE_SECRET_KEY: 'https://api.stripe.com/v1/balance',
  RESEND_API_KEY: 'https://api.resend.com/domains',
  RECAPTCHA_SECRET_KEY: 'https://www.google.com/recaptcha/api/siteverify',
  SENDGRID_API_KEY: 'https://api.sendgrid.com/v3/scopes',
};
type Key = keyof typeof endpoints;
type RequestEvidence = { method: string | undefined; hasCredential: boolean };

async function requestEvidence(request: IncomingMessage): Promise<RequestEvidence> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return {
    method: request.method,
    hasCredential: request.headers.authorization === `Bearer ${credential}`
      || request.headers['x-api-key'] === credential
      || new URLSearchParams(body).get('secret') === credential,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  return `http://127.0.0.1:${address.port}`;
}

describe('known credential checks over real HTTP transport', () => {
  const servers: Server[] = [];
  const approvedRequests: RequestEvidence[] = [];
  const redirectedRequests: RequestEvidence[] = [];
  let redirectStatus: number | undefined;
  let responseStatus: number;
  let responseBody: Record<string, unknown>;

  beforeAll(async () => {
    const nativeFetch = globalThis.fetch;
    const target = createServer(async (request, response) => {
      redirectedRequests.push(await requestEvidence(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ scopes: ['mail.send'], 'error-codes': ['missing-input-response'] }));
    });
    servers.push(target);
    const targetOrigin = await listen(target);
    const approved = createServer(async (request, response) => {
      approvedRequests.push(await requestEvidence(request));
      if (redirectStatus) {
        response.writeHead(redirectStatus, { location: `${targetOrigin}/unapproved-destination` });
        response.end();
        return;
      }
      response.writeHead(responseStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    });
    servers.push(approved);
    const approvedOrigin = await listen(approved);
    // Only replace the initial service destination. Native fetch still performs
    // real HTTP requests and applies its own redirect behavior between origins.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const entry = Object.entries(endpoints).find(([, endpoint]) => endpoint === url);
      if (!entry) throw new Error('Unexpected credential-check destination');
      return nativeFetch(`${approvedOrigin}/${entry[0]}`, init);
    });
  });

  beforeEach(() => {
    approvedRequests.length = 0;
    redirectedRequests.length = 0;
    redirectStatus = undefined;
    responseStatus = 200;
    responseBody = {};
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }));
  });

  for (const key of Object.keys(endpoints) as Key[]) {
    it.each([307, 308])(`rejects %i redirects for ${key} before contacting another origin`, async (status) => {
      redirectStatus = status;
      const verdict = await checkKnownSecret(KNOWN_SECRETS[key]!, credential);
      expect(approvedRequests).toEqual([{ method: key === 'RECAPTCHA_SECRET_KEY' ? 'POST' : 'GET', hasCredential: true }]);
      expect(redirectedRequests).toEqual([]);
      expect(verdict).toContain('did not accept that key');
      expect(verdict).not.toContain(credential);
    });
  }

  const directCases: Array<{ key: Key; status: number; body: Record<string, unknown>; outcome: 'accepted' | 'rejected' | 'missing-mail-scope' }> = [
    { key: 'ANTHROPIC_API_KEY', status: 200, body: {}, outcome: 'accepted' },
    { key: 'OPENAI_API_KEY', status: 200, body: {}, outcome: 'accepted' },
    { key: 'STRIPE_SECRET_KEY', status: 200, body: {}, outcome: 'accepted' },
    { key: 'OPENAI_API_KEY', status: 401, body: { error: credential }, outcome: 'rejected' },
    { key: 'RESEND_API_KEY', status: 200, body: {}, outcome: 'accepted' },
    { key: 'RESEND_API_KEY', status: 403, body: { name: 'restricted_api_key' }, outcome: 'accepted' },
    { key: 'RESEND_API_KEY', status: 403, body: { name: 'validation_error' }, outcome: 'rejected' },
    { key: 'RECAPTCHA_SECRET_KEY', status: 200, body: { 'error-codes': ['missing-input-response'] }, outcome: 'accepted' },
    { key: 'RECAPTCHA_SECRET_KEY', status: 200, body: { 'error-codes': ['invalid-input-secret'] }, outcome: 'rejected' },
    { key: 'SENDGRID_API_KEY', status: 200, body: { scopes: ['mail.send'] }, outcome: 'accepted' },
    { key: 'SENDGRID_API_KEY', status: 200, body: { scopes: [] }, outcome: 'missing-mail-scope' },
    { key: 'SENDGRID_API_KEY', status: 403, body: { error: credential }, outcome: 'rejected' },
  ];

  it.each(directCases)('preserves $key direct response $status ($outcome)', async ({ key, status, body, outcome }) => {
    responseStatus = status;
    responseBody = body;
    const verdict = await checkKnownSecret(KNOWN_SECRETS[key]!, credential);
    expect(approvedRequests).toEqual([{ method: key === 'RECAPTCHA_SECRET_KEY' ? 'POST' : 'GET', hasCredential: true }]);
    expect(redirectedRequests).toEqual([]);
    if (outcome === 'accepted') expect(verdict).toBeUndefined();
    else {
      expect(verdict).toContain(outcome === 'missing-mail-scope' ? 'cannot send mail' : 'did not accept that key');
      expect(verdict).not.toContain(credential);
    }
  });
});
