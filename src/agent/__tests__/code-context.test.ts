import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractCodeContext, findRelatedFiles } from '../analyzer/code-context.js';

describe('code-context', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-context-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('extractCodeContext', () => {
    it('extracts code from stack trace paths', async () => {
      // Create a source file
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() { return 42; }');

      const files = await extractCodeContext(
        tempDir,
        'TypeError: x is undefined',
        'at foo (src/service.ts:1:5)'
      );

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('src/service.ts');
      expect(files[0].content).toContain('foo');
    });

    it('handles multiple files in stack trace', async () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/a.ts'), 'export const a = 1;');
      writeFileSync(join(tempDir, 'src/b.ts'), 'export const b = 2;');

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (src/a.ts:1:1)\n    at bar (src/b.ts:1:1)'
      );

      expect(files).toHaveLength(2);
    });

    it('limits to 5 files', async () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(tempDir, `src/file${i}.ts`), `export const x${i} = ${i};`);
      }

      const stackTrace = Array.from({ length: 10 }, (_, i) =>
        `at fn (src/file${i}.ts:1:1)`
      ).join('\n');

      const files = await extractCodeContext(tempDir, 'Error', stackTrace);

      expect(files.length).toBeLessThanOrEqual(5);
    });

    it('truncates large files', async () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      const largeContent = 'x'.repeat(20000);
      writeFileSync(join(tempDir, 'src/large.ts'), largeContent);

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (src/large.ts:1:1)'
      );

      expect(files).toHaveLength(1);
      expect(files[0].content.length).toBeLessThan(largeContent.length);
      expect(files[0].content).toContain('truncated');
    });

    it('skips node_modules paths', async () => {
      mkdirSync(join(tempDir, 'node_modules/pkg'), { recursive: true });
      writeFileSync(join(tempDir, 'node_modules/pkg/index.js'), 'module.exports = {}');

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (node_modules/pkg/index.js:1:1)'
      );

      expect(files).toHaveLength(0);
    });

    it('handles non-existent files gracefully', async () => {
      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (src/nonexistent.ts:1:1)'
      );

      expect(files).toHaveLength(0);
    });

    it('maps dist paths to src', async () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (dist/service.js:1:1)'
      );

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('src/service.ts');
    });

    it('deduplicates files', async () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'at foo (src/service.ts:1:1)\n    at bar (src/service.ts:5:1)'
      );

      expect(files).toHaveLength(1);
    });

    it('extracts paths from Python stack traces', async () => {
      mkdirSync(join(tempDir, 'app'), { recursive: true });
      writeFileSync(join(tempDir, 'app/main.py'), 'def main(): pass');

      const files = await extractCodeContext(
        tempDir,
        'Error',
        'File "app/main.py", line 10, in main'
      );

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('app/main.py');
    });
  });

  describe('findRelatedFiles', () => {
    it('finds test files', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');
      writeFileSync(join(tempDir, 'src/service.test.ts'), 'test("foo", () => {})');

      const related = findRelatedFiles(tempDir, 'src/service.ts');

      expect(related).toContain('src/service.test.ts');
    });

    it('finds spec files', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');
      writeFileSync(join(tempDir, 'src/service.spec.ts'), 'describe("foo", () => {})');

      const related = findRelatedFiles(tempDir, 'src/service.ts');

      expect(related).toContain('src/service.spec.ts');
    });

    it('finds type definition files', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');
      writeFileSync(join(tempDir, 'src/service.types.ts'), 'export interface Foo {}');

      const related = findRelatedFiles(tempDir, 'src/service.ts');

      expect(related).toContain('src/service.types.ts');
    });

    it('returns empty array when no related files exist', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {}');

      const related = findRelatedFiles(tempDir, 'src/service.ts');

      expect(related).toEqual([]);
    });
  });
});
