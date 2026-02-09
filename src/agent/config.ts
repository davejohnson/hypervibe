/**
 * Auto-fix agent configuration loaded from environment variables.
 */
export interface AutoFixConfig {
  // Claude API
  anthropicApiKey: string;
  claudeModel: string;

  // Polling
  pollIntervalSeconds: number;
  maxErrorsPerPoll: number;

  // Safety limits
  maxPRsPerHour: number;
  cooldownSeconds: number;

  // Git
  workingDirectory: string;
  gitUserName: string;
  gitUserEmail: string;

  // Dry run mode
  dryRun: boolean;
}

/**
 * Load configuration from environment variables with sensible defaults.
 */
export function loadConfig(): AutoFixConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return {
    // Claude API
    anthropicApiKey,
    claudeModel: process.env.AUTOFIX_CLAUDE_MODEL || 'claude-sonnet-4-20250514',

    // Polling
    pollIntervalSeconds: parseInt(process.env.AUTOFIX_POLL_INTERVAL || '300', 10),
    maxErrorsPerPoll: parseInt(process.env.AUTOFIX_MAX_ERRORS_PER_POLL || '10', 10),

    // Safety limits
    maxPRsPerHour: parseInt(process.env.AUTOFIX_MAX_PRS_PER_HOUR || '5', 10),
    cooldownSeconds: parseInt(process.env.AUTOFIX_COOLDOWN_SECONDS || '3600', 10),

    // Git
    workingDirectory: process.env.AUTOFIX_WORKING_DIR || process.cwd(),
    gitUserName: process.env.AUTOFIX_GIT_USER_NAME || 'Auto-Fix Agent',
    gitUserEmail: process.env.AUTOFIX_GIT_USER_EMAIL || 'autofix@infraprint.dev',

    // Dry run mode
    dryRun: process.env.AUTOFIX_DRY_RUN === 'true',
  };
}
