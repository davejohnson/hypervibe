/** Decode one JSON object from a provider response before inspecting its fields. */
export function providerObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid provider object.');
  }
  return value as Record<string, unknown>;
}
