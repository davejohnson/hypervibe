import { describe, expect, it } from 'vitest';
import {
  applyEnvFileVarsToBootstrapParams,
  applyOverridesToBootstrapParams,
  specToBootstrapParams,
} from '../spec-bootstrap.js';

describe('spec bootstrap env vars', () => {
  it('merges deploy env files below spec envVars and explicit overrides above both', () => {
    const params = specToBootstrapParams('env-app', 'production', {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
      email: { enabled: false },
      envVars: {
        NODE_ENV: 'production',
        SENDGRID_API_KEY: 'spec-sendgrid',
      },
    });

    const withEnvFile = applyEnvFileVarsToBootstrapParams(params, {
      NODE_ENV: 'from-dotenv',
      SENDGRID_API_KEY: 'dotenv-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
    const withExplicit = applyOverridesToBootstrapParams(withEnvFile, {
      envVars: {
        SENDGRID_API_KEY: 'explicit-sendgrid',
      },
    });

    expect(withEnvFile.envVars).toEqual({
      NODE_ENV: 'production',
      SENDGRID_API_KEY: 'spec-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
    expect(withExplicit.envVars).toEqual({
      NODE_ENV: 'production',
      SENDGRID_API_KEY: 'explicit-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
  });
});

