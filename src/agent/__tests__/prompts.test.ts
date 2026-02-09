import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_SYSTEM_PROMPT,
  createAnalysisPrompt,
} from '../analyzer/prompts.js';

describe('prompts', () => {
  describe('ANALYSIS_SYSTEM_PROMPT', () => {
    it('includes JSON schema instruction', () => {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('```json');
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('canFix');
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('suggestedFix');
    });

    it('includes guidance about when not to fix', () => {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('NOT Fixable');
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('configuration');
      expect(ANALYSIS_SYSTEM_PROMPT).toContain('third-party');
    });
  });

  describe('createAnalysisPrompt', () => {
    it('includes error message', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'TypeError: x is undefined',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [],
      });

      expect(prompt).toContain('TypeError: x is undefined');
    });

    it('includes service and environment info', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Error',
        serviceName: 'api-server',
        environmentName: 'staging',
        relevantCode: [],
      });

      expect(prompt).toContain('api-server');
      expect(prompt).toContain('staging');
    });

    it('includes stack trace when provided', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Error',
        stackTrace: 'at foo (src/service.ts:10:5)',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [],
      });

      expect(prompt).toContain('Stack Trace');
      expect(prompt).toContain('at foo (src/service.ts:10:5)');
    });

    it('omits stack trace section when not provided', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Error',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [],
      });

      expect(prompt).not.toContain('Stack Trace');
    });

    it('includes relevant source code', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Error',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [
          { path: 'src/service.ts', content: 'export function foo() { return x; }' },
          { path: 'src/utils.ts', content: 'export const x = undefined;' },
        ],
      });

      expect(prompt).toContain('Relevant Source Code');
      expect(prompt).toContain('src/service.ts');
      expect(prompt).toContain('export function foo()');
      expect(prompt).toContain('src/utils.ts');
    });

    it('omits source code section when empty', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Error',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [],
      });

      expect(prompt).not.toContain('Relevant Source Code');
    });

    it('formats code blocks properly', () => {
      const prompt = createAnalysisPrompt({
        errorMessage: 'Test error',
        serviceName: 'api',
        environmentName: 'production',
        relevantCode: [
          { path: 'src/test.ts', content: 'const x = 1;' },
        ],
      });

      // Should have code blocks with proper formatting
      expect(prompt).toContain('```');
    });
  });
});
