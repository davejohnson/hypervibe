import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Run validation checks on the codebase.
 */
export async function validateFix(workingDirectory: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Detect package manager
  const hasYarn = existsSync(join(workingDirectory, 'yarn.lock'));
  const hasPnpm = existsSync(join(workingDirectory, 'pnpm-lock.yaml'));
  const hasNpm = existsSync(join(workingDirectory, 'package-lock.json'));

  const pm = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';

  // Check for TypeScript
  const hasTsConfig = existsSync(join(workingDirectory, 'tsconfig.json'));

  // Run type check if TypeScript is present
  if (hasTsConfig) {
    try {
      execSync(`${pm} run typecheck 2>&1 || ${pm} exec tsc --noEmit 2>&1`, {
        cwd: workingDirectory,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000, // 1 minute timeout
      });
    } catch (error) {
      if (error instanceof Error && 'stdout' in error) {
        const output = (error as { stdout?: string }).stdout || '';
        // Extract actual errors
        const typeErrors = output.split('\n').filter((line) =>
          /error TS\d+/.test(line)
        );
        if (typeErrors.length > 0) {
          errors.push(...typeErrors.slice(0, 5));
          if (typeErrors.length > 5) {
            errors.push(`... and ${typeErrors.length - 5} more type errors`);
          }
        }
      }
    }
  }

  // Check for linting
  const hasEslint = existsSync(join(workingDirectory, '.eslintrc')) ||
                    existsSync(join(workingDirectory, '.eslintrc.js')) ||
                    existsSync(join(workingDirectory, '.eslintrc.json')) ||
                    existsSync(join(workingDirectory, 'eslint.config.js'));

  if (hasEslint) {
    try {
      execSync(`${pm} run lint 2>&1`, {
        cwd: workingDirectory,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
    } catch (error) {
      if (error instanceof Error && 'stdout' in error) {
        const output = (error as { stdout?: string }).stdout || '';
        // Check for actual errors (not just warnings)
        const lintErrors = output.split('\n').filter((line) =>
          /^\s*\d+:\d+\s+error\s/.test(line)
        );
        if (lintErrors.length > 0) {
          warnings.push(`${lintErrors.length} lint errors found`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Run a quick syntax check on specific files.
 */
export function checkFileSyntax(
  workingDirectory: string,
  files: string[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const file of files) {
    const fullPath = join(workingDirectory, file);

    if (!existsSync(fullPath)) {
      errors.push(`File not found: ${file}`);
      continue;
    }

    // TypeScript/JavaScript syntax check
    if (/\.[tj]sx?$/.test(file)) {
      try {
        execSync(`node --check "${fullPath}" 2>&1`, {
          cwd: workingDirectory,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
      } catch (error) {
        if (error instanceof Error && 'stderr' in error) {
          const output = (error as { stderr?: string }).stderr || '';
          errors.push(`Syntax error in ${file}: ${output.split('\n')[0]}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
