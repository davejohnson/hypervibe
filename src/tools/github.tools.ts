import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { GitHubCredentials } from '../adapters/providers/github/github.adapter.js';
import type { CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { Project } from '../domain/entities/project.entity.js';

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

const BRANCH_DEPLOY_TEMPLATES: Record<string, { staging: string; production: string }> = {
  railway: {
    staging: 'deploy-railway-staging',
    production: 'deploy-railway-production',
  },
  vercel: {
    staging: 'deploy-vercel-staging',
    production: 'deploy-vercel-production',
  },
  render: {
    staging: 'deploy-render-staging',
    production: 'deploy-render-production',
  },
  digitalocean: {
    staging: 'deploy-digitalocean-staging',
    production: 'deploy-digitalocean-production',
  },
};

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const projectRepo = new ProjectRepository();
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

/**
 * Get a Cloudflare adapter, using scoped connection if available.
 * @param scopeHint - Optional domain hint (e.g., "example.com") for finding scoped tokens
 */
function getCloudflareAdapter(scopeHint?: string): { adapter: CloudflareAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', scopeHint);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use connection_create with provider=cloudflare first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
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

function resolveBranchDeployProject(owner: string, repo: string, projectName?: string): Project | null {
  if (projectName) {
    return projectRepo.findByName(projectName);
  }

  return (
    projectRepo.findByGitRemoteUrl(`https://github.com/${owner}/${repo}`) ??
    projectRepo.findByGitRemoteUrl(`git@github.com:${owner}/${repo}.git`) ??
    projectRepo.findByName(repo)
  );
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

export function registerGitHubTools(server: McpServer): void {
  server.tool(
    'github_setup_help',
    'Get instructions for creating a GitHub personal access token with the correct permissions',
    {},
    async () => {
      const instructions = `# GitHub Personal Access Token Setup

## Fine-Grained Token (Recommended)

Fine-grained tokens let you scope access to specific repositories with minimal permissions.

1. Go to https://github.com/settings/tokens?type=beta
2. Click **"Generate new token"**
3. Set a **Token name** (e.g., "Hypervibe")
4. Set **Expiration** (90 days recommended, or custom)
5. Under **Repository access**, select **"Only select repositories"** and pick your repos
6. Under **Permissions → Repository permissions**, enable:

| Permission | Access | Used by |
|------------|--------|---------|
| Actions | Read and write | Workflow runs: list, rerun, trigger |
| Administration | Read and write | Branch protection rules |
| Contents | Read and write | Repository files, workflow files, CNAME file for Pages |
| Workflows | Read and write | Required to create or update files in \`.github/workflows/\` |
| Pages | Read and write | GitHub Pages setup and status |
| Secrets | Read and write | Repository secrets management |

7. Click **"Generate token"**
8. Copy the token (shown only once!)

### Minimum recommended fine-grained set for Hypervibe

If you want Hypervibe to manage branch-deploy workflows, branch protection, Pages, and secrets reliably, grant:

- **Actions:** Read and write
- **Administration:** Read and write
- **Contents:** Read and write
- **Workflows:** Read and write
- **Pages:** Read and write
- **Secrets:** Read and write

## Classic Token (Simpler Alternative)

If you prefer a simpler setup or need org-wide access:

1. Go to https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Set a **Note** (e.g., "Hypervibe")
4. Select the **\`repo\`** scope
5. Select the **\`workflow\`** scope if Hypervibe will create or update files under \`.github/workflows/\`
6. Click **"Generate token"**
7. Copy the token (shown only once!)

## What Each Hypervibe Feature Needs

| Feature | Fine-grained permission | Classic scope |
|---------|------------------------|---------------|
| Secrets (list, set, delete) | Secrets: Read and write | repo |
| Workflow runs (list, trigger) | Actions: Read and write | repo |
| Workflow file creation/update (\`.github/workflows/*\`) | Contents: Read and write, Workflows: Read and write | repo + workflow |
| Branch protection | Administration: Read and write | repo |
| GitHub Pages setup | Pages: Read and write, Contents: Read and write | repo |
| AI code review setup | Actions: Read and write, Contents: Read and write, Workflows: Read and write, Secrets: Read and write | repo + workflow |

## Verification

After creating the token, connect and verify it:

\`\`\`
connection_create provider=github credentials={"apiToken":"ghp_your_token_here"}
connection_verify provider=github
\`\`\`

Note: GitHub's repository contents API has a special case for \`.github/workflows/\`. Even when the token can read/write normal repository contents, modifying workflow files may require explicit **Workflows: Read and write** permission for fine-grained PATs, or the **\`workflow\`** scope for classic PATs.`;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            instructions,
          }),
        }],
      };
    }
  );

  server.tool(
    'github_pages_status',
    'Get the GitHub Pages status for a repository',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const pagesConfig = await adapter.getPagesConfig(owner, repo);

        if (!pagesConfig) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                pagesEnabled: false,
                message: `GitHub Pages is not enabled for ${owner}/${repo}. Enable it in Settings > Pages.`,
              }),
            }],
          };
        }

        // Get health check if custom domain is set
        let healthCheck = null;
        if (pagesConfig.cname) {
          healthCheck = await adapter.getPagesHealthCheck(owner, repo);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              pagesEnabled: true,
              repository: `${owner}/${repo}`,
              url: pagesConfig.url,
              status: pagesConfig.status,
              customDomain: pagesConfig.cname,
              httpsEnforced: pagesConfig.https_enforced,
              buildType: pagesConfig.build_type,
              source: pagesConfig.source,
              httpsCertificate: pagesConfig.https_certificate ? {
                state: pagesConfig.https_certificate.state,
                description: pagesConfig.https_certificate.description,
                domains: pagesConfig.https_certificate.domains,
                expiresAt: pagesConfig.https_certificate.expires_at,
              } : null,
              healthCheck: healthCheck?.domain ? {
                dnsResolves: healthCheck.domain.dns_resolves,
                isServedByPages: healthCheck.domain.is_served_by_pages,
                isHttpsEligible: healthCheck.domain.is_https_eligible,
                enforcesHttps: healthCheck.domain.enforces_https,
                isPointedToGitHubPagesIp: healthCheck.domain.is_pointed_to_github_pages_ip,
                isCnameToGitHubUserDomain: healthCheck.domain.is_cname_to_github_user_domain,
                isApexDomain: healthCheck.domain.is_apex_domain,
              } : null,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_pages_setup',
    'Set up GitHub Pages with a custom domain (two-step: preview then confirm)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      domain: z.string().describe('Custom domain (e.g., example.com or www.example.com)'),
      confirm: z.boolean().optional().describe('Set to true to actually apply the changes'),
    },
    async ({ owner, repo, domain, confirm }) => {
      // Get GitHub adapter with scope hint
      const ghResult = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in ghResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: ghResult.error }),
          }],
        };
      }

      // Get Cloudflare adapter with domain scope hint
      const apexDomain = getApexDomain(domain);
      const cfResult = getCloudflareAdapter(apexDomain);
      if ('error' in cfResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: cfResult.error }),
          }],
        };
      }

      const { adapter: githubAdapter } = ghResult;
      const { adapter: cloudflareAdapter } = cfResult;

      try {
        // Check if GitHub Pages is enabled, enable it if not
        let pagesConfig = await githubAdapter.getPagesConfig(owner, repo);
        let pagesWasEnabled = false;

        if (!pagesConfig) {
          // GitHub Pages not enabled - enable it first
          try {
            pagesConfig = await githubAdapter.enablePages(owner, repo, { branch: 'main', path: '/docs' });
            pagesWasEnabled = true;
          } catch (enableError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Failed to enable GitHub Pages: ${enableError instanceof Error ? enableError.message : String(enableError)}`,
                }),
              }],
            };
          }
        }

        // Find the Cloudflare zone for this domain
        const apexDomain = getApexDomain(domain);
        const zone = await cloudflareAdapter.findZoneByName(apexDomain);
        if (!zone) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Domain "${apexDomain}" not found in Cloudflare account. Make sure the domain is added to Cloudflare.`,
              }),
            }],
          };
        }

        // Determine DNS records to create based on whether it's apex or subdomain
        const isApex = isApexDomain(domain);
        const plannedDnsRecords: Array<{
          name: string;
          type: string;
          content: string;
          purpose: string;
        }> = [];

        if (isApex) {
          // Apex domain: Create 4 A records pointing to GitHub Pages IPs
          for (const ip of GITHUB_PAGES_IPS) {
            plannedDnsRecords.push({
              name: domain,
              type: 'A',
              content: ip,
              purpose: `GitHub Pages IP (${ip})`,
            });
          }
          // Also create www CNAME for redirect to apex domain
          plannedDnsRecords.push({
            name: `www.${domain}`,
            type: 'CNAME',
            content: `${owner}.github.io`,
            purpose: 'www redirect to apex domain',
          });
        } else {
          // Subdomain: Create CNAME record pointing to <owner>.github.io
          plannedDnsRecords.push({
            name: domain,
            type: 'CNAME',
            content: `${owner}.github.io`,
            purpose: 'GitHub Pages CNAME',
          });
        }

        // Plan GitHub config changes
        const plannedGitHubChanges: Array<{
          setting: string;
          currentValue: unknown;
          newValue: unknown;
        }> = [];

        if (pagesConfig.cname !== domain) {
          plannedGitHubChanges.push({
            setting: 'Custom domain (CNAME)',
            currentValue: pagesConfig.cname || '(not set)',
            newValue: domain,
          });
        }

        if (!pagesConfig.https_enforced) {
          plannedGitHubChanges.push({
            setting: 'HTTPS enforcement',
            currentValue: false,
            newValue: true,
          });
        }

        const sourcePath = pagesConfig.source?.path || '/docs';
        const cnameFilePath = sourcePath === '/' ? 'CNAME' : `${sourcePath.replace(/^\//, '')}/CNAME`;
        plannedGitHubChanges.push({
          setting: `CNAME file (${cnameFilePath})`,
          currentValue: '(will check)',
          newValue: domain,
        });

        // Preview mode - return planned changes
        if (!confirm) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                mode: 'preview',
                message: 'Review the planned changes and call again with confirm=true to apply.',
                repository: `${owner}/${repo}`,
                domain,
                isApexDomain: isApex,
                pagesWasEnabled,
                cloudflareZone: {
                  id: zone.id,
                  name: zone.name,
                },
                plannedDnsRecords: plannedDnsRecords.map(r => ({
                  action: 'create/update',
                  name: r.name,
                  type: r.type,
                  content: r.content,
                  purpose: r.purpose,
                  proxied: false,
                })),
                plannedGitHubChanges,
                currentStatus: {
                  pagesUrl: pagesConfig.url,
                  currentDomain: pagesConfig.cname,
                  httpsEnforced: pagesConfig.https_enforced,
                },
              }),
            }],
          };
        }

        // Confirm mode - apply changes
        const dnsResults: Array<{
          name: string;
          type: string;
          success: boolean;
          action?: 'created' | 'updated';
          error?: string;
        }> = [];

        const githubResults: Array<{
          setting: string;
          success: boolean;
          error?: string;
        }> = [];

        // Step 1: Create DNS records in Cloudflare
        // Group records by name+type to handle multi-value records (like multiple A records)
        const recordGroups = new Map<string, { name: string; type: string; contents: string[] }>();
        for (const record of plannedDnsRecords) {
          const key = `${record.name}:${record.type}`;
          if (!recordGroups.has(key)) {
            recordGroups.set(key, { name: record.name, type: record.type, contents: [] });
          }
          recordGroups.get(key)!.contents.push(record.content);
        }

        // Create/sync records for each group
        for (const group of recordGroups.values()) {
          try {
            if (group.contents.length > 1) {
              // Multiple records with same name+type (e.g., GitHub Pages A records)
              const result = await cloudflareAdapter.ensureRecords(
                zone.id,
                group.name,
                group.type,
                group.contents,
                { proxied: false }
              );

              for (const content of result.created) {
                dnsResults.push({
                  name: group.name,
                  type: group.type,
                  success: true,
                  action: 'created',
                });
              }
              for (const content of result.unchanged) {
                dnsResults.push({
                  name: group.name,
                  type: group.type,
                  success: true,
                  action: 'updated', // Already existed
                });
              }
            } else {
              // Single record - use upsert
              const { action } = await cloudflareAdapter.upsertDnsRecord(
                zone.id,
                group.name,
                group.type,
                group.contents[0],
                { proxied: false }
              );

              dnsResults.push({
                name: group.name,
                type: group.type,
                success: true,
                action,
              });
            }
          } catch (error) {
            dnsResults.push({
              name: group.name,
              type: group.type,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Step 2: Set custom domain in GitHub
        // First remove any existing custom domain to trigger fresh certificate provisioning
        try {
          const currentConfig = await githubAdapter.getPagesConfig(owner, repo);
          if (currentConfig?.cname && currentConfig.cname !== domain) {
            await githubAdapter.removeCustomDomain(owner, repo);
            // Brief pause to let GitHub process the removal
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch {
          // Ignore errors removing old domain
        }

        try {
          await githubAdapter.setCustomDomain(owner, repo, domain);
          githubResults.push({
            setting: 'Custom domain',
            success: true,
          });
        } catch (error) {
          githubResults.push({
            setting: 'Custom domain',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 2b: Ensure CNAME file exists in the repo's Pages source directory
        // Without this file, GitHub won't provision a Let's Encrypt certificate
        try {
          const sourcePath = pagesConfig.source?.path || '/docs';
          const cnameResult = await githubAdapter.ensureCnameFile(owner, repo, domain, sourcePath);
          if (cnameResult.created) {
            githubResults.push({ setting: 'CNAME file', success: true });
          } else if (cnameResult.updated) {
            githubResults.push({ setting: 'CNAME file (updated)', success: true });
          }
          // If neither created nor updated, file already had correct content - no action needed
        } catch (error) {
          githubResults.push({
            setting: 'CNAME file',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 3: Request a pages build to trigger certificate provisioning
        try {
          await githubAdapter.requestPagesBuild(owner, repo);
        } catch {
          // Build request may fail, ignore
        }

        // Step 4: Wait for SSL certificate to be provisioned
        let certReady = false;
        let certState: string | null = null;
        let certError: string | undefined;

        try {
          const certResult = await githubAdapter.waitForCertificate(owner, repo, {
            maxWaitMs: 90000, // Wait up to 90 seconds
            pollIntervalMs: 5000,
          });
          certReady = certResult.ready;
          certState = certResult.state;
          certError = certResult.error;

          githubResults.push({
            setting: 'SSL certificate',
            success: certReady,
            error: certReady ? undefined : certError ?? `Certificate state: ${certState ?? 'unknown'}`,
          });
        } catch (error) {
          githubResults.push({
            setting: 'SSL certificate',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 5: Enable HTTPS enforcement (only if certificate is ready)
        if (certReady) {
          try {
            await githubAdapter.enableHttpsEnforcement(owner, repo);
            githubResults.push({
              setting: 'HTTPS enforcement',
              success: true,
            });
          } catch (error) {
            githubResults.push({
              setting: 'HTTPS enforcement',
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          githubResults.push({
            setting: 'HTTPS enforcement',
            success: false,
            error: 'Skipped - certificate not yet provisioned. Enable manually in GitHub Settings > Pages once certificate is ready.',
          });
        }

        const allDnsSucceeded = dnsResults.every(r => r.success);
        const allGitHubSucceeded = githubResults.every(r => r.success);
        const overallSuccess = allDnsSucceeded && githubResults.some(r => r.setting === 'Custom domain' && r.success);

        // Audit log
        auditRepo.create({
          action: 'github.pages_setup',
          resourceType: 'github_pages',
          resourceId: `${owner}/${repo}`,
          details: {
            domain,
            dnsResults,
            githubResults,
            success: overallSuccess,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: overallSuccess,
              mode: 'executed',
              repository: `${owner}/${repo}`,
              domain,
              pagesWasEnabled,
              dnsResults,
              githubResults,
              message: allGitHubSucceeded
                ? `GitHub Pages configured for ${domain} with HTTPS enabled.`
                : overallSuccess
                  ? `GitHub Pages configured for ${domain}. SSL certificate pending.`
                  : 'Setup completed with some errors. Check results above.',
              nextSteps: !allGitHubSucceeded && allDnsSucceeded ? [
                'DNS records created successfully.',
                'SSL certificate is still being provisioned by GitHub (can take up to 24 hours).',
                'Run github_pages_status to check certificate state.',
                'Once certificate shows as "issued", HTTPS will be automatically enforced.',
              ] : undefined,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_ai_review_setup',
    'Create a GitHub Actions workflow for AI-powered PR code review using Claude. Two-step: preview shows planned changes, confirm creates workflow + sets secret.',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      apiKey: z.string().describe('Anthropic API key for Claude'),
      model: z.string().optional().describe('Claude model to use (default: claude-sonnet-4-20250514)'),
      confirm: z.boolean().optional().describe('Set to true to actually create the workflow and set the secret'),
    },
    async ({ owner, repo, apiKey, model, confirm }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;
      const claudeModel = model ?? AI_REVIEW_DEFAULT_MODEL;

      const workflowContent = buildAiReviewWorkflowContent(claudeModel);

      const workflowPath = AI_REVIEW_WORKFLOW_PATH;

      // Preview mode
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Review the planned changes and call again with confirm=true to apply.',
              repository: `${owner}/${repo}`,
              plannedChanges: [
                {
                  action: 'create/update',
                  path: workflowPath,
                  description: `GitHub Actions workflow that reviews PRs using Claude (${claudeModel})`,
                },
                {
                  action: 'set',
                  type: 'repository_secret',
                  name: 'ANTHROPIC_API_KEY',
                  description: 'Anthropic API key for Claude API calls',
                },
              ],
              workflowTriggers: ['pull_request: opened', 'pull_request: synchronize'],
            }),
          }],
        };
      }

      // Confirm mode — create workflow and set secret
      try {
        const fileResult = await adapter.createOrUpdateFile(
          owner,
          repo,
          workflowPath,
          workflowContent,
          'Add AI code review workflow'
        );

        let secretSet = false;
        let secretError: string | undefined;
        try {
          await adapter.setRepositorySecret(owner, repo, 'ANTHROPIC_API_KEY', apiKey);
          secretSet = true;
        } catch (error) {
          secretError = error instanceof Error ? error.message : String(error);
        }

        auditRepo.create({
          action: 'github.ai_review_setup',
          resourceType: 'github_workflow',
          resourceId: `${owner}/${repo}`,
          details: {
            workflowCreated: fileResult.created,
            workflowUpdated: fileResult.updated,
            secretSet,
            model: claudeModel,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'executed',
              repository: `${owner}/${repo}`,
              workflow: {
                path: workflowPath,
                created: fileResult.created,
                updated: fileResult.updated,
              },
              secret: {
                name: 'ANTHROPIC_API_KEY',
                set: secretSet,
                error: secretError,
              },
              model: claudeModel,
              message: secretSet
                ? `AI code review workflow created. PRs will be reviewed by Claude (${claudeModel}).`
                : `Workflow created but failed to set ANTHROPIC_API_KEY secret: ${secretError}. Set it manually in repo Settings > Secrets.`,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // ============= Repository Secrets Tools =============

  server.tool(
    'github_secrets_list',
    'List repository secret names (values are never exposed)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        const secrets = await result.adapter.listSecrets(owner, repo);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              total_count: secrets.total_count,
              secrets: secrets.secrets.map(s => ({
                name: s.name,
                created_at: s.created_at,
                updated_at: s.updated_at,
              })),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_secret_set',
    'Set or update a repository secret',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      secretName: z.string().describe('Secret name (uppercase with underscores, e.g., API_KEY)'),
      secretValue: z.string().describe('Secret value'),
    },
    async ({ owner, repo, secretName, secretValue }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        // Check if secret exists before setting to determine action
        const existingSecrets = await result.adapter.listSecrets(owner, repo);
        const exists = existingSecrets.secrets.some(s => s.name === secretName);

        await result.adapter.setRepositorySecret(owner, repo, secretName, secretValue);

        auditRepo.create({
          action: exists ? 'github.secret_updated' : 'github.secret_created',
          resourceType: 'github_secret',
          resourceId: `${owner}/${repo}/${secretName}`,
          details: { secretName },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              secretName,
              action: exists ? 'updated' : 'created',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_secret_delete',
    'Delete a repository secret',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      secretName: z.string().describe('Secret name to delete'),
    },
    async ({ owner, repo, secretName }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        await result.adapter.deleteSecret(owner, repo, secretName);

        auditRepo.create({
          action: 'github.secret_deleted',
          resourceType: 'github_secret',
          resourceId: `${owner}/${repo}/${secretName}`,
          details: { secretName },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              secretName,
              deleted: true,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // ============= Workflow Tools =============

  server.tool(
    'github_workflows_list',
    'List workflows in a repository',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        const workflows = await result.adapter.listWorkflows(owner, repo);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              total_count: workflows.total_count,
              workflows: workflows.workflows.map(w => ({
                id: w.id,
                name: w.name,
                path: w.path,
                state: w.state,
                created_at: w.created_at,
              })),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_workflow_runs',
    'Get recent runs for a workflow',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      workflowId: z.string().describe('Workflow ID (number) or filename (e.g., "test.yml")'),
      status: z.string().optional().describe('Filter by status (queued, in_progress, completed)'),
      limit: z.number().optional().describe('Maximum number of runs to return (default: 10)'),
    },
    async ({ owner, repo, workflowId, status, limit }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        const runs = await result.adapter.listWorkflowRuns(owner, repo, workflowId, {
          status,
          per_page: limit ?? 10,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              workflowId,
              total_count: runs.total_count,
              runs: runs.workflow_runs.map(r => ({
                id: r.id,
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                created_at: r.created_at,
                head_sha: r.head_sha.substring(0, 7),
                head_branch: r.head_branch,
                event: r.event,
                url: r.html_url,
              })),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_workflow_trigger',
    'Manually trigger a workflow (requires workflow_dispatch trigger)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      workflowId: z.string().describe('Workflow ID (number) or filename (e.g., "deploy.yml")'),
      ref: z.string().optional().describe('Git ref to run workflow on (default: main)'),
      inputs: z.record(z.string()).optional().describe('Workflow inputs as key-value pairs'),
    },
    async ({ owner, repo, workflowId, ref, inputs }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        await result.adapter.triggerWorkflow(owner, repo, workflowId, ref ?? 'main', inputs);

        auditRepo.create({
          action: 'github.workflow_triggered',
          resourceType: 'github_workflow',
          resourceId: `${owner}/${repo}/${workflowId}`,
          details: { workflowId, ref: ref ?? 'main', inputs },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              workflowId,
              ref: ref ?? 'main',
              message: 'Workflow dispatch event triggered. Use github_workflow_runs to check status.',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'deploy_branch_setup',
    'Set up branch-based deploy workflows for a provider using the project\'s actual environments and desired deploy state',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      projectName: z.string().optional().describe('Optional Hypervibe project name override for resolving environments/desired state'),
      provider: z.enum(['railway', 'vercel', 'render', 'digitalocean']).describe('Deployment provider'),
      protectBranches: z.boolean().optional().describe('Set true to configure branch protection for the deploy branches'),
      ignoreBranchProtection: z.boolean().optional().describe('Set true to skip branch protection setup even if protectBranches=true'),
      statusChecks: z.array(z.string()).optional().describe('Required status checks for branch protection'),
      requiredReviewers: z.number().optional().describe('Number of required PR reviewers (default: 1)'),
      confirm: z.boolean().optional().describe('Set to true to create/update the workflows'),
    },
    async ({ owner, repo, projectName, provider, protectBranches, ignoreBranchProtection, statusChecks, requiredReviewers, confirm }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const verification = await result.adapter.verify();
      if (!verification.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: verification.error || 'GitHub connection verification failed',
            }),
          }],
        };
      }

      const project = resolveBranchDeployProject(owner, repo, projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No Hypervibe project matched ${owner}/${repo}. Pass projectName explicitly or ensure the project's gitRemoteUrl matches this repository.`,
            }),
          }],
        };
      }

      const { targets, migration, skippedEnvironments } = resolveBranchDeployTargets(project);
      if (targets.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Project "${project.name}" has no deployable staging/production environments for branch setup.`,
              skippedEnvironments,
            }),
          }],
        };
      }

      const workflows = targets.map((target) => buildBranchDeployWorkflow(provider, target, migration));

      const uniqueRequiredSecrets = Array.from(new Set(workflows.flatMap((workflow) => workflow.requiredSecrets)));
      const uniqueRequiredVariables = Array.from(new Set(workflows.flatMap((workflow) => workflow.requiredVariables)));
      const shouldProtectBranches = protectBranches === true && ignoreBranchProtection !== true;
      const protectedBranches = Array.from(new Set(targets.map((target) => target.branch)));
      const branchProtectionPlan = shouldProtectBranches
        ? {
            branches: protectedBranches,
            rules: {
              requireReviews: true,
              requiredReviewers: requiredReviewers ?? 1,
              dismissStaleReviews: true,
              requireCodeOwnerReviews: false,
              requireStatusChecks: (statusChecks?.length ?? 0) > 0,
              statusChecks: statusChecks ?? [],
              strictStatusChecks: true,
              enforceAdmins: true,
              requireLinearHistory: false,
              allowForcePushes: false,
              allowDeletions: false,
            },
          }
        : null;

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              provider,
              project: project.name,
              repository: `${owner}/${repo}`,
              branchMapping: Object.fromEntries(targets.map((target) => [target.kind, target.branch])),
              message: 'Review planned workflows and call again with confirm=true to apply.',
              workflows,
              requiredSecrets: uniqueRequiredSecrets,
              requiredVariables: uniqueRequiredVariables,
              branchProtection: branchProtectionPlan,
              notes: [
                ...(migration.includeStep
                  ? targets.map((target) => `Set secret DATABASE_URL in GitHub Environment "${target.environmentName}" for the migration step.`)
                  : []),
                ...(migration.note ? [migration.note] : []),
                ...(skippedEnvironments.length > 0
                  ? [`Skipped unsupported/custom environments: ${skippedEnvironments.join(', ')}`]
                  : []),
              ],
            }),
          }],
        };
      }

      const workflowResults: Array<{
        template: string;
        templateName: string;
        branch: string;
        path: string;
        created: boolean;
        updated: boolean;
      }> = [];
      const errors: Array<{ template: string; path: string; error: string }> = [];
      const branchProtectionResults: Array<{
        branch: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const workflow of workflows) {
        try {
          const fileResult = await result.adapter.createOrUpdateFile(
            owner,
            repo,
            workflow.path,
            workflow.content,
            `Add ${workflow.templateName} workflow`
          );

          workflowResults.push({
            template: workflow.template,
            templateName: workflow.templateName,
            branch: workflow.branch,
            path: workflow.path,
            created: fileResult.created,
            updated: fileResult.updated,
          });
        } catch (error) {
          errors.push({
            template: workflow.template,
            path: workflow.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (errors.length === 0 && shouldProtectBranches && branchProtectionPlan) {
        for (const branch of branchProtectionPlan.branches) {
          try {
            await result.adapter.updateBranchProtection(owner, repo, branch, branchProtectionPlan.rules);
            branchProtectionResults.push({ branch, success: true });
          } catch (error) {
            branchProtectionResults.push({
              branch,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      auditRepo.create({
        action: 'github.workflow_created',
        resourceType: 'github_workflow',
        resourceId: `${owner}/${repo}/branch-deploy/${provider}`,
        details: {
          project: project.name,
          provider,
          branchMapping: Object.fromEntries(targets.map((target) => [target.kind, target.branch])),
          workflows: workflowResults,
          errors,
          branchProtection: branchProtectionResults,
        },
      });

      const protectionFailures = branchProtectionResults.filter((r) => !r.success);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: errors.length === 0 && protectionFailures.length === 0,
            mode: 'executed',
            provider,
            project: project.name,
            repository: `${owner}/${repo}`,
            branchMapping: Object.fromEntries(targets.map((target) => [target.kind, target.branch])),
            workflows: workflowResults,
            errors,
            branchProtection: {
              enabled: shouldProtectBranches && errors.length === 0,
              results: branchProtectionResults,
              rules: branchProtectionPlan?.rules ?? null,
            },
            requiredSecrets: uniqueRequiredSecrets,
            requiredVariables: uniqueRequiredVariables,
            notes: [
              ...(migration.includeStep
                ? targets.map((target) => `Set secret DATABASE_URL in GitHub Environment "${target.environmentName}" for the migration step.`)
                : []),
              ...(migration.note ? [migration.note] : []),
              ...(skippedEnvironments.length > 0
                ? [`Skipped unsupported/custom environments: ${skippedEnvironments.join(', ')}`]
                : []),
            ],
          }),
        }],
      };
    }
  );

  server.tool(
    'github_workflow_create',
    'Create a workflow from common templates (two-step: preview then confirm)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      template: z.enum([
        'node-test',
        'python-test',
        'deploy-railway',
        'deploy-railway-staging',
        'deploy-railway-production',
        'deploy-vercel-staging',
        'deploy-vercel-production',
        'deploy-render-staging',
        'deploy-render-production',
        'deploy-digitalocean-staging',
        'deploy-digitalocean-production',
        'lint',
      ]).describe('Workflow template to use'),
      confirm: z.boolean().optional().describe('Set to true to create the workflow'),
    },
    async ({ owner, repo, template, confirm }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const tmpl = WORKFLOW_TEMPLATES[template];
      if (!tmpl) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Unknown template: ${template}. Available: ${Object.keys(WORKFLOW_TEMPLATES).join(', ')}`,
            }),
          }],
        };
      }

      const workflowPath = `.github/workflows/${tmpl.filename}`;

      // Preview mode
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Review the workflow and call again with confirm=true to create.',
              repository: `${owner}/${repo}`,
              template,
              templateName: tmpl.name,
              path: workflowPath,
              content: tmpl.content,
              requiredSecrets: tmpl.requiredSecrets ?? [],
              requiredVariables: tmpl.requiredVariables ?? [],
            }),
          }],
        };
      }

      try {
        const fileResult = await result.adapter.createOrUpdateFile(
          owner,
          repo,
          workflowPath,
          tmpl.content,
          `Add ${tmpl.name} workflow`
        );

        auditRepo.create({
          action: 'github.workflow_created',
          resourceType: 'github_workflow',
          resourceId: `${owner}/${repo}/${workflowPath}`,
          details: { template, path: workflowPath, created: fileResult.created, updated: fileResult.updated },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'executed',
              repository: `${owner}/${repo}`,
              template,
              templateName: tmpl.name,
              path: workflowPath,
              created: fileResult.created,
              updated: fileResult.updated,
              requiredSecrets: tmpl.requiredSecrets ?? [],
              requiredVariables: tmpl.requiredVariables ?? [],
              message: fileResult.created
                ? `Workflow "${tmpl.name}" created at ${workflowPath}.`
                : `Workflow "${tmpl.name}" updated at ${workflowPath}.`,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // ============= Branch Protection Tools =============

  server.tool(
    'github_branch_protection_get',
    'Get branch protection rules for a branch',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      branch: z.string().describe('Branch name (e.g., main)'),
    },
    async ({ owner, repo, branch }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      try {
        const protection = await result.adapter.getBranchProtection(owner, repo, branch);

        if (!protection) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                repository: `${owner}/${repo}`,
                branch,
                protected: false,
                message: `Branch "${branch}" has no protection rules.`,
              }),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              repository: `${owner}/${repo}`,
              branch,
              protected: true,
              rules: {
                requireReviews: !!protection.required_pull_request_reviews,
                requiredReviewers: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
                dismissStaleReviews: protection.required_pull_request_reviews?.dismiss_stale_reviews ?? false,
                requireCodeOwnerReviews: protection.required_pull_request_reviews?.require_code_owner_reviews ?? false,
                requireStatusChecks: !!protection.required_status_checks,
                statusChecks: protection.required_status_checks?.contexts ?? [],
                strictStatusChecks: protection.required_status_checks?.strict ?? false,
                enforceAdmins: protection.enforce_admins?.enabled ?? false,
                requireLinearHistory: protection.required_linear_history?.enabled ?? false,
                allowForcePushes: protection.allow_force_pushes?.enabled ?? false,
                allowDeletions: protection.allow_deletions?.enabled ?? false,
              },
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'github_branch_protection_set',
    'Create or update branch protection rules (two-step: preview then confirm)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      branch: z.string().describe('Branch name (e.g., main)'),
      requireReviews: z.boolean().optional().describe('Require pull request reviews'),
      requiredReviewers: z.number().optional().describe('Number of required reviewers (default: 1)'),
      dismissStaleReviews: z.boolean().optional().describe('Dismiss stale reviews on new commits'),
      requireCodeOwnerReviews: z.boolean().optional().describe('Require code owner reviews'),
      requireStatusChecks: z.boolean().optional().describe('Require status checks to pass'),
      statusChecks: z.array(z.string()).optional().describe('List of required status check contexts'),
      strictStatusChecks: z.boolean().optional().describe('Require branches to be up to date (default: true)'),
      enforceAdmins: z.boolean().optional().describe('Enforce rules for admins too'),
      requireLinearHistory: z.boolean().optional().describe('Require linear commit history'),
      allowForcePushes: z.boolean().optional().describe('Allow force pushes'),
      allowDeletions: z.boolean().optional().describe('Allow branch deletion'),
      confirm: z.boolean().optional().describe('Set to true to apply the changes'),
    },
    async (params) => {
      const { owner, repo, branch, confirm, ...rules } = params;

      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      // Get current protection for comparison
      const currentProtection = await result.adapter.getBranchProtection(owner, repo, branch);

      // Preview mode
      if (!confirm) {
        const plannedRules = {
          requireReviews: rules.requireReviews ?? false,
          requiredReviewers: rules.requiredReviewers ?? 1,
          dismissStaleReviews: rules.dismissStaleReviews ?? false,
          requireCodeOwnerReviews: rules.requireCodeOwnerReviews ?? false,
          requireStatusChecks: rules.requireStatusChecks ?? false,
          statusChecks: rules.statusChecks ?? [],
          strictStatusChecks: rules.strictStatusChecks ?? true,
          enforceAdmins: rules.enforceAdmins ?? false,
          requireLinearHistory: rules.requireLinearHistory ?? false,
          allowForcePushes: rules.allowForcePushes ?? false,
          allowDeletions: rules.allowDeletions ?? false,
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Review the planned rules and call again with confirm=true to apply.',
              repository: `${owner}/${repo}`,
              branch,
              currentlyProtected: !!currentProtection,
              currentRules: currentProtection ? {
                requireReviews: !!currentProtection.required_pull_request_reviews,
                requiredReviewers: currentProtection.required_pull_request_reviews?.required_approving_review_count ?? 0,
                requireStatusChecks: !!currentProtection.required_status_checks,
                statusChecks: currentProtection.required_status_checks?.contexts ?? [],
                enforceAdmins: currentProtection.enforce_admins?.enabled ?? false,
              } : null,
              plannedRules,
            }),
          }],
        };
      }

      try {
        await result.adapter.updateBranchProtection(owner, repo, branch, rules);

        auditRepo.create({
          action: 'github.branch_protection_updated',
          resourceType: 'github_branch',
          resourceId: `${owner}/${repo}/${branch}`,
          details: { branch, rules },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'executed',
              repository: `${owner}/${repo}`,
              branch,
              message: `Branch protection rules updated for "${branch}".`,
              appliedRules: rules,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );
}
