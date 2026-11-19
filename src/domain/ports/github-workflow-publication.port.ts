import type { AuditEvent, CreateAuditEventInput } from '../entities/audit.entity.js';

export interface PublicationAuditPort {
  findByResource(resourceType: string, resourceId: string, limit: number): AuditEvent[];
  create(input: CreateAuditEventInput): AuditEvent;
}

export interface GitHubPullRequestSummary {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: {
    repo?: { full_name: string };
    ref: string;
    sha: string;
  };
  base: {
    repo?: { full_name: string };
    ref: string;
    sha: string;
  };
}

export interface GitHubWorkflowPublicationPort {
  getRef(owner: string, repo: string, ref: string): Promise<{ ref: string; object: { sha: string } } | null>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  createPublicationCommit(owner: string, repo: string, parentSha: string, message: string,
    files: Array<{ path: string; content: string | null }>): Promise<string>;
  createRef(owner: string, repo: string, ref: string, sha: string): Promise<void>;
  listPullRequests(owner: string, repo: string, filter: { head: string; state: 'all' }): Promise<GitHubPullRequestSummary[]>;
  createPullRequest(owner: string, repo: string, input: {
    head: string; base: string; title: string; body: string; draft: boolean;
  }): Promise<{ number: number; html_url: string }>;
}
