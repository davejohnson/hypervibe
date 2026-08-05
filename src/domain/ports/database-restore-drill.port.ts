import type { GitHubScheduleSpec } from '../spec/spec.schema.js';

export interface DatabaseRestoreDrillTarget {
  environmentName: string;
  projectId: string;
  region: string;
  sourceInstanceId: string;
  sourceConnectionName: string;
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
  buildWorkflow(target: DatabaseRestoreDrillTarget): DatabaseRestoreDrillWorkflow;
}
