import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('throws when ANTHROPIC_API_KEY is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(() => loadConfig()).toThrow('ANTHROPIC_API_KEY environment variable is required');
    });

    it('loads config with required API key', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const config = loadConfig();
      expect(config.anthropicApiKey).toBe('test-key');
    });

    it('uses default values when optional vars not set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const config = loadConfig();

      expect(config.claudeModel).toBe('claude-sonnet-4-20250514');
      expect(config.pollIntervalSeconds).toBe(300);
      expect(config.maxErrorsPerPoll).toBe(10);
      expect(config.maxPRsPerHour).toBe(5);
      expect(config.cooldownSeconds).toBe(3600);
      expect(config.gitUserName).toBe('Auto-Fix Agent');
      expect(config.gitUserEmail).toBe('autofix@infraprint.dev');
      expect(config.dryRun).toBe(false);
    });

    it('respects custom environment variables', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.AUTOFIX_CLAUDE_MODEL = 'claude-3-opus';
      process.env.AUTOFIX_POLL_INTERVAL = '600';
      process.env.AUTOFIX_MAX_ERRORS_PER_POLL = '20';
      process.env.AUTOFIX_MAX_PRS_PER_HOUR = '10';
      process.env.AUTOFIX_COOLDOWN_SECONDS = '7200';
      process.env.AUTOFIX_GIT_USER_NAME = 'Custom Bot';
      process.env.AUTOFIX_GIT_USER_EMAIL = 'bot@example.com';
      process.env.AUTOFIX_DRY_RUN = 'true';

      const config = loadConfig();

      expect(config.claudeModel).toBe('claude-3-opus');
      expect(config.pollIntervalSeconds).toBe(600);
      expect(config.maxErrorsPerPoll).toBe(20);
      expect(config.maxPRsPerHour).toBe(10);
      expect(config.cooldownSeconds).toBe(7200);
      expect(config.gitUserName).toBe('Custom Bot');
      expect(config.gitUserEmail).toBe('bot@example.com');
      expect(config.dryRun).toBe(true);
    });

    it('uses cwd as default working directory', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const config = loadConfig();
      expect(config.workingDirectory).toBe(process.cwd());
    });

    it('respects custom working directory', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.AUTOFIX_WORKING_DIR = '/custom/path';
      const config = loadConfig();
      expect(config.workingDirectory).toBe('/custom/path');
    });
  });
});
