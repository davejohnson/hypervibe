export type WakerReadFailure = 'access denied' | 'query rejected' | 'database unreachable' | 'query failed';

/**
 * A fixed local category for why a waker could not read pending work. The provider's
 * own message can carry SQL text, hostnames or account names, so it is only matched
 * here and never shown.
 */
export function classifyWakerReadError(providerMessage: unknown): WakerReadFailure {
  const text = typeof providerMessage === 'string' ? providerMessage : '';
  if (/permission|denied|forbidden|not authori[sz]ed|unauthenticated|\b40[13]\b/i.test(text)) return 'access denied';
  if (/does not exist|syntax error|undefined (table|column)|relation|invalid (query|statement)|\b400\b/i.test(text)) return 'query rejected';
  if (/timed? ?out|deadline|unavailable|connection|not running|\b50[0-9]\b/i.test(text)) return 'database unreachable';
  return 'query failed';
}
