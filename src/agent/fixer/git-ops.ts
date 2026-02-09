import { execSync } from 'child_process';
import type { AutoFixConfig } from '../config.js';

/**
 * Git operations for the auto-fix agent.
 * Uses git CLI directly for reliability.
 */
export class GitOps {
  private readonly config: AutoFixConfig;
  private readonly cwd: string;

  constructor(config: AutoFixConfig) {
    this.config = config;
    this.cwd = config.workingDirectory;
  }

  /**
   * Get the current branch name.
   */
  getCurrentBranch(): string {
    return this.exec('git rev-parse --abbrev-ref HEAD').trim();
  }

  /**
   * Get the default branch (main or master).
   */
  getDefaultBranch(): string {
    // Try to get from remote refs
    try {
      const refs = this.exec('git remote show origin 2>/dev/null').trim();
      const match = refs.match(/HEAD branch:\s*(\S+)/);
      if (match && match[1] && match[1] !== '(unknown)') {
        return match[1];
      }
    } catch {
      // Fallback
    }

    // Check if main or master exists locally
    try {
      this.exec('git rev-parse --verify main 2>/dev/null');
      return 'main';
    } catch {
      // Fall through
    }

    try {
      this.exec('git rev-parse --verify master 2>/dev/null');
      return 'master';
    } catch {
      // Fall through
    }

    // As last resort, return current branch
    return this.getCurrentBranch();
  }

  /**
   * Check if the working directory is clean.
   */
  isClean(): boolean {
    const status = this.exec('git status --porcelain').trim();
    return status === '';
  }

  /**
   * Stash any uncommitted changes (including untracked files).
   */
  stash(): boolean {
    if (this.isClean()) {
      return false;
    }
    this.exec('git stash --include-untracked');
    return true;
  }

  /**
   * Pop stashed changes.
   */
  unstash(): void {
    try {
      this.exec('git stash pop');
    } catch {
      // Ignore if no stash exists
    }
  }

  /**
   * Create and checkout a new branch.
   */
  createBranch(branchName: string, baseBranch?: string): void {
    const base = baseBranch || this.getDefaultBranch();

    // Ensure we have the latest from remote
    try {
      this.exec(`git fetch origin ${base}`);
    } catch {
      // Ignore fetch errors
    }

    // Create branch from the base
    this.exec(`git checkout -b ${branchName} origin/${base}`);
  }

  /**
   * Checkout an existing branch.
   */
  checkout(branchName: string): void {
    this.exec(`git checkout ${branchName}`);
  }

  /**
   * Check if a branch exists.
   */
  branchExists(branchName: string): boolean {
    try {
      this.exec(`git rev-parse --verify ${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stage files for commit.
   */
  add(files: string[]): void {
    for (const file of files) {
      this.exec(`git add "${file}"`);
    }
  }

  /**
   * Commit staged changes.
   */
  commit(message: string): void {
    // Set author info
    this.exec(`git config user.name "${this.config.gitUserName}"`);
    this.exec(`git config user.email "${this.config.gitUserEmail}"`);

    // Commit with message
    const escapedMessage = message.replace(/"/g, '\\"');
    this.exec(`git commit -m "${escapedMessage}"`);
  }

  /**
   * Push branch to remote.
   */
  push(branchName: string): void {
    this.exec(`git push -u origin ${branchName}`);
  }

  /**
   * Delete a local branch.
   */
  deleteBranch(branchName: string): void {
    try {
      this.exec(`git branch -D ${branchName}`);
    } catch {
      // Ignore if branch doesn't exist
    }
  }

  /**
   * Get the remote URL.
   */
  getRemoteUrl(): string {
    return this.exec('git remote get-url origin').trim();
  }

  /**
   * Extract owner and repo from remote URL.
   */
  getRepoInfo(): { owner: string; repo: string } | null {
    const url = this.getRemoteUrl();

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+)\/(.+?)(\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/(.+?)(\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return null;
  }

  /**
   * Execute a git command.
   */
  private exec(command: string): string {
    return execSync(command, {
      cwd: this.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}
