import { describe, expect, it } from 'vitest';
import { railwayExportPrefix } from '../railway-export-prefix.js';

describe('the Railway export location', () => {
  it.each(['', '..', '../shared', 'another/path', 'prod%2Fshared', 'app${var.name}', 'app%{name}', 'prod\n', 'app\\prod'])('rejects an ambiguous export destination %j', name => {
    expect(() => railwayExportPrefix(name)).toThrow('single safe path segment');
  });

  it('preserves the exact spelling of a destination with spaces or accented letters', () => {
    expect(railwayExportPrefix('Préproduction Québec')).toBe('migrations/Préproduction Québec/');
  });
});
