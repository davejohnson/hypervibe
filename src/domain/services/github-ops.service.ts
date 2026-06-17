import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema } from '../spec/spec.schema.js';
import { formatConnectionGuidance } from './connection-guidance.js';

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
    content: buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS'],
  },
  'deploy-railway-staging': {
    name: 'Deploy Railway (staging)',
    filename: 'deploy-railway-staging.yml',
    content: buildBranchDeployWorkflow('railway', {
      environmentName: 'staging',
      kind: 'staging',
      branch: 'staging',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS'],
  },
  'deploy-railway-production': {
    name: 'Deploy Railway (production)',
    filename: 'deploy-railway-production.yml',
    content: buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS'],
  },
  'deploy-vercel-staging': {
    name: 'Deploy Vercel (staging)',
    filename: 'deploy-vercel-staging.yml',
    content: buildBranchDeployWorkflow('vercel', {
      environmentName: 'staging',
      kind: 'staging',
      branch: 'staging',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['VERCEL_DEPLOY_HOOK_URL'],
  },
  'deploy-vercel-production': {
    name: 'Deploy Vercel (production)',
    filename: 'deploy-vercel-production.yml',
    content: buildBranchDeployWorkflow('vercel', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['VERCEL_DEPLOY_HOOK_URL'],
  },
  'deploy-render-staging': {
    name: 'Deploy Render (staging)',
    filename: 'deploy-render-staging.yml',
    content: buildBranchDeployWorkflow('render', {
      environmentName: 'staging',
      kind: 'staging',
      branch: 'staging',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['RENDER_API_KEY'],
    requiredVariables: ['RENDER_SERVICE_IDS'],
  },
  'deploy-render-production': {
    name: 'Deploy Render (production)',
    filename: 'deploy-render-production.yml',
    content: buildBranchDeployWorkflow('render', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['RENDER_API_KEY'],
    requiredVariables: ['RENDER_SERVICE_IDS'],
  },
  'deploy-digitalocean-staging': {
    name: 'Deploy DigitalOcean App Platform (staging)',
    filename: 'deploy-digitalocean-staging.yml',
    content: buildBranchDeployWorkflow('digitalocean', {
      environmentName: 'staging',
      kind: 'staging',
      branch: 'staging',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['DO_APP_ID', 'DO_SERVICE_NAMES'],
  },
  'deploy-digitalocean-production': {
    name: 'Deploy DigitalOcean App Platform (production)',
    filename: 'deploy-digitalocean-production.yml',
    content: buildBranchDeployWorkflow('digitalocean', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      serviceNames: [],
      providerServiceIds: [],
      providerServiceArns: [],
    }, { includeStep: false }).content,
    requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['DO_APP_ID', 'DO_SERVICE_NAMES'],
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
  const connection = connectionRepo.findBestMatch('github', scopeHint);
  if (!connection) {
    return { error: `No GitHub connection found. ${formatConnectionGuidance('github', { scope: scopeHint })}` };
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

export type BranchDeployProvider =
  | 'railway'
  | 'vercel'
  | 'render'
  | 'digitalocean'
  | 'cloudrun'
  | 'apprunner'
  | 'heroku';
export type BranchDeployEnvironmentKind = 'staging' | 'production';

export interface BranchDeployTarget {
  environmentName: string;
  kind: BranchDeployEnvironmentKind;
  branch: string;
  serviceNames: string[];
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerServiceArns: string[];
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

function environmentBindings(projectId: string, environmentName: string): {
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerServiceArns: string[];
  boundServiceNames: string[];
} {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds = Object.values(services ?? {})
    .map((service) => asRecord(service)?.serviceId)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const providerServiceArns = Object.values(services ?? {})
    .map((service) => asRecord(service)?.serviceArn)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return {
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    providerServiceIds,
    providerServiceArns,
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

      const branch = envSpec.deploy.branch ?? (kind === 'production' ? 'main' : 'staging');
      desiredBranches[kind] = branch;
      const bindings = environmentBindings(project.id, environmentName);
      const serviceNames = Object.keys(envSpec.services);
      targetsByKind.set(kind, {
        environmentName,
        kind,
        branch,
        serviceNames: serviceNames.length > 0 ? serviceNames : bindings.boundServiceNames,
        providerProjectId: bindings.providerProjectId,
        providerEnvironmentId: bindings.providerEnvironmentId,
        providerServiceIds: bindings.providerServiceIds,
        providerServiceArns: bindings.providerServiceArns,
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
        : desiredBranches.staging ?? 'staging',
      serviceNames: desiredServiceNames.length > 0 ? desiredServiceNames : bindings.boundServiceNames,
      providerProjectId: bindings.providerProjectId,
      providerEnvironmentId: bindings.providerEnvironmentId,
      providerServiceIds: bindings.providerServiceIds,
      providerServiceArns: bindings.providerServiceArns,
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

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function variableExpression(name: string): string {
  return `\${{ vars.${name} }}`;
}

function providerValueOrVariable(value: string | undefined, variableName: string): string {
  return value && value.trim().length > 0
    ? yamlSingleQuoted(value.trim())
    : variableExpression(variableName);
}

function providerListValueOrVariable(values: string[], variableName: string): string {
  return values.length > 0
    ? yamlSingleQuoted(values.join(','))
    : variableExpression(variableName);
}

function buildProviderDeploySteps(provider: BranchDeployProvider, kind: BranchDeployEnvironmentKind, target: BranchDeployTarget): {
  steps: string;
  requiredSecrets: string[];
  requiredVariables: string[];
} {
  switch (provider) {
    case 'railway': {
      const railwayEnvironmentId = providerValueOrVariable(target.providerEnvironmentId, 'RAILWAY_ENVIRONMENT_ID');
      const railwayServiceIds = target.providerServiceIds.length > 0
        ? yamlSingleQuoted(target.providerServiceIds.join(','))
        : variableExpression('RAILWAY_SERVICE_IDS');
      const requiredVariables = [
        ...(!target.providerEnvironmentId ? ['RAILWAY_ENVIRONMENT_ID'] : []),
        ...(target.providerServiceIds.length === 0 ? ['RAILWAY_SERVICE_IDS'] : []),
      ];
      return {
        steps: `      - name: Resolve image URI
        id: image
        uses: actions/github-script@v7
        with:
          script: |
            const repo = process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('uri', 'ghcr.io/' + repo + ':' + process.env.GITHUB_SHA);
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Verify Railway image pull credentials
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ secrets.IMAGE_REGISTRY_USERNAME }}
          password: \${{ secrets.IMAGE_REGISTRY_TOKEN }}
      - name: Verify Railway can read image
        run: docker buildx imagetools inspect "\${{ steps.image.outputs.uri }}" >/dev/null
      - name: Deploy image to Railway
        uses: actions/github-script@v7
        env:
          RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}
          RAILWAY_ENVIRONMENT_ID: ${railwayEnvironmentId}
          RAILWAY_SERVICE_IDS: ${railwayServiceIds}
          IMAGE_REGISTRY_USERNAME: \${{ secrets.IMAGE_REGISTRY_USERNAME }}
          IMAGE_REGISTRY_TOKEN: \${{ secrets.IMAGE_REGISTRY_TOKEN }}
          IMAGE_URI: \${{ steps.image.outputs.uri }}
        with:
          script: |
            const endpoint = 'https://backboard.railway.app/graphql/v2';
            const required = ['RAILWAY_API_TOKEN', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const serviceIds = process.env.RAILWAY_SERVICE_IDS.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceIds.length === 0) throw new Error('RAILWAY_SERVICE_IDS is empty');

            async function railway(query, variables) {
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + process.env.RAILWAY_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables }),
              });
              const body = await response.text();
              if (!response.ok) throw new Error('Railway API ' + response.status + ': ' + body);
              const payload = JSON.parse(body);
              if (payload.errors && payload.errors.length > 0) {
                throw new Error(payload.errors.map((error) => error.message).join('; '));
              }
              return payload.data;
            }

            const updateMutation = 'mutation UpdateServiceImage($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }';
            const deployMutation = 'mutation DeployServiceImage($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
            const deploymentQuery = 'query DeploymentStatus($id: String!) { deployment(id: $id) { id status url staticUrl diagnosis meta } }';
            const buildLogsQuery = 'query BuildLogs($deploymentId: String!, $limit: Int) { buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp severity message } }';
            const deploymentLogsQuery = 'query DeploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp severity message } }';
            const successStatuses = new Set(['SUCCESS']);
            const failedStatuses = new Set(['CRASHED', 'FAILED', 'REMOVED', 'SKIPPED']);

            function shortJson(value) {
              if (value === null || value === undefined) return '';
              if (typeof value === 'string') return value;
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            }

            function summarizeDeployment(deployment) {
              const parts = [];
              const diagnosis = shortJson(deployment.diagnosis);
              const meta = shortJson(deployment.meta);
              if (diagnosis) parts.push('diagnosis=' + diagnosis);
              if (meta) parts.push('meta=' + meta);
              return parts.join(' ');
            }

            function formatLogs(logs) {
              return (logs || [])
                .slice(-25)
                .map((log) => [log.timestamp, log.severity, log.message].filter(Boolean).join(' '))
                .filter(Boolean)
                .join('\\n');
            }

            async function logsFor(deploymentId) {
              const sections = [];
              for (const entry of [
                ['build logs', buildLogsQuery, 'buildLogs'],
                ['deployment logs', deploymentLogsQuery, 'deploymentLogs'],
              ]) {
                try {
                  const data = await railway(entry[1], { deploymentId, limit: 100 });
                  const lines = formatLogs(data[entry[2]]);
                  if (lines) sections.push(entry[0] + ':\\n' + lines);
                } catch (error) {
                  core.warning('Could not read Railway ' + entry[0] + ' for ' + deploymentId + ': ' + error.message);
                }
              }
              return sections.join('\\n\\n');
            }

            async function waitForDeployment(deploymentId, serviceId) {
              for (let attempt = 0; attempt < 90; attempt++) {
                const data = await railway(deploymentQuery, { id: deploymentId });
                const deployment = data.deployment;
                const status = deployment.status;
                core.info('Railway deployment ' + deploymentId + ' for service ' + serviceId + ' status: ' + status);
                if (successStatuses.has(status)) return deployment;
                if (failedStatuses.has(status)) {
                  const summary = summarizeDeployment(deployment);
                  const logs = await logsFor(deploymentId);
                  throw new Error(
                    'Railway deployment ' + deploymentId + ' for service ' + serviceId + ' failed with status ' + status
                    + (summary ? '. ' + summary : '')
                    + (logs ? '\\n\\nRecent Railway logs:\\n' + logs : '')
                  );
                }
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
              const logs = await logsFor(deploymentId);
              throw new Error('Timed out waiting for Railway deployment ' + deploymentId + ' for service ' + serviceId + (logs ? '\\n\\nRecent Railway logs:\\n' + logs : ''));
            }

            for (const serviceId of serviceIds) {
              await railway(updateMutation, {
                serviceId,
                environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                input: {
                  source: { image: process.env.IMAGE_URI },
                  registryCredentials: {
                    username: process.env.IMAGE_REGISTRY_USERNAME,
                    password: process.env.IMAGE_REGISTRY_TOKEN,
                  },
                },
              });
              const deploymentId = await railway(deployMutation, {
                serviceId,
                environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                commitSha: process.env.GITHUB_SHA,
              });
              await waitForDeployment(deploymentId, serviceId);
            }
`,
        requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
        requiredVariables,
      };
    }
    case 'vercel':
      return {
        steps: `      - name: Trigger Vercel deploy hook
        uses: actions/github-script@v7
        env:
          VERCEL_DEPLOY_HOOK_URL: \${{ secrets.VERCEL_DEPLOY_HOOK_URL }}
        with:
          script: |
            if (!process.env.VERCEL_DEPLOY_HOOK_URL) throw new Error('VERCEL_DEPLOY_HOOK_URL is required');
            const response = await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' });
            if (!response.ok) throw new Error('Vercel deploy hook failed: ' + response.status + ' ' + await response.text());
`,
        requiredSecrets: ['VERCEL_DEPLOY_HOOK_URL'],
        requiredVariables: [],
      };
    case 'render':
      {
        const renderServiceIds = providerListValueOrVariable(target.providerServiceIds, 'RENDER_SERVICE_IDS');
        const requiredVariables = target.providerServiceIds.length === 0 ? ['RENDER_SERVICE_IDS'] : [];
        return {
          steps: `      - name: Trigger Render deployment
        uses: actions/github-script@v7
        env:
          RENDER_API_KEY: \${{ secrets.RENDER_API_KEY }}
          RENDER_SERVICE_IDS: ${renderServiceIds}
        with:
          script: |
            if (!process.env.RENDER_API_KEY) throw new Error('RENDER_API_KEY is required');
            const serviceIds = process.env.RENDER_SERVICE_IDS.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceIds.length === 0) throw new Error('RENDER_SERVICE_IDS is empty');
            for (const serviceId of serviceIds) {
              const response = await fetch('https://api.render.com/v1/services/' + encodeURIComponent(serviceId) + '/deploys', {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + process.env.RENDER_API_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
              });
              if (!response.ok) throw new Error('Render deployment failed for ' + serviceId + ': ' + response.status + ' ' + await response.text());
            }
`,
          requiredSecrets: ['RENDER_API_KEY'],
          requiredVariables,
        };
      }
    case 'digitalocean': {
      const doAppId = providerValueOrVariable(target.providerProjectId, 'DO_APP_ID');
      const doServiceNames = providerListValueOrVariable(
        target.serviceNames.length > 0 ? target.serviceNames : target.providerServiceIds,
        'DO_SERVICE_NAMES'
      );
      const requiredVariables = [
        ...(target.providerProjectId ? [] : ['DO_APP_ID']),
        ...(target.serviceNames.length > 0 || target.providerServiceIds.length > 0 ? [] : ['DO_SERVICE_NAMES']),
      ];
      return {
        steps: `      - name: Resolve DigitalOcean image URI
        id: image
        uses: actions/github-script@v7
        with:
          script: |
            const repo = process.env.GITHUB_REPOSITORY.toLowerCase();
            const [owner, name] = repo.split('/');
            core.setOutput('registry', 'ghcr.io');
            core.setOutput('registry_owner', owner);
            core.setOutput('repository', name);
            core.setOutput('tag', process.env.GITHUB_SHA);
            core.setOutput('uri', 'ghcr.io/' + repo + ':' + process.env.GITHUB_SHA);
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Deploy image to DigitalOcean App Platform
        uses: actions/github-script@v7
        env:
          DIGITALOCEAN_ACCESS_TOKEN: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
          DO_APP_ID: ${doAppId}
          DO_SERVICE_NAMES: ${doServiceNames}
          IMAGE_REGISTRY_USERNAME: \${{ secrets.IMAGE_REGISTRY_USERNAME }}
          IMAGE_REGISTRY_TOKEN: \${{ secrets.IMAGE_REGISTRY_TOKEN }}
          IMAGE_REGISTRY_OWNER: \${{ steps.image.outputs.registry_owner }}
          IMAGE_REPOSITORY: \${{ steps.image.outputs.repository }}
          IMAGE_TAG: \${{ steps.image.outputs.tag }}
        with:
          script: |
            if (!process.env.DIGITALOCEAN_ACCESS_TOKEN) throw new Error('DIGITALOCEAN_ACCESS_TOKEN is required');
            if (!process.env.DO_APP_ID) throw new Error('DO_APP_ID is required');
            const required = ['DO_SERVICE_NAMES', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'IMAGE_REGISTRY_OWNER', 'IMAGE_REPOSITORY', 'IMAGE_TAG'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const serviceNames = process.env.DO_SERVICE_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceNames.length === 0) throw new Error('DO_SERVICE_NAMES is empty');
            async function digitalOcean(method, path, body) {
              const response = await fetch('https://api.digitalocean.com/v2' + path, {
                method,
                headers: {
                  Authorization: 'Bearer ' + process.env.DIGITALOCEAN_ACCESS_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: body ? JSON.stringify(body) : undefined,
              });
              const text = await response.text();
              if (!response.ok) throw new Error('DigitalOcean API ' + method + ' ' + path + ' failed: ' + response.status + ' ' + text);
              return text ? JSON.parse(text) : {};
            }
            const payload = await digitalOcean('GET', '/apps/' + process.env.DO_APP_ID);
            const spec = payload.app.spec;
            const services = spec.services || [];
            for (const serviceName of serviceNames) {
              const service = services.find((candidate) => candidate.name === serviceName);
              if (!service) throw new Error('DigitalOcean service not found in app spec: ' + serviceName);
              delete service.bitbucket;
              delete service.git;
              delete service.github;
              delete service.gitlab;
              delete service.build_command;
              delete service.dockerfile_path;
              delete service.environment_slug;
              delete service.source_dir;
              service.image = {
                registry_type: 'GHCR',
                registry: process.env.IMAGE_REGISTRY_OWNER,
                repository: process.env.IMAGE_REPOSITORY,
                tag: process.env.IMAGE_TAG,
                registry_credentials: process.env.IMAGE_REGISTRY_USERNAME + ':' + process.env.IMAGE_REGISTRY_TOKEN,
              };
            }
            await digitalOcean('PUT', '/apps/' + process.env.DO_APP_ID, { spec });
            const deployment = await fetch('https://api.digitalocean.com/v2/apps/' + process.env.DO_APP_ID + '/deployments', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + process.env.DIGITALOCEAN_ACCESS_TOKEN,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ force_build: true }),
            });
            if (!deployment.ok) throw new Error('DigitalOcean deployment failed: ' + deployment.status + ' ' + await deployment.text());
`,
        requiredSecrets: ['DIGITALOCEAN_ACCESS_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
        requiredVariables,
      };
    }
    case 'cloudrun': {
      const cloudRunServiceNames = providerListValueOrVariable(target.providerServiceIds, 'CLOUDRUN_SERVICE_NAMES');
      const requiredVariables = target.providerServiceIds.length === 0 ? ['CLOUDRUN_SERVICE_NAMES'] : [];
      return {
        steps: `      - name: Resolve Cloud Run image URI
        id: image
        uses: actions/github-script@v7
        env:
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          GCP_ARTIFACT_REPOSITORY: \${{ vars.GCP_ARTIFACT_REPOSITORY }}
        with:
          script: |
            for (const key of ['GCP_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const registry = process.env.GCP_REGION + '-docker.pkg.dev';
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'infraprint';
            const imageName = process.env.GITHUB_REPOSITORY.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
            core.setOutput('registry', registry);
            core.setOutput('repository', repository);
            core.setOutput('uri', registry + '/' + process.env.GCP_PROJECT_ID + '/' + repository + '/' + imageName + ':' + process.env.GITHUB_SHA);
      - name: Prepare GCP Artifact Registry
        id: gcp
        uses: actions/github-script@v7
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          GCP_ARTIFACT_REPOSITORY: \${{ vars.GCP_ARTIFACT_REPOSITORY }}
        with:
          script: |
            const crypto = require('crypto');

            async function getAccessToken() {
              if (!process.env.GCP_SERVICE_ACCOUNT_JSON) throw new Error('GCP_SERVICE_ACCOUNT_JSON is required');
              const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
              const now = Math.floor(Date.now() / 1000);
              const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
              const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
                iss: credentials.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: now + 3600,
              });
              const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                  assertion: unsigned + '.' + signature,
                }),
              });
              const body = await response.text();
              if (!response.ok) throw new Error('GCP token exchange failed: ' + response.status + ' ' + body);
              return JSON.parse(body).access_token;
            }

            for (const key of ['GCP_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const token = await getAccessToken();
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'infraprint';
            const base = 'https://artifactregistry.googleapis.com/v1/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/repositories';
            const getResponse = await fetch(base + '/' + repository, {
              headers: { Authorization: 'Bearer ' + token },
            });
            if (getResponse.status === 404) {
              const createResponse = await fetch(base + '?repositoryId=' + encodeURIComponent(repository), {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + token,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ format: 'DOCKER', description: 'Hypervibe CI images' }),
              });
              const createBody = await createResponse.text();
              if (!createResponse.ok) throw new Error('Artifact Registry create failed: ' + createResponse.status + ' ' + createBody);
            } else if (!getResponse.ok) {
              throw new Error('Artifact Registry lookup failed: ' + getResponse.status + ' ' + await getResponse.text());
            }
            core.setOutput('access_token', token);
      - uses: docker/login-action@v3
        with:
          registry: \${{ steps.image.outputs.registry }}
          username: oauth2accesstoken
          password: \${{ steps.gcp.outputs.access_token }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Deploy image to Cloud Run
        uses: actions/github-script@v7
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          CLOUDRUN_SERVICE_NAMES: ${cloudRunServiceNames}
          IMAGE_URI: \${{ steps.image.outputs.uri }}
        with:
          script: |
            const crypto = require('crypto');

            async function getAccessToken() {
              const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
              const now = Math.floor(Date.now() / 1000);
              const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
              const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
                iss: credentials.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: now + 3600,
              });
              const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                  assertion: unsigned + '.' + signature,
                }),
              });
              const body = await response.text();
              if (!response.ok) throw new Error('GCP token exchange failed: ' + response.status + ' ' + body);
              return JSON.parse(body).access_token;
            }

            const required = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION', 'CLOUDRUN_SERVICE_NAMES', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const token = await getAccessToken();
            const serviceNames = process.env.CLOUDRUN_SERVICE_NAMES.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceNames.length === 0) throw new Error('CLOUDRUN_SERVICE_NAMES is empty');
            for (const serviceName of serviceNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + encodeURIComponent(serviceName);
              const currentResponse = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
              const currentBody = await currentResponse.text();
              if (!currentResponse.ok) throw new Error('Cloud Run service lookup failed for ' + serviceName + ': ' + currentResponse.status + ' ' + currentBody);
              const current = JSON.parse(currentBody);
              const template = current.template || {};
              const containers = Array.isArray(template.containers) && template.containers.length > 0 ? template.containers : [{}];
              containers[0] = { ...containers[0], image: process.env.IMAGE_URI };
              template.containers = containers;
              const patchResponse = await fetch(url + '?updateMask=template.containers', {
                method: 'PATCH',
                headers: {
                  Authorization: 'Bearer ' + token,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ template }),
              });
              if (!patchResponse.ok) throw new Error('Cloud Run deployment failed for ' + serviceName + ': ' + patchResponse.status + ' ' + await patchResponse.text());
            }
`,
        requiredSecrets: ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION'],
        requiredVariables,
      };
    }
    case 'apprunner': {
      const appRunnerServiceArns = providerListValueOrVariable(target.providerServiceArns, 'APPRUNNER_SERVICE_ARNS');
      const requiredVariables = target.providerServiceArns.length === 0 ? ['APPRUNNER_SERVICE_ARNS'] : [];
      return {
        steps: `      - name: Prepare ECR image
        id: ecr
        uses: actions/github-script@v7
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: \${{ secrets.AWS_REGION }}
          AWS_ECR_REPOSITORY: \${{ vars.AWS_ECR_REPOSITORY }}
        with:
          script: |
            const crypto = require('crypto');

            function sha256(data) {
              return crypto.createHash('sha256').update(data).digest('hex');
            }

            function hmac(key, data, encoding) {
              return crypto.createHmac('sha256', key).update(data).digest(encoding);
            }

            function signRequest({ method, host, path, service, region, accessKeyId, secretAccessKey, headers, body }) {
              const now = new Date();
              const amzDate = now.toISOString().replace(/[:-]|\\.\\d{3}/g, '');
              const dateStamp = amzDate.slice(0, 8);
              const signedHeadersObject = { ...headers, Host: host, 'X-Amz-Date': amzDate };
              const signedHeaders = Object.keys(signedHeadersObject).map((key) => key.toLowerCase()).sort().join(';');
              const canonicalHeaders = Object.entries(signedHeadersObject).map(([key, value]) => key.toLowerCase() + ':' + String(value).trim()).sort().join('\\n');
              const canonicalRequest = [method, path, '', canonicalHeaders + '\\n', signedHeaders, sha256(body)].join('\\n');
              const algorithm = 'AWS4-HMAC-SHA256';
              const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
              const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join('\\n');
              const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
              const kRegion = hmac(kDate, region);
              const kService = hmac(kRegion, service);
              const kSigning = hmac(kService, 'aws4_request');
              const signature = hmac(kSigning, stringToSign, 'hex');
              return {
                ...signedHeadersObject,
                Authorization: algorithm + ' Credential=' + accessKeyId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
              };
            }

            async function awsJsonRequest(service, target, bodyObject) {
              const region = process.env.AWS_REGION;
              const host = service === 'ecr' ? 'api.ecr.' + region + '.amazonaws.com' : service + '.' + region + '.amazonaws.com';
              const body = JSON.stringify(bodyObject);
              const headers = signRequest({
                method: 'POST',
                host,
                path: '/',
                service,
                region,
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                headers: {
                  'Content-Type': service === 'ecr' ? 'application/x-amz-json-1.1' : 'application/x-amz-json-1.0',
                  'X-Amz-Target': target,
                },
                body,
              });
              const response = await fetch('https://' + host + '/', { method: 'POST', headers, body });
              const text = await response.text();
              if (!response.ok) throw new Error(service + ' API ' + target + ' failed: ' + response.status + ' ' + text);
              return text ? JSON.parse(text) : {};
            }

            for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const repositoryName = process.env.AWS_ECR_REPOSITORY || process.env.GITHUB_REPOSITORY.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
            try {
              await awsJsonRequest('ecr', 'AmazonEC2ContainerRegistry_V20150921.DescribeRepositories', { repositoryNames: [repositoryName] });
            } catch (error) {
              await awsJsonRequest('ecr', 'AmazonEC2ContainerRegistry_V20150921.CreateRepository', { repositoryName });
            }
            const auth = await awsJsonRequest('ecr', 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken', {});
            const authData = auth.authorizationData[0];
            const decoded = Buffer.from(authData.authorizationToken, 'base64').toString('utf8');
            const separator = decoded.indexOf(':');
            const username = decoded.slice(0, separator);
            const password = decoded.slice(separator + 1);
            const registry = authData.proxyEndpoint.replace(/^https?:\\/\\//, '');
            core.setOutput('registry', registry);
            core.setOutput('username', username);
            core.setOutput('password', password);
            core.setOutput('uri', registry + '/' + repositoryName + ':' + process.env.GITHUB_SHA);
      - uses: docker/login-action@v3
        with:
          registry: \${{ steps.ecr.outputs.registry }}
          username: \${{ steps.ecr.outputs.username }}
          password: \${{ steps.ecr.outputs.password }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.ecr.outputs.uri }}
      - name: Deploy image to AWS App Runner
        uses: actions/github-script@v7
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: \${{ secrets.AWS_REGION }}
          APPRUNNER_SERVICE_ARNS: ${appRunnerServiceArns}
          IMAGE_URI: \${{ steps.ecr.outputs.uri }}
        with:
          script: |
            const crypto = require('crypto');

            function sha256(data) {
              return crypto.createHash('sha256').update(data).digest('hex');
            }

            function hmac(key, data, encoding) {
              return crypto.createHmac('sha256', key).update(data).digest(encoding);
            }

            function signRequest({ method, host, path, service, region, accessKeyId, secretAccessKey, headers, body }) {
              const now = new Date();
              const amzDate = now.toISOString().replace(/[:-]|\\.\\d{3}/g, '');
              const dateStamp = amzDate.slice(0, 8);
              const signedHeadersObject = { ...headers, Host: host, 'X-Amz-Date': amzDate };
              const signedHeaders = Object.keys(signedHeadersObject).map((key) => key.toLowerCase()).sort().join(';');
              const canonicalHeaders = Object.entries(signedHeadersObject).map(([key, value]) => key.toLowerCase() + ':' + String(value).trim()).sort().join('\\n');
              const canonicalRequest = [method, path, '', canonicalHeaders + '\\n', signedHeaders, sha256(body)].join('\\n');
              const algorithm = 'AWS4-HMAC-SHA256';
              const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
              const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join('\\n');
              const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
              const kRegion = hmac(kDate, region);
              const kService = hmac(kRegion, service);
              const kSigning = hmac(kService, 'aws4_request');
              const signature = hmac(kSigning, stringToSign, 'hex');
              return {
                ...signedHeadersObject,
                Authorization: algorithm + ' Credential=' + accessKeyId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
              };
            }

            async function appRunnerRequest(action, bodyObject) {
              const region = process.env.AWS_REGION;
              const host = 'apprunner.' + region + '.amazonaws.com';
              const body = JSON.stringify(bodyObject);
              const headers = signRequest({
                method: 'POST',
                host,
                path: '/',
                service: 'apprunner',
                region,
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                headers: {
                  'Content-Type': 'application/x-amz-json-1.0',
                  'X-Amz-Target': 'AppRunner.' + action,
                },
                body,
              });
              const response = await fetch('https://' + host + '/', { method: 'POST', headers, body });
              const text = await response.text();
              if (!response.ok) throw new Error('App Runner ' + action + ' failed: ' + response.status + ' ' + text);
              return text ? JSON.parse(text) : {};
            }

            const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'APPRUNNER_SERVICE_ARNS', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const serviceArns = process.env.APPRUNNER_SERVICE_ARNS.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceArns.length === 0) throw new Error('APPRUNNER_SERVICE_ARNS is empty');
            for (const serviceArn of serviceArns) {
              await appRunnerRequest('UpdateService', {
                ServiceArn: serviceArn,
                SourceConfiguration: {
                  ImageRepository: {
                    ImageIdentifier: process.env.IMAGE_URI,
                    ImageRepositoryType: 'ECR',
                  },
                },
              });
            }
`,
        requiredSecrets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
        requiredVariables,
      };
    }
    case 'heroku': {
      const herokuApp = providerValueOrVariable(target.providerProjectId, 'HEROKU_APP');
      const requiredVariables = target.providerProjectId ? [] : ['HEROKU_APP'];
      return {
        steps: `      - name: Resolve Heroku app
        id: heroku
        uses: actions/github-script@v7
        env:
          HEROKU_API_KEY: \${{ secrets.HEROKU_API_KEY }}
          HEROKU_APP: ${herokuApp}
        with:
          script: |
            if (!process.env.HEROKU_API_KEY) throw new Error('HEROKU_API_KEY is required');
            if (!process.env.HEROKU_APP) throw new Error('HEROKU_APP is required');
            const response = await fetch('https://api.heroku.com/apps/' + encodeURIComponent(process.env.HEROKU_APP), {
              method: 'GET',
              headers: {
                Authorization: 'Bearer ' + process.env.HEROKU_API_KEY,
                Accept: 'application/vnd.heroku+json; version=3',
              },
            });
            const body = await response.text();
            if (!response.ok) throw new Error('Heroku app lookup failed: ' + response.status + ' ' + body);
            const app = JSON.parse(body);
            core.setOutput('app_name', app.name);
      - uses: docker/login-action@v3
        with:
          registry: registry.heroku.com
          username: _
          password: \${{ secrets.HEROKU_API_KEY }}
      - uses: docker/setup-buildx-action@v3
      - name: Build and push Heroku image
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: registry.heroku.com/\${{ steps.heroku.outputs.app_name }}/web
      - name: Release Heroku image
        uses: actions/github-script@v7
        env:
          HEROKU_API_KEY: \${{ secrets.HEROKU_API_KEY }}
          HEROKU_APP_NAME: \${{ steps.heroku.outputs.app_name }}
          IMAGE_DIGEST: \${{ steps.build.outputs.digest }}
        with:
          script: |
            const required = ['HEROKU_API_KEY', 'HEROKU_APP_NAME', 'IMAGE_DIGEST'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const response = await fetch('https://api.heroku.com/apps/' + encodeURIComponent(process.env.HEROKU_APP_NAME) + '/formation', {
              method: 'PATCH',
              headers: {
                Authorization: 'Bearer ' + process.env.HEROKU_API_KEY,
                Accept: 'application/vnd.heroku+json; version=3.docker-releases',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ updates: [{ type: 'web', docker_image: process.env.IMAGE_DIGEST }] }),
            });
            if (!response.ok) throw new Error('Heroku release failed: ' + response.status + ' ' + await response.text());
`,
        requiredSecrets: ['HEROKU_API_KEY'],
        requiredVariables,
      };
    }
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
      : provider === 'cloudrun'
        ? 'Cloud Run'
        : provider === 'apprunner'
          ? 'AWS App Runner'
          : provider.charAt(0).toUpperCase() + provider.slice(1);
  const template = `deploy-${provider}-${target.kind}`;
  const filename = `${template}.yml`;
  const migrationStep = migration.includeStep && migration.command ? buildMigrationStep(migration.command) : '';
  const deployBlock = buildProviderDeploySteps(provider, target.kind, target);
  const requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];
  const requiredVariables = [...deployBlock.requiredVariables];
  const permissionsBlock = provider === 'railway' || provider === 'digitalocean'
    ? `    permissions:
      contents: read
      packages: write
`
    : `    permissions:
      contents: read
`;

  const content = `name: Deploy ${providerName} (${target.environmentName})

on:
  push:
    branches: [${target.branch}]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${target.environmentName}
${permissionsBlock.trimEnd()}
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
