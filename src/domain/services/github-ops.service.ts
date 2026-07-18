import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema } from '../spec/spec.schema.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
  BranchDeployWorkflow,
} from '../ports/ci-deploy.port.js';

// ============= Workflow Templates =============

export const WORKFLOW_TEMPLATES: Record<string, {
  name: string;
  filename: string;
  content?: string;
  buildContent?: () => string;
  requiredSecrets?: string[];
  requiredVariables?: string[];
}> = {
  'node-test': {
    name: 'Node.js Tests',
    filename: 'test.yml',
    content: `name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test
`,
  },
  'python-test': {
    name: 'Python Tests',
    filename: 'test.yml',
    content: `name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: 'pip'
      - run: pip install -r requirements.txt
      - run: pytest
`,
  },
  'lint': {
    name: 'Lint',
    filename: 'lint.yml',
    content: `name: Lint

on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
`,
  },
};

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
  return null;
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
  desiredBranches: { staging?: string; production?: string };
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  const specRow = projectSpecRepo.findLatest(project.id);
  const parsedSpec = specRow ? projectSpecSchema.safeParse(specRow.document) : null;
  if (parsedSpec?.success) {
    const targetsByKind = new Map<BranchDeployEnvironmentKind, BranchDeployTarget>();
    const skippedEnvironments: string[] = [];
    const desiredBranches: { staging?: string; production?: string } = {};
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
      if (targetsByKind.has(kind)) {
        skippedEnvironments.push(environmentName);
        continue;
      }

      const branch = envSpec.deploy.branch ?? 'main';
      const autoDeployOnPush = envSpec.deploy.autoDeploy ?? kind !== 'production';
      desiredBranches[kind] = branch;
      const serviceNames = Object.keys(envSpec.services);
      const bindings = environmentBindings(project.id, environmentName, new Set(serviceNames));
      const runtimeServiceNames = Object.entries(envSpec.services)
        .filter(([, service]) => service.workloadKind !== 'cron')
        .map(([name]) => name);
      const jobServiceNames = Object.entries(envSpec.services)
        .filter(([, service]) => service.workloadKind === 'cron')
        .map(([name]) => name);
      const webService = Object.values(envSpec.services).find((service) => service.workloadKind === 'web');
      targetsByKind.set(kind, {
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

    const targets = Array.from(targetsByKind.values()).sort((a, b) => {
      if (a.kind === b.kind) return a.environmentName.localeCompare(b.environmentName);
      return a.kind === 'staging' ? -1 : 1;
    });

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
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install dependencies for migrations
        run: npm ci
      - name: Run migrations
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
        type: string`;
  if (!target.autoDeployOnPush) {
    return dispatch;
  }
  return `  push:
    branches: [${target.branch}]
${dispatch}`;
}

export function buildBranchDeployWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string }
): BranchDeployWorkflow {
  const template = `deploy-${provider}-${target.kind}`;
  const filename = `${template}.yml`;
  const migrationStep = migration.includeStep && migration.command ? buildMigrationStep(migration.command) : '';
  const deployBlock = buildProviderDeploySteps(provider, target);
  const providerName = deployBlock.displayName ?? providerRegistry.getMetadata(provider)?.displayName ?? provider;
  const requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];
  const requiredVariables = [...deployBlock.requiredVariables];
  const permissionsBlock = deployBlock.permissions ?? `    permissions:
      contents: read
`;

  const content = `name: Deploy ${providerName} (${target.environmentName})

on:
${buildWorkflowTrigger(target)}

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
            const sha = inputSha || process.env.GITHUB_SHA;
            if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
              throw new Error('commit_sha must be a Git commit SHA, got: ' + JSON.stringify(inputSha || sha));
            }
            core.setOutput('sha', sha);
            core.info('Deploying commit ' + sha);
      - uses: actions/checkout@v4
        with:
          ref: \${{ steps.deploy.outputs.sha }}
${migrationStep}${deployBlock.steps}`;

  return {
    template,
    templateName: `Deploy ${providerName} (${target.environmentName})`,
    branch: target.branch,
    autoDeployOnPush: target.autoDeployOnPush,
    ...(target.promoteFromEnvironment ? { promoteFromEnvironment: target.promoteFromEnvironment } : {}),
    environment: target.environmentName,
    path: `.github/workflows/${filename}`,
    content,
    requiredSecrets: Array.from(new Set(requiredSecrets)),
    requiredVariables: Array.from(new Set(requiredVariables)),
  };
}

export const AI_REVIEW_WORKFLOW_PATH = '.github/workflows/ai-code-review.yml';
export const AI_REVIEW_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function buildAiReviewWorkflowContent(claudeModel: string): string {
  return `name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/github-script@v8
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        with:
          script: |
            const diff = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number,
              mediaType: { format: 'diff' },
            });

            const response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: '${claudeModel}',
                max_tokens: 4096,
                messages: [{
                  role: 'user',
                  content: \`Review this pull request diff. Provide a concise code review focusing on bugs, security issues, and significant improvements. Be constructive and specific. If the code looks good, say so briefly.\\n\\nDiff:\\n\${diff.data.substring(0, 100000)}\`,
                }],
              }),
            });

            const result = await response.json();
            const review = result.content?.[0]?.text ?? 'Unable to generate review.';

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: \`## 🤖 AI Code Review\\n\\n\${review}\\n\\n---\\n*Powered by Claude (${claudeModel})*\`,
            });
`;
}
