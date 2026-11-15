import { describe, expect, it } from 'vitest';
import { serveMultiPastePage } from '../local-paste-page.js';
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
