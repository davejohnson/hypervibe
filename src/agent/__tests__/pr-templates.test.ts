import { describe, it, expect } from 'vitest';
import {
  generatePRTitle,
  generatePRBody,
  generateCommitMessage,
} from '../github/pr-templates.js';
import type { NormalizedError } from '../watchers/types.js';
import type { AnalysisResult } from '../analyzer/error-analyzer.js';
import type { FixResult } from '../fixer/code-fixer.js';

describe('pr-templates', () => {
  const mockError: NormalizedError = {
    timestamp: new Date('2024-01-15T10:00:00Z'),
    message: 'TypeError: Cannot read property x of undefined',
    stackTrace: 'at foo (src/service.ts:10:5)\n    at bar (src/index.ts:20:10)',
    serviceName: 'api',
    environmentName: 'production',
    projectId: 'proj-1',
    rawLines: ['TypeError: Cannot read property x of undefined'],
    errorType: 'TypeError',
  };

  const mockAnalysis: AnalysisResult = {
    canFix: true,
    reason: 'This is a null reference that can be fixed with optional chaining',
    rootCause: 'The variable x is accessed before being initialized',
    suggestedFix: {
      description: 'Add null check before accessing property',
      files: [
        {
          path: 'src/service.ts',
          changes: [
            {
              type: 'replace',
              search: 'obj.x',
              replace: 'obj?.x',
            },
          ],
        },
      ],
    },
    confidence: 'high',
    testSuggestion: 'Add a test case where obj is undefined',
  };

  const mockFix: FixResult = {
    success: true,
    branchName: 'autofix/err-abc123',
    filesChanged: ['src/service.ts'],
  };

  describe('generatePRTitle', () => {
    it('includes service name and description', () => {
      const title = generatePRTitle(mockError, mockAnalysis);

      expect(title).toContain('api');
      expect(title).toContain('fix(');
    });

    it('truncates long descriptions', () => {
      const longAnalysis: AnalysisResult = {
        ...mockAnalysis,
        suggestedFix: {
          ...mockAnalysis.suggestedFix!,
          description: 'A'.repeat(100),
        },
      };

      const title = generatePRTitle(mockError, longAnalysis);

      expect(title.length).toBeLessThan(80);
      expect(title).toContain('...');
    });

    it('handles missing suggestedFix', () => {
      const noFixAnalysis: AnalysisResult = {
        ...mockAnalysis,
        suggestedFix: undefined,
      };

      const title = generatePRTitle(mockError, noFixAnalysis);

      expect(title).toContain('Fix production error');
    });
  });

  describe('generatePRBody', () => {
    it('includes error details section', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('## Auto-Fix: Production Error');
      expect(body).toContain('api');
      expect(body).toContain('production');
      expect(body).toContain('TypeError');
    });

    it('includes stack trace in details', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Stack Trace');
      expect(body).toContain('<details>');
      expect(body).toContain('at foo');
    });

    it('includes root cause analysis', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Root Cause Analysis');
      expect(body).toContain('variable x is accessed before being initialized');
    });

    it('includes files changed', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Files Changed');
      expect(body).toContain('src/service.ts');
    });

    it('includes test suggestions when available', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Testing Suggestions');
      expect(body).toContain('test case where obj is undefined');
    });

    it('includes verification checklist', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Verification Checklist');
      expect(body).toContain('[ ]'); // Unchecked checkboxes
    });

    it('includes fingerprint', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Fingerprint');
      expect(body).toContain('abc123');
    });

    it('includes confidence level', () => {
      const body = generatePRBody({
        error: mockError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).toContain('Confidence');
      expect(body).toContain('high');
    });

    it('handles error without stack trace', () => {
      const noStackError: NormalizedError = {
        ...mockError,
        stackTrace: undefined,
      };

      const body = generatePRBody({
        error: noStackError,
        analysis: mockAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).not.toContain('<details>');
      expect(body).not.toContain('Stack Trace');
    });

    it('handles missing test suggestion', () => {
      const noTestAnalysis: AnalysisResult = {
        ...mockAnalysis,
        testSuggestion: undefined,
      };

      const body = generatePRBody({
        error: mockError,
        analysis: noTestAnalysis,
        fix: mockFix,
        fingerprint: 'abc123',
      });

      expect(body).not.toContain('Testing Suggestions');
    });
  });

  describe('generateCommitMessage', () => {
    it('includes service name', () => {
      const msg = generateCommitMessage(mockError, mockAnalysis, 'abc123');

      expect(msg).toContain('fix(api)');
    });

    it('includes root cause', () => {
      const msg = generateCommitMessage(mockError, mockAnalysis, 'abc123');

      expect(msg).toContain('Root cause:');
      expect(msg).toContain('variable x is accessed');
    });

    it('includes fingerprint', () => {
      const msg = generateCommitMessage(mockError, mockAnalysis, 'abc123');

      expect(msg).toContain('Fingerprint: abc123');
    });

    it('includes confidence', () => {
      const msg = generateCommitMessage(mockError, mockAnalysis, 'abc123');

      expect(msg).toContain('Confidence: high');
    });

    it('uses fix description as title', () => {
      const msg = generateCommitMessage(mockError, mockAnalysis, 'abc123');

      expect(msg).toContain('Add null check before accessing property');
    });
  });
});
