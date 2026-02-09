#!/usr/bin/env node
/**
 * Auto-Fix Agent Entry Point
 *
 * This script runs a single poll cycle of the auto-fix agent.
 * It's designed to be run by GitHub Actions on a cron schedule.
 *
 * Usage:
 *   npm run autofix
 *
 * Required environment variables:
 *   - ANTHROPIC_API_KEY: Claude API key for error analysis
 *   - RAILWAY_API_TOKEN: Railway API token (if watching Railway services)
 *   - GITHUB_TOKEN: GitHub token for PR creation (auto-provided in Actions)
 *
 * Optional environment variables:
 *   - AUTOFIX_DRY_RUN: Set to 'true' to analyze without creating PRs
 *   - AUTOFIX_CLAUDE_MODEL: Claude model to use (default: claude-sonnet-4-20250514)
 *   - AUTOFIX_MAX_PRS_PER_HOUR: Rate limit for PR creation (default: 5)
 *   - AUTOFIX_COOLDOWN_SECONDS: Cooldown after PR creation (default: 3600)
 */

import { loadConfig } from './config.js';
import { AutoFixAgent } from './autofix-agent.js';

async function main() {
  try {
    const config = loadConfig();

    if (config.dryRun) {
      console.log('Running in DRY RUN mode - no PRs will be created');
    }

    const agent = new AutoFixAgent(config);
    const result = await agent.run();

    // Exit with error if there were processing errors
    if (result.errors.length > 0) {
      console.error('Some errors failed to process:');
      for (const err of result.errors) {
        console.error(`  ${err.fingerprint}: ${err.error}`);
      }
      process.exit(1);
    }

    // Output summary for GitHub Actions
    console.log('\n--- Summary ---');
    console.log(`Errors found: ${result.errorsFound}`);
    console.log(`Errors analyzed: ${result.errorsAnalyzed}`);
    console.log(`Fixes attempted: ${result.fixesAttempted}`);
    console.log(`PRs created: ${result.prsCreated}`);

  } catch (error) {
    console.error('Auto-fix agent failed:', error);
    process.exit(1);
  }
}

main();
