import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import {
  getGitHubAdapter,
  resolveBranchDeployTargets,
  buildBranchDeployWorkflow,
  WORKFLOW_TEMPLATES,
  GITHUB_PAGES_IPS,
  isApexDomain,
  getApexDomain,
  AI_REVIEW_WORKFLOW_PATH,
  AI_REVIEW_DEFAULT_MODEL,
  buildAiReviewWorkflowContent,
} from '../domain/services/github-ops.service.js';
import {
  githubCiDeployPermissionProblem,
  missingProviderSecretsMessage,
  providerSecretsForGitHubActions,
  requiredProviderSecretNamesForGitHubActions,
} from '../domain/services/ci-deploy.service.js';
import { getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import type { ToolContext } from './context.js';
import { projectField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

const repoField = z
  .string()
  .optional()
  .describe('GitHub repository as "owner/repo". Defaults from the project gitRemoteUrl.');

const statusChecksField = z.preprocess(
  (value) => value === false ? undefined : value,
  z.array(z.string()).optional()
);

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
      hint: formatConnectionGuidance('github', { scope: `${owner}/${repo}` }),
    });
  }
  return result.adapter;
}

function parseKindConfig<T extends z.ZodTypeAny>(schema: T, config: unknown, kind: string): z.infer<T> {
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new HvError('VALIDATION', `Invalid config for kind "${kind}".`, {
      details: parsed.error.flatten().fieldErrors,
      hint: 'See the hv_ci_setup description for the fields each kind expects.',
    });
  }
  return parsed.data;
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

function diagnoseWorkflowLog(text: string): Array<{
  code: string;
  severity: 'error' | 'warning';
  summary: string;
  evidence: string;
  next: string[];
}> {
  const diagnostics: Array<{
    code: string;
    severity: 'error' | 'warning';
    summary: string;
    evidence: string;
    next: string[];
  }> = [];

  if (
    /docker buildx imagetools inspect/i.test(text)
    && /ghcr\.io/i.test(text)
    && /403 Forbidden/i.test(text)
  ) {
    diagnostics.push({
      code: 'GHCR_IMAGE_PULL_FORBIDDEN',
      severity: 'error',
      summary: 'The workflow pushed the image, but IMAGE_REGISTRY_USERNAME/IMAGE_REGISTRY_TOKEN cannot read it back from GHCR. Railway is not called until this check passes, so Railway will show no new deploy attempt.',
      evidence: 'docker buildx imagetools inspect returned 403 Forbidden for the GHCR image.',
      next: [
        'Confirm IMAGE_REGISTRY_USERNAME is the GitHub login that owns the package-read token.',
        'Set IMAGE_REGISTRY_TOKEN from a classic GitHub PAT with read:packages, and repo when the repo/package is private.',
        'Use hv_secrets_set target="github" key="IMAGE_REGISTRY_TOKEN" secretRef="dotenv:/absolute/path/.env#GHCR_TOKEN" to update the GitHub Actions secret without pasting the token into chat.',
        'Re-run the workflow with hv_ci_trigger, then inspect logs with hv_ci_status include=["logs"].',
      ],
    });
  }

  return diagnostics;
}

const deployBranchConfigSchema = z.object({
  repo: z.string().optional(),
  provider: z.enum(['railway', 'vercel', 'render', 'digitalocean', 'cloudrun', 'apprunner', 'heroku']),
  protectBranches: z.boolean().optional(),
  statusChecks: statusChecksField,
  requiredReviewers: z.number().optional(),
});

const aiReviewConfigSchema = z.object({
  repo: z.string().optional(),
  apiKey: z.string(),
  model: z.string().optional(),
});

const pagesConfigSchema = z.object({
  repo: z.string().optional(),
  domain: z.string(),
});

const branchProtectionConfigSchema = z.object({
  repo: z.string().optional(),
  branch: z.string(),
  requireReviews: z.boolean().optional(),
  requiredReviewers: z.number().optional(),
  dismissStaleReviews: z.boolean().optional(),
  requireCodeOwnerReviews: z.boolean().optional(),
  requireStatusChecks: z.boolean().optional(),
  statusChecks: statusChecksField,
  strictStatusChecks: z.boolean().optional(),
  enforceAdmins: z.boolean().optional(),
  requireLinearHistory: z.boolean().optional(),
  allowForcePushes: z.boolean().optional(),
  allowDeletions: z.boolean().optional(),
});

const workflowConfigSchema = z.object({
  repo: z.string().optional(),
  template: z.string(),
});

export function registerHvCiTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_ci_setup',
    'Set up explicit CI/CD tasks on GitHub for a project. For desired-state push deploys, prefer hv_spec_set deploy.strategy="branch" trigger="ci", then hv_plan/hv_apply; that manages the deploy workflow and provider API secrets as infrastructure. Dispatches on kind; config holds the kind-specific fields (config.repo="owner/repo" overrides the project gitRemoteUrl for every kind). ' +
      'kind="deploy-branch": explicit/backfill branch-based GitHub Actions deploy workflows from the project environments using provider APIs (no provider CLIs). Requires a GitHub apiToken that can write workflow files and repo secrets (classic PAT scopes repo + workflow for private repos); Railway/DigitalOcean image deploys also require packageReadToken with read:packages for GHCR pull credentials. config { provider (railway|vercel|render|digitalocean|cloudrun|apprunner|heroku, required), protectBranches?, statusChecks?, requiredReviewers? }. ' +
      'kind="ai-review": Claude PR review workflow; config { apiKey (required), model? }. ' +
      'kind="pages": GitHub Pages with a custom domain via Cloudflare DNS; config { domain (required) }. ' +
      'kind="branch-protection": protection rules; config { branch (required), requireReviews?, requiredReviewers?, dismissStaleReviews?, requireCodeOwnerReviews?, requireStatusChecks?, statusChecks?, strictStatusChecks?, enforceAdmins?, requireLinearHistory?, allowForcePushes?, allowDeletions? }. ' +
      'kind="workflow": a workflow from a template; config { template (required, e.g. node-test, lint, deploy-railway) }.',
    {
      project: projectField,
      kind: z.enum(['deploy-branch', 'ai-review', 'pages', 'branch-protection', 'workflow']).describe('What to set up'),
      config: z.record(z.unknown()).optional().describe('Kind-specific configuration (see tool description)'),
    },
    wrapHandler(async ({ project: projectRef, kind, config }) => {
      switch (kind) {
        case 'deploy-branch': {
          const cfg = parseKindConfig(deployBranchConfigSchema, config, kind);
          const { project, owner, repo } = resolveRepoOrThrow(ctx, projectRef, cfg.repo);
          const adapter = githubAdapterOrThrow({ owner, repo });

          const verification = await adapter.verify();
          if (!verification.success) {
            return toolError('PROVIDER_ERROR', verification.error || 'GitHub connection verification failed');
          }
          const permissionProblem = githubCiDeployPermissionProblem(verification, { repo: `${owner}/${repo}` });
          if (permissionProblem) {
            return toolError('MISSING_CONNECTION', 'GitHub connection is missing CI deploy permissions.', {
              details: {
                repository: `${owner}/${repo}`,
                missingScopes: permissionProblem.missingScopes,
                currentScopes: verification.scopes,
              },
              hint: permissionProblem.hint,
              next: ['hv_connect', 'hv_ci_setup'],
            });
          }

          const { targets, migration, skippedEnvironments } = resolveBranchDeployTargets(project);
          if (targets.length === 0) {
            return toolError('NOT_FOUND', `Project "${project.name}" has no deployable staging/production environments for branch setup.`, {
              details: { skippedEnvironments },
            });
          }

          const workflows = targets.map((target) => buildBranchDeployWorkflow(cfg.provider, target, migration));
          const created: Array<{ template: string; branch: string; path: string; created: boolean; updated: boolean }> = [];
          const errors: Array<{ template: string; path: string; error: string }> = [];
          for (const workflow of workflows) {
            try {
              const fileResult = await adapter.createOrUpdateFile(owner, repo, workflow.path, workflow.content, `Add ${workflow.templateName} workflow`);
              created.push({ template: workflow.template, branch: workflow.branch, path: workflow.path, created: fileResult.created, updated: fileResult.updated });
            } catch (error) {
              errors.push({ template: workflow.template, path: workflow.path, error: error instanceof Error ? error.message : String(error) });
            }
          }

          const requiredSecrets = Array.from(new Set(workflows.flatMap((workflow) => workflow.requiredSecrets)));
          const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(cfg.provider)
            .filter((name) => requiredSecrets.includes(name));
          const syncedSecrets: string[] = [];
          const secretSyncErrors: Array<{ name: string; error: string }> = [];
          for (const secret of providerSecretsForGitHubActions(cfg.provider, {
            githubLogin: verification.login,
            githubRepo: `${owner}/${repo}`,
          })) {
            if (!requiredSecrets.includes(secret.name)) {
              continue;
            }
            try {
              await adapter.setRepositorySecret(owner, repo, secret.name, secret.value);
              syncedSecrets.push(secret.name);
            } catch (error) {
              secretSyncErrors.push({
                name: secret.name,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          const missingProviderSecrets = requiredProviderSecrets.filter((name) => !syncedSecrets.includes(name));

          const protectedBranches = Array.from(new Set(targets.map((target) => target.branch)));
          const protectionResults: Array<{ branch: string; success: boolean; error?: string }> = [];
          if (cfg.protectBranches && errors.length === 0) {
            const rules = {
              requireReviews: true,
              requiredReviewers: cfg.requiredReviewers ?? 1,
              dismissStaleReviews: true,
              requireCodeOwnerReviews: false,
              requireStatusChecks: (cfg.statusChecks?.length ?? 0) > 0,
              statusChecks: cfg.statusChecks ?? [],
              strictStatusChecks: true,
              enforceAdmins: true,
              requireLinearHistory: false,
              allowForcePushes: false,
              allowDeletions: false,
            };
            for (const branch of protectedBranches) {
              try {
                await adapter.updateBranchProtection(owner, repo, branch, rules);
                protectionResults.push({ branch, success: true });
              } catch (error) {
                protectionResults.push({ branch, success: false, error: error instanceof Error ? error.message : String(error) });
              }
            }
          }

          ctx.repos.audit.create({
            action: 'hv.ci_setup',
            resourceType: 'github_workflow',
            resourceId: `${owner}/${repo}/branch-deploy/${cfg.provider}`,
            details: { kind, project: project.name, provider: cfg.provider, workflows: created, errors, branchProtection: protectionResults },
          });

          const data = {
            repository: `${owner}/${repo}`,
            provider: cfg.provider,
            branchMapping: Object.fromEntries(targets.map((target) => [target.kind, target.branch])),
            workflows: created,
            errors: errors.length > 0 ? errors : undefined,
            branchProtection: cfg.protectBranches ? protectionResults : undefined,
            requiredSecrets,
            requiredVariables: Array.from(new Set(workflows.flatMap((workflow) => workflow.requiredVariables))),
            syncedSecrets: syncedSecrets.length > 0 ? syncedSecrets : undefined,
            manualSecrets: requiredSecrets.filter((name) => !syncedSecrets.includes(name)),
            missingProviderSecrets: missingProviderSecrets.length > 0 ? missingProviderSecrets : undefined,
            secretSyncErrors: secretSyncErrors.length > 0 ? secretSyncErrors : undefined,
            skippedEnvironments: skippedEnvironments.length > 0 ? skippedEnvironments : undefined,
          };
          const protectionFailures = protectionResults.filter((r) => !r.success);
          if (errors.length > 0 || protectionFailures.length > 0) {
            return toolError('PROVIDER_ERROR', 'Branch deploy setup had errors.', {
              details: data,
              hint: formatConnectionGuidance('github', {
                scope: `${owner}/${repo}`,
                intro: 'If GitHub rejected workflow or secret changes, confirm the GitHub token type and CI deploy permissions.',
              }),
            });
          }
          const warnings = [
            ...secretSyncErrors.map((entry) => `Failed to sync GitHub Actions secret ${entry.name}: ${entry.error}`),
            ...(missingProviderSecrets.length > 0
              ? [missingProviderSecretsMessage(cfg.provider, missingProviderSecrets)]
              : []),
          ];
          return toolSuccess(data, {
            warnings: warnings.length > 0 ? warnings : undefined,
            hint: `Set the manual secrets (${data.manualSecrets.join(', ') || 'none'})${data.requiredVariables.length > 0 ? ` and variables (${data.requiredVariables.join(', ')})` : ''} in the GitHub repository, then pushes to the mapped branches will deploy.`,
          });
        }
        case 'ai-review': {
          const cfg = parseKindConfig(aiReviewConfigSchema, config, kind);
          const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, cfg.repo);
          const adapter = githubAdapterOrThrow({ owner, repo });

          const model = cfg.model ?? AI_REVIEW_DEFAULT_MODEL;
          const fileResult = await adapter.createOrUpdateFile(owner, repo, AI_REVIEW_WORKFLOW_PATH, buildAiReviewWorkflowContent(model), 'Add AI code review workflow');
          let secretError: string | undefined;
          try {
            await adapter.setRepositorySecret(owner, repo, 'ANTHROPIC_API_KEY', cfg.apiKey);
          } catch (error) {
            secretError = error instanceof Error ? error.message : String(error);
          }

          ctx.repos.audit.create({
            action: 'hv.ci_setup',
            resourceType: 'github_workflow',
            resourceId: `${owner}/${repo}`,
            details: { kind, model, workflowCreated: fileResult.created, workflowUpdated: fileResult.updated, secretSet: !secretError },
          });

          return toolSuccess(
            {
              repository: `${owner}/${repo}`,
              workflow: { path: AI_REVIEW_WORKFLOW_PATH, created: fileResult.created, updated: fileResult.updated },
              secret: { name: 'ANTHROPIC_API_KEY', set: !secretError },
              model,
            },
            {
              warnings: secretError ? [`Failed to set ANTHROPIC_API_KEY secret: ${secretError}. Set it manually in repo Settings > Secrets.`] : undefined,
              hint: `PRs will be reviewed by Claude (${model}).`,
            }
          );
        }
        case 'pages': {
          const cfg = parseKindConfig(pagesConfigSchema, config, kind);
          const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, cfg.repo);
          const adapter = githubAdapterOrThrow({ owner, repo });
          const domain = cfg.domain.trim().toLowerCase();
          const apex = getApexDomain(domain);

          const cfResult = getCloudflareAdapter(apex);
          if ('error' in cfResult) {
            return toolError('MISSING_CONNECTION', cfResult.error, {
              hint: formatConnectionGuidance('cloudflare', { scope: apex }),
            });
          }

          let pages = await adapter.getPagesConfig(owner, repo);
          let pagesWasEnabled = false;
          if (!pages) {
            pages = await adapter.enablePages(owner, repo, { branch: 'main', path: '/docs' });
            pagesWasEnabled = true;
          }

          const zone = await cfResult.adapter.findZoneByName(apex);
          if (!zone) {
            return toolError('NOT_FOUND', `Cloudflare zone "${apex}" not found.`, {
              hint: `Add the domain to Cloudflare or create a scoped connection for it. ${formatConnectionGuidance('cloudflare', { scope: apex })}`,
            });
          }

          const dnsRecords: Array<Record<string, unknown>> = [];
          if (isApexDomain(domain)) {
            const ensured = await cfResult.adapter.ensureRecords(zone.id, domain, 'A', GITHUB_PAGES_IPS, { proxied: false });
            dnsRecords.push({ name: domain, type: 'A', created: ensured.created, unchanged: ensured.unchanged });
            const www = await cfResult.adapter.upsertDnsRecord(zone.id, `www.${domain}`, 'CNAME', `${owner}.github.io`, { proxied: false });
            dnsRecords.push({ name: `www.${domain}`, type: 'CNAME', action: www.action });
          } else {
            const record = await cfResult.adapter.upsertDnsRecord(zone.id, domain, 'CNAME', `${owner}.github.io`, { proxied: false });
            dnsRecords.push({ name: domain, type: 'CNAME', action: record.action });
          }

          const warnings: string[] = [];
          try {
            await adapter.setCustomDomain(owner, repo, domain);
          } catch (error) {
            warnings.push(`Failed to set custom domain on GitHub: ${error instanceof Error ? error.message : String(error)}`);
          }
          try {
            await adapter.ensureCnameFile(owner, repo, domain, pages.source?.path || '/docs');
          } catch (error) {
            warnings.push(`Failed to ensure CNAME file: ${error instanceof Error ? error.message : String(error)}`);
          }
          try {
            await adapter.requestPagesBuild(owner, repo);
          } catch {
            // Build request is best-effort.
          }

          ctx.repos.audit.create({
            action: 'hv.ci_setup',
            resourceType: 'github_pages',
            resourceId: `${owner}/${repo}`,
            details: { kind, domain, pagesWasEnabled, dnsRecords, warnings },
          });

          return toolSuccess(
            { repository: `${owner}/${repo}`, domain, pagesWasEnabled, zone: { id: zone.id, name: zone.name }, dnsRecords },
            {
              warnings,
              hint: 'DNS is configured. GitHub provisions the HTTPS certificate asynchronously (can take a while) — check progress with hv_ci_status include=["pages"], then enforce HTTPS once issued.',
            }
          );
        }
        case 'branch-protection': {
          const cfg = parseKindConfig(branchProtectionConfigSchema, config, kind);
          const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, cfg.repo);
          const adapter = githubAdapterOrThrow({ owner, repo });

          const { repo: _repoOverride, branch, ...rules } = cfg;
          await adapter.updateBranchProtection(owner, repo, branch, rules);
          ctx.repos.audit.create({
            action: 'hv.ci_setup',
            resourceType: 'github_branch',
            resourceId: `${owner}/${repo}/${branch}`,
            details: { kind, branch, rules },
          });
          return toolSuccess({ repository: `${owner}/${repo}`, branch, appliedRules: rules });
        }
        case 'workflow': {
          const cfg = parseKindConfig(workflowConfigSchema, config, kind);
          const { owner, repo } = resolveRepoOrThrow(ctx, projectRef, cfg.repo);
          const adapter = githubAdapterOrThrow({ owner, repo });

          const template = WORKFLOW_TEMPLATES[cfg.template];
          if (!template) {
            throw new HvError('VALIDATION', `Unknown template: ${cfg.template}.`, {
              hint: `Available templates: ${Object.keys(WORKFLOW_TEMPLATES).join(', ')}.`,
            });
          }
          const workflowPath = `.github/workflows/${template.filename}`;
          const fileResult = await adapter.createOrUpdateFile(owner, repo, workflowPath, template.content, `Add ${template.name} workflow`);
          ctx.repos.audit.create({
            action: 'hv.ci_setup',
            resourceType: 'github_workflow',
            resourceId: `${owner}/${repo}/${workflowPath}`,
            details: { kind, template: cfg.template, path: workflowPath, created: fileResult.created, updated: fileResult.updated },
          });
          return toolSuccess({
            repository: `${owner}/${repo}`,
            template: cfg.template,
            path: workflowPath,
            created: fileResult.created,
            updated: fileResult.updated,
            requiredSecrets: template.requiredSecrets ?? [],
            requiredVariables: template.requiredVariables ?? [],
          });
        }
      }
    })
  );

  server.tool(
    'hv_ci_status',
    'Get GitHub Actions status for a project repository: workflows, recent runs for a workflow, run jobs/steps, bounded job log tails, GitHub Pages status, and branch protection rules. For deploy.strategy="branch" with trigger="ci", use this to check push-deploy workflow runs and inspect failed job logs through Hypervibe\'s stored GitHub connection.',
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
    'Manually trigger a GitHub Actions workflow (requires a workflow_dispatch trigger in the workflow).',
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
