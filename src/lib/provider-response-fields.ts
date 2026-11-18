// Only fixed field names and rules belong in these errors. Provider values may
// identify private accounts or contain one-time credentials.
export function responseFields(operation: string) {
  function reject(field: string, reason: string): never {
    throw new Error(`${operation}: ${field} ${reason}.`);
  }

  function text(field: string, value: unknown): string {
    if (value === undefined) return reject(field, 'is missing');
    if (typeof value !== 'string') return reject(field, 'must be text');
    return value;
  }

  return {
    reject,
    text,
    matches(field: string, value: unknown, pattern: RegExp, rule: string): string {
      const parsed = text(field, value);
      if (!pattern.test(parsed)) return reject(field, rule);
      return parsed;
    },
    exact(field: string, value: unknown, expected: string, ignoreCase = false): void {
      const observed = text(field, value);
      if (ignoreCase ? observed.toLowerCase() !== expected.toLowerCase() : observed !== expected) reject(field, 'does not match the requested resource');
    },
    oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
      const parsed = text(field, value);
      const matched = allowed.find(item => item === parsed);
      return matched ?? reject(field, `must be one of ${allowed.join(', ')}`);
    },
    boolean(field: string, value: unknown): boolean {
      if (typeof value !== 'boolean') return reject(field, 'must be true or false');
      return value;
    },
  };
}
