import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateManager, type Watch } from '../state.js';

describe('StateManager', () => {
  // Use a unique prefix for each test to ensure isolation
  let tempDirs: string[] = [];

  function createFreshManager(): { manager: StateManager; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), `autofix-test-${Date.now()}-${Math.random().toString(36).slice(2)}-`));
    tempDirs.push(dir);
    return { manager: new StateManager(dir), dir };
  }

  afterEach(() => {
    // Clean up all temp directories
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDirs = [];
  });

  describe('initialization', () => {
    it('creates with default state when no file exists', () => {
      const { manager } = createFreshManager();
      expect(manager.getWatches()).toEqual([]);
      expect(manager.getAllErrors()).toEqual({});
      expect(manager.getLastPollAt()).toBeNull();
    });

    it('loads existing state from file', () => {
      const { manager: manager1, dir } = createFreshManager();

      // Add some state and save
      manager1.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      });
      manager1.save();

      // Create new manager from same directory
      const manager2 = new StateManager(dir);
      expect(manager2.getWatches()).toHaveLength(1);
      expect(manager2.getWatches()[0].serviceName).toBe('api');
    });
  });

  describe('watches', () => {
    it('adds a new watch', () => {
      const { manager } = createFreshManager();
      const watch: Watch = {
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      };

      manager.addWatch(watch);

      expect(manager.getWatches()).toHaveLength(1);
      expect(manager.getWatches()[0]).toEqual(watch);
    });

    it('updates existing watch', () => {
      const { manager } = createFreshManager();

      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      });

      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: false,
      });

      expect(manager.getWatches()).toHaveLength(1);
      expect(manager.getWatches()[0].enabled).toBe(false);
    });

    it('returns only enabled watches', () => {
      const { manager } = createFreshManager();

      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      });
      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'worker',
        enabled: false,
      });

      const enabled = manager.getEnabledWatches();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].serviceName).toBe('api');
    });

    it('removes a watch', () => {
      const { manager } = createFreshManager();

      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      });

      const removed = manager.removeWatch('proj-1', 'env-1', 'api');

      expect(removed).toBe(true);
      expect(manager.getWatches()).toHaveLength(0);
    });

    it('returns false when removing non-existent watch', () => {
      const { manager } = createFreshManager();
      const removed = manager.removeWatch('proj-1', 'env-1', 'api');
      expect(removed).toBe(false);
    });
  });

  describe('errors', () => {
    it('tracks a new error', () => {
      const { manager } = createFreshManager();

      const tracked = manager.trackError('fp-unique-1', {
        serviceName: 'api',
        message: 'Test error message',
      });

      expect(tracked.serviceName).toBe('api');
      expect(tracked.message).toBe('Test error message');
      expect(tracked.occurrenceCount).toBe(1);
      expect(tracked.status).toBe('new');
      expect(tracked.firstSeen).toBeDefined();
      expect(tracked.lastSeen).toBeDefined();
    });

    it('increments occurrence count on duplicate error', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-unique-2', {
        serviceName: 'api',
        message: 'Test error',
      });

      const tracked = manager.trackError('fp-unique-2', {
        serviceName: 'api',
        message: 'Test error',
      });

      expect(tracked.occurrenceCount).toBe(2);
    });

    it('truncates long messages', () => {
      const { manager } = createFreshManager();

      const longMessage = 'x'.repeat(1000);
      const tracked = manager.trackError('fp-unique-3', {
        serviceName: 'api',
        message: longMessage,
      });

      expect(tracked.message.length).toBe(500);
    });

    it('updates error status', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-unique-4', {
        serviceName: 'api',
        message: 'Test error',
      });

      manager.updateErrorStatus('fp-unique-4', 'pr_created', {
        prUrl: 'https://github.com/owner/repo/pull/1',
        branchName: 'autofix/err-fp-unique-4',
      });

      const error = manager.getError('fp-unique-4');
      expect(error?.status).toBe('pr_created');
      expect(error?.prUrl).toBe('https://github.com/owner/repo/pull/1');
      expect(error?.branchName).toBe('autofix/err-fp-unique-4');
    });

    it('returns undefined for non-existent error', () => {
      const { manager } = createFreshManager();
      expect(manager.getError('non-existent')).toBeUndefined();
    });

    it('gets all errors', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-a', { serviceName: 'api', message: 'Error 1' });
      manager.trackError('fp-b', { serviceName: 'web', message: 'Error 2' });

      const all = manager.getAllErrors();
      expect(Object.keys(all)).toHaveLength(2);
    });
  });

  describe('poll tracking', () => {
    it('updates last poll timestamp', () => {
      const { manager } = createFreshManager();

      expect(manager.getLastPollAt()).toBeNull();

      manager.updateLastPoll();

      const lastPoll = manager.getLastPollAt();
      expect(lastPoll).toBeInstanceOf(Date);
      expect(lastPoll!.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('PR rate limiting', () => {
    it('allows PRs when under limit', () => {
      const { manager } = createFreshManager();
      expect(manager.canCreatePR(5)).toBe(true);
    });

    it('blocks PRs when at limit', () => {
      const { manager } = createFreshManager();

      for (let i = 0; i < 5; i++) {
        manager.incrementPRCount();
      }
      expect(manager.canCreatePR(5)).toBe(false);
    });

    it('resets count in new hour', () => {
      const { manager } = createFreshManager();

      for (let i = 0; i < 5; i++) {
        manager.incrementPRCount();
      }
      expect(manager.canCreatePR(5)).toBe(false);

      // Simulate time passing by manipulating state
      manager['state'].lastPRCountResetHour = '2020-01-01T00';
      expect(manager.canCreatePR(5)).toBe(true);
    });
  });

  describe('cooldown', () => {
    it('returns false when error not tracked', () => {
      const { manager } = createFreshManager();
      expect(manager.isInCooldown('unknown', 3600)).toBe(false);
    });

    it('returns false when error not in pr_created status', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cool-1', { serviceName: 'api', message: 'Error' });
      expect(manager.isInCooldown('fp-cool-1', 3600)).toBe(false);
    });

    it('returns true when error is in cooldown', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cool-2', { serviceName: 'api', message: 'Error' });
      manager.updateErrorStatus('fp-cool-2', 'pr_created');

      expect(manager.isInCooldown('fp-cool-2', 3600)).toBe(true);
    });

    it('returns false when cooldown expired', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cool-3', { serviceName: 'api', message: 'Error' });
      manager.updateErrorStatus('fp-cool-3', 'pr_created');

      // Set lastSeen to 2 hours ago
      const error = manager.getError('fp-cool-3')!;
      error.lastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      expect(manager.isInCooldown('fp-cool-3', 3600)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes old resolved/ignored errors', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cleanup-1', { serviceName: 'api', message: 'Error 1' });
      manager.updateErrorStatus('fp-cleanup-1', 'resolved');

      // Set to 8 days ago
      manager['state'].errors['fp-cleanup-1'].lastSeen =
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      manager.cleanup();

      expect(manager.getError('fp-cleanup-1')).toBeUndefined();
    });

    it('keeps recent resolved errors', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cleanup-2', { serviceName: 'api', message: 'Error 1' });
      manager.updateErrorStatus('fp-cleanup-2', 'resolved');

      manager.cleanup();

      expect(manager.getError('fp-cleanup-2')).toBeDefined();
    });

    it('keeps errors with other statuses', () => {
      const { manager } = createFreshManager();

      manager.trackError('fp-cleanup-3', { serviceName: 'api', message: 'Error 1' });
      manager.updateErrorStatus('fp-cleanup-3', 'pr_created');

      // Set to 8 days ago
      manager['state'].errors['fp-cleanup-3'].lastSeen =
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      manager.cleanup();

      expect(manager.getError('fp-cleanup-3')).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('saves state to file', () => {
      const { manager, dir } = createFreshManager();

      manager.addWatch({
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'api',
        enabled: true,
      });
      manager.save();

      const filePath = join(dir, 'autofix-state.json');
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.watches).toHaveLength(1);
    });
  });
});
