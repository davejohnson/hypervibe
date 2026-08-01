import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema, type IosSpec } from '../spec/spec.schema.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
  BranchDeployWorkflow,
} from '../ports/ci-deploy.port.js';

const connectionRepo = new ConnectionRepository();
const envRepo = new EnvironmentRepository();
const projectSpecRepo = new ProjectSpecRepository();

// GitHub Pages IP addresses for A records (apex domain)
export const GITHUB_PAGES_IPS = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];

/**
 * Get a GitHub adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., "owner/repo" or "owner/*") for finding scoped tokens
 */
export function getGitHubAdapter(scopeHint?: string): { adapter: GitHubAdapter } | { error: string } {
  const connection = connectionRepo.findBestVerifiedMatch('github', scopeHint);
  if (!connection) {
    return { error: `No verified GitHub connection found. ${formatConnectionGuidance('github', { scope: scopeHint })}` };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<GitHubCredentials>(connection.credentialsEncrypted);
  const adapter = new GitHubAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export function isApexDomain(domain: string): boolean {
  // Simple check: apex domain has only one dot (e.g., example.com)
  // Subdomain has multiple dots (e.g., www.example.com, blog.example.com)
  const parts = domain.split('.');
  return parts.length === 2;
}

export function getApexDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) {
    return domain;
  }
  // Return last two parts for apex domain
  return parts.slice(-2).join('.');
}

export type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
  BranchDeployWorkflow,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function classifyEnvironmentName(name: string): BranchDeployEnvironmentKind | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === 'local') return null;
  if (normalized === 'production' || normalized === 'prod' || normalized.includes('prod')) return 'production';
  if (normalized === 'staging' || normalized === 'stage' || normalized.includes('stag')) return 'staging';
  if (normalized === 'development' || normalized === 'dev' || normalized.includes('develop')) return 'development';
  if (normalized === 'test' || normalized.includes('test')) return 'test';
  return 'custom';
}

function environmentBindings(projectId: string, environmentName: string, desiredServiceNames?: Set<string>): {
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerJobNames: string[];
  boundServiceNames: string[];
} {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds: string[] = [];
  const providerJobNames: string[] = [];
  for (const [serviceName, service] of Object.entries(services ?? {})) {
    if (desiredServiceNames && !desiredServiceNames.has(serviceName)) continue;
    const record = asRecord(service);
    const serviceId = typeof record?.serviceId === 'string' && record.serviceId.trim().length > 0
      ? record.serviceId.trim()
      : undefined;
    const jobName = typeof record?.jobName === 'string' && record.jobName.trim().length > 0
      ? record.jobName.trim()
      : undefined;
    const isScheduledJob = record?.resourceType === 'scheduledJob' || Boolean(jobName);
    if (isScheduledJob) {
      const target = jobName ?? serviceId;
      if (target) providerJobNames.push(target);
    } else if (serviceId) {
      providerServiceIds.push(serviceId);
    }
  }
  return {
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    providerServiceIds,
    providerJobNames,
    boundServiceNames,
  };
}

function legacyServiceNames(desiredState: Record<string, unknown> | null): string[] {
  const names = new Set<string>();
  const services = Array.isArray(desiredState?.services) ? desiredState.services : [];
  for (const service of services) {
    if (typeof service === 'string' && service.trim().length > 0) {
      names.add(service.trim());
    }
  }
  if (typeof desiredState?.serviceName === 'string' && desiredState.serviceName.trim().length > 0) {
    names.add(desiredState.serviceName.trim());
  }
  const serviceConfig = asRecord(desiredState?.serviceConfig);
  for (const serviceName of Object.keys(serviceConfig ?? {})) {
    if (serviceName.trim().length > 0) {
      names.add(serviceName.trim());
    }
  }
  return Array.from(names);
}

export function resolveBranchDeployTargets(project: Project): {
  targets: BranchDeployTarget[];
  desiredBranches: Record<string, string | undefined>;
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  const specRow = projectSpecRepo.findLatest(project.id);
  const parsedSpec = specRow ? projectSpecSchema.safeParse(specRow.document) : null;
  if (parsedSpec?.success) {
    const targetsByEnvironment = new Map<string, BranchDeployTarget>();
    const skippedEnvironments: string[] = [];
    const desiredBranches: Record<string, string | undefined> = {};
    let migration: { includeStep: boolean; command?: string; note?: string } = { includeStep: false };

    for (const [environmentName, envSpec] of Object.entries(parsedSpec.data.environments)) {
      const kind = classifyEnvironmentName(environmentName);
      if (!kind) {
        skippedEnvironments.push(environmentName);
        continue;
      }
      if (envSpec.deploy?.strategy !== 'branch') {
        skippedEnvironments.push(environmentName);
        continue;
      }
      if (envSpec.deploy.trigger === 'native') {
        skippedEnvironments.push(environmentName);
        continue;
      }
      const branch = envSpec.deploy.branch ?? 'main';
      const autoDeployOnPush = envSpec.deploy.autoDeploy ?? kind !== 'production';
      desiredBranches[environmentName] = branch;
      const serviceNames = Object.keys(envSpec.services);
      const bindings = environmentBindings(project.id, environmentName, new Set(serviceNames));
      const runtimeServiceNames = Object.entries(envSpec.services)
        .filter(([, service]) => service.workloadKind !== 'cron')
        .map(([name]) => name);
      const jobServiceNames = Object.entries(envSpec.services)
        .filter(([, service]) => service.workloadKind === 'cron')
        .map(([name]) => name);
      const webService = Object.values(envSpec.services).find((service) => service.workloadKind === 'web');
      targetsByEnvironment.set(environmentName, {
        environmentName,
        kind,
        branch,
        autoDeployOnPush,
        ...(kind === 'production' && !autoDeployOnPush
          ? { promoteFromEnvironment: envSpec.deploy.promoteFrom ?? 'staging' }
          : {}),
        serviceNames: serviceNames.length > 0 ? serviceNames : bindings.boundServiceNames,
        providerProjectId: bindings.providerProjectId,
        providerEnvironmentId: bindings.providerEnvironmentId,
        providerServiceIds: bindings.providerServiceIds,
        providerJobNames: bindings.providerJobNames,
        needsServiceNames: runtimeServiceNames.length > 0 || (serviceNames.length === 0 && bindings.providerServiceIds.length > 0),
        needsJobNames: jobServiceNames.length > 0 || (serviceNames.length === 0 && bindings.providerJobNames.length > 0),
        webStartCommand: webService?.startCommand,
      });

      if (!migration.includeStep && envSpec.migrations?.mode === 'tool' && envSpec.migrations.runInDeploy !== false && envSpec.migrations.command) {
        migration = { includeStep: true, command: envSpec.migrations.command };
      } else if (!migration.note && envSpec.migrations?.mode === 'releaseCommand') {
        migration = {
          includeStep: false,
          note: 'Project uses release-command migrations; branch workflows will not run migrations in GitHub Actions.',
        };
      }
    }

    const order: BranchDeployEnvironmentKind[] = ['development', 'test', 'staging', 'production', 'custom'];
    const targets = Array.from(targetsByEnvironment.values()).sort((a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind)
      || a.environmentName.localeCompare(b.environmentName)
    );

    return { targets, desiredBranches, migration, skippedEnvironments };
  }

  const desiredState = asRecord(project.policies?.desiredState);
  const desiredServiceNames = legacyServiceNames(desiredState);
  const desiredDeploy = asRecord(desiredState?.deploy);
  const desiredBranchesRecord = asRecord(desiredDeploy?.branches);
  const desiredBranches = {
    staging:
      typeof desiredBranchesRecord?.staging === 'string' && desiredBranchesRecord.staging.trim().length > 0
        ? desiredBranchesRecord.staging.trim()
        : undefined,
    production:
      typeof desiredBranchesRecord?.production === 'string' && desiredBranchesRecord.production.trim().length > 0
        ? desiredBranchesRecord.production.trim()
        : undefined,
  };

  const desiredEnvironmentName =
    typeof desiredState?.environmentName === 'string' && desiredState.environmentName.trim().length > 0
      ? desiredState.environmentName.trim()
      : undefined;

  const migrations = asRecord(desiredState?.migrations);
  const migrationMode = typeof migrations?.mode === 'string' ? migrations.mode : undefined;
  const migrationCommand =
    typeof migrations?.command === 'string' && migrations.command.trim().length > 0
      ? migrations.command.trim()
      : undefined;
  const includeMigrationStep =
    migrationMode === 'tool' && migrations?.runInDeploy !== false && Boolean(migrationCommand);

  const candidateEnvironmentNames = Array.from(
    new Set(
      [
        ...envRepo.findByProjectId(project.id).map((environment) => environment.name),
        desiredEnvironmentName,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  );

  const targetsByKind = new Map<BranchDeployEnvironmentKind, BranchDeployTarget>();
  const skippedEnvironments: string[] = [];

  for (const environmentName of candidateEnvironmentNames) {
    const kind = classifyEnvironmentName(environmentName);
    if (!kind) {
      skippedEnvironments.push(environmentName);
      continue;
    }
    if (targetsByKind.has(kind)) {
      skippedEnvironments.push(environmentName);
      continue;
    }

    const bindings = environmentBindings(project.id, environmentName);
    targetsByKind.set(kind, {
      environmentName,
      kind,
      branch: kind === 'production'
        ? desiredBranches.production ?? 'main'
        : desiredBranches.staging ?? 'main',
      autoDeployOnPush: kind !== 'production',
      ...(kind === 'production' ? { promoteFromEnvironment: 'staging' } : {}),
      serviceNames: desiredServiceNames.length > 0 ? desiredServiceNames : bindings.boundServiceNames,
      providerProjectId: bindings.providerProjectId,
      providerEnvironmentId: bindings.providerEnvironmentId,
      providerServiceIds: bindings.providerServiceIds,
      providerJobNames: bindings.providerJobNames,
      needsServiceNames: true,
      needsJobNames: bindings.providerJobNames.length > 0,
    });
  }

  const targets = Array.from(targetsByKind.values()).sort((a, b) => {
    if (a.kind === b.kind) return a.environmentName.localeCompare(b.environmentName);
    return a.kind === 'staging' ? -1 : 1;
  });

  return {
    targets,
    desiredBranches,
    migration: {
      includeStep: includeMigrationStep,
      command: migrationCommand,
      note:
        migrationMode === 'releaseCommand'
          ? 'Project uses release-command migrations; branch workflows will not run migrations in GitHub Actions.'
          : undefined,
    },
    skippedEnvironments,
  };
}

function buildMigrationStep(command: string): string {
  // Migrations run app tooling (prisma, node scripts), so the runner needs
  // dependencies installed — the deploy steps that follow build a container
  // image and never run npm ci on the runner themselves.
  return `      - uses: actions/setup-node@v4
        if: steps.deploy.outputs.operation != 'rollback'
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install dependencies for migrations
        if: steps.deploy.outputs.operation != 'rollback'
        run: npm ci
      - name: Run migrations
        if: steps.deploy.outputs.operation != 'rollback'
        run: ${command}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`;
}

function buildProviderDeploySteps(provider: BranchDeployProvider, target: BranchDeployTarget) {
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;
  if (!ci) {
    throw new Error(`GitHub Actions branch deploys are not supported for provider "${provider}".`);
  }
  return ci.buildGitHubActionsSteps(target);
}

function buildWorkflowTrigger(target: BranchDeployTarget): string {
  const dispatch = `  workflow_dispatch:
    inputs:
      commit_sha:
        description: 'Commit SHA to deploy. Defaults to the selected ref when omitted.'
        required: false
        type: string
      rollback:
        description: 'Restore a previously verified release. Hypervibe sets this automatically.'
        required: false
        default: false
        type: boolean
      expected_latest_run_id:
        description: 'Latest observed deploy run. Hypervibe uses it to reject stale rollback dispatches.'
        required: false
        type: string
      source_artifact_id:
        description: 'Verified release artifact selected by Hypervibe for rollback.'
        required: false
        type: string
      source_workflow_run_id:
        description: 'Successful workflow run that emitted the verified rollback artifact.'
        required: false
        type: string`;
  if (!target.autoDeployOnPush) {
    return dispatch;
  }
  return `  push:
    branches: [${target.branch}]
${dispatch}`;
}

function buildDeploymentContractStep(environmentName: string): string {
  return `      - name: "Deployment safety gate: verify Hypervibe reconciliation"
        uses: actions/github-script@v8
        env:
          HYPERVIBE_ENVIRONMENT: ${JSON.stringify(environmentName)}
          HYPERVIBE_APPLIED_SPEC_HASH: \${{ vars.HYPERVIBE_APPLIED_SPEC_HASH }}
          HYPERVIBE_DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const { createHash } = require('crypto');
            const { readFileSync } = require('fs');

            function asRecord(value) {
              return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
            }

            function canonicalize(value) {
              if (Array.isArray(value)) return value.map(canonicalize);
              const record = asRecord(value);
              if (!record) return value;
              return Object.fromEntries(
                Object.entries(record)
                  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                  .map(([key, child]) => [key, canonicalize(child)])
              );
            }

            const spec = JSON.parse(readFileSync('.hypervibe/spec.json', 'utf8'));
            const environmentName = process.env.HYPERVIBE_ENVIRONMENT;
            const environment = asRecord(spec.environments)?.[environmentName];
            if (!asRecord(environment)) {
              throw new Error('Hypervibe spec has no environment "' + environmentName + '".');
            }
            const secrets = Object.fromEntries(
              Object.entries(asRecord(spec.secrets) || {})
                .filter(([, value]) => {
                  const environments = asRecord(value)?.environments;
                  return Array.isArray(environments) && environments.includes(environmentName);
                })
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            );
            const contract = canonicalize({
              version: spec.version,
              project: spec.project,
              gitRemoteUrl: spec.gitRemoteUrl || null,
              environmentName,
              environment,
              secrets,
            });
            const desiredHash = createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
            const appliedHash = (process.env.HYPERVIBE_APPLIED_SPEC_HASH || '').trim();
            const deploySha = (process.env.HYPERVIBE_DEPLOY_SHA || '').trim();
            core.info('Desired Hypervibe contract hash: ' + desiredHash);
            core.info('Applied Hypervibe contract hash: ' + (appliedHash || '(missing)'));
            if (!appliedHash || appliedHash !== desiredHash) {
              const annotationTitle = 'Deployment blocked — Hypervibe reconciliation required';
              const cause = !appliedHash
                ? 'applied hash missing'
                : 'desired and applied hashes differ';
              const failureMessage = !appliedHash
                ? 'Deployment blocked for ' + environmentName + ': applied contract hash is missing.'
                : 'Deployment blocked for ' + environmentName + ': desired and applied contract hashes differ.';

              core.error(failureMessage, { title: annotationTitle });
              await core.summary
                .addHeading('🚧 ' + annotationTitle, 2)
                .addRaw('**This is not an application build or test failure. No image was built and nothing was deployed.**')
                .addBreak()
                .addRaw(
                  'The desired ' + environmentName + ' infrastructure contract for commit \`'
                  + deploySha
                  + '\` does not match the last contract applied through Hypervibe.'
                )
                .addBreak()
                .addRaw('**Cause:** ' + cause)
                .addBreak()
                .addTable([
                  [{ data: 'Field', header: true }, { data: 'Value', header: true }],
                  ['Environment', environmentName],
                  ['Desired hash', desiredHash],
                  ['Applied hash', appliedHash || 'missing'],
                  ['Prevented commit', deploySha],
                ])
                .addHeading('Next', 3)
                .addList([
                  'Check out commit \`' + deploySha + '\`.',
                  'Run \`hv_status\` for \`' + environmentName + '\`.',
                  'Run \`hv_plan\` for \`' + environmentName + '\`.',
                  'Review and apply that exact plan with \`hv_apply\`.',
                  'Retrigger this workflow with \`hv_ci_trigger\`.',
                ], true)
                .write();
              core.setFailed(failureMessage);
            }
`;
}

function buildDeploymentFailureEvidenceJob(environmentName: string): string {
  return `
  failure_evidence:
    needs: deploy
    if: \${{ always() && needs.deploy.result == 'failure' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    steps:
      - name: Capture sanitized deployment failure evidence
        uses: actions/github-script@v8
        env:
          HYPERVIBE_RUN_ID: \${{ github.run_id }}
        with:
          script: |
            const { writeFileSync } = require('fs');
            const runId = Number(process.env.HYPERVIBE_RUN_ID);
            if (!Number.isSafeInteger(runId) || runId <= 0) {
              throw new Error('GITHUB_RUN_ID must be a positive integer.');
            }

            const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: runId,
              filter: 'latest',
              per_page: 100,
            });
            const deployJob = jobs.find((job) => job.name === 'deploy' && job.conclusion === 'failure');
            if (!deployJob) {
              throw new Error('Could not find the failed deploy job for workflow run ' + runId + '.');
            }

            const response = await github.request(
              'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
              { owner: context.repo.owner, repo: context.repo.repo, job_id: deployJob.id }
            );
            const raw = typeof response.data === 'string'
              ? response.data
              : Buffer.from(response.data).toString('utf8');
            const redacted = raw
              .replace(/([a-z][a-z0-9+.-]*:\\/\\/)[^\\s\\/:@]+:[^\\s@\\/]+@/gi, '$1***:***@')
              .replace(/([?&](?:token|password|secret|credential|api_key)=)[^&\\s]+/gi, '$1***')
              .split(/\\r?\\n/)
              .slice(-400)
              .map((line) => line
                .replace(/(Authorization:\\s*(?:Bearer|Basic)\\s+)\\S+/gi, '$1***')
                .replace(/\\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\\s*([=:]\\s*)(?:"[^"]*"|'[^']*'|\\S+)/gi, '$1$2***')
                .replace(/\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\\b/g, '***'))
              .join('\\n')
              .slice(-65536);

            writeFileSync(
              'hypervibe-deploy-failure.log',
              (redacted || 'Deploy job failed without readable log output.') + '\\n',
              { encoding: 'utf8', mode: 0o600 }
            );
            core.info('Captured sanitized evidence from failed deploy job ' + deployJob.id + '.');
      - name: Upload deployment failure evidence
        uses: actions/upload-artifact@v4
        with:
          name: deploy-${environmentName}-failure-evidence
          path: hypervibe-deploy-failure.log
          if-no-files-found: error
          retention-days: 14
`;
}

export const IOS_RELEASE_REQUIRED_SECRETS = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_PRIVATE_KEY',
] as const;

function buildIosReleaseWorkflow(params: {
  provider: BranchDeployProvider;
  providerName: string;
  target: BranchDeployTarget;
  ios: IosSpec;
  serverWorkflowPath: string;
}): { files: Array<{ path: string; content: string }>; requiredSecrets: string[] } | null {
  const release = params.ios.release;
  if (!release) return null;
  const environmentName = params.target.environmentName;
  const safeEnvironment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const workflowPath = `.github/workflows/hypervibe-ios-release-${safeEnvironment}.yml`;
  const automaticTrigger = release.trigger === 'after-server-deploy'
    ? `  workflow_run:
    workflows: [${JSON.stringify(`Deploy ${params.providerName} (${environmentName})`)}]
    types: [completed]
`
    : '';
  const content = `name: iOS release (${environmentName})

on:
${automaticTrigger}  workflow_dispatch:
    inputs:
      commit_sha:
        description: Exact monorepo commit already deployed to ${environmentName}
        required: true
        type: string
      server_run_id:
        description: Successful server deploy workflow run containing matching release evidence
        required: true
        type: string

permissions:
  actions: read
  contents: read

concurrency:
  group: hypervibe-deploy-${environmentName}
  cancel-in-progress: false

jobs:
  release:
    if: \${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: macos-26
    timeout-minutes: 60
    environment: ${environmentName}
    env:
      HYPERVIBE_ENVIRONMENT: ${JSON.stringify(environmentName)}
      HYPERVIBE_BUNDLE_ID: ${JSON.stringify(params.ios.bundleId)}
      HYPERVIBE_TESTFLIGHT_GROUPS: ${JSON.stringify(JSON.stringify(release.testflight.groups))}
      HYPERVIBE_USES_NON_EXEMPT_ENCRYPTION: ${JSON.stringify(String(release.testflight.usesNonExemptEncryption))}
      HYPERVIBE_SUBMIT_BETA_REVIEW: ${JSON.stringify(String(release.testflight.submitForBetaReview))}
      HYPERVIBE_WORKING_DIRECTORY: ${JSON.stringify(release.build.workingDirectory)}
      HYPERVIBE_IPA_PATH: ${JSON.stringify(release.build.ipaPath)}
      HYPERVIBE_RELEASE_SCRIPT: ${JSON.stringify(release.testflight.scriptPath)}
    steps:
      - name: Resolve release provenance
        id: release
        uses: actions/github-script@v8
        with:
          script: |
            const automatic = context.eventName === 'workflow_run';
            const requestedSha = automatic
              ? ''
              : String(context.payload.inputs.commit_sha || '').trim();
            const serverRunId = automatic
              ? String(context.payload.workflow_run.id)
              : String(context.payload.inputs.server_run_id || '').trim();
            if (requestedSha && !/^[0-9a-f]{40}$/i.test(requestedSha)) throw new Error('commit_sha must be a full 40-character Git SHA');
            if (!/^[0-9]+$/.test(serverRunId)) throw new Error('server_run_id must be a GitHub Actions run id');
            core.setOutput('requested_sha', requestedSha);
            core.setOutput('server_run_id', serverRunId);
      - name: Download verified server release evidence
        uses: actions/download-artifact@v4
        with:
          pattern: hypervibe-server-release-${safeEnvironment}-*
          path: \${{ runner.temp }}/hypervibe-server-evidence
          merge-multiple: true
          github-token: \${{ github.token }}
          run-id: \${{ steps.release.outputs.server_run_id }}
      - name: Verify server release gate
        id: gate
        shell: bash
        env:
          HYPERVIBE_SERVER_EVIDENCE_PATH: \${{ runner.temp }}/hypervibe-server-evidence/hypervibe-server-release.json
          HYPERVIBE_REQUESTED_SHA: \${{ steps.release.outputs.requested_sha }}
          HYPERVIBE_REQUIRED_SERVICES: ${JSON.stringify(JSON.stringify(release.services))}
        run: |
          node -e 'const fs=require("fs"); const evidence=JSON.parse(fs.readFileSync(process.env.HYPERVIBE_SERVER_EVIDENCE_PATH,"utf8")); const required=JSON.parse(process.env.HYPERVIBE_REQUIRED_SERVICES); if(evidence.version!==1||evidence.environment!==process.env.HYPERVIBE_ENVIRONMENT) throw new Error("server evidence environment mismatch"); if(evidence.server.repository!==process.env.GITHUB_REPOSITORY||!/^[0-9a-f]{40}$/i.test(evidence.server.sha)) throw new Error("server evidence repository/SHA mismatch"); if(process.env.HYPERVIBE_REQUESTED_SHA&&evidence.server.sha!==process.env.HYPERVIBE_REQUESTED_SHA) throw new Error("server evidence does not match requested SHA"); for(const service of required) if(!evidence.services.includes(service)) throw new Error("server evidence is missing service "+service); fs.appendFileSync(process.env.GITHUB_OUTPUT, "sha="+evidence.server.sha+"\\n");'
      - uses: actions/checkout@v4
        with:
          ref: \${{ steps.gate.outputs.sha }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
          bundler-cache: true
      - name: Verify project-owned release script
        shell: bash
        run: |
          if [ ! -f "$HYPERVIBE_RELEASE_SCRIPT" ]; then
            echo "::error::Missing project-owned iOS release script: $HYPERVIBE_RELEASE_SCRIPT"
            exit 1
          fi
      - name: Build signed IPA
        working-directory: ${JSON.stringify(release.build.workingDirectory)}
        env:
${release.build.requiredSecrets.map((name) => `          ${name}: \${{ secrets.${name} }}`).join('\n') || '          HYPERVIBE_NO_ADDITIONAL_BUILD_SECRETS: "true"'}
        run: |
${release.build.command.split('\n').map((line) => `          ${line}`).join('\n')}
      - name: Validate IPA identity
        id: ipa
        shell: bash
        env:
          HYPERVIBE_RELEASE_SHA: \${{ steps.gate.outputs.sha }}
        run: |
          python3 - <<'PY'
          import os, pathlib, plistlib, zipfile
          root = pathlib.Path(os.environ["GITHUB_WORKSPACE"]).resolve()
          ipa = (root / os.environ["HYPERVIBE_WORKING_DIRECTORY"] / os.environ["HYPERVIBE_IPA_PATH"]).resolve()
          if root not in ipa.parents or not ipa.is_file():
              raise SystemExit("IPA is missing or outside the checked-out repository")
          with zipfile.ZipFile(ipa) as archive:
              for info in archive.infolist():
                  path = pathlib.PurePosixPath(info.filename)
                  if path.is_absolute() or ".." in path.parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
                      raise SystemExit("unsafe IPA archive entry: " + info.filename)
              plists = [name for name in archive.namelist() if name.startswith("Payload/") and name.count("/") == 2 and name.endswith(".app/Info.plist")]
              if len(plists) != 1:
                  raise SystemExit("expected exactly one Payload/*.app/Info.plist")
              info = plistlib.loads(archive.read(plists[0]))
          if info.get("CFBundleIdentifier") != os.environ["HYPERVIBE_BUNDLE_ID"]:
              raise SystemExit("IPA bundle identifier does not match desired ios.bundleId")
          version = str(info.get("CFBundleShortVersionString", ""))
          build = str(info.get("CFBundleVersion", ""))
          if not version or not build:
              raise SystemExit("IPA is missing marketing version or build number")
          with open(os.environ["GITHUB_OUTPUT"], "a") as output:
              output.write("path=" + str(ipa) + "\\n")
              output.write("version=" + version + "\\n")
              output.write("build=" + build + "\\n")
          PY
      - name: Run project-owned TestFlight release script
        env:
          APP_STORE_CONNECT_KEY_ID: \${{ secrets.APP_STORE_CONNECT_KEY_ID }}
          APP_STORE_CONNECT_ISSUER_ID: \${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
          APP_STORE_CONNECT_PRIVATE_KEY: \${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
          HYPERVIBE_IPA_PATH: \${{ steps.ipa.outputs.path }}
          HYPERVIBE_RELEASE_SHA: \${{ steps.gate.outputs.sha }}
          HYPERVIBE_MARKETING_VERSION: \${{ steps.ipa.outputs.version }}
          HYPERVIBE_BUILD_NUMBER: \${{ steps.ipa.outputs.build }}
          HYPERVIBE_SERVER_EVIDENCE_PATH: \${{ runner.temp }}/hypervibe-server-evidence/hypervibe-server-release.json
        run: node "$HYPERVIBE_RELEASE_SCRIPT"
      - name: Upload iOS release manifest
        uses: actions/upload-artifact@v4
        with:
          name: hypervibe-ios-release-${safeEnvironment}-\${{ steps.gate.outputs.sha }}
          path: hypervibe-ios-release.json
          if-no-files-found: error
          retention-days: 90
`;
  return {
    files: [{ path: workflowPath, content }],
    requiredSecrets: [
      ...IOS_RELEASE_REQUIRED_SECRETS,
      ...release.build.requiredSecrets,
    ],
  };
}

export function buildBranchDeployWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string },
  ios?: IosSpec
): BranchDeployWorkflow {
  const safeEnvironment = target.environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const template = `deploy-${provider}-${safeEnvironment}`;
  const filename = `${template}.yml`;
  const migrationStep = migration.includeStep && migration.command ? buildMigrationStep(migration.command) : '';
  const deployBlock = buildProviderDeploySteps(provider, target);
  const providerName = deployBlock.displayName ?? providerRegistry.getMetadata(provider)?.displayName ?? provider;
  let requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];
  const requiredVariables = [...deployBlock.requiredVariables];
  const permissionsBlock = deployBlock.permissions ?? `    permissions:
      actions: read
      contents: read
`;

  const content = `name: Deploy ${providerName} (${target.environmentName})

run-name: Deploy ${target.environmentName} \${{ inputs.commit_sha || github.sha }} \${{ inputs.rollback && '(rollback)' || '' }}

on:
${buildWorkflowTrigger(target)}

concurrency:
  group: hypervibe-deploy-${target.environmentName}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${target.environmentName}
${permissionsBlock.trimEnd()}
    steps:
      - name: Resolve deploy SHA
        id: deploy
        uses: actions/github-script@v8
        with:
          script: |
            const inputSha = ((context.payload.inputs || {}).commit_sha || '').trim();
            const sha = (inputSha || process.env.GITHUB_SHA).toLowerCase();
            if (!/^[0-9a-f]{40}$/i.test(sha)) {
              throw new Error('commit_sha must be a full 40-character Git commit SHA, got: ' + JSON.stringify(inputSha || sha));
            }
            const rollbackInput = (context.payload.inputs || {}).rollback;
            const operation = rollbackInput === true || rollbackInput === 'true' ? 'rollback' : 'deploy';
            core.setOutput('sha', sha);
            core.setOutput('operation', operation);
            core.info((operation === 'rollback' ? 'Restoring' : 'Deploying') + ' commit ' + sha);
      - name: Verify rollback release evidence
        if: steps.deploy.outputs.operation == 'rollback'
        uses: actions/github-script@v8
        env:
          HYPERVIBE_ENVIRONMENT: ${JSON.stringify(target.environmentName)}
          HYPERVIBE_ROLLBACK_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_WORKFLOW_REF: \${{ github.workflow_ref }}
          HYPERVIBE_EXPECTED_LATEST_RUN_ID: \${{ inputs.expected_latest_run_id }}
          HYPERVIBE_SOURCE_ARTIFACT_ID: \${{ inputs.source_artifact_id }}
          HYPERVIBE_SOURCE_WORKFLOW_RUN_ID: \${{ inputs.source_workflow_run_id }}
        with:
          script: |
            const environment = process.env.HYPERVIBE_ENVIRONMENT;
            const targetSha = process.env.HYPERVIBE_ROLLBACK_SHA.toLowerCase();
            const safeEnvironment = environment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
            const expectedName = 'hypervibe-server-release-' + safeEnvironment + '-' + targetSha;
            const expectedLatestRunId = Number(process.env.HYPERVIBE_EXPECTED_LATEST_RUN_ID);
            if (!Number.isSafeInteger(expectedLatestRunId) || expectedLatestRunId <= 0) {
              throw new Error('Rollback requires Hypervibe expected_latest_run_id evidence');
            }
            const sourceArtifactId = Number(process.env.HYPERVIBE_SOURCE_ARTIFACT_ID);
            const sourceWorkflowRunId = Number(process.env.HYPERVIBE_SOURCE_WORKFLOW_RUN_ID);
            if (!Number.isSafeInteger(sourceArtifactId) || sourceArtifactId <= 0
                || !Number.isSafeInteger(sourceWorkflowRunId) || sourceWorkflowRunId <= 0) {
              throw new Error('Rollback requires exact Hypervibe source artifact and workflow run evidence');
            }
            const workflowPath = process.env.HYPERVIBE_WORKFLOW_REF.split('@')[0].split('/').slice(2).join('/');
            const recentRuns = await github.rest.actions.listWorkflowRuns({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: workflowPath,
              per_page: 10,
            });
            const latestPriorRun = recentRuns.data.workflow_runs.find((run) => run.id !== context.runId);
            if (!latestPriorRun || latestPriorRun.id !== expectedLatestRunId) {
              throw new Error(
                'Rollback dispatch is stale: expected latest run ' + expectedLatestRunId
                + ', observed ' + (latestPriorRun ? latestPriorRun.id : 'none')
              );
            }
            const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: sourceWorkflowRunId,
              per_page: 100,
            });
            const artifact = artifacts.find((candidate) => candidate.id === sourceArtifactId);
            if (!artifact || artifact.name !== expectedName || artifact.expired
                || artifact.workflow_run?.id !== sourceWorkflowRunId) {
              throw new Error('Exact Hypervibe rollback artifact evidence is missing, expired, or does not match SHA ' + targetSha);
            }
            const run = await github.rest.actions.getWorkflowRun({
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: sourceWorkflowRunId,
            });
            if (run.data.conclusion !== 'success' || run.data.path !== workflowPath) {
              throw new Error('Rollback evidence for ' + targetSha + ' did not come from a successful run of ' + workflowPath);
            }
            core.info('Verified rollback evidence from successful workflow run ' + run.data.id);
      - uses: actions/checkout@v4
        with:
          ref: \${{ steps.deploy.outputs.sha }}
${buildDeploymentContractStep(target.environmentName)}${migrationStep}${deployBlock.steps}      - name: Write server release evidence
        shell: bash
        env:
          HYPERVIBE_RELEASE_SHA: \${{ steps.deploy.outputs.sha }}
        run: |
          node -e 'const fs=require("fs"); fs.writeFileSync("hypervibe-server-release.json", JSON.stringify({version:1,environment:${JSON.stringify(target.environmentName)},server:{repository:process.env.GITHUB_REPOSITORY,sha:process.env.HYPERVIBE_RELEASE_SHA},services:${JSON.stringify(target.serviceNames)},verifiedAt:new Date().toISOString()}, null, 2)+"\\n")'
      - name: Upload server release evidence
        uses: actions/upload-artifact@v4
        with:
          name: hypervibe-server-release-${safeEnvironment}-\${{ steps.deploy.outputs.sha }}
          path: hypervibe-server-release.json
          if-no-files-found: error
          retention-days: 90
${buildDeploymentFailureEvidenceJob(target.environmentName)}`;

  const iosRelease = ios
    ? buildIosReleaseWorkflow({
      provider,
      providerName,
      target,
      ios,
      serverWorkflowPath: `.github/workflows/${filename}`,
    })
    : null;
  if (iosRelease) requiredSecrets = [...requiredSecrets, ...iosRelease.requiredSecrets];
  const readableServiceNames = target.serviceNames.length <= 1
    ? target.serviceNames.join('')
    : `${target.serviceNames.slice(0, -1).join(', ')} and ${target.serviceNames.at(-1)}`;
  const serviceLabel = target.serviceNames.length === 0
    ? 'the configured services'
    : target.serviceNames.length === 1
      ? `the ${target.serviceNames[0]} service`
      : `the ${readableServiceNames} services`;
  const reviewDetails = [
    'Requires a full 40-character commit ID so the deployment always points to one exact version of the code.',
    `Builds and deploys ${serviceLabel}, then waits for ${providerName} to confirm the result.`,
    ...(migrationStep ? ['Runs the declared database migration before deploying the services.'] : []),
    ...(deployBlock.reviewDetails ?? []),
    'Saves a release record showing the environment, commit, and services that were successfully deployed.',
    'Uploads safe failure details when the deployment does not complete.',
  ];
  return {
    template,
    templateName: `Deploy ${providerName} (${target.environmentName})`,
    branch: target.branch,
    autoDeployOnPush: target.autoDeployOnPush,
    ...(target.promoteFromEnvironment ? { promoteFromEnvironment: target.promoteFromEnvironment } : {}),
    environment: target.environmentName,
    path: `.github/workflows/${filename}`,
    content,
    ...(iosRelease ? { companionFiles: iosRelease.files } : {}),
    review: {
      title: `${target.environmentName} deployment`,
      summary: `Updates the GitHub workflow that deploys ${serviceLabel} to ${providerName}.`,
      details: reviewDetails,
      mergeEffect: target.autoDeployOnPush
        ? `Merging this PR may start a ${target.environmentName} deployment because pushes to ${target.branch} deploy automatically.`
        : `Merging this PR does not deploy ${target.environmentName} by itself; that deployment still has to be started manually.`,
    },
    requiredSecrets: Array.from(new Set(requiredSecrets)),
    requiredVariables: Array.from(new Set(requiredVariables)),
  };
}
