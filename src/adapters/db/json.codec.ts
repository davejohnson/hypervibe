import type { z } from 'zod';

/**
 * Parse a JSON TEXT column through a zod schema.
 *
 * Reads never throw: corrupt JSON or schema mismatches log a warning (stderr)
 * and fall back to the schema's default. Schemas passed here must carry a
 * `.default(...)` so a fallback value always exists.
 */
export function parseJsonColumn<Schema extends z.ZodDefault<z.ZodTypeAny>>(
  schema: Schema,
  raw: unknown,
  ctx: string
): z.infer<Schema> {
  if (raw === null || raw === undefined || raw === '') {
    return schema.parse(undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    console.warn(`[hypervibe] Corrupt JSON in ${ctx}; falling back to default`);
    return schema.parse(undefined);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[hypervibe] Invalid shape in ${ctx}: ${result.error.issues[0]?.message ?? 'unknown'}; falling back to default`);
    return schema.parse(undefined);
  }
  return result.data;
}
