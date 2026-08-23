import { describe, expect, it } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import {
  detectProviderName,
  isErrorLike,
  supportsLogsBuildProvider,
  supportsLogsDeploymentsProvider,
} from '../provider-logs.service.js';

describe('provider-logs.service helpers', () => {
  describe('detectProviderName', () => {
    it('prefers explicit provider from bindings', () => {
      expect(detectProviderName('railway', 'cloudrun')).toBe('cloudrun');
    });

    it('falls back to project default platform', () => {
      expect(detectProviderName('vercel', undefined)).toBe('vercel');
    });

    it('reports unconfigured when no provider is available', () => {
      expect(detectProviderName(undefined, undefined)).toBe('unconfigured');
    });
  });

  describe('isErrorLike', () => {
    it('detects error by severity', () => {
      expect(isErrorLike({ timestamp: '', severity: 'error', message: 'ok' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'warn', message: 'ok' })).toBe(true);
    });

    it('detects error by message keywords', () => {
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Unhandled exception occurred' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'deploy failed due to timeout' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'SequelizeConnectionRefusedError: connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'service is healthy' })).toBe(false);
    });

    it('ignores benign filenames and zero-error summaries', () => {
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Loading model: exception.js' })).toBe(false);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Checks complete: 0 errors' })).toBe(false);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: '0 errors, 0 failures' })).toBe(false);
    });
  });

  describe('provider support matrix', () => {
    it('matches deployments provider support contract', () => {
      expect(supportsLogsDeploymentsProvider('railway')).toBe(true);
      expect(supportsLogsDeploymentsProvider('cloudrun')).toBe(true);
      expect(supportsLogsDeploymentsProvider('vercel')).toBe(false);
    });

    it('matches build provider support contract', () => {
      expect(supportsLogsBuildProvider('railway')).toBe(true);
      expect(supportsLogsBuildProvider('cloudrun')).toBe(false);
      expect(supportsLogsBuildProvider('vercel')).toBe(false);
    });
  });
});
