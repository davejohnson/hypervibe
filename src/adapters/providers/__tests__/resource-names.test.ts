import { describe, expect, it } from 'vitest';
import { resourceName, resourceScopeSuffix } from '../../../domain/services/resource-names.js';

describe('provider resource names', () => {
  it('preserves valid names inside a provider-native namespace', () => {
    for (const name of ['web', 'worker', 'stay-reminders', 'documents']) {
      expect(resourceName(name, { maxLength: 32 })).toBe(name);
    }
  });

  it('adds only a stable scope suffix in shared namespaces', () => {
    const scope = ['account-a', 'project-a', 'staging'];
    const name = resourceName('web', { scope });
    expect(name).toMatch(/^web-[a-f0-9]{10}$/);
    expect(name).toBe(`web-${resourceScopeSuffix(scope)}`);
    expect(resourceName('web', { scope: [...scope] })).toBe(name);
    for (const other of [['account-b', 'project-a', 'staging'], ['account-a', 'project-b', 'staging'], ['account-a', 'project-a', 'production']]) {
      expect(resourceName('web', { scope: other })).not.toBe(name);
    }
    expect(resourceScopeSuffix(['a:b', 'c'])).not.toBe(resourceScopeSuffix(['a', 'b:c']));
  });

  it.each([24, 32, 49, 63])('does not collapse sanitized or truncated names at length %s', (maxLength) => {
    const names = ['web', 'Web', 'web!', 'web_', 'web-', '1web', '---', 'w'.repeat(100), `${'w'.repeat(99)}x`];
    for (const compact of [false, true]) {
      const results = names.map((name) => resourceName(name, { maxLength, scope: ['project', 'staging'], compact }));
      expect(new Set(results).size).toBe(names.length);
      for (const result of results) {
        expect(result.length).toBeLessThanOrEqual(maxLength);
        expect(result).toMatch(compact ? /^[a-z][a-z0-9]+$/ : /^[a-z][a-z0-9-]*[a-z0-9]$/);
        expect(result.endsWith(resourceScopeSuffix(['project', 'staging']))).toBe(true);
      }
    }
  });

  it('satisfies minimum lengths without colliding with an already-valid name', () => {
    expect(resourceName('a', { minLength: 3 })).not.toBe(resourceName('aaa', { minLength: 3 }));
    expect(resourceName('a', { minLength: 3 }).length).toBeGreaterThanOrEqual(3);
  });

  it('escapes provider-reserved prefixes without merging logical names', () => {
    const options = { reservedPrefixes: ['goog', 'amzn-s3-demo-'] };
    for (const name of ['goog-events', 'amzn-s3-demo-photos']) {
      const escaped = resourceName(name, options);
      expect(options.reservedPrefixes.some((prefix) => escaped.startsWith(prefix))).toBe(false);
      expect(escaped).not.toBe(resourceName(`r-${name}`, options));
    }
  });
});
