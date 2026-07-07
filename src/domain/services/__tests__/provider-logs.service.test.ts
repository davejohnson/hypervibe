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
      expect(detectProviderName('railway', 'render')).toBe('render');
    });

    it('falls back to project default platform', () => {
      expect(detectProviderName('vercel', undefined)).toBe('vercel');
    });

    it('defaults to cloudrun when no provider is available', () => {
      expect(detectProviderName(undefined, undefined)).toBe('cloudrun');
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
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'service is healthy' })).toBe(false);
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
