import { execFile } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { servingMcpClient } from './requesting-agent.js';

/**
 * A one-time local page that takes a credential pasted by a person: Hypervibe
 * serves it on 127.0.0.1 behind an unguessable path, links to the provider's
 * page for creating the credential, and receives the value directly. It never
 * passes through chat, a file the person edits, or any remote server. Each
 * caller checks the value against the real service before saving it.
 */
export interface LocalPasteResult {
  status: 'connected' | 'waiting' | 'failed';
  provider: string;
  scope: string;
  url?: string;
  message: string;
}

export interface PastePageSpec {
  /** Browser tab title, for example "Connect Cloudflare". */
  tabTitle: string;
  eyebrow: string;
  /** Heading; may contain trusted HTML built from escaped values. */
  titleHtml: string;
  leadHtml: string;
  rows: Array<[string, string]>;
  /** Where the person gets the value; omitted when Hypervibe knows no page for it. */
  link?: { url: string; label: string; hintHtml: string; copy?: { label: string; value: string } };
  /** Shown in step 1 when there is no link. */
  sourceHintHtml?: string;
  input: { label: string; placeholder: string; button: string; missing: string };
  details?: { summary: string; items: Array<{ name: string; why: string }>; note: string };
  done: { title: string; note: string };
  /** Who the trust panel says the value is never sent to, for example "Claude Code". */
  agent: string;
  /** What the value is checked against before saving, for example "usebillforge.com"; omitted when there is no check. */
  checkedAgainst?: string;
  /** Where it is stored, for example "Saved encrypted on this computer". */
  storedWhere: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const LOCK = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 9V7a4 4 0 1 1 8 0v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4" y="9" width="12" height="9" rx="2.2" fill="currentColor"/></svg>`;

const COPY_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function renderPastePage(spec: PastePageSpec, state: { nonce: string; scriptNonce?: string; error?: string; connected?: string }): string {
  const agent = escapeHtml(spec.agent);
  const rows = `<dl class="context">${spec.rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
  const body = state.connected
    ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>${escapeHtml(spec.done.title)}</h1><p>${escapeHtml(state.connected)}</p>
<p class="muted">${escapeHtml(spec.done.note)} You can close this tab; ${agent} continues from here.</p></section>`
    : `<p class="eyebrow">${escapeHtml(spec.eyebrow)}</p>
<h1>${spec.titleHtml}</h1>
<p class="lead">${spec.leadHtml}</p>
${rows}
<ol class="steps">
  <li><span class="num">1</span><div>${spec.link ? `<a class="button" href="${escapeHtml(spec.link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(spec.link.label)} ↗</a>
    <p class="muted">${spec.link.hintHtml}</p>${spec.link.copy ? `
    <p class="copyrow"><span class="muted">${escapeHtml(spec.link.copy.label)}</span> <code class="copy">${escapeHtml(spec.link.copy.value)}</code> <button type="button" class="icon-button" data-copy="${escapeHtml(spec.link.copy.value)}" aria-label="Copy" title="Copy">${COPY_ICON}</button></p>` : ''}` : `<p>${spec.sourceHintHtml ?? 'Copy the value from the service that issued it.'}</p>`}</div></li>
  <li><span class="num">2</span><div><p>Paste it here:</p>
<form method="post" action="/connect/${state.nonce}" autocomplete="off">
  <input type="hidden" name="nonce" value="${state.nonce}">
  <label class="sr" for="token">${escapeHtml(spec.input.label)}</label>
  <input id="token" type="password" name="token" placeholder="${escapeHtml(spec.input.placeholder)}" required spellcheck="false" autocapitalize="off" autofocus>
  <button type="submit">${escapeHtml(spec.input.button)}</button>
</form>
${state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : ''}</div></li>
</ol>
${spec.details ? `<details><summary>${escapeHtml(spec.details.summary)}</summary><ul class="perms">
${spec.details.items.map((entry) => `  <li><strong>${escapeHtml(entry.name)}</strong> <span class="muted">to ${escapeHtml(entry.why)}</span></li>`).join('\n')}
</ul><p class="muted small">${escapeHtml(spec.details.note)}</p></details>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(spec.tabTitle)} · Hypervibe</title>
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
.copyrow{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.copy{font:.8rem var(--mono);color:#fff;background:var(--ink-950);border:1px solid var(--frame);border-radius:2px;padding:.2rem .45rem;overflow-wrap:anywhere}
.icon-button{min-height:0;width:1.7rem;height:1.7rem;padding:0;justify-content:center;border-color:var(--frame);color:var(--cloud-300)}.icon-button:hover{color:var(--signal-300)}.icon-button svg{width:14px;height:14px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body><div class="wrap">
<header><div class="wordmark" aria-label="Hypervibe">hyper<span>vibe</span></div><div class="local" title="Served by Hypervibe on 127.0.0.1">${LOCK}<span>Running on this computer</span></div></header>
<main>${body}</main>
<section class="trust" aria-label="How this is handled"><strong>How this is handled</strong><ul>
<li>Served on this computer only (127.0.0.1); loads nothing from the internet.</li>
<li>${escapeHtml(spec.storedWhere)}. Never sent to chat, ${agent} or any Hypervibe server.</li>
<li>${spec.checkedAgainst ? `Checked against ${escapeHtml(spec.checkedAgainst)} before saving. ` : ''}Link expires in 30 minutes.</li>
</ul></section>
</div>${state.scriptNonce ? `<script nonce="${state.scriptNonce}">document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var i=b.innerHTML;b.innerHTML=${JSON.stringify(CHECK_ICON)};b.title='Copied';setTimeout(function(){b.innerHTML=i;b.title='Copy'},1500)})})})</script>` : ''}</body></html>`;
}

interface ActivePage {
  url: string;
  result: Promise<LocalPasteResult>;
  settled?: LocalPasteResult;
}

const active = new Map<string, ActivePage>();

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => {});
}

/**
 * Opens (or reuses) a paste page and waits up to `waitMs` for the person to
 * finish. Under MCP the page keeps listening afterwards, so a later call picks
 * up the result; a CLI command waits for the page's whole lifetime.
 */
export async function servePastePage(params: {
  /** One page per key; a second request reuses it. */
  key: string;
  provider: string;
  scope: string;
  spec: PastePageSpec;
  /** Checks and saves the pasted value. Its message is shown on success. */
  accept: (value: string) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<LocalPasteResult> {
  let entry = active.get(params.key);
  if (entry?.settled?.status === 'connected') return entry.settled;
  if (!entry) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    let resolve!: (result: LocalPasteResult) => void;
    const result = new Promise<LocalPasteResult>((done) => { resolve = done; });
    const server = http.createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      // Reject DNS-rebinding and cross-site requests: only this exact local origin may talk to the page.
      if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(421).end(); return; }
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      if (path !== `/connect/${nonce}`) { response.writeHead(404).end(); return; }
      // One inline script (the copy button) may run, authorized by a fresh nonce per response.
      const scriptNonce = crypto.randomBytes(16).toString('base64');
      const html = (body: string, status = 200) => response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; form-action 'self'; base-uri 'none'`,
        // same-origin, not no-referrer: under no-referrer browsers send "Origin: null" on this page's own form post.
        'Referrer-Policy': 'same-origin',
      }).end(body);
      if (request.method === 'GET') { html(renderPastePage(params.spec, { nonce, scriptNonce, ...(entry?.settled?.status === 'connected' ? { connected: entry.settled.message } : {}) })); return; }
      // Only this page may post: its exact origin, or the browser's own same-origin marker.
      const sameOrigin = request.headers.origin === `http://127.0.0.1:${port}`
        || ((request.headers.origin === undefined || request.headers.origin === 'null') && request.headers['sec-fetch-site'] === 'same-origin');
      if (request.method !== 'POST' || !sameOrigin) { response.writeHead(403).end(); return; }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.length > 8192) request.destroy(); });
      request.on('end', async () => {
        const form = new URLSearchParams(raw);
        const value = form.get('token')?.trim() ?? '';
        if (form.get('nonce') !== nonce || !value) { html(renderPastePage(params.spec, { nonce, scriptNonce, error: params.spec.input.missing }), 400); return; }
        const outcome = await params.accept(value);
        if (!outcome.ok) { html(renderPastePage(params.spec, { nonce, scriptNonce, error: outcome.error }), 400); return; }
        const settled: LocalPasteResult = { status: 'connected', provider: params.provider, scope: params.scope, message: outcome.message };
        entry!.settled = settled;
        html(renderPastePage(params.spec, { nonce, scriptNonce, connected: outcome.message }));
        resolve(settled);
        setTimeout(() => { server.close(); active.delete(params.key); }, 2000).unref();
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connect/${nonce}`;
    // Give up quietly after 30 minutes; a new request opens a fresh page.
    setTimeout(() => { if (!entry?.settled) { server.close(); active.delete(params.key); } }, 30 * 60 * 1000).unref();
    entry = { url, result };
    active.set(params.key, entry);
    (params.openBrowser ?? openInBrowser)(url);
  }
  const waited = await Promise.race([
    entry.result,
    new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? (servingMcpClient() ? 4 * 60 * 1000 : 30 * 60 * 1000)).unref()),
  ]);
  return waited ?? {
    status: 'waiting', provider: params.provider, scope: params.scope, url: entry.url,
    message: `A ${params.spec.tabTitle.replace(/^Connect /, '')} page is open in your browser (${entry.url}). Finish there, then ${params.spec.agent} continues.`,
  };
}
