import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { Project } from '../entities/project.entity.js';

// ============= Workflow Templates =============

export const WORKFLOW_TEMPLATES: Record<string, {
  name: string;
  filename: string;
  content: string;
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
  'deploy-railway': {
    name: 'Deploy to Railway',
    filename: 'deploy.yml',
    content: `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: railwayapp/railway-github-action@v0.1.0
        with:
          railway_token: \${{ secrets.RAILWAY_TOKEN }}
`,
    requiredSecrets: ['RAILWAY_TOKEN'],
  },
  'deploy-railway-staging': {
    name: 'Deploy Railway (staging)',
    filename: 'deploy-railway-staging.yml',
    content: `name: Deploy Railway (staging)

on:
  push:
    branches: [staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - uses: railwayapp/railway-github-action@v0.1.0
        with:
          railway_token: \${{ secrets.RAILWAY_TOKEN }}
`,
    requiredSecrets: ['RAILWAY_TOKEN'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-railway-production': {
    name: 'Deploy Railway (production)',
    filename: 'deploy-railway-production.yml',
    content: `name: Deploy Railway (production)

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - uses: railwayapp/railway-github-action@v0.1.0
        with:
          railway_token: \${{ secrets.RAILWAY_TOKEN }}
`,
    requiredSecrets: ['RAILWAY_TOKEN'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-vercel-staging': {
    name: 'Deploy Vercel (staging)',
    filename: 'deploy-vercel-staging.yml',
    content: `name: Deploy Vercel (staging)

on:
  push:
    branches: [staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - name: Install Vercel CLI
        run: npm i -g vercel@latest
      - name: Deploy (preview)
        run: vercel deploy --token \${{ secrets.VERCEL_TOKEN }} --yes
`,
    requiredSecrets: ['VERCEL_TOKEN'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-vercel-production': {
    name: 'Deploy Vercel (production)',
    filename: 'deploy-vercel-production.yml',
    content: `name: Deploy Vercel (production)

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - name: Install Vercel CLI
        run: npm i -g vercel@latest
      - name: Deploy (production)
        run: vercel deploy --token \${{ secrets.VERCEL_TOKEN }} --prod --yes
`,
    requiredSecrets: ['VERCEL_TOKEN'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-render-staging': {
    name: 'Deploy Render (staging)',
    filename: 'deploy-render-staging.yml',
    content: `name: Deploy Render (staging)

on:
  push:
    branches: [staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - name: Trigger Render deploy hook
        run: curl -fsSL -X POST "\${{ secrets.RENDER_DEPLOY_HOOK_URL }}"
`,
    requiredSecrets: ['RENDER_DEPLOY_HOOK_URL'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-render-production': {
    name: 'Deploy Render (production)',
    filename: 'deploy-render-production.yml',
    content: `name: Deploy Render (production)

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - name: Trigger Render deploy hook
        run: curl -fsSL -X POST "\${{ secrets.RENDER_DEPLOY_HOOK_URL }}"
`,
    requiredSecrets: ['RENDER_DEPLOY_HOOK_URL'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-digitalocean-staging': {
    name: 'Deploy DigitalOcean App Platform (staging)',
    filename: 'deploy-digitalocean-staging.yml',
    content: `name: Deploy DigitalOcean (staging)

on:
  push:
    branches: [staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - uses: digitalocean/action-doctl@v2
        with:
          token: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      - name: Trigger App Platform deployment
        run: doctl apps create-deployment \${{ secrets.DO_APP_ID }}
`,
    requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'DO_APP_ID'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
  },
  'deploy-digitalocean-production': {
    name: 'Deploy DigitalOcean App Platform (production)',
    filename: 'deploy-digitalocean-production.yml',
    content: `name: Deploy DigitalOcean (production)

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations (optional)
        if: \${{ vars.MIGRATION_COMMAND != '' }}
        run: \${{ vars.MIGRATION_COMMAND }}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
      - uses: digitalocean/action-doctl@v2
        with:
          token: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      - name: Trigger App Platform deployment
        run: doctl apps create-deployment \${{ secrets.DO_APP_ID }}
`,
    requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'DO_APP_ID'],
    requiredVariables: ['MIGRATION_COMMAND (optional)'],
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
  const connection = connectionRepo.findBestMatch('github', scopeHint);
  if (!connection) {
    return { error: 'No GitHub connection found. Use connection_create with provider=github first.' };
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

export type BranchDeployProvider = 'railway' | 'vercel' | 'render' | 'digitalocean';
export type BranchDeployEnvironmentKind = 'staging' | 'production';

export interface BranchDeployTarget {
  environmentName: string;
  kind: BranchDeployEnvironmentKind;
  branch: string;
}

export interface BranchDeployWorkflow {
  template: string;
  templateName: string;
  branch: string;
  environment: string;
  path: string;
  content: string;
  requiredSecrets: string[];
  requiredVariables: string[];
}

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

export function resolveBranchDeployTargets(project: Project): {
  targets: BranchDeployTarget[];
  desiredBranches: { staging?: string; production?: string };
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  const desiredState = asRecord(project.policies?.desiredState);
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

    targetsByKind.set(kind, {
      environmentName,
      kind,
      branch: kind === 'production'
        ? desiredBranches.production ?? 'main'
        : desiredBranches.staging ?? 'staging',
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
  return `      - name: Run migrations
        run: ${command}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`;
}

function buildProviderDeploySteps(provider: BranchDeployProvider, kind: BranchDeployEnvironmentKind): {
  steps: string;
  requiredSecrets: string[];
} {
  switch (provider) {
    case 'railway':
      return {
        steps: `      - uses: railwayapp/railway-github-action@v0.1.0
        with:
          railway_token: \${{ secrets.RAILWAY_TOKEN }}
`,
        requiredSecrets: ['RAILWAY_TOKEN'],
      };
    case 'vercel':
      return {
        steps: `      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install Vercel CLI
        run: npm i -g vercel@latest
      - name: Deploy (${kind === 'production' ? 'production' : 'preview'})
        run: vercel deploy --token \${{ secrets.VERCEL_TOKEN }}${kind === 'production' ? ' --prod' : ''} --yes
`,
        requiredSecrets: ['VERCEL_TOKEN'],
      };
    case 'render':
      return {
        steps: `      - name: Trigger Render deploy hook
        run: curl -fsSL -X POST "\${{ secrets.RENDER_DEPLOY_HOOK_URL }}"
`,
        requiredSecrets: ['RENDER_DEPLOY_HOOK_URL'],
      };
    case 'digitalocean':
      return {
        steps: `      - uses: digitalocean/action-doctl@v2
        with:
          token: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      - name: Trigger App Platform deployment
        run: doctl apps create-deployment \${{ secrets.DO_APP_ID }}
`,
        requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'DO_APP_ID'],
      };
  }
}

export function buildBranchDeployWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string }
): BranchDeployWorkflow {
  const providerName =
    provider === 'digitalocean'
      ? 'DigitalOcean'
      : provider.charAt(0).toUpperCase() + provider.slice(1);
  const template = `deploy-${provider}-${target.kind}`;
  const filename = `${template}.yml`;
  const migrationStep = migration.includeStep && migration.command ? buildMigrationStep(migration.command) : '';
  const deployBlock = buildProviderDeploySteps(provider, target.kind);
  const requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];

  const content = `name: Deploy ${providerName} (${target.environmentName})

on:
  push:
    branches: [${target.branch}]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${target.environmentName}
    steps:
      - uses: actions/checkout@v4
${migrationStep}${deployBlock.steps}`;

  return {
    template,
    templateName: `Deploy ${providerName} (${target.environmentName})`,
    branch: target.branch,
    environment: target.environmentName,
    path: `.github/workflows/${filename}`,
    content,
    requiredSecrets: Array.from(new Set(requiredSecrets)),
    requiredVariables: [],
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

      - uses: actions/github-script@v7
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

