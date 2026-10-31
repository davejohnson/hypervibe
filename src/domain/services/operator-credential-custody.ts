import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { runtimeSecretReferenceSchema } from '../ports/secret-destination.port.js';
const contextSchema = z.object({ projectId: z.string().guid(), environmentId: z.string().guid(), installationId: z.string().guid(),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(['github-app', 'google-oauth', 'google-recaptcha', 'sendgrid']) }).strict();
export type OperatorCustodyContext = z.infer<typeof contextSchema>;
const privateText = z.string().min(1).max(65_536), nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const browserSchema = z.object({ attemptId: z.string().guid(), expiresAt: z.string().datetime(), state: nonce, launch: nonce,
  port: z.number().int().min(1024).max(65535).optional(), formDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  callbackDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), issued: z.boolean().default(false) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), context: contextSchema,
  phase: z.enum(['awaiting-browser', 'code-staged', 'conversion-started', 'credentials-stored', 'delivered']),
  browser: browserSchema.optional(), code: privateText.optional(),
  credentials: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), privateText).optional(),
  identity: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.string().max(2048)).optional(),
  deliveries: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), z.object({ attemptId: z.string().guid(), status: z.enum(['attempted', 'delivered', 'uncertain', 'rejected']),
    // Omission is historical uncertainty, never evidence that dispatch is pending.
    dispatchState: z.enum(['pending', 'started']).optional(), reference: runtimeSecretReferenceSchema.optional() }).strict()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.phase === 'awaiting-browser' && (!value.browser || value.code || value.credentials)
    || value.phase === 'code-staged' && (!value.browser || !value.code || value.credentials)
    || value.phase === 'conversion-started' && (!value.browser || value.code || value.credentials)
    || value.phase === 'credentials-stored' && (!value.credentials || !Object.keys(value.credentials).length || !value.identity || value.code)
    || value.phase === 'delivered' && (value.browser || value.code || value.credentials || !value.identity || !value.deliveries || Object.values(value.deliveries).some(item => item.status !== 'delivered' || !item.reference)))
    ctx.addIssue({ code: 'custom', message: 'Invalid operator custody phase.' });
});
export type OperatorCustodyState = z.infer<typeof stateSchema>;
export interface PrivateOperatorSnapshot { cipher: string; state: OperatorCustodyState }
const PROVIDER = 'hypervibe-operator-credential-custody';
const unavailable = () => new Error('Private operator credential custody changed or is unavailable. Preserve the retained operation; never repeat an uncertain credential exchange.');
/** Private transport/recovery only. Never return a snapshot through a command. */
export class OperatorCredentialCustody {
  private readonly context: OperatorCustodyContext;
  private readonly scope: string;
  constructor(context: OperatorCustodyContext) {
    // Provider-local contexts may also carry transient authorization callbacks.
    // Persist only this closed nonsecret identity tuple.
    this.context = contextSchema.parse({ projectId: context.projectId, environmentId: context.environmentId,
      installationId: context.installationId, intentDigest: context.intentDigest, provider: context.provider });
    this.scope = `${context.projectId}/${context.environmentId}/${context.installationId}`;
  }
  private assertScope() {
    const environment = new EnvironmentRepository().findById(this.context.environmentId);
    if (!environment || environment.projectId !== this.context.projectId) throw unavailable();
  }
  read(): PrivateOperatorSnapshot | null {
    this.assertScope();
    const row = new ConnectionRepository().findByProviderAndScope(PROVIDER, this.scope); if (!row) return null;
    try {
      const state = stateSchema.parse(getSecretStore().decryptObject(row.credentialsEncrypted));
      if (!isDeepStrictEqual(state.context, this.context)) throw unavailable();
      return { cipher: row.credentialsEncrypted, state };
    } catch { throw unavailable(); }
  }
  private save(previous: PrivateOperatorSnapshot | null, next: OperatorCustodyState): PrivateOperatorSnapshot | null {
    this.assertScope(); const state = stateSchema.parse(next);
    if (!isDeepStrictEqual(state.context, this.context) || JSON.stringify(state).length > 300_000) throw unavailable();
    const credentialsEncrypted = getSecretStore().encryptObject(state);
    const saved = new ConnectionRepository().compareAndSwap({ provider: PROVIDER, scope: this.scope, credentialsEncrypted }, previous?.cipher ?? null, 'pending');
    return saved ? { cipher: saved.credentialsEncrypted, state } : null;
  }
  createBrowser(browser: Omit<z.infer<typeof browserSchema>, 'issued'>): PrivateOperatorSnapshot {
    if (Date.parse(browser.expiresAt) <= Date.now() || Date.parse(browser.expiresAt) > Date.now() + 3_600_000) throw unavailable();
    const result = this.save(null, { schemaVersion: 1, context: this.context, phase: 'awaiting-browser', browser: { ...browser, issued: false } });
    if (!result) throw unavailable(); return result;
  }
  configurePort(previous: PrivateOperatorSnapshot, port: number): PrivateOperatorSnapshot | null {
    if (previous.state.phase !== 'awaiting-browser' || !previous.state.browser || previous.state.browser.port && previous.state.browser.port !== port) return null;
    return this.save(previous, { ...previous.state, browser: { ...previous.state.browser, port } });
  }
  issueForm(previous: PrivateOperatorSnapshot): PrivateOperatorSnapshot | null {
    const browser = previous.state.browser;
    if (previous.state.phase !== 'awaiting-browser' || !browser || Date.parse(browser.expiresAt) <= Date.now()) return null;
    return this.save(previous, { ...previous.state, browser: { ...browser, issued: true } });
  }
  configureForm(previous: PrivateOperatorSnapshot, formDigest: string): PrivateOperatorSnapshot | null {
    const browser = previous.state.browser;
    if (previous.state.phase !== 'awaiting-browser' || !browser || browser.formDigest && browser.formDigest !== formDigest) return null;
    return this.save(previous, { ...previous.state, browser: { ...browser, formDigest } });
  }
  stageCode(previous: PrivateOperatorSnapshot, state: string, code: string, now = Date.now()): boolean {
    const browser = previous.state.browser;
    if (!browser || !browser.issued || !nonce.safeParse(state).success || Date.parse(browser.expiresAt) <= now
      || !privateText.safeParse(code).success || /[\u0000-\u0020\u007f]/.test(code) || !timingSafeEqual(Buffer.from(state), Buffer.from(browser.state))) return false;
    const digest = createHash('sha256').update(code).digest('hex');
    if (['code-staged', 'conversion-started', 'credentials-stored'].includes(previous.state.phase)) {
      const retained = browser.callbackDigest ?? (previous.state.code ? createHash('sha256').update(previous.state.code).digest('hex') : undefined);
      return !!retained && timingSafeEqual(Buffer.from(retained), Buffer.from(digest));
    }
    if (previous.state.phase !== 'awaiting-browser') return false;
    return !!this.save(previous, { ...previous.state, phase: 'code-staged', code, browser: { ...browser, callbackDigest: digest } });
  }
  consumeCode(previous: PrivateOperatorSnapshot): { code: string } | null {
    if (previous.state.phase !== 'code-staged' || !previous.state.code || !previous.state.browser || Date.parse(previous.state.browser.expiresAt) <= Date.now()) return null;
    const { code, ...retained } = previous.state;
    return this.save(previous, { ...retained, phase: 'conversion-started', browser: { ...previous.state.browser,
      callbackDigest: previous.state.browser.callbackDigest ?? createHash('sha256').update(code).digest('hex') } }) ? { code } : null;
  }
  storeCredentials(previous: PrivateOperatorSnapshot | null, credentials: NonNullable<OperatorCustodyState['credentials']>, identity: NonNullable<OperatorCustodyState['identity']>): PrivateOperatorSnapshot | null {
    if (previous && previous.state.phase !== 'conversion-started') return null;
    return this.save(previous, { schemaVersion: 1, context: this.context, phase: 'credentials-stored', credentials, identity,
      ...(previous?.state.browser ? { browser: previous.state.browser } : {}) });
  }
  updateDelivery(previous: PrivateOperatorSnapshot, key: string, value: NonNullable<OperatorCustodyState['deliveries']>[string]): PrivateOperatorSnapshot | null {
    if (previous.state.phase !== 'credentials-stored') return null;
    const retained = previous.state.deliveries?.[key];
    if (retained && (retained.attemptId !== value.attemptId && !(retained.status === 'rejected' && value.status === 'attempted')
      || retained.status === 'delivered' && !isDeepStrictEqual(retained, value))) return null;
    if (value.dispatchState === 'pending' && value.status === 'delivered') return null;
    if (retained?.attemptId === value.attemptId && (
      retained.status === 'rejected' && !isDeepStrictEqual(retained, value)
      || retained.dispatchState !== value.dispatchState
        && !(retained.dispatchState === 'pending' && value.dispatchState === 'started'
          && retained.status === 'attempted' && value.status === 'attempted'))) return null;
    return this.save(previous, { ...previous.state, deliveries: { ...previous.state.deliveries, [key]: value } });
  }
  eraseDeliveredCredentials(previous: PrivateOperatorSnapshot, keys: string[]): PrivateOperatorSnapshot | null {
    const deliveries = previous.state.deliveries;
    if (previous.state.phase !== 'credentials-stored' || !deliveries || !keys.length || keys.length !== Object.keys(deliveries).length
      || new Set(keys).size !== keys.length || keys.some(key => deliveries[key]?.status !== 'delivered' || !deliveries[key]?.reference)) return null;
    return this.save(previous, { schemaVersion: 1, context: this.context, phase: 'delivered', identity: previous.state.identity, deliveries });
  }
}
