import { DestinationBudget } from '../secret-destination-http.js';
import { runtimeMailProbeSchema, type RuntimeMailProbe, type RuntimeMailAuthenticationEvidence } from '../../../domain/ports/runtime-mail-authentication.port.js';

/** Fixed endpoint and payload: callers cannot disable sandbox mode or add mail options. */
export async function verifySendGridRuntimeMail(apiKey: unknown, input: RuntimeMailProbe, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<RuntimeMailAuthenticationEvidence> {
  const base = { sandbox: true, delivery: 'unchecked', leastPrivilege: 'unchecked', senderAuthorization: 'unchecked', deployedConfiguration: 'unchecked' } as const;
  const parsed = runtimeMailProbeSchema.safeParse(input);
  if (!parsed.success || typeof apiKey !== 'string' || !apiKey || apiKey.length > 65_536 || /[\r\n\0]/.test(apiKey))
    return { ...base, authentication: 'unknown', reason: 'configuration_invalid' };
  const budget = new DestinationBudget({ deadlineMs: 15_000, signal: options.signal });
  try {
    const response = await budget.wait((options.fetch ?? fetch)('https://api.sendgrid.com/v3/mail/send', { method: 'POST', redirect: 'error', signal: budget.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: parsed.data.recipient }] }], from: { email: parsed.data.sender },
        subject: 'Hypervibe sandbox validation', content: [{ type: 'text/plain', value: 'Hypervibe sandbox validation; no email is sent.' }],
        mail_settings: { sandbox_mode: { enable: true } } }),
    }));
    // The response may echo private inputs. Status is sufficient; never parse its body.
    void response.body?.cancel().catch(() => {});
    if (response.redirected) return { ...base, authentication: 'unknown', reason: 'unexpected_response' };
    if (response.status === 200) return { ...base, authentication: 'authenticated' };
    if (response.status === 401) return { ...base, authentication: 'rejected', reason: 'authentication_rejected' };
    if (response.status === 403) return { ...base, authentication: 'rejected', reason: 'access_denied' };
    return { ...base, authentication: 'unknown', reason: response.status === 429 || response.status >= 500 ? 'provider_unavailable' : 'unexpected_response' };
  } catch { return { ...base, authentication: 'unknown', reason: 'provider_unavailable' }; }
  finally { budget.close(); }
}
