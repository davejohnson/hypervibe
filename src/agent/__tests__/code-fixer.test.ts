import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeFixer } from '../fixer/code-fixer.js';
import type { SuggestedFix } from '../analyzer/prompts.js';
import type { AutoFixConfig } from '../config.js';

describe('CodeFixer', () => {
  let tempDir: string;
  let bareDir: string;
  let fixer: CodeFixer;
  let config: AutoFixConfig;

  beforeEach(() => {
    // Create temp directory with a git repo
    tempDir = mkdtempSync(join(tmpdir(), 'code-fixer-test-'));

    // Create bare repo for remote
    bareDir = mkdtempSync(join(tmpdir(), 'code-fixer-bare-'));
    execSync('git init --bare', { cwd: bareDir });

    // Initialize git repo with explicit branch name for consistency
    execSync('git init -b master', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test"', { cwd: tempDir });

    // Create initial structure
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/service.ts'), 'export function foo() {\n  return obj.x;\n}');
    writeFileSync(join(tempDir, 'README.md'), '# Test');

    // Initial commit
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "Initial commit"', { cwd: tempDir });

    // Add remote
    execSync(`git remote add origin ${bareDir}`, { cwd: tempDir });
    execSync('git push -u origin master', { cwd: tempDir });

    config = {
      workingDirectory: tempDir,
      gitUserName: 'Test Bot',
      gitUserEmail: 'bot@example.com',
      anthropicApiKey: 'test',
      claudeModel: 'test',
      pollIntervalSeconds: 300,
      maxErrorsPerPoll: 10,
      maxPRsPerHour: 5,
      cooldownSeconds: 3600,
      dryRun: false,
    };

    fixer = new CodeFixer(config);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  describe('applyFix', () => {
    it('applies simple replace fix', async () => {
      const fix: SuggestedFix = {
        description: 'Add optional chaining',
        files: [
          {
            path: 'src/service.ts',
            changes: [
              {
                type: 'replace',
                search: 'obj.x',
                replace: 'obj?.x',
              },
            ],
          },
        ],
      };

      const result = await fixer.applyFix(fix, 'fingerprint123');

      expect(result.success).toBe(true);
      expect(result.branchName).toBe('autofix/err-fingerprint123');
      expect(result.filesChanged).toContain('src/service.ts');

      // Verify file was changed
      execSync(`git checkout ${result.branchName}`, { cwd: tempDir });
      const content = readFileSync(join(tempDir, 'src/service.ts'), 'utf-8');
      expect(content).toContain('obj?.x');
    });

    it('fails when branch already exists', async () => {
      // Create the branch first
      execSync('git branch autofix/err-existing', { cwd: tempDir });

      const fix: SuggestedFix = {
        description: 'Test',
        files: [],
      };

      const result = await fixer.applyFix(fix, 'existing');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('fails when file not found', async () => {
      const fix: SuggestedFix = {
        description: 'Test',
        files: [
          {
            path: 'src/nonexistent.ts',
            changes: [{ type: 'replace', search: 'x', replace: 'y' }],
          },
        ],
      };

      const result = await fixer.applyFix(fix, 'fp1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('fails when search string not found', async () => {
      const fix: SuggestedFix = {
        description: 'Test',
        files: [
          {
            path: 'src/service.ts',
            changes: [{ type: 'replace', search: 'nonexistent string', replace: 'y' }],
          },
        ],
      };

      const result = await fixer.applyFix(fix, 'fp2');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('applies multiple changes to same file', async () => {
      writeFileSync(join(tempDir, 'src/service.ts'), 'const a = 1;\nconst b = 2;');
      execSync('git add .', { cwd: tempDir });
      execSync('git commit -m "Update"', { cwd: tempDir });
      execSync('git push origin master', { cwd: tempDir });

      const fix: SuggestedFix = {
        description: 'Update constants',
        files: [
          {
            path: 'src/service.ts',
            changes: [
              { type: 'replace', search: 'const a = 1', replace: 'const a = 10' },
              { type: 'replace', search: 'const b = 2', replace: 'const b = 20' },
            ],
          },
        ],
      };

      const result = await fixer.applyFix(fix, 'fp3');

      expect(result.success).toBe(true);

      execSync(`git checkout ${result.branchName}`, { cwd: tempDir });
      const content = readFileSync(join(tempDir, 'src/service.ts'), 'utf-8');
      expect(content).toContain('const a = 10');
      expect(content).toContain('const b = 20');
    });

    it('applies changes to multiple files', async () => {
      writeFileSync(join(tempDir, 'src/a.ts'), 'export const a = 1;');
      writeFileSync(join(tempDir, 'src/b.ts'), 'export const b = 2;');
      execSync('git add .', { cwd: tempDir });
      execSync('git commit -m "Add files"', { cwd: tempDir });
      execSync('git push origin master', { cwd: tempDir });

      const fix: SuggestedFix = {
        description: 'Update both files',
        files: [
          { path: 'src/a.ts', changes: [{ type: 'replace', search: 'a = 1', replace: 'a = 10' }] },
          { path: 'src/b.ts', changes: [{ type: 'replace', search: 'b = 2', replace: 'b = 20' }] },
        ],
      };

      const result = await fixer.applyFix(fix, 'fp4');

      expect(result.success).toBe(true);
      expect(result.filesChanged).toHaveLength(2);
    });

    it('handles delete change type', async () => {
      writeFileSync(join(tempDir, 'src/service.ts'), '// TODO: remove this\nexport const x = 1;');
      execSync('git add .', { cwd: tempDir });
      execSync('git commit -m "Update"', { cwd: tempDir });
      execSync('git push origin master', { cwd: tempDir });

      const fix: SuggestedFix = {
        description: 'Remove TODO comment',
        files: [
          {
            path: 'src/service.ts',
            changes: [{ type: 'delete', search: '// TODO: remove this\n' }],
          },
        ],
      };

      const result = await fixer.applyFix(fix, 'fp5');

      expect(result.success).toBe(true);

      execSync(`git checkout ${result.branchName}`, { cwd: tempDir });
      const content = readFileSync(join(tempDir, 'src/service.ts'), 'utf-8');
      expect(content).not.toContain('TODO');
    });

    it('returns to original branch after success', async () => {
      const originalBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: tempDir,
        encoding: 'utf-8',
      }).trim();

      const fix: SuggestedFix = {
        description: 'Test',
        files: [
          {
            path: 'src/service.ts',
            changes: [{ type: 'replace', search: 'obj.x', replace: 'obj?.x' }],
          },
        ],
      };

      await fixer.applyFix(fix, 'fp6');

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: tempDir,
        encoding: 'utf-8',
      }).trim();

      expect(currentBranch).toBe(originalBranch);
    });

    it('cleans up on failure', async () => {
      const fix: SuggestedFix = {
        description: 'Test',
        files: [
          { path: 'src/nonexistent.ts', changes: [{ type: 'replace', search: 'x', replace: 'y' }] },
        ],
      };

      await fixer.applyFix(fix, 'fp7');

      // Branch should not exist after failure cleanup
      const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
      expect(branches).not.toContain('autofix/err-fp7');
    });
  });
});
