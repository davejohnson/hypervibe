import type { LocalCommitSource } from './commit-release.port.js';
import type { EngineReleaseResult } from './infrastructure-engine.port.js';
import type { ProjectRuntime } from '../spec/project-runtime.js';

/** Private GitHub runner inputs; token values never belong in receipts. */
export interface GitHubOidcContext {
  repository: string; ref: string; sha: string; eventName: string; runId: string; runAttempt: string;
  requestUrl: string; requestToken: string;
  /** Internal absolute deadline; never a token claim or exported binding. */
  deadlineMs?: number;
}
/** Authenticated, exact-bound image-only release capability. No infrastructure methods. */
export interface EngineCiReleaseTarget {
  cloudName: string; buildPhrase: string; format: 'zip' | 'tar.gz'; dockerfileName: string;
  missingDockerfileMessage?: string;
  addFiles?: Record<string, string>;
  dockerfileFor(params: { repositoryDockerfile?: string; runtime?: ProjectRuntime; startCommand?: string }): string;
  /** Verify every bound native workload before uploading source or starting a build. */
  preflight(): Promise<void | { blocked: string }>;
  build(source: LocalCommitSource): Promise<{ image: string; imagesByService?: Record<string, string>; logsUrl?: string } | { error: string; unknown?: boolean; logsUrl?: string }>;
  releaseWorkload(workload: { name: string; kind: string; resource: string; image: string }): Promise<EngineReleaseResult>;
  /** Private values used solely for redaction before receipt persistence. */
  redact: string[];
}
