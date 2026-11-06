import { execFile } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { findCloudflareZone } from '../domain/services/cloudflare-ops.service.js';
import { CLOUDFLARE_TOKEN_URLS } from '../domain/services/connection-guidance.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { dnsZoneScopeForDomain } from '../domain/services/domain-scope.js';

/**
 * A one-page local connect flow for providers that only offer API tokens.
 * Hypervibe serves it on 127.0.0.1 behind an unguessable path, deep-links
 * into the provider's pre-filled token form, and receives the pasted token
 * directly: it never passes through chat, a file the user edits, or any
 * remote server. The token is checked against the real resource before it
 * is saved encrypted.
 */
export interface LocalConnectResult {
  status: 'connected' | 'waiting' | 'failed';
  provider: string;
  scope: string;
  url?: string;
  message: string;
}

interface ActivePage {
  url: string;
  result: Promise<LocalConnectResult>;
  settled?: LocalConnectResult;
}

const active = new Map<string, ActivePage>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function page(params: { domain: string; nonce: string; error?: string; connected?: string }): string {
  const body = params.connected
    ? `<div class="done"><div class="tick">✓</div><h1>Connected</h1><p>${escapeHtml(params.connected)}</p><p class="muted">You can close this tab and go back to your assistant.</p></div>`
    : `<h1>Connect Cloudflare</h1>
<p>Hypervibe needs to manage DNS for <strong>${escapeHtml(params.domain)}</strong> so your app can use it.</p>
<ol>
  <li><a class="button" href="${CLOUDFLARE_TOKEN_URLS.user}" target="_blank" rel="noopener">Open Cloudflare</a>
    <span class="muted">The permissions are already filled in. Under <em>Zone Resources</em>, choose <strong>${escapeHtml(dnsZoneScopeForDomain(params.domain))}</strong>, then click <em>Continue to summary</em> and <em>Create Token</em>.</span></li>
  <li>Copy the token Cloudflare shows you and paste it here:</li>
</ol>
<form method="post" action="/connect/${params.nonce}" autocomplete="off">
  <input type="hidden" name="nonce" value="${params.nonce}">
  <input type="password" name="token" placeholder="Paste your Cloudflare token" required spellcheck="false" autofocus>
  <button type="submit">Connect</button>
</form>
${params.error ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>` : ''}
<p class="muted small">The token goes straight from this page to Hypervibe on your computer and is stored encrypted. It is never shown in chat.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Cloudflare · Hypervibe</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#f38020;--ok:#15803d;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--ok:#4ade80;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:34rem;margin:8vh auto;padding:2rem;background:var(--card);border:1px solid var(--line);border-radius:14px}
h1{font-size:1.4rem;margin:0 0 .5rem}ol{padding-left:1.2rem}li{margin:.9rem 0}.muted{color:var(--muted)}.small{font-size:.85rem}
.button,button{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:.55rem 1rem;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
li .button{margin-right:.5rem}form{display:flex;gap:.5rem;margin:.5rem 0 1rem}input[type=password]{flex:1;min-width:0;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.error{color:var(--err)}.done{text-align:center}.tick{font-size:2.5rem;color:var(--ok)}
</style></head><body><main>${body}</main></body></html>`;
}

/** Checks that the token can read the zone and its DNS records before anything is saved. */
async function checkCloudflareToken(token: string, domain: string): Promise<{ ok: true; zone: string } | { ok: false; error: string }> {
  const adapter = new CloudflareAdapter();
  try {
    adapter.connect({ apiToken: token });
    const verified = await adapter.verify();
    if (!verified.success) return { ok: false, error: 'Cloudflare did not accept that token. Copy it again from Cloudflare and paste the whole value.' };
    const zone = await findCloudflareZone(adapter, domain);
    if (!zone) return { ok: false, error: `That token cannot see ${dnsZoneScopeForDomain(domain)}. In Cloudflare, edit the token and include this zone under Zone Resources.` };
    await adapter.listRecords(zone.id);
    return { ok: true, zone: zone.name };
  } catch {
    return { ok: false, error: 'That token cannot read DNS records for this domain. Make sure it has the DNS Edit permission.' };
  }
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => {});
}

/**
 * Opens (or reuses) the Cloudflare connect page for a domain and waits up to
 * `waitMs` for the user to finish. The page keeps listening afterwards while
 * the process lives, so a later call can pick up the result.
 */
export async function connectCloudflareInBrowser(params: {
  domain: string;
  waitMs?: number;
  openBrowser?: (url: string) => void;
  /** Overrides the token check and save, for tests. */
  complete?: (token: string, domain: string) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}): Promise<LocalConnectResult> {
  const domain = params.domain.trim().toLowerCase();
  const scope = dnsZoneScopeForDomain(domain);
  const key = `cloudflare:${scope}`;
  let entry = active.get(key);
  if (entry?.settled?.status === 'connected') return entry.settled;
  if (!entry) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    let resolve!: (result: LocalConnectResult) => void;
    const result = new Promise<LocalConnectResult>((done) => { resolve = done; });
    const complete = params.complete ?? (async (token: string) => {
      const checked = await checkCloudflareToken(token, domain);
      if (!checked.ok) return checked;
      const saved = await saveConnection('cloudflare', { apiToken: token }, scope, { credentialsSource: 'local-connect-page' });
      if (!saved.success) return { ok: false as const, error: 'Hypervibe could not save the connection. Try again.' };
      const verified = await verifyConnection('cloudflare', scope);
      if (verified.kind !== 'verified') return { ok: false as const, error: 'Cloudflare accepted the token, but Hypervibe could not verify it. Try again.' };
      return { ok: true as const, message: `Hypervibe can now manage DNS for ${checked.zone}.` };
    });
    const server = http.createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      // Reject DNS-rebinding and cross-site requests: only this exact local origin may talk to the page.
      if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(421).end(); return; }
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      if (path !== `/connect/${nonce}`) { response.writeHead(404).end(); return; }
      const html = (body: string, status = 200) => response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
      }).end(body);
      if (request.method === 'GET') { html(page({ domain, nonce, ...(entry?.settled?.status === 'connected' ? { connected: entry.settled.message } : {}) })); return; }
      if (request.method !== 'POST' || request.headers.origin !== `http://127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.length > 8192) request.destroy(); });
      request.on('end', async () => {
        const form = new URLSearchParams(raw);
        const token = form.get('token')?.trim() ?? '';
        if (form.get('nonce') !== nonce || !token) { html(page({ domain, nonce, error: 'Paste the token Cloudflare showed you.' }), 400); return; }
        const outcome = await complete(token, domain);
        if (!outcome.ok) { html(page({ domain, nonce, error: outcome.error }), 400); return; }
        const settled: LocalConnectResult = { status: 'connected', provider: 'cloudflare', scope, message: outcome.message };
        entry!.settled = settled;
        html(page({ domain, nonce, connected: outcome.message }));
        resolve(settled);
        setTimeout(() => { server.close(); active.delete(key); }, 2000).unref();
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connect/${nonce}`;
    // Give up quietly after 30 minutes; a new request opens a fresh page.
    setTimeout(() => { if (!entry?.settled) { server.close(); active.delete(key); } }, 30 * 60 * 1000).unref();
    entry = { url, result };
    active.set(key, entry);
    (params.openBrowser ?? openInBrowser)(url);
  }
  const waited = await Promise.race([
    entry.result,
    new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? 4 * 60 * 1000).unref()),
  ]);
  return waited ?? {
    status: 'waiting', provider: 'cloudflare', scope, url: entry.url,
    message: `A Cloudflare connect page is open in your browser (${entry.url}). Finish there, then ask your assistant to continue.`,
  };
}
