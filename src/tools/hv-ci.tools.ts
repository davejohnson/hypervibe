import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import {
  getGitHubAdapter,
} from '../domain/services/github-ops.service.js';
import {
  connectionSetupDetails,
  formatConnectionGuidance,
} from '../domain/services/connection-guidance.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import type { CiWorkflowDiagnostic } from '../domain/ports/ci-deploy.port.js';
import type { CommandContext } from '../application/context.js';
import { projectField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';

const repoField = z
  .string()
  .optional()
  .describe('GitHub repository as "owner/repo". Defaults from the project gitRemoteUrl.');

const numericIdField = z.preprocess(
  (value) => {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
    return value;
  },
  z.number().int().positive()
);

interface RepoRef {
  owner: string;
  repo: string;
}

interface WorkflowJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: Array<{
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

function resolveRepoOrThrow(ctx: CommandContext, projectRef: string | undefined, repoOverride: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const slug = repoOverride?.trim() || parseGitHubRepoFromRemote(project.gitRemoteUrl);
  const parts = slug?.split('/') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/repo", or set the project gitRemoteUrl to a GitHub remote.',
    });
  }
  return { project, owner: parts[0], repo: parts[1] };
}

function githubAdapterOrThrow({ owner, repo }: RepoRef): GitHubAdapter {
  const result = getGitHubAdapter(`${owner}/${repo}`);
  if ('error' in result) {
    throw new HvError('MISSING_CONNECTION', result.error, {
      details: { connectionSetup: connectionSetupDetails('github', { scope: `${owner}/${repo}` }) },
      hint: formatConnectionGuidance('github', { scope: `${owner}/${repo}` }),
    });
  }
  return result.adapter;
}

function summarizeWorkflowJob(job: {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at: string | null;
    completed_at: string | null;
  }>;
}): WorkflowJobSummary {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
    steps: (job.steps ?? []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  };
}

function isUnsuccessfulJob(job: { status: string; conclusion: string | null }): boolean {
  if (job.conclusion) {
    return !['success', 'skipped'].includes(job.conclusion);
  }
  return job.status !== 'completed';
}

function tailLogText(text: string, requestedLines: number) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tail = lines.slice(-requestedLines);
  return {
    text: tail.join('\n'),
    lineCount: lines.length,
    returnedLines: tail.length,
    truncated: lines.length > tail.length,
  };
}

function diagnoseGenericWorkflowLog(text: string): CiWorkflowDiagnostic[] {
  const diagnostics: CiWorkflowDiagnostic[] = [];

  if (/failed to read dockerfile|dockerfile.*no such file or directory/i.test(text)) {
    diagnostics.push({
      code: 'DOCKERFILE_MISSING',
      severity: 'error',
      summary: 'The Docker build step found no Dockerfile in the repository. Current Hypervibe workflows generate one automatically for Node apps (package.json), so this workflow predates that support.',
      evidence: 'failed to read dockerfile during the image build step.',
      next: [
        'Re-sync the declarative deploy workflow with hv_plan + hv_apply so it picks up the auto-Dockerfile step.',
        'A Dockerfile in the repo is only needed for non-Node apps (no package.json); if present it always takes precedence over the generated one.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  if (/ECONNREFUSED (127\.0\.0\.1|::1):5432/.test(text) && /db:setup|migrat|sequelize|prisma|knex/i.test(text)) {
    diagnostics.push({
      code: 'MIGRATION_DATABASE_URL_EMPTY',
      severity: 'error',
      summary: 'The migration step connected to localhost:5432 — DATABASE_URL is empty or unset in the workflow, so the database client fell back to local defaults.',
      evidence: 'ECONNREFUSED 127.0.0.1:5432 during the migration step.',
      next: [
        'Prefer in-environment migrations where the hosting provider supports them, so migrations run with the deployed service image and managed database env vars.',
        'If migrations must run in GitHub Actions, the managed database needs an externally reachable URL; re-run hv_plan/hv_apply after exposing one so DATABASE_URL can be synced into repository secrets.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  if (/Node 20 is being deprecated/i.test(text) && /actions\/github-script@v7/i.test(text)) {
    diagnostics.push({
      code: 'GITHUB_SCRIPT_NODE20_DEPRECATED',
      severity: 'warning',
      summary: 'This deploy workflow still uses actions/github-script@v7, which runs on the deprecated Node 20 action runtime. Current Hypervibe workflows use actions/github-script@v8.',
      evidence: 'GitHub Actions reported Node 20 deprecation for actions/github-script@v7.',
      next: [
        'Re-sync the declarative deploy workflow with hv_plan + hv_apply so it uses actions/github-script@v8.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  return diagnostics;
}

function diagnoseWorkflowLog(text: string): CiWorkflowDiagnostic[] {
  return [
    ...diagnoseGenericWorkflowLog(text),
    ...providerRegistry
      .all()
      .flatMap((provider) => provider.metadata.orchestration?.ci?.diagnoseWorkflowLog?.(text) ?? []),
  ];
}

export function registerHvCiTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_ci_status',
    'Authoritative inspection path for Hypervibe-managed GitHub Actions deploys and iOS releases. Use this before gh, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls. Returns workflows, recent runs, run jobs/steps, bounded job log tails, release artifact provenance, GitHub Pages status, and branch protection rules through Hypervibe\'s stored GitHub connection.',
    {
      project: projectField,
      repo: repoField,
      include: z.array(z.enum(['workflows', 'runs', 'jobs', 'logs', 'artifacts', 'pages', 'branch-protection'])).optional().describe('Sections to include (default: ["workflows"]). jobs/logs require runId. artifacts exposes names/provenance but never artifact contents. logs returns a bounded tail, not a full archive.'),
      workflow: z.string().optional().describe('Workflow id or filename (required when include contains "runs")'),
      runId: numericIdField.optional().describe('GitHub Actions run id, required when include contains "jobs" or "logs".'),
      jobId: numericIdField.optional().describe('Optional GitHub Actions job id for include=["logs"]. Defaults to failed jobs for the run, or the first job if none failed.'),
      logLines: z.number().int().positive().max(500).optional().describe('Number of log lines to return per job for include=["logs"] (default 120, max 500).'),
      branch: z.string().optional().describe('Branch for branch-protection (default "main")'),
    },
    wrapCommandHandler(async ({ project: projectRef, repo: repoOverride, include, workflow, runId, jobId, logLines, branch }) => {
      const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, repoOverride);
      const adapter = githubAdapterOrThrow({ owner, repo });
      const sections = include?.length ? include : ['workflows' as const];
      const data: Record<string, unknown> = { repository: `${owner}/${repo}` };

      for (const section of sections) {
        try {
          switch (section) {
            case 'workflows': {
              const workflows = await adapter.listWorkflows(owner, repo);
              data.workflows = workflows.workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
              break;
            }
            case 'runs': {
              if (!workflow) {
                throw new HvError('VALIDATION', 'workflow is required when include contains "runs".', {
                  hint: 'Pass workflow as a filename (e.g. "deploy.yml") or numeric id.',
                });
              }
              const runs = await adapter.listWorkflowRuns(owner, repo, workflow, { per_page: 10 });
              data.runs = runs.workflow_runs.map((r) => ({
                id: r.id,
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                headSha: r.head_sha,
                branch: r.head_branch,
                event: r.event,
                createdAt: r.created_at,
                url: r.html_url,
              }));
              break;
            }
            case 'jobs': {
              if (!runId) {
                throw new HvError('VALIDATION', 'runId is required when include contains "jobs".', {
                  hint: 'Get the run id from hv_ci_status include=["runs"], then rerun with include=["jobs"] and runId=<id>.',
                });
              }
              const jobs = await adapter.listWorkflowRunJobs(owner, repo, runId, { per_page: 100 });
              data.jobs = jobs.jobs.map(summarizeWorkflowJob);
              break;
            }
            case 'logs': {
              if (!runId) {
                throw new HvError('VALIDATION', 'runId is required when include contains "logs".', {
                  hint: 'Get the run id from hv_ci_status include=["runs"], then rerun with include=["logs"] and runId=<id>.',
                });
              }
              const jobs = await adapter.listWorkflowRunJobs(owner, repo, runId, { per_page: 100 });
              const targetJobs = jobId
                ? jobs.jobs.filter((job) => job.id === jobId)
                : jobs.jobs.filter(isUnsuccessfulJob).slice(0, 3);
              const jobsForLogs = targetJobs.length > 0
                ? targetJobs
                : (jobId
                    ? [{ id: jobId, name: `job ${jobId}`, status: 'unknown', conclusion: null }]
                    : jobs.jobs.slice(0, 1));
              const resolvedLogLines = logLines ?? 120;
              const logEntries = await Promise.all(jobsForLogs.map(async (job) => {
                try {
                  const text = await adapter.getWorkflowJobLogs(owner, repo, job.id);
                  const tail = tailLogText(text, resolvedLogLines);
                  return {
                    jobId: job.id,
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    ...tail,
                  };
                } catch (error) {
                  return {
                    jobId: job.id,
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }));
              data.logs = logEntries;
              const diagnostics = logEntries.flatMap((entry) => {
                if (!('text' in entry) || typeof entry.text !== 'string') {
                  return [];
                }
                return diagnoseWorkflowLog(entry.text).map((diagnostic) => ({
                  ...diagnostic,
                  jobId: entry.jobId,
                  jobName: entry.name,
                }));
              });
              if (diagnostics.length > 0) {
                data.diagnostics = diagnostics;
              }
              break;
            }
            case 'artifacts': {
              const artifacts = await adapter.listArtifacts(owner, repo, 100);
              data.artifacts = artifacts.artifacts.map((artifact) => ({
                id: artifact.id,
                name: artifact.name,
                expired: artifact.expired,
                createdAt: artifact.created_at,
                workflowRun: artifact.workflow_run
                  ? {
                    id: artifact.workflow_run.id,
                    headSha: artifact.workflow_run.head_sha,
                    headBranch: artifact.workflow_run.head_branch,
                  }
                  : null,
              }));
              break;
            }
            case 'pages': {
              const pages = await adapter.getPagesConfig(owner, repo);
              data.pages = pages
                ? {
                    enabled: true,
                    url: pages.url,
                    status: pages.status,
                    customDomain: pages.cname,
                    httpsEnforced: pages.https_enforced,
                    certificateState: pages.https_certificate?.state,
                  }
                : { enabled: false };
              break;
            }
            case 'branch-protection': {
              const branchName = branch ?? 'main';
              const protection = await adapter.getBranchProtection(owner, repo, branchName);
              data.branchProtection = protection
                ? {
                    branch: branchName,
                    protected: true,
                    requireReviews: !!protection.required_pull_request_reviews,
                    requiredReviewers: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
                    requireStatusChecks: !!protection.required_status_checks,
                    statusChecks: protection.required_status_checks?.contexts ?? [],
                    enforceAdmins: protection.enforce_admins?.enabled ?? false,
                  }
                : { branch: branchName, protected: false };
              break;
            }
          }
        } catch (error) {
          if (error instanceof HvError) throw error;
          data[section === 'branch-protection' ? 'branchProtection' : section] = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return commandSuccess(data);
    })
  );

  commands.register(
    'hv_ci_trigger',
    'Manually trigger a GitHub Actions workflow (requires a workflow_dispatch trigger in the workflow). For production promotion, trigger the deploy-<provider>-production.yml workflow on ref="main" and pass inputs.commit_sha when promoting a specific SHA that already passed staging.',
    {
      project: projectField,
      repo: repoField,
      workflow: z.string().describe('Workflow id or filename (e.g. "deploy.yml")'),
      ref: z.string().optional().describe('Git ref to run on (default "main")'),
      inputs: z.record(z.string()).optional().describe('Workflow inputs as key-value pairs'),
    },
    wrapCommandHandler(async ({ project: projectRef, repo: repoOverride, workflow, ref, inputs }) => {
      const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, repoOverride);
      const adapter = githubAdapterOrThrow({ owner, repo });

      await adapter.triggerWorkflow(owner, repo, workflow, ref ?? 'main', inputs);
      ctx.repos.audit.create({
        action: 'hv.ci_trigger',
        resourceType: 'github_workflow',
        resourceId: `${owner}/${repo}/${workflow}`,
        details: { workflow, ref: ref ?? 'main', inputs },
      });

      return commandSuccess(
        { repository: `${owner}/${repo}`, workflow, ref: ref ?? 'main' },
        { hint: 'Workflow dispatched. Check progress with hv_ci_status include=["runs"].', next: ['hv_ci_status'] }
      );
    })
  );
}
