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
    }, { includeStep: false }).content,
    requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    requiredVariables: ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS'],
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

export type BranchDeployProvider =
  | 'railway'
  | 'cloudrun';
export type BranchDeployEnvironmentKind = 'staging' | 'production';

export interface BranchDeployTarget {
  environmentName: string;
  kind: BranchDeployEnvironmentKind;
  branch: string;
  serviceNames: string[];
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
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
  boundServiceNames: string[];
} {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds = Object.values(services ?? {})
    .map((service) => asRecord(service)?.serviceId)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return {
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    providerServiceIds,
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
  }
}

export function buildBranchDeployWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string }
): BranchDeployWorkflow {
  const providerName =
    provider === 'cloudrun'
      ? 'Cloud Run'
      : provider.charAt(0).toUpperCase() + provider.slice(1);
  const template = `deploy-${provider}-${target.kind}`;
  const filename = `${template}.yml`;
  const migrationStep = migration.includeStep && migration.command ? buildMigrationStep(migration.command) : '';
  const deployBlock = buildProviderDeploySteps(provider, target.kind, target);
  const requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];
  const requiredVariables = [...deployBlock.requiredVariables];
  const permissionsBlock = provider === 'railway'
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
