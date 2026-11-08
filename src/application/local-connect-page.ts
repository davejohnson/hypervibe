import { execFile } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { findCloudflareZone } from '../domain/services/cloudflare-ops.service.js';
import { CLOUDFLARE_TOKEN_URLS } from '../domain/services/connection-guidance.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { dnsZoneScopeForDomain } from '../domain/services/domain-scope.js';
import { requestingAgent } from './requesting-agent.js';

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

const LOCK = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 9V7a4 4 0 1 1 8 0v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4" y="9" width="12" height="9" rx="2.2" fill="currentColor"/></svg>`;

/** What the requested token can do, and why Hypervibe needs each part. */
const CLOUDFLARE_PERMISSIONS: Array<{ name: string; why: string }> = [
  { name: 'DNS: Edit', why: 'point your domain at your app' },
  { name: 'Zone and Zone Settings: Read', why: 'find the domain and check its settings' },
  { name: 'Workers Routes and Scripts: Edit', why: 'show a maintenance page and move traffic during a migration' },
  { name: 'Account Settings: Read', why: 'find the Cloudflare account the domain belongs to' },
];

/** Who asked and why, so the person knows exactly what they are approving. */
export interface ConnectContext {
  /** Coding agent product name, for example "Claude Code" or "Codex". */
  agent: string;
  project?: string;
  repository?: string;
  environment?: string;
  /** What Hypervibe will do with the access, as a phrase after "so it can", for example "move staging.usebillforge.com to Google Cloud". */
  purpose?: string;
}

function contextRows(domain: string, context: ConnectContext): string {
  const rows: Array<[string, string]> = [
    ['Requested by', context.agent],
    ...(context.project ? [['Project', context.repository ? `${context.project} (${context.repository})` : context.project] as [string, string]] : []),
    ...(context.environment ? [['Environment', context.environment] as [string, string]] : []),
    ['Domain', domain],
  ];
  return `<dl class="context">${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
}

function page(params: { domain: string; nonce: string; context: ConnectContext; error?: string; connected?: string }): string {
  const zone = escapeHtml(dnsZoneScopeForDomain(params.domain));
  const agent = escapeHtml(params.context.agent);
  const purpose = escapeHtml(params.context.purpose ?? `manage DNS and traffic for ${params.domain}`);
  const body = params.connected
    ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Cloudflare is connected</h1><p>${escapeHtml(params.connected)}</p>
<p class="muted">The token is stored encrypted on this computer. You can close this tab; ${agent} continues from here.</p></section>`
    : `<p class="eyebrow">Connect Cloudflare</p>
<h1>Let Hypervibe manage <span class="nowrap">${zone}</span> on Cloudflare</h1>
<p class="lead">${agent} needs a Cloudflare token to ${purpose}.</p>
${contextRows(params.domain, params.context)}
<ol class="steps">
  <li><span class="num">1</span><div><a class="button" href="${CLOUDFLARE_TOKEN_URLS.user}" target="_blank" rel="noopener noreferrer">Open Cloudflare's token form ↗</a>
    <p class="muted">Permissions are pre-selected. Set <em>Zone Resources</em> to <strong>${zone}</strong>, then create the token.</p></div></li>
  <li><span class="num">2</span><div><p>Paste the token:</p>
<form method="post" action="/connect/${params.nonce}" autocomplete="off">
  <input type="hidden" name="nonce" value="${params.nonce}">
  <label class="sr" for="token">Cloudflare API token</label>
  <input id="token" type="password" name="token" placeholder="Paste your Cloudflare token" required spellcheck="false" autocapitalize="off" autofocus>
  <button type="submit">Connect</button>
</form>
${params.error ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>` : ''}</div></li>
</ol>
<details><summary>What this token can do</summary><ul class="perms">
${CLOUDFLARE_PERMISSIONS.map((entry) => `  <li><strong>${escapeHtml(entry.name)}</strong> <span class="muted">to ${escapeHtml(entry.why)}</span></li>`).join('\n')}
</ul><p class="muted small">Revoke it any time under My Profile → API Tokens.</p></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect Cloudflare · Hypervibe</title>
<style>
/* Matches the hosted Hypervibe app: ink background, signal green, terminal wordmark. */
:root{color-scheme:dark;--ink-950:#080b0d;--ink-900:#0d1215;--ink-800:#10171b;--cloud-100:#c8d1d6;--cloud-300:#93a1a9;--signal-300:#79d98b;--signal-700:#3a7047;--signal-950:#15221a;--frame:#26333a;--err:#f2a7a7;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--ink-950);color:var(--cloud-100);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;
  background-image:linear-gradient(rgb(121 217 139/.022) 1px,transparent 1px),linear-gradient(90deg,rgb(121 217 139/.018) 1px,transparent 1px);background-size:32px 32px}
.wrap{max-width:38rem;margin:7vh auto;padding:0 16px}
header{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.9rem}
.wordmark{font-family:var(--mono);font-size:1.125rem;font-weight:600;letter-spacing:-.025em;color:#fff}.wordmark span{color:var(--signal-300)}
.local{display:flex;align-items:center;gap:.4rem;font-family:var(--mono);font-size:.75rem;color:var(--cloud-300);border:1px solid var(--frame);border-radius:2px;padding:.2rem .55rem;background:var(--ink-900)}
.icon{width:12px;height:12px;color:var(--signal-300)}
main{background:var(--ink-900);border:1px solid var(--frame);border-radius:2px;padding:1.5rem}
.eyebrow{margin:0 0 .35rem;font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--signal-300)}
h1{font-size:1.15rem;line-height:1.35;margin:0 0 .6rem;font-weight:600;color:#fff}.lead{margin:0 0 1.25rem}
strong{color:#fff;font-weight:600}.nowrap{white-space:nowrap}.muted{color:var(--cloud-300)}.small{font-size:.8rem}
.steps{list-style:none;padding:0;margin:0 0 1rem}.steps>li{display:flex;gap:.75rem;margin-bottom:1.1rem}.steps p{margin:.4rem 0 0}
.num{flex:none;width:1.5rem;height:1.5rem;border:1px solid var(--signal-700);border-radius:2px;color:var(--signal-300);font-family:var(--mono);font-size:.75rem;display:grid;place-items:center;margin-top:.1rem}
.steps>li>div{flex:1;min-width:0}
.button,button{display:inline-flex;align-items:center;gap:.5rem;min-height:2.5rem;padding:.4rem .8rem;border:1px solid var(--signal-700);border-radius:2px;background:var(--ink-900);color:var(--signal-300);font:500 .8rem/1 inherit;font-family:inherit;text-decoration:none;cursor:pointer}
.button:hover,button:hover{border-color:var(--signal-300);background:var(--signal-950)}
a:focus-visible,button:focus-visible{outline:2px solid var(--signal-300);outline-offset:4px}
form{display:flex;gap:.5rem;margin:.6rem 0 .25rem;flex-wrap:wrap}
input[type=password]{flex:1 1 14rem;min-width:0;padding:.5rem .75rem;border:1px solid var(--frame);border-radius:2px;background:var(--ink-950);color:var(--cloud-100);font:.875rem var(--mono)}
input[type=password]::placeholder{color:rgb(147 161 169/.7);font-family:ui-sans-serif,system-ui,sans-serif}
input[type=password]:focus{outline:none;border-color:var(--signal-300);box-shadow:0 0 0 3px rgb(121 217 139/.2)}
.error{color:var(--err);margin:.45rem 0 0}
details{border-top:1px solid var(--frame);padding-top:.85rem}summary{cursor:pointer;color:#fff}.perms{margin:.6rem 0;padding-left:1.1rem}.perms li{margin:.25rem 0}
.trust{margin-top:1rem;border:1px solid var(--frame);border-radius:2px;background:var(--ink-800);padding:.8rem 1rem;font-size:.8rem;color:var(--cloud-300)}.trust ul{margin:.35rem 0 0;padding-left:1.1rem}.trust li{margin:.2rem 0}.trust strong{font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--signal-300);font-weight:500}
.done{text-align:center}.tick{width:2.75rem;height:2.75rem;margin:0 auto .6rem;border:1px solid var(--signal-700);border-radius:2px;background:var(--signal-950);color:var(--signal-300);font-size:1.4rem;display:grid;place-items:center}
.context{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem;margin:0 0 1.25rem;padding:.75rem .9rem;border:1px solid var(--frame);border-radius:2px;background:var(--ink-950);font-size:.82rem}
.context dt{font-family:var(--mono);font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--cloud-300);padding-top:.12rem}.context dd{margin:0;color:#fff;overflow-wrap:anywhere}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body><div class="wrap">
<header><div class="wordmark" aria-label="Hypervibe">hyper<span>vibe</span></div><div class="local" title="Served by Hypervibe on 127.0.0.1">${LOCK}<span>Running on this computer</span></div></header>
<main>${body}</main>
<section class="trust" aria-label="How your token is handled"><strong>How your token is handled</strong><ul>
<li>Served on this computer only (127.0.0.1); loads nothing from the internet.</li>
<li>Saved encrypted on this computer. Never sent to chat, ${agent} or any Hypervibe server.</li>
<li>Checked against ${zone} before saving. Link expires in 30 minutes.</li>
</ul></section>
</div></body></html>`;
}

/** Checks that the token can read the zone and its DNS records before anything is saved. */
async function checkCloudflareToken(token: string, domain: string): Promise<{ ok: true; zone: string } | { ok: false; error: string }> {
  const adapter = new CloudflareAdapter();
  let zoneName: string;
  try {
    adapter.connect({ apiToken: token });
    const verified = await adapter.verify();
    if (!verified.success) return { ok: false, error: 'Cloudflare did not accept that token. Copy it again from Cloudflare and paste the whole value.' };
    const zone = await findCloudflareZone(adapter, domain);
    if (!zone) return { ok: false, error: `That token cannot see ${dnsZoneScopeForDomain(domain)}. In Cloudflare, edit the token and include this zone under Zone Resources.` };
    await adapter.listRecords(zone.id);
    zoneName = zone.name;
  } catch {
    return { ok: false, error: 'That token cannot read DNS records for this domain. Make sure it has the DNS Edit permission.' };
  }
  // Maintenance pages and migration cutovers run as a Worker on the app's hostname.
  const workers = await adapter.observeMaintenanceEdge(domain).catch(() => undefined);
  if (!workers || /cannot manage Workers/.test(workers.reason ?? '')) {
    return { ok: false, error: 'That token cannot manage Cloudflare Workers, which Hypervibe uses for maintenance pages and moving traffic. Create it again from the button above and keep the Workers Routes and Workers Scripts permissions.' };
  }
  return { ok: true, zone: zoneName };
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
  /** Who asked and why; shown on the page. Defaults to the detected coding agent. */
  context?: Partial<ConnectContext>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
  /** Overrides the token check and save, for tests. */
  complete?: (token: string, domain: string) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}): Promise<LocalConnectResult> {
  const domain = params.domain.trim().toLowerCase();
  const scope = dnsZoneScopeForDomain(domain);
  const context: ConnectContext = { ...params.context, agent: params.context?.agent ?? requestingAgent() };
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
      if (request.method === 'GET') { html(page({ domain, nonce, context, ...(entry?.settled?.status === 'connected' ? { connected: entry.settled.message } : {}) })); return; }
      if (request.method !== 'POST' || request.headers.origin !== `http://127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.length > 8192) request.destroy(); });
      request.on('end', async () => {
        const form = new URLSearchParams(raw);
        const token = form.get('token')?.trim() ?? '';
        if (form.get('nonce') !== nonce || !token) { html(page({ domain, nonce, context, error: 'Paste the token Cloudflare showed you.' }), 400); return; }
        const outcome = await complete(token, domain);
        if (!outcome.ok) { html(page({ domain, nonce, context, error: outcome.error }), 400); return; }
        const settled: LocalConnectResult = { status: 'connected', provider: 'cloudflare', scope, message: outcome.message };
        entry!.settled = settled;
        html(page({ domain, nonce, context, connected: outcome.message }));
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
    message: `A Cloudflare connect page is open in your browser (${entry.url}). Finish there, then ${context.agent} continues.`,
  };
}
