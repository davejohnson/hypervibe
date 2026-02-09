import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkFileSyntax } from '../fixer/validators.js';

describe('validators', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'validators-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('checkFileSyntax', () => {
    it('returns valid for correct JavaScript', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/valid.js'), 'const x = 1; console.log(x);');

      const result = checkFileSyntax(tempDir, ['src/valid.js']);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns invalid for syntax error', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/invalid.js'), 'const x = {');

      const result = checkFileSyntax(tempDir, ['src/invalid.js']);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns error for non-existent file', () => {
      const result = checkFileSyntax(tempDir, ['nonexistent.js']);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('File not found');
    });

    it('checks multiple files', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/a.js'), 'const a = 1;');
      writeFileSync(join(tempDir, 'src/b.js'), 'const b = {'); // Invalid

      const result = checkFileSyntax(tempDir, ['src/a.js', 'src/b.js']);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
    });

    it('handles non-JS files gracefully', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/data.json'), '{"key": "value"}');

      const result = checkFileSyntax(tempDir, ['src/data.json']);

      // JSON files should be skipped (no JS check)
      expect(result.valid).toBe(true);
    });
  });
});
