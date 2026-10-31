import { createHash } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { redactExactValues } from '../../../utils/redact-exact-values.js';

export const awsAuthenticationFields = {
  authMode: z.enum(['default', 'static']).optional().describe('Use the local AWS profile/SSO/login chain, or explicit automation credentials.'),
  accessKeyId: z.string().trim().min(16).optional(),
  secretAccessKey: z.string().min(32).optional(),
  sessionToken: z.string().min(1).optional(),
  profile: z.string().trim().min(1).optional().describe('Exact local AWS profile; omitted uses the SDK default chain.'),
  accountId: z.string().regex(/^\d{12}$/).optional().describe('Verified AWS account identity; local login must continue to match it.'),
};

export type AwsAuthentication = z.infer<z.ZodObject<typeof awsAuthenticationFields>>;

/** Local profiles and STS sessions are never durable deployment credentials. */
export function canUseAwsCredentialsForAutomation(credentials: Record<string, unknown>): boolean {
  return credentials.authMode !== 'default' && !credentials.sessionToken
    && typeof credentials.accessKeyId === 'string' && credentials.accessKeyId.startsWith('AKIA')
    && typeof credentials.secretAccessKey === 'string' && credentials.secretAccessKey.length > 0;
}

export function validateAwsAuthentication(value: AwsAuthentication, ctx: z.RefinementCtx): void {
  const explicit = value.authMode === 'static' || value.accessKeyId !== undefined || value.secretAccessKey !== undefined || value.sessionToken !== undefined;
  if (value.authMode === 'default' && explicit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Default AWS authentication cannot include explicit keys or session tokens.' });
  } else if (value.authMode !== 'default') {
    if (!value.accessKeyId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessKeyId'], message: 'AWS access key ID is required with explicit credentials.' });
    if (!value.secretAccessKey) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secretAccessKey'], message: 'AWS secret access key is required with explicit credentials.' });
    if (value.profile) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profile'], message: 'An AWS profile cannot be combined with explicit credentials.' });
  }
}

export function checkedAwsAccountId(accountId: unknown, expected?: string): string {
  if (typeof accountId !== 'string' || !/^\d{12}$/.test(accountId)) throw new Error('AWS did not return a valid account identity.');
  if (expected && accountId !== expected) throw new Error('The active AWS credentials belong to a different account than the verified connection. Reconnect the intended account before continuing.');
  return accountId;
}

/** Reuse native profile placement for connection checks; spec targets override it. */
export async function awsConnectionRegion(input: AwsAuthentication, fallback: string): Promise<string> {
  if (input.authMode !== 'default' && input.accessKeyId) return fallback;
  const client = new STSClient({ ...(input.profile ? { profile: input.profile } : {}) });
  try { return await client.config.region(); }
  catch (error) {
    // The SDK's documented missing-region state permits Hypervibe's ordinary
    // default. A malformed/unreadable configuration does not select a new scope.
    if (error instanceof Error && error.message === 'Region is missing') return fallback;
    throw new Error('AWS local region configuration could not be read. Check the selected profile before continuing.');
  } finally { client.destroy(); }
}

/** Refreshable local credentials stay in memory and must keep their pinned account. */
export class AwsConnectionAuthentication {
  private readonly source?: ReturnType<typeof defaultProvider>;
  private readonly profile?: string;
  private checked?: { fingerprint: string; accountId: string };
  private pending?: { fingerprint: string; promise: Promise<string> };
  private readonly privateValues = new Set<string>();
  readonly native: boolean;

  constructor(private readonly input: AwsAuthentication, private readonly region: string,
    private readonly identityClientOptions?: () => Pick<STSClientConfig, 'requestHandler' | 'maxAttempts'> & { abortSignal?: AbortSignal },
    source?: ReturnType<typeof defaultProvider>) {
    this.native = input.authMode === 'default';
    this.profile = this.native ? input.profile ?? (process.env.AWS_PROFILE?.trim() || undefined) : undefined;
    if (this.native) this.source = source ?? defaultProvider(this.profile ? { profile: this.profile } : {});
    for (const value of [input.accessKeyId, input.secretAccessKey, input.sessionToken]) if (value) this.privateValues.add(value);
  }

  readonly credentials = async (): ReturnType<ReturnType<typeof defaultProvider>> => {
    if (!this.native) return {
      accessKeyId: this.input.accessKeyId!, secretAccessKey: this.input.secretAccessKey!,
      ...(this.input.sessionToken ? { sessionToken: this.input.sessionToken } : {}),
    };
    let resolved: Awaited<ReturnType<ReturnType<typeof defaultProvider>>>;
    // Login refresh needs the caller's region when its selected profile omits it.
    // The SDK still gives an explicit login-profile region precedence.
    try { resolved = await this.source!({ callerClientConfig: { region: async () => this.region } }); }
    catch { throw new Error('AWS local credentials could not be resolved. Check the selected profile or sign-in; no cloud operation was authorized.'); }
    for (const value of [resolved.accessKeyId, resolved.secretAccessKey, resolved.sessionToken]) if (value) this.privateValues.add(value);
    if (resolved.expiration && resolved.expiration.getTime() <= Date.now()) throw new Error('The local AWS session has expired. Sign in to the selected profile before continuing.');
    const fingerprint = createHash('sha256').update(JSON.stringify([resolved.accessKeyId, resolved.secretAccessKey, resolved.sessionToken])).digest('hex');
    if (this.checked?.fingerprint !== fingerprint) {
      if (this.pending?.fingerprint !== fingerprint) {
        const { abortSignal, ...clientOptions } = this.identityClientOptions?.() ?? {};
        const client = new STSClient({ region: this.region, credentials: resolved, ...clientOptions });
        const promise = client.send(new GetCallerIdentityCommand({}), { abortSignal }).then(identity => {
          const accountId = checkedAwsAccountId(identity.Account, this.input.accountId ?? this.checked?.accountId);
          if (typeof identity.Arn !== 'string' || identity.Arn.split(':')[4] !== accountId) throw new Error('AWS returned inconsistent caller identity metadata.');
          this.checked = { fingerprint, accountId };
          return accountId;
        }).catch(error => { throw new Error(this.redact(error)); }).finally(() => {
          client.destroy();
          if (this.pending?.promise === promise) this.pending = undefined;
        });
        this.pending = { fingerprint, promise };
      }
      await this.pending.promise;
    }
    return resolved;
  };

  identity(): Record<string, string> {
    return this.native && this.checked
      ? { accountId: this.checked.accountId, ...(this.profile ? { profile: this.profile } : {}) }
      : {};
  }

  redact(error: unknown): string {
    return redactExactValues(error instanceof Error ? error.message : String(error), [...this.privateValues]);
  }
}
