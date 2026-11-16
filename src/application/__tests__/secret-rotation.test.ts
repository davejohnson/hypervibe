import { describe, expect, it } from 'vitest';
import { serveMultiPastePage, unfinishedPage } from '../local-paste-page.js';
import { looksSecret } from '../secret-rotation.js';

describe('secret rotation', () => {
  it('rotates credentials, not configuration copied alongside them', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'JWT_SECRET', 'SESSION_SECRET', 'RECAPTCHA_SECRET_KEY', 'GITHUB_TOKEN', 'SMTP_PASSWORD', 'SENTRY_DSN']) expect(looksSecret(key)).toBe(true);
    for (const key of ['SENDGRID_FROM_EMAIL', 'SENDGRID_FROM_NAME', 'SENDGRID_INBOUND_HOSTNAME', 'RECAPTCHA_SITE_KEY', 'STRIPE_PUBLISHABLE_KEY', 'APP_URL']) expect(looksSecret(key)).toBe(false);
  });

  it('saves each key on one page independently and finishes when all are saved', async () => {
    let url = '';
    const saved: Array<[string, string]> = [];
    const pending = serveMultiPastePage({
      key: 'test-rotate', provider: 'secret', scope: 'staging', waitMs: 10_000, openBrowser: (opened) => { url = opened; },
      accept: async (field, value) => {
        if (value === 'bad') return { ok: false, error: 'rejected' };
        saved.push([field, typeof value === 'string' ? value : 'generated']);
        return { ok: true, message: 'saved' };
      },
      spec: { tabTitle: 'Rotate', eyebrow: 'Rotate keys', titleHtml: 'Replace keys', leadHtml: 'Lead', rows: [], agent: 'Claude Code', storedWhere: 'Saved', doneTitle: 'Done',
        fields: [{ id: 'API_KEY' }, { id: 'OTHER_KEY' }, { id: 'JWT_SECRET', allowGenerate: true }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const target = new URL(url);
    const nonce = target.pathname.split('/').pop()!;
    const post = (body: Record<string, string>, background = false) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: target.origin, ...(background ? { 'x-hv-fetch': '1' } : {}) },
      body: new URLSearchParams({ nonce, ...body }).toString() });
    expect((await post({ save: 'API_KEY', 'value:API_KEY': 'bad' })).status).toBe(400);
    // A background save reports per-field results without re-rendering the page.
    const partial = await post({ save: 'OTHER_KEY', 'value:OTHER_KEY': 'other', 'value:API_KEY': 'typed' }, true);
    expect(await partial.json()).toEqual({ saved: { OTHER_KEY: 'saved' }, errors: { API_KEY: 'rejected' } });
    // Save all saves every filled field at once.
    const all = await post({ save: '*', 'value:API_KEY': 'good', 'value:JWT_SECRET': '' }, true);
    expect(await all.json()).toMatchObject({ saved: { API_KEY: 'saved', OTHER_KEY: 'saved' } });
    expect((await post({ generate: 'JWT_SECRET' })).status).toBe(200);
    await expect(pending).resolves.toMatchObject({ status: 'connected', saved: ['OTHER_KEY', 'API_KEY', 'JWT_SECRET'] });
    expect(saved).toEqual([['OTHER_KEY', 'other'], ['API_KEY', 'good'], ['JWT_SECRET', 'generated']]);
  });
});

describe('keys page with values found locally and optional keys', () => {
  it('offers every local value from the top, tucks saved keys away, and lets an optional key be skipped', async () => {
    let url = '';
    const accepted: string[] = [];
    const pending = serveMultiPastePage({
      key: 'test-bulk-skip', provider: 'secret', scope: 'staging', waitMs: 10_000, openBrowser: (opened) => { url = opened; },
      accept: async (field) => { accepted.push(field); return { ok: true, message: 'saved from .env' }; },
      spec: { tabTitle: 'Keys', eyebrow: 'Add keys', titleHtml: 'Add keys', leadHtml: 'Lead', rows: [], agent: 'Claude Code', storedWhere: 'Saved', doneTitle: 'Done',
        fields: [{ id: 'A_KEY', fromFile: '.env' }, { id: 'B_KEY', fromFile: '.env' }, { id: 'STRIPE_KEY', optional: true }] },
    });
    while (!url) await new Promise((resolve) => setTimeout(resolve, 5));
    const nonce = url.split('/').pop()!;
    const post = (fields: Record<string, string>) => fetch(url, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded', 'x-hv-fetch': '1' },
      body: new URLSearchParams({ nonce, ...fields }).toString() });
    const page = await (await fetch(url)).text();
    // The one-click button comes before the list of keys, not after it.
    expect(page.indexOf('name="fromfile" value="*"')).toBeGreaterThan(0);
    expect(page.indexOf('name="fromfile" value="*"')).toBeLessThan(page.indexOf('<ol class="fields">'));
    expect(page).toContain('name="skip" value="STRIPE_KEY"');
    expect(page).not.toContain('name="skip" value="A_KEY"');
    expect((await post({ skip: 'A_KEY' })).status).toBe(400);
    expect(await (await post({ fromfile: '*' })).json()).toMatchObject({ saved: { A_KEY: 'saved from .env', B_KEY: 'saved from .env' } });
    const after = await (await fetch(url)).text();
    expect(after).toContain('>2</span> of 3 done');
    expect(after).toMatch(/<details class="donelist">[\s\S]*A_KEY[\s\S]*B_KEY[\s\S]*<\/details>/);
    expect((await post({ skip: 'STRIPE_KEY' })).status).toBe(200);
    // A skipped key is never sent to the store and is not reported as saved.
    await expect(pending).resolves.toMatchObject({ status: 'connected', saved: ['A_KEY', 'B_KEY'], skipped: ['STRIPE_KEY'] });
    expect(accepted).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('a page the person did not finish in time', () => {
  it('keeps its address while the server goes on serving it', () => {
    expect(unfinishedPage({ url: 'http://127.0.0.1:1/connect/x', staysOpen: true, open: 'A page is open.' }))
      .toEqual({ url: 'http://127.0.0.1:1/connect/x', message: 'A page is open.' });
  });

  it('gives no address once a CLI command returns, because its page ends with it', () => {
    const result = unfinishedPage({ url: 'http://127.0.0.1:1/connect/x', staysOpen: false, open: 'A page is open.' });
    expect(result).not.toHaveProperty('url');
    expect(result.message).toMatch(/has now closed.*Run the same command again/);
  });
});
