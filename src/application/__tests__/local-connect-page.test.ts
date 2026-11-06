import http from 'http';
import { describe, expect, it } from 'vitest';
import { connectCloudflareInBrowser } from '../local-connect-page.js';

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: '127.0.0.1', port: target.port, path: target.pathname, method: options.method ?? 'GET',
      headers: { host: target.host, ...(options.headers ?? {}) } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('local Cloudflare connect page', () => {
  it('serves a deep link, rejects cross-site and rebinding requests, and accepts a pasted token directly', async () => {
    let opened = '';
    const received: string[] = [];
    const pending = connectCloudflareInBrowser({
      domain: 'app.example.com',
      waitMs: 10_000,
      openBrowser: (url) => { opened = url; },
      complete: async (token) => {
        received.push(token);
        return token === 'good-token' ? { ok: true, message: 'Hypervibe can now manage DNS for example.com.' } : { ok: false, error: 'Cloudflare did not accept that token.' };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const url = new URL(opened);
    const nonce = url.pathname.split('/').pop()!;

    const pageResponse = await request(opened);
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.body).toContain('dash.cloudflare.com/profile/api-tokens');
    expect(pageResponse.body).toContain('example.com');

    expect((await request(opened, { headers: { host: `evil.test:${url.port}` } })).status).toBe(421);
    expect((await request(`${url.origin}/connect/wrong`)).status).toBe(404);
    const form = (token: string) => new URLSearchParams({ nonce, token }).toString();
    const post = (token: string, origin?: string) => request(opened, { method: 'POST', body: form(token),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) } });
    expect((await post('good-token')).status).toBe(403);
    const rejected = await post('bad-token', url.origin);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toContain('did not accept');
    const accepted = await post('good-token', url.origin);
    expect(accepted.body).toContain('Connected');

    await expect(pending).resolves.toMatchObject({ status: 'connected', scope: 'example.com' });
    expect(received).toEqual(['bad-token', 'good-token']);
  });
});
