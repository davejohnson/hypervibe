export interface ProjectSecurityReviewInput {
  repositoryPath: string;
  lockfilePaths?: string[];
  nodeVersions?: Array<{ source: string; version: string }>;
  publicPackageNames?: string[];
}
export interface ProjectSecurityReviewDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}
export interface ProjectSecurityReviewResult {
  version: 1;
  scannedAt: string;
  status: 'findings' | 'clear' | 'incomplete';
  complete: boolean;
  source: { commit: string | null; dirty: boolean | null; files: Array<{ path: string; sha256: string; bytes: number }> };
  npm: { status: 'findings' | 'clear' | 'unknown'; coverage: string; lockedPackages: number; queriedPackages: number; skippedPackages: number; findings: Array<{ package: string; version: string; advisoryId: string; modified: string; url: string; severity: 'unknown'; remediation: string }> };
  node: { entries: Array<{ source: string; version: string | null; status: 'security-update-available' | 'no-newer-security-release' | 'end-of-life' | 'unknown'; reason?: string; recommendedVersion?: string; latestSecurityRelease?: { version: string; date: string; url: string }; releaseDate?: string; supportEnds?: string; url?: string }>; feedSource: string; supportSource: string };
  advisorySources: Array<{ url: string; sha256: string; bytes: number }>;
  issues: string[];
  limitations: string[];
}
export function reviewProjectSecurity(input: ProjectSecurityReviewInput, dependencies?: ProjectSecurityReviewDependencies): Promise<ProjectSecurityReviewResult>;
export function runSecurityReviewCli(argv?: string[]): Promise<number>;
