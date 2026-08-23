import type { z } from 'zod';

/**
 * Parse a JSON TEXT column through a zod schema.
 *
 * Empty legacy columns use the schema's declared empty value. Non-empty
 * corrupt JSON and schema mismatches throw: treating unreadable bindings,
 * plans, or receipts as empty state could authorize unsafe reconciliation.
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
    throw new Error(
      `Cannot read ${ctx}: persisted JSON is corrupt. Hypervibe refuses to treat unreadable state as empty.`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Cannot read ${ctx}: persisted JSON has an invalid shape (${result.error.issues[0]?.message ?? 'unknown'}). `
      + 'Hypervibe refuses to treat unreadable state as empty.'
    );
  }
  return result.data;
}
