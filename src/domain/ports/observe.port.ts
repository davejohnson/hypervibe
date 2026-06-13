import { createHash } from 'crypto';
import type { Environment } from '../entities/environment.entity.js';

/**
 * Live infrastructure state read back from a provider — the "observe" half of
 * the spec → observe → diff → converge loop.
 *
 * Adapters that support observation declare `supportsObserve: true` in their
 * capabilities and implement `observe()`. When a provider can't be observed,
 * the diff engine falls back to local state and marks actions `verified: false`.
 */

export interface ObservedService {
  name: string;
  externalId: string;
  workloadKind: 'web' | 'worker' | 'cron' | 'job';
  url?: string;
  customDomains: string[];
  config: {
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    public?: boolean;
  };
  /** Repo-linked deploy source, when the provider links services to a git repo. */
  source?: { repo?: string; branch?: string };
  /** Env var names present on the live service. Values are never returned. */
  envVarKeys: string[];
  /** sha256 hex of each env var value, for drift comparison without exposure. */
  envVarHashes: Record<string, string>;
  /** 'empty' = the service exists but has never deployed (no source/code). */
  status: 'running' | 'failed' | 'empty' | 'unknown';
}

export interface ObservedDatabase {
  provider: string;
  engine: string;
  externalId: string;
  name?: string;
  status: string;
}

export interface ObservedState {
  provider: string;
  observedAt: string;
  projectExists: boolean;
  projectId?: string;
  environmentId?: string;
  services: ObservedService[];
  databases: ObservedDatabase[];
  /** True when one or more sub-queries failed; see warnings. */
  partial: boolean;
  warnings: string[];
}

export interface IObservableHosting {
  observe(environment: Environment): Promise<ObservedState>;
}

export interface IObservableDatabase {
  observeDatabase(environment: Environment): Promise<ObservedDatabase | null>;
}

/** Compute the sha256 hex digest used for env var drift comparison. */
export function hashEnvValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
