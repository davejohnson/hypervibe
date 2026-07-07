import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { defaultDeployEnvFilePath, loadDeployEnvFile, valueLooksLocal } from '../deploy-env-file.js';

describe('deploy-env-file', () => {
  it('loads repo .env by default and skips provider credentials', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-'));
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'app'));
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, [
      'SENDGRID_API_KEY=SG.runtime',
      'SESSION_SECRET=session-runtime',
      'SENTRY_DSN=https://public@example.ingest.sentry.io/1',
      'WEBHOOK_URL=http://localhost:4040/webhook',
      'REDIS_URL=redis://127.0.0.1:6379',
      'PRIVATE_DATABASE_URL=postgres://app:pw@db.railway.internal:5432/app',
      'SEARCH_URL=search.internal:9200',
      'LOCAL_DEBUG_FLAG=1',
      'RAILWAY_API_TOKEN=provider-token',
      'GITHUB_TOKEN=github-provider-token',
      'SENTRY_AUTH_TOKEN=sentry-provider-token',
      'NPM_TOKEN=npm-provider-token',
      'VERCEL_TOKEN=vercel-provider-token',
      '',
    ].join('\n'));

    expect(defaultDeployEnvFilePath(path.join(root, 'app'))).toBe(envPath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app') })).toEqual({
      path: envPath,
      vars: {
        SENDGRID_API_KEY: 'SG.runtime',
        SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
        SESSION_SECRET: 'session-runtime',
      },
      ignoredKeys: ['LOCAL_DEBUG_FLAG'],
      skippedKeys: ['GITHUB_TOKEN', 'NPM_TOKEN', 'RAILWAY_API_TOKEN', 'SENTRY_AUTH_TOKEN', 'VERCEL_TOKEN'],
      excludedKeys: [],
      localValueKeys: ['PRIVATE_DATABASE_URL', 'REDIS_URL', 'SEARCH_URL', 'WEBHOOK_URL'],
    });
  });

  it('prefers environment-specific env files over the base .env', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-specific-'));
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const prodPath = path.join(root, '.env.production');
    writeFileSync(basePath, 'SENDGRID_API_KEY=SG.base\n');
    writeFileSync(prodPath, 'SENDGRID_API_KEY=SG.prod\n');

    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'production')).toBe(prodPath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'production' })).toEqual({
      path: prodPath,
      vars: {
        SENDGRID_API_KEY: 'SG.prod',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
    });
    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'bad/env')).toBe(basePath);
  });

  it('creates an environment-specific env file from base .env when it is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-fallback-'));
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const stagingPath = path.join(root, '.env.staging');
    writeFileSync(basePath, 'SENDGRID_API_KEY=SG.base\n');

    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'staging')).toBe(basePath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'staging' })).toEqual({
      path: stagingPath,
      baseEnvPath: basePath,
      createdEnvSpecificPath: stagingPath,
      syncedFromBaseKeys: ['SENDGRID_API_KEY'],
      vars: {
        SENDGRID_API_KEY: 'SG.base',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
    });
    expect(existsSync(stagingPath)).toBe(true);
    expect(readFileSync(stagingPath, 'utf-8')).toBe('SENDGRID_API_KEY=SG.base\n');
  });

  it('copies newly added base .env keys into an existing environment-specific file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-sync-'));
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const stagingPath = path.join(root, '.env.staging');
    writeFileSync(basePath, [
      'SENDGRID_API_KEY=SG.base',
      'SESSION_SECRET=session-base',
      'STRIPE_SECRET_KEY=stripe-base',
      '',
    ].join('\n'));
    writeFileSync(stagingPath, [
      'SENDGRID_API_KEY=SG.staging',
      'SESSION_SECRET=session-base',
      '',
    ].join('\n'));

    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'staging' })).toEqual({
      path: stagingPath,
      baseEnvPath: basePath,
      syncedFromBaseKeys: ['STRIPE_SECRET_KEY'],
      divergentFromBaseKeys: ['SENDGRID_API_KEY'],
      vars: {
        SENDGRID_API_KEY: 'SG.staging',
        SESSION_SECRET: 'session-base',
        STRIPE_SECRET_KEY: 'stripe-base',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
    });
    expect(readFileSync(stagingPath, 'utf-8')).toContain('STRIPE_SECRET_KEY=stripe-base');
    expect(readFileSync(stagingPath, 'utf-8')).toContain('Copied from .env by Hypervibe');
  });

  it('recognizes common local-only values', () => {
    expect(valueLooksLocal('redis://localhost:6379')).toBe(true);
    expect(valueLooksLocal('https://api.service.internal/hook')).toBe(true);
    expect(valueLooksLocal('db.internal:5432')).toBe(true);
    expect(valueLooksLocal('callback.local/path')).toBe(true);
    expect(valueLooksLocal('postgres://app:pw@db.example.com:5432/app')).toBe(false);
  });

  it('supports all and explicit mode with include/exclude lists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-policy-'));
    mkdirSync(path.join(root, '.git'));
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, [
      'CUSTOM_WORKER_FLAG=true',
      'LOCAL_DEBUG_FLAG=1',
      'SESSION_SECRET=session-runtime',
      '',
    ].join('\n'));

    expect(loadDeployEnvFile({
      startDir: root,
      mode: 'all',
      excludeKeys: ['LOCAL_DEBUG_FLAG'],
    })).toEqual({
      path: envPath,
      vars: {
        CUSTOM_WORKER_FLAG: 'true',
        SESSION_SECRET: 'session-runtime',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: ['LOCAL_DEBUG_FLAG'],
      localValueKeys: [],
    });

    expect(loadDeployEnvFile({
      startDir: root,
      mode: 'explicit',
      includeKeys: ['CUSTOM_WORKER_FLAG'],
    })).toEqual({
      path: envPath,
      vars: {
        CUSTOM_WORKER_FLAG: 'true',
      },
      ignoredKeys: ['LOCAL_DEBUG_FLAG', 'SESSION_SECRET'],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
    });
  });
});
