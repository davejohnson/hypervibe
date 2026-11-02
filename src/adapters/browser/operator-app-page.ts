import { createHash } from 'node:crypto';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
// Hypervibe's ink/signal palette, system fonts and wordmark. No remote assets.
const styles = `
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#c8d1d6;background:#080b0d;font-size:16px;line-height:1.6}
*{box-sizing:border-box}body{margin:0;padding:36px 20px}main{max-width:700px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:48px}
.brand{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:23px;font-weight:700;letter-spacing:-1px;color:#79d98b}.label{color:#93a1a9;font-size:13px}.eyebrow{color:#79d98b;text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-weight:650}
h1{font-size:clamp(28px,5vw,38px);line-height:1.2;letter-spacing:-.025em;margin:12px 0 16px;color:#fff}h2{font-size:17px;color:#fff;margin:0 0 8px}p{margin:0 0 18px}.intro{font-size:18px;color:#c8d1d6}
.panel{border:1px solid #26333a;background:#0d1215;border-radius:10px;padding:24px;margin:24px 0}.details{display:grid;grid-template-columns:100px 1fr;gap:8px 16px;margin:0}.details dt{color:#93a1a9}.details dd{margin:0;overflow-wrap:anywhere}
ol{padding-left:24px;margin:0}li{padding-left:8px;margin:16px 0}li::marker{color:#79d98b;font-weight:bold}li:last-child{margin-bottom:0}strong{color:#fff;font-weight:600}
form{margin-bottom:16px}button{display:block;width:100%;border:0;border-radius:7px;padding:14px 20px;background:#79d98b;color:#080b0d;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#9de6aa}button:focus-visible{outline:3px solid #fff;outline-offset:4px}
.note{font-size:14px;color:#93a1a9}.privacy{border-left:3px solid #3a7047;padding-left:18px;margin:28px 0}.privacy p:last-child{margin-bottom:0}footer{border-top:1px solid #26333a;padding-top:18px;margin-top:32px;font-size:13px;color:#93a1a9}
@media(max-width:480px){body{padding:24px 16px}header{margin-bottom:32px}.panel{padding:18px}.details{grid-template-columns:1fr;gap:2px}.details dd{margin-bottom:10px}}
`;
export const operatorPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`;
function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Hypervibe</title><style>${styles}</style></head><body><main><header><span class="brand">hypervibe</span><span class="label">Private browser setup</span></header>${content}<footer>This page runs on your computer. Keep Hypervibe running until you return from GitHub.</footer></main></body></html>`;
}
export function operatorReviewPage(input: { postUrl: string; manifest: Record<string, unknown>; serializedManifest: string; state: string; expiresAt: string }) {
  const name = typeof input.manifest.name === 'string' ? input.manifest.name : 'GitHub App';
  const address = typeof input.manifest.url === 'string' ? input.manifest.url : '';
  const organization = new URL(input.postUrl).pathname.match(/^\/organizations\/([^/]+)\//)?.[1];
  return page('Connect GitHub', `<p class="eyebrow">GitHub connection</p><h1>One browser step.<br>Hypervibe handles the rest.</h1><p class="intro">Create the GitHub App for your Hypervibe setup. GitHub will show the requested permissions before you approve.</p>
<section class="panel" aria-label="Connection details"><dl class="details"><dt>App name</dt><dd>${escapeHtml(name)}</dd>${address ? `<dt>App address</dt><dd>${escapeHtml(address)}</dd>` : ''}<dt>Owner</dt><dd>${organization ? escapeHtml(organization) : 'The GitHub account you choose on the next page'}</dd></dl></section>
<section aria-labelledby="steps"><h2 id="steps">What to do</h2><ol><li><strong>Review on GitHub.</strong> Sign in with the account that should own this app. Check its name, owner and requested permissions, then approve creation if they match your setup.</li><li><strong>Let GitHub return you here.</strong> Keep Hypervibe running and use the same browser on this computer. You do not need to copy a token or download credentials.</li><li><strong>Return to Hypervibe.</strong> Tell your agent you have finished the browser step. It will verify the response and continue the setup you approved.</li></ol></section>
<div class="privacy"><h2>Credentials stay out of chat</h2><p>Hypervibe receives GitHub’s response privately. Generated credentials are encrypted on this computer until delivery to the secret manager you approved.</p><p class="note">Never paste credentials into chat. This step creates a GitHub App; it does not deploy your app or install it on your repositories. Those actions need their own authorization.</p></div>
<form method="POST" action="${escapeHtml(input.postUrl)}"><input type="hidden" name="manifest" value="${escapeHtml(input.serializedManifest)}"><input type="hidden" name="state" value="${escapeHtml(input.state)}"><button type="submit">Review on GitHub</button></form>
<p class="note">This private link expires at <time datetime="${escapeHtml(input.expiresAt)}">${escapeHtml(input.expiresAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'))}</time>. If you cancel or see an error, return to Hypervibe and report what happened. Your agent will check the saved setup before trying again.</p>`);
}
export function operatorReceivedPage() {
  return page('GitHub response received', '<p class="eyebrow">Browser step received</p><h1>GitHub response received</h1><p class="intro">You can close this tab and return to Hypervibe.</p><section class="panel"><h2>Return to Hypervibe</h2><p>Tell your agent you finished the GitHub browser step. It will verify the response and finish saving the credentials to your approved secret manager.</p><p class="note">Setup is still in progress. This page confirms receipt of the browser response, not completed installation or deployment.</p></section>');
}
export function operatorUnavailablePage() {
  return page('Return to Hypervibe', '<p class="eyebrow">Setup paused</p><h1>Return to Hypervibe</h1><p class="intro">This private setup link is unavailable. It may have expired or already been used.</p><section class="panel"><h2>Your next step</h2><p>Ask your agent to check the saved GitHub setup and resume it. If you already approved creation on GitHub, mention that so it can check for the existing app first.</p><p class="note">Do not create another app or share this private link. Never paste credentials into chat.</p></section>');
}
