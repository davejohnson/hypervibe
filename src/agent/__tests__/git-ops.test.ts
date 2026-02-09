import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitOps } from '../fixer/git-ops.js';

describe('GitOps', () => {
  let tempDir: string;
  let git: GitOps;

  beforeEach(() => {
    // Create temp directory with a git repo
    tempDir = mkdtempSync(join(tmpdir(), 'git-ops-test-'));

    // Initialize git repo with explicit branch name for consistency
    execSync('git init -b master', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test"', { cwd: tempDir });

    // Create initial commit
    writeFileSync(join(tempDir, 'README.md'), '# Test');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "Initial commit"', { cwd: tempDir });

    git = new GitOps({
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
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getCurrentBranch', () => {
    it('returns current branch name', () => {
      expect(git.getCurrentBranch()).toBe('master');
    });

    it('returns new branch after checkout', () => {
      execSync('git checkout -b feature', { cwd: tempDir });
      expect(git.getCurrentBranch()).toBe('feature');
    });
  });

  describe('getDefaultBranch', () => {
    it('returns master when main does not exist', () => {
      expect(git.getDefaultBranch()).toBe('master');
    });

    it('returns main when main exists', () => {
      execSync('git branch -m master main', { cwd: tempDir });
      expect(git.getDefaultBranch()).toBe('main');
    });
  });

  describe('isClean', () => {
    it('returns true when working directory is clean', () => {
      expect(git.isClean()).toBe(true);
    });

    it('returns false when there are uncommitted changes', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      expect(git.isClean()).toBe(false);
    });

    it('returns false when there are staged changes', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      execSync('git add new-file.txt', { cwd: tempDir });
      expect(git.isClean()).toBe(false);
    });
  });

  describe('stash/unstash', () => {
    it('stash returns false when clean', () => {
      expect(git.stash()).toBe(false);
    });

    it('stash returns true and stashes changes', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      expect(git.stash()).toBe(true);
      expect(git.isClean()).toBe(true);
    });

    it('unstash restores stashed changes', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      git.stash();
      git.unstash();
      expect(git.isClean()).toBe(false);
    });
  });

  describe('createBranch', () => {
    it('creates and checks out a new branch', () => {
      // Need a "remote" for this test - create a bare repo
      const bareDir = mkdtempSync(join(tmpdir(), 'git-bare-'));
      execSync('git init --bare', { cwd: bareDir });
      execSync(`git remote add origin ${bareDir}`, { cwd: tempDir });
      execSync('git push -u origin master', { cwd: tempDir });

      git.createBranch('feature-branch', 'master');

      expect(git.getCurrentBranch()).toBe('feature-branch');

      rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('branchExists', () => {
    it('returns true for existing branch', () => {
      expect(git.branchExists('master')).toBe(true);
    });

    it('returns false for non-existent branch', () => {
      expect(git.branchExists('nonexistent')).toBe(false);
    });
  });

  describe('add and commit', () => {
    it('stages and commits files', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');

      git.add(['new-file.txt']);
      git.commit('Add new file');

      expect(git.isClean()).toBe(true);

      const log = execSync('git log --oneline -1', { cwd: tempDir, encoding: 'utf-8' });
      expect(log).toContain('Add new file');
    });

    it('uses configured user for commits', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      git.add(['new-file.txt']);
      git.commit('Test commit');

      const log = execSync('git log -1 --format="%an <%ae>"', { cwd: tempDir, encoding: 'utf-8' });
      expect(log.trim()).toBe('Test Bot <bot@example.com>');
    });
  });

  describe('checkout', () => {
    it('checks out existing branch', () => {
      execSync('git branch feature', { cwd: tempDir });
      git.checkout('feature');
      expect(git.getCurrentBranch()).toBe('feature');
    });
  });

  describe('deleteBranch', () => {
    it('deletes existing branch', () => {
      execSync('git branch feature', { cwd: tempDir });
      expect(git.branchExists('feature')).toBe(true);

      git.deleteBranch('feature');
      expect(git.branchExists('feature')).toBe(false);
    });

    it('does not throw when deleting non-existent branch', () => {
      expect(() => git.deleteBranch('nonexistent')).not.toThrow();
    });
  });

  describe('getRemoteUrl', () => {
    it('returns remote URL when set', () => {
      execSync('git remote add origin https://github.com/owner/repo.git', { cwd: tempDir });
      expect(git.getRemoteUrl()).toBe('https://github.com/owner/repo.git');
    });
  });

  describe('getRepoInfo', () => {
    it('parses HTTPS URL', () => {
      execSync('git remote add origin https://github.com/myowner/myrepo.git', { cwd: tempDir });
      const info = git.getRepoInfo();
      expect(info).toEqual({ owner: 'myowner', repo: 'myrepo' });
    });

    it('parses SSH URL', () => {
      execSync('git remote add origin git@github.com:myowner/myrepo.git', { cwd: tempDir });
      const info = git.getRepoInfo();
      expect(info).toEqual({ owner: 'myowner', repo: 'myrepo' });
    });

    it('handles URL without .git suffix', () => {
      execSync('git remote add origin https://github.com/myowner/myrepo', { cwd: tempDir });
      const info = git.getRepoInfo();
      expect(info).toEqual({ owner: 'myowner', repo: 'myrepo' });
    });

    it('returns null for non-GitHub URLs', () => {
      execSync('git remote add origin https://gitlab.com/owner/repo.git', { cwd: tempDir });
      const info = git.getRepoInfo();
      expect(info).toBeNull();
    });
  });
});
