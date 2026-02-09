import { execSync } from 'child_process';
import type { AutoFixConfig } from '../config.js';
import type { NormalizedError } from '../watchers/types.js';
import type { AnalysisResult } from '../analyzer/error-analyzer.js';
import type { FixResult } from '../fixer/code-fixer.js';
import { generatePRTitle, generatePRBody } from './pr-templates.js';
import { createFingerprint } from '../watchers/types.js';

/**
 * Result of PR creation.
 */
export interface PRResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

/**
 * Parameters for creating a PR.
 */
export interface CreatePRParams {
  branchName: string;
  error: NormalizedError;
  analysis: AnalysisResult;
  fix: FixResult;
}

/**
 * Creates GitHub PRs for auto-fixes using the gh CLI.
 */
export class PRCreator {
  private readonly config: AutoFixConfig;

  constructor(config: AutoFixConfig) {
    this.config = config;
  }

  /**
   * Create a PR for an auto-fix.
   */
  async createPR(params: CreatePRParams): Promise<PRResult> {
    const { branchName, error, analysis, fix } = params;
    const fingerprint = createFingerprint(error);

    try {
      // Check if gh CLI is available
      this.checkGhCli();

      // Generate PR content
      const title = generatePRTitle(error, analysis);
      const body = generatePRBody({ error, analysis, fix, fingerprint });

      // Create PR using gh CLI
      const result = this.exec(
        `gh pr create --head "${branchName}" --title "${this.escapeShell(title)}" --body "${this.escapeShell(body)}"`
      );

      // Parse PR URL from output
      const prUrl = result.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;

      // Add labels if possible
      if (prNumber) {
        try {
          this.exec(`gh pr edit ${prNumber} --add-label "auto-fix,production-error"`);
        } catch {
          // Ignore label errors (labels may not exist)
        }
      }

      return {
        success: true,
        prUrl,
        prNumber,
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a PR already exists for this branch.
   */
  async prExists(branchName: string): Promise<boolean> {
    try {
      const result = this.exec(`gh pr list --head "${branchName}" --json number`);
      const prs = JSON.parse(result);
      return prs.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get PR URL for a branch.
   */
  async getPRUrl(branchName: string): Promise<string | null> {
    try {
      const result = this.exec(`gh pr view "${branchName}" --json url -q .url`);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Add a comment to an existing PR.
   */
  async addComment(prNumber: number, comment: string): Promise<void> {
    try {
      this.exec(`gh pr comment ${prNumber} --body "${this.escapeShell(comment)}"`);
    } catch {
      // Ignore comment errors
    }
  }

  /**
   * Check if gh CLI is available and authenticated.
   */
  private checkGhCli(): void {
    try {
      this.exec('gh auth status');
    } catch (error) {
      throw new Error(
        'GitHub CLI (gh) is not authenticated. Please run "gh auth login" or set GITHUB_TOKEN.'
      );
    }
  }

  /**
   * Execute a command.
   */
  private exec(command: string): string {
    return execSync(command, {
      cwd: this.config.workingDirectory,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure gh uses the token if available
        GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      },
    });
  }

  /**
   * Escape a string for shell usage.
   */
  private escapeShell(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }
}
