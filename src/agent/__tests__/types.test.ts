import { describe, it, expect } from 'vitest';
import {
  createFingerprint,
  isErrorLog,
  groupConsecutiveErrors,
  ERROR_KEYWORDS,
  type NormalizedError,
} from '../watchers/types.js';

describe('watchers/types', () => {
  describe('createFingerprint', () => {
    it('creates consistent fingerprint for same error', () => {
      const error: NormalizedError = {
        timestamp: new Date(),
        message: 'TypeError: Cannot read property x of undefined',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: ['TypeError: Cannot read property x of undefined'],
      };

      const fp1 = createFingerprint(error);
      const fp2 = createFingerprint(error);

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(16);
    });

    it('creates different fingerprints for different errors', () => {
      const error1: NormalizedError = {
        timestamp: new Date(),
        message: 'TypeError: Cannot read property x of undefined',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const error2: NormalizedError = {
        timestamp: new Date(),
        message: 'ReferenceError: foo is not defined',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      expect(createFingerprint(error1)).not.toBe(createFingerprint(error2));
    });

    it('normalizes variable parts of messages', () => {
      const error1: NormalizedError = {
        timestamp: new Date(),
        message: 'Error: User 12345 not found',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const error2: NormalizedError = {
        timestamp: new Date(),
        message: 'Error: User 67890 not found',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      expect(createFingerprint(error1)).toBe(createFingerprint(error2));
    });

    it('normalizes UUIDs in messages', () => {
      const error1: NormalizedError = {
        timestamp: new Date(),
        message: 'Error: Record 550e8400-e29b-41d4-a716-446655440000 not found',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const error2: NormalizedError = {
        timestamp: new Date(),
        message: 'Error: Record a1b2c3d4-e5f6-7890-abcd-ef1234567890 not found',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      expect(createFingerprint(error1)).toBe(createFingerprint(error2));
    });

    it('normalizes timestamps in messages', () => {
      const error1: NormalizedError = {
        timestamp: new Date(),
        message: 'Error at 2024-01-15T10:30:00Z: Connection failed',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const error2: NormalizedError = {
        timestamp: new Date(),
        message: 'Error at 2024-02-20T15:45:30Z: Connection failed',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      expect(createFingerprint(error1)).toBe(createFingerprint(error2));
    });

    it('uses stack trace for fingerprinting when available', () => {
      const error1: NormalizedError = {
        timestamp: new Date(),
        message: 'TypeError: x is undefined',
        stackTrace: 'at foo (/app/src/service.ts:10:5)',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const error2: NormalizedError = {
        timestamp: new Date(),
        message: 'TypeError: x is undefined',
        stackTrace: 'at bar (/app/src/other.ts:20:10)',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      expect(createFingerprint(error1)).not.toBe(createFingerprint(error2));
    });

    it('uses provided errorType', () => {
      const error: NormalizedError = {
        timestamp: new Date(),
        message: 'Something went wrong',
        errorType: 'CustomError',
        serviceName: 'api',
        environmentName: 'production',
        projectId: 'proj-1',
        rawLines: [],
      };

      const fp = createFingerprint(error);
      expect(fp).toBeDefined();
    });
  });

  describe('isErrorLog', () => {
    it('returns true for error severity', () => {
      expect(isErrorLog('Normal message', 'error')).toBe(true);
    });

    it('returns true for messages containing error keywords', () => {
      for (const keyword of ERROR_KEYWORDS) {
        expect(isErrorLog(`Something ${keyword} here`, undefined)).toBe(true);
      }
    });

    it('returns false for normal messages', () => {
      expect(isErrorLog('Server started on port 3000', undefined)).toBe(false);
      expect(isErrorLog('Request completed successfully', 'info')).toBe(false);
    });

    it('is case insensitive', () => {
      expect(isErrorLog('ERROR: Something wrong', undefined)).toBe(true);
      expect(isErrorLog('Error: Something wrong', undefined)).toBe(true);
      expect(isErrorLog('FATAL error occurred', undefined)).toBe(true);
    });
  });

  describe('groupConsecutiveErrors', () => {
    it('groups consecutive error logs', () => {
      const logs = [
        { timestamp: '2024-01-01T10:00:00Z', message: 'TypeError: x is undefined' },
        { timestamp: '2024-01-01T10:00:01Z', message: '    at foo (file.js:10:5)' },
        { timestamp: '2024-01-01T10:00:02Z', message: '    at bar (file.js:20:10)' },
        { timestamp: '2024-01-01T10:00:03Z', message: 'Request completed' },
      ];

      const groups = groupConsecutiveErrors(logs);

      expect(groups).toHaveLength(1);
      expect(groups[0].lines).toHaveLength(3);
      expect(groups[0].timestamp).toBe('2024-01-01T10:00:00Z');
    });

    it('creates separate groups for non-consecutive errors', () => {
      const logs = [
        { timestamp: '2024-01-01T10:00:00Z', message: 'Error: First error' },
        { timestamp: '2024-01-01T10:00:01Z', message: 'Request completed' },
        { timestamp: '2024-01-01T10:00:02Z', message: 'Error: Second error' },
      ];

      const groups = groupConsecutiveErrors(logs);

      expect(groups).toHaveLength(2);
      expect(groups[0].lines[0]).toBe('Error: First error');
      expect(groups[1].lines[0]).toBe('Error: Second error');
    });

    it('handles empty input', () => {
      expect(groupConsecutiveErrors([])).toEqual([]);
    });

    it('includes stack trace lines with at prefix', () => {
      const logs = [
        { timestamp: '2024-01-01T10:00:00Z', message: 'Error: Something failed' },
        { timestamp: '2024-01-01T10:00:01Z', message: '    at Object.<anonymous>' },
        { timestamp: '2024-01-01T10:00:02Z', message: '    at Module._compile' },
      ];

      const groups = groupConsecutiveErrors(logs);

      expect(groups).toHaveLength(1);
      expect(groups[0].lines).toHaveLength(3);
    });

    it('includes caret lines for syntax errors', () => {
      // Note: Context lines (like '  const x = {') break the grouping
      // because they're not detected as error or stack trace lines.
      // Only 'at ...' lines or '   ^' caret lines are grouped.
      const logs = [
        { timestamp: '2024-01-01T10:00:00Z', message: 'SyntaxError: Unexpected token' },
        { timestamp: '2024-01-01T10:00:01Z', message: '    at Object.<anonymous>' },
        { timestamp: '2024-01-01T10:00:02Z', message: '            ^' },
      ];

      const groups = groupConsecutiveErrors(logs);

      expect(groups).toHaveLength(1);
      expect(groups[0].lines).toHaveLength(3);
    });

    it('respects severity field', () => {
      const logs = [
        { timestamp: '2024-01-01T10:00:00Z', message: 'Normal looking message', severity: 'error' as const },
        { timestamp: '2024-01-01T10:00:01Z', message: '    at somewhere' },
      ];

      const groups = groupConsecutiveErrors(logs);

      expect(groups).toHaveLength(1);
      expect(groups[0].lines).toHaveLength(2);
    });
  });
});
