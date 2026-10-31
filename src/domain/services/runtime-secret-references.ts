import { runtimeSecretReferenceSchema, secretDestinationIdentity, type RuntimeSecretReference, type SecretDestination } from '../ports/secret-destination.port.js';

/** Validate before provider access. Never serialize rejected input in errors. */
export function validateRuntimeSecretReferences(
  input: Record<string, RuntimeSecretReference> | undefined,
  literalVars: Record<string, string>,
  accepts: (destination: SecretDestination) => boolean,
): Record<string, RuntimeSecretReference> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 256) {
    throw new Error('Invalid runtime secret reference map.');
  }
  const result: Record<string, RuntimeSecretReference> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    const parsed = runtimeSecretReferenceSchema.safeParse(raw);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith('HYPERVIBE_') || Object.hasOwn(literalVars, key)
      || !parsed.success || !accepts(parsed.data.destination)) {
      throw new Error('Runtime secret reference has an invalid destination, version, key, or conflicting literal value.');
    }
    result[key] = parsed.data;
  }
  return result;
}

/** Provider-native reference identity is metadata, never a SecretResolver input. */
export function runtimeSecretReferenceIdentity(reference: RuntimeSecretReference): {
  provider: SecretDestination['provider']; resource: string; version: string;
} {
  return { ...secretDestinationIdentity(reference.destination), version: reference.version };
}
