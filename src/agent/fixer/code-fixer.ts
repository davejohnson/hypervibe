import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AutoFixConfig } from '../config.js';
import type { SuggestedFix, FileChange } from '../analyzer/prompts.js';
import { GitOps } from './git-ops.js';
import { validateFix } from './validators.js';

/**
 * Result of applying a fix.
 */
export interface FixResult {
  success: boolean;
  branchName?: string;
  filesChanged?: string[];
  error?: string;
  validationErrors?: string[];
}

/**
 * Applies code fixes suggested by the analyzer.
 */
export class CodeFixer {
  private readonly config: AutoFixConfig;
  private readonly git: GitOps;

  constructor(config: AutoFixConfig) {
    this.config = config;
    this.git = new GitOps(config);
  }

  /**
   * Apply a suggested fix and prepare it for PR.
   */
  async applyFix(fix: SuggestedFix, fingerprint: string): Promise<FixResult> {
    const branchName = `autofix/err-${fingerprint}`;
    const originalBranch = this.git.getCurrentBranch();
    let stashed = false;

    try {
      // 1. Check if branch already exists
      if (this.git.branchExists(branchName)) {
        return {
          success: false,
          error: `Branch ${branchName} already exists`,
        };
      }

      // 2. Stash any uncommitted changes
      stashed = this.git.stash();

      // 3. Create feature branch
      this.git.createBranch(branchName);

      // 4. Apply file changes
      const filesChanged: string[] = [];
      for (const fileChange of fix.files) {
        const result = this.applyFileChanges(fileChange);
        if (!result.success) {
          // Rollback
          this.git.checkout(originalBranch);
          this.git.deleteBranch(branchName);
          if (stashed) this.git.unstash();

          return {
            success: false,
            error: result.error,
          };
        }
        filesChanged.push(fileChange.path);
      }

      // 5. Validate changes
      const validation = await validateFix(this.config.workingDirectory);
      if (!validation.valid) {
        // Rollback
        this.git.checkout(originalBranch);
        this.git.deleteBranch(branchName);
        if (stashed) this.git.unstash();

        return {
          success: false,
          error: 'Validation failed',
          validationErrors: validation.errors,
        };
      }

      // 6. Commit changes
      this.git.add(filesChanged);
      this.git.commit(`fix: ${fix.description}\n\nAuto-generated fix for production error.\nFingerprint: ${fingerprint}`);

      // 7. Push to remote
      this.git.push(branchName);

      // 8. Return to original branch
      this.git.checkout(originalBranch);
      if (stashed) this.git.unstash();

      return {
        success: true,
        branchName,
        filesChanged,
      };

    } catch (error) {
      // Attempt cleanup
      try {
        this.git.checkout(originalBranch);
        this.git.deleteBranch(branchName);
        if (stashed) this.git.unstash();
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Apply changes to a single file.
   */
  private applyFileChanges(fileChange: FileChange): { success: boolean; error?: string } {
    const filePath = join(this.config.workingDirectory, fileChange.path);

    // Check if file exists
    if (!existsSync(filePath)) {
      return {
        success: false,
        error: `File not found: ${fileChange.path}`,
      };
    }

    try {
      let content = readFileSync(filePath, 'utf-8');

      for (const change of fileChange.changes) {
        switch (change.type) {
          case 'replace':
            if (!change.search) {
              return { success: false, error: 'Replace change missing search string' };
            }
            if (!content.includes(change.search)) {
              return {
                success: false,
                error: `Search string not found in ${fileChange.path}: "${change.search.substring(0, 50)}..."`,
              };
            }
            content = content.replace(change.search, change.replace || '');
            break;

          case 'insert':
            if (!change.after || !change.content) {
              return { success: false, error: 'Insert change missing after or content' };
            }
            if (!content.includes(change.after)) {
              return {
                success: false,
                error: `Insert anchor not found in ${fileChange.path}: "${change.after.substring(0, 50)}..."`,
              };
            }
            content = content.replace(change.after, change.after + change.content);
            break;

          case 'delete':
            if (!change.search) {
              return { success: false, error: 'Delete change missing search string' };
            }
            if (!content.includes(change.search)) {
              return {
                success: false,
                error: `Delete target not found in ${fileChange.path}: "${change.search.substring(0, 50)}..."`,
              };
            }
            content = content.replace(change.search, '');
            break;

          default:
            return { success: false, error: `Unknown change type: ${(change as { type: string }).type}` };
        }
      }

      writeFileSync(filePath, content, 'utf-8');
      return { success: true };

    } catch (error) {
      return {
        success: false,
        error: `Failed to modify ${fileChange.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
