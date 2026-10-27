import { parseCredentialRef } from './credential-reference.js';
import { commandError, commandSuccess } from './results.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { supportsRuntimeMailAuthentication, type RuntimeMailProbe } from '../domain/ports/runtime-mail-authentication.port.js';

/** Explicit private runtime probe; never reads or updates a saved management connection. */
export async function verifyRuntimeMailConnection(provider: string, credentialsRef: string, input: RuntimeMailProbe) {
  if (providerRegistry.getMetadata(provider)?.category !== 'email') return commandError('UNSUPPORTED', 'This provider does not support runtime email sandbox validation.');
  let credentials: Record<string, unknown>;
  try { credentials = await parseCredentialRef(provider, credentialsRef); }
  catch { return commandError('VALIDATION', 'The private runtime email credential could not be resolved.', { details: { reason: 'configuration_unavailable' } }); }
  try {
    const adapter = await providerRegistry.createAdapter(provider, credentials);
    if (!supportsRuntimeMailAuthentication(adapter)) return commandError('UNSUPPORTED', 'This provider does not support runtime email sandbox validation.');
    const evidence = await adapter.verifyRuntimeMail(input);
    if (evidence.authentication !== 'authenticated') return commandError('PROVIDER_ERROR', 'Runtime email sandbox validation was not accepted.', { details: evidence });
    return commandSuccess(evidence, { warnings: ['Only the fixed sandbox request was accepted. No email was delivered. Least privilege, sender authorization, deployed configuration and real delivery remain unchecked.'] });
  } catch { return commandError('PROVIDER_ERROR', 'Runtime email sandbox validation is unavailable.'); }
}
