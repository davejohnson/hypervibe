import type { GitHubScheduleSpec } from '../spec/spec.schema.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { RecoverySourceIdentity } from './recovery-source.port.js';

export interface DatabaseRestoreDrillTarget {
  environmentName: string;
  source: RecoverySourceIdentity;
  databaseName: string;
  schedule: GitHubScheduleSpec;
  credentialsSecretName: string;
  verificationQuery: string;
  restoreLagMinutes: number;
  retainFailedInstanceDays: number;
}

export interface DatabaseRestoreDrillFile {
  path: string;
  content: string;
  review: {
    title: string;
    summary: string;
    details?: string[];
    mergeEffect?: string;
  };
}

export interface DatabaseRestoreDrillWorkflow {
  files: DatabaseRestoreDrillFile[];
  requiredSecrets: string[];
}

/** Provider-owned compiler for an isolated scheduled database restore drill. */
export interface ProviderDatabaseRestoreDrillMetadata {
  /** Resolve only allowlisted, non-secret identity from this environment's binding. */
  resolveSource(params: { environment: Environment; component: Component }):
    | { status: 'resolved'; source: RecoverySourceIdentity; databaseName: string }
    | { status: 'binding_missing' | 'identity_invalid'; message: string };
  buildWorkflow(target: DatabaseRestoreDrillTarget): DatabaseRestoreDrillWorkflow;
}
