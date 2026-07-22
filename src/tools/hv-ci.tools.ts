import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import type { ToolContext } from './context.js';
import { projectField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';
import { canonicalizeLegacyGitHubSpec, deepMergeSpec, SpecStore } from '../domain/spec/spec.store.js';
import { projectSpecSchema } from '../domain/spec/spec.schema.js';

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

function resolveRepoOrThrow(ctx: ToolContext, projectRef: string | undefined, repoOverride: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const slug = repoOverride?.trim() || parseGitHubRepoFromRemote(project.gitRemoteUrl);
  const parts = slug?.split('/') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/repo" (config.repo for hv_ci_setup), or set the project gitRemoteUrl to a GitHub remote.',
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

export function deprecatedCiSetupPatch(
  kind: 'deploy-branch' | 'ai-review' | 'branch-protection' | 'workflow',
  rawConfig: Record<string, unknown>,
  current: ReturnType<typeof projectSpecSchema.parse>
): Record<string, unknown> {
  const repository = typeof rawConfig.repo === 'string' ? rawConfig.repo : undefined;
  const githubBase = repository ? { repository } : {};
  if (kind === 'ai-review') {
    return { github: { ...githubBase, actions: { 'pr-review': { kind: 'pull-request-review' } } } };
  }
  if (kind === 'workflow') {
    const template = String(rawConfig.template ?? '');
    const templates: Record<string, Record<string, unknown>> = {
      'node-test': { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'], triggers: { pullRequest: true } },
      lint: { kind: 'check', category: 'lint', runtime: { kind: 'node' }, commands: ['npm run lint'], triggers: { pullRequest: true } },
      'python-test': { kind: 'check', category: 'test', runtime: { kind: 'python' }, commands: ['python -m pytest'], triggers: { pullRequest: true } },
    };
    const automation = templates[template];
    if (!automation) {
      throw new HvError('VALIDATION', `The deprecated workflow template "${template}" cannot be migrated.`, {
        hint: 'Declare a typed spec.github.actions check with category, runtime, commands, and triggers.',
      });
    }
    return { github: { ...githubBase, actions: { [template]: automation } } };
  }
  if (kind === 'branch-protection') {
    if (rawConfig.allowForcePushes === true || rawConfig.allowDeletions === true) {
      throw new HvError('VALIDATION', 'Hypervibe GitHub desired state does not enable force-pushes or protected-branch deletion.', {
        hint: 'Remove allowForcePushes/allowDeletions or manage that exceptional policy outside Hypervibe.',
      });
    }
    return {
      github: {
        ...githubBase,
        collaboration: {
          pullRequests: {
            targetBranch: rawConfig.branch,
            requirePr: true,
            requireReview: rawConfig.requireReviews ?? true,
            requiredReviewers: rawConfig.requiredReviewers ?? 1,
            dismissStaleReviews: rawConfig.dismissStaleReviews ?? false,
            requireCodeOwnerReviews: rawConfig.requireCodeOwnerReviews ?? false,
            requireStatusChecks: rawConfig.requireStatusChecks ?? false,
            statusChecks: rawConfig.statusChecks ?? [],
            strictStatusChecks: rawConfig.strictStatusChecks ?? true,
            enforceAdmins: rawConfig.enforceAdmins ?? false,
          },
        },
      },
    };
  }

  const provider = String(rawConfig.provider ?? '');
  const environments = Object.fromEntries(Object.entries(current.environments)
    .filter(([name, environment]) => /stag|prod/i.test(name) && environment.hosting.provider === provider)
    .map(([name, environment]) => [name, {
      deploy: {
        ...environment.deploy,
        strategy: 'branch',
        trigger: 'ci',
        branch: environment.deploy?.branch ?? 'main',
      },
    }]));
  if (Object.keys(environments).length === 0) {
    throw new HvError('NOT_FOUND', `No staging/production environments use provider "${provider}".`, {
      hint: 'Update the desired environment deploy fields directly with hv_spec_set.',
    });
  }
  return {
    github: {
      ...githubBase,
      ...(rawConfig.protectBranches === true ? {
        collaboration: {
          pullRequests: {
            requirePr: true,
            requireReview: true,
            requiredReviewers: rawConfig.requiredReviewers ?? 1,
            requireStatusChecks: Array.isArray(rawConfig.statusChecks) && rawConfig.statusChecks.length > 0,
            statusChecks: rawConfig.statusChecks ?? [],
          },
        },
      } : {}),
    },
    environments,
  };
}

export function registerHvCiTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_ci_setup',
    'Deprecated one-release compatibility bridge. Converts old setup requests into spec.github desired state and returns the revision to plan; it never mutates GitHub. Prefer hv_spec_set followed by hv_plan/hv_apply. deploy-branch maps environment deploy state; ai-review maps to an OpenAI pull-request-review and ignores legacy raw apiKey input; branch-protection maps github.collaboration; workflow maps known templates to typed checks.',
    {
      project: projectField,
      kind: z.enum(['deploy-branch', 'ai-review', 'branch-protection', 'workflow']).describe('What to set up'),
      config: z.record(z.unknown()).optional().describe('Kind-specific configuration (see tool description)'),
    },
    wrapHandler(async ({ project: projectRef, kind, config }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specStore = new SpecStore();
      const stored = specStore.get(project);
      if (!stored) {
        throw new HvError('NOT_FOUND', `Project "${project.name}" has no spec.`, {
          hint: 'Create desired state with hv_spec_set first.',
        });
      }
      const canonicalCurrent = projectSpecSchema.parse(canonicalizeLegacyGitHubSpec(stored.spec));
      const patch = deprecatedCiSetupPatch(kind, (config ?? {}) as Record<string, unknown>, canonicalCurrent);
      const next = projectSpecSchema.parse(deepMergeSpec(canonicalCurrent, patch));
      const result = specStore.replace(project, next);
      ctx.repos.audit.create({
        action: 'hv.ci_setup.deprecated_bridge',
        resourceType: 'project_spec',
        resourceId: project.id,
        details: { kind, revision: result.revision },
      });
      const bridgeResult = toolSuccess({
        project: project.name,
        revision: result.revision,
        spec: result.spec,
        deprecated: true,
      }, {
        warnings: [
          'hv_ci_setup is deprecated. The request was saved as desired state only; GitHub was not mutated.',
          ...(kind === 'ai-review' && typeof (config as Record<string, unknown> | undefined)?.apiKey === 'string'
            ? ['The legacy apiKey input was ignored and not stored. Connect OpenAI with hv_connect provider="openai" credentialsRef="env:OPENAI_API_KEY".']
            : []),
        ],
        hint: 'Run hv_plan for the canonical environment, review the infrastructure-PR action, then run hv_apply with that planId.',
        next: ['hv_plan'],
      });
      return bridgeResult;
    })
  );

  server.tool(
    'hv_ci_status',
    'Authoritative inspection path for Hypervibe-managed GitHub Actions deploys. Use this before gh, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls. Returns workflows, recent runs, run jobs/steps, bounded job log tails, GitHub Pages status, and branch protection rules through Hypervibe\'s stored GitHub connection. For deploy.strategy="branch" with trigger="ci", use it to check push-deploy workflow runs and diagnose failed job logs.',
    {
      project: projectField,
      repo: repoField,
      include: z.array(z.enum(['workflows', 'runs', 'jobs', 'logs', 'pages', 'branch-protection'])).optional().describe('Sections to include (default: ["workflows"]). jobs/logs require runId. logs returns a bounded tail, not a full archive.'),
      workflow: z.string().optional().describe('Workflow id or filename (required when include contains "runs")'),
      runId: numericIdField.optional().describe('GitHub Actions run id, required when include contains "jobs" or "logs".'),
      jobId: numericIdField.optional().describe('Optional GitHub Actions job id for include=["logs"]. Defaults to failed jobs for the run, or the first job if none failed.'),
      logLines: z.number().int().positive().max(500).optional().describe('Number of log lines to return per job for include=["logs"] (default 120, max 500).'),
      branch: z.string().optional().describe('Branch for branch-protection (default "main")'),
    },
    wrapHandler(async ({ project: projectRef, repo: repoOverride, include, workflow, runId, jobId, logLines, branch }) => {
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

      return toolSuccess(data);
    })
  );

  server.tool(
    'hv_ci_trigger',
    'Manually trigger a GitHub Actions workflow (requires a workflow_dispatch trigger in the workflow). For production promotion, trigger the deploy-<provider>-production.yml workflow on ref="main" and pass inputs.commit_sha when promoting a specific SHA that already passed staging.',
    {
      project: projectField,
      repo: repoField,
      workflow: z.string().describe('Workflow id or filename (e.g. "deploy.yml")'),
      ref: z.string().optional().describe('Git ref to run on (default "main")'),
      inputs: z.record(z.string()).optional().describe('Workflow inputs as key-value pairs'),
    },
    wrapHandler(async ({ project: projectRef, repo: repoOverride, workflow, ref, inputs }) => {
      const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, repoOverride);
      const adapter = githubAdapterOrThrow({ owner, repo });

      await adapter.triggerWorkflow(owner, repo, workflow, ref ?? 'main', inputs);
      ctx.repos.audit.create({
        action: 'hv.ci_trigger',
        resourceType: 'github_workflow',
        resourceId: `${owner}/${repo}/${workflow}`,
        details: { workflow, ref: ref ?? 'main', inputs },
      });

      return toolSuccess(
        { repository: `${owner}/${repo}`, workflow, ref: ref ?? 'main' },
        { hint: 'Workflow dispatched. Check progress with hv_ci_status include=["runs"].', next: ['hv_ci_status'] }
      );
    })
  );
}
