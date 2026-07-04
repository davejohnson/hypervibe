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
  /** Cloud Run job names for cron workloads; Railway cron uses providerServiceIds. */
  providerJobNames?: string[];
  /** Whether an unbound Cloud Run workflow should require CLOUDRUN_SERVICE_NAMES. */
  needsServiceNames?: boolean;
  /** Whether an unbound Cloud Run workflow should require CLOUDRUN_JOB_NAMES. */
  needsJobNames?: boolean;
  /** CMD for the generated fallback Dockerfile (repos without one). */
  webStartCommand?: string;
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
  providerJobNames: string[];
  boundServiceNames: string[];
} {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds: string[] = [];
  const providerJobNames: string[] = [];
  for (const service of Object.values(services ?? {})) {
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

      const branch = envSpec.deploy.branch ?? (kind === 'production' ? 'main' : 'staging');
      desiredBranches[kind] = branch;
      const bindings = environmentBindings(project.id, environmentName);
      const serviceNames = Object.keys(envSpec.services);
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
        : desiredBranches.staging ?? 'staging',
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

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A repo Dockerfile is never required: Node apps get the same minimal image
 * the Cloud Build path generates (cloudrun.adapter cloudBuildScript), built
 * on the runner when no Dockerfile exists.
 */
function buildDockerfileStep(target: BranchDeployTarget): string {
  const startCommand = target.webStartCommand?.trim() || 'npm start';
  const cmdLine = `CMD ["sh", "-lc", ${JSON.stringify(startCommand)}]`;
  return `      - name: Resolve Dockerfile
        id: dockerfile
        run: |
          if [ -f Dockerfile ]; then
            echo "path=Dockerfile" >> "$GITHUB_OUTPUT"
          elif [ -f package.json ]; then
            printf '%s\\n' \\
              'FROM node:20-slim' \\
              'WORKDIR /app' \\
              'COPY package*.json ./' \\
              'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi' \\
              'COPY . .' \\
              'ENV PORT=8080' \\
              'EXPOSE 8080' \\
              ${shellSingleQuoted(cmdLine)} \\
              > Dockerfile.hypervibe
            echo "path=Dockerfile.hypervibe" >> "$GITHUB_OUTPUT"
          else
            echo "No Dockerfile or package.json found. Node apps build automatically; anything else needs a Dockerfile in the repo." >&2
            exit 1
          fi
`;
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
        uses: actions/github-script@v8
        with:
          script: |
            const repo = process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('uri', 'ghcr.io/' + repo + ':' + process.env.GITHUB_SHA);
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
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
        uses: actions/github-script@v8
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

            function operationName(query) {
              return (query.match(/\\b(?:query|mutation)\\s+(\\w+)/) || [])[1] || 'RailwayGraphQL';
            }

            function redact(value) {
              if (Array.isArray(value)) return value.map(redact);
              if (!value || typeof value !== 'object') return value;
              return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
                key,
                /token|password|secret|credential/i.test(key) ? '***' : redact(entry),
              ]));
            }

            function errorDetails(payload, body) {
              const errors = Array.isArray(payload?.errors) ? payload.errors : [];
              const messages = errors.map((error) => error.message).filter(Boolean);
              const traceIds = errors.map((error) => error.traceId).filter(Boolean);
              return [
                messages.length ? messages.join('; ') : body,
                traceIds.length ? 'traceId=' + traceIds.join(',') : '',
              ].filter(Boolean).join(' ');
            }

            async function railway(query, variables) {
              const operation = operationName(query);
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + process.env.RAILWAY_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables }),
              });
              const body = await response.text();
              let payload;
              try {
                payload = JSON.parse(body);
              } catch {
                payload = null;
              }
              if (!response.ok) {
                throw new Error(
                  'Railway API ' + response.status + ' during ' + operation
                  + ' variables=' + JSON.stringify(redact(variables))
                  + ': ' + errorDetails(payload, body)
                );
              }
              if (!payload) throw new Error('Railway API returned non-JSON during ' + operation + ': ' + body);
              if (payload.errors && payload.errors.length > 0) {
                throw new Error(
                  'Railway GraphQL error during ' + operation
                  + ' variables=' + JSON.stringify(redact(variables))
                  + ': ' + errorDetails(payload, body)
                );
              }
              return payload.data;
            }

            function requireString(value, name) {
              if (typeof value !== 'string' || value.trim().length === 0) {
                throw new Error(name + ' must be a non-empty string, got: ' + JSON.stringify(redact(value)));
              }
              return value;
            }

            const updateMutation = 'mutation UpdateServiceImage($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }';
            const deployMutation = 'mutation DeployServiceImage($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
            const deploymentQuery = 'query DeploymentStatus($id: String!) { deployment(id: $id) { id status url staticUrl diagnosis meta } }';
            const buildLogsQuery = 'query BuildLogs($deploymentId: String!) { buildLogs(deploymentId: $deploymentId) { timestamp severity message } }';
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
                ['build logs', buildLogsQuery, 'buildLogs', { deploymentId }],
                ['deployment logs', deploymentLogsQuery, 'deploymentLogs', { deploymentId, limit: 100 }],
              ]) {
                try {
                  const data = await railway(entry[1], entry[3]);
                  const lines = formatLogs(data[entry[2]]);
                  if (lines) sections.push(entry[0] + ':\\n' + lines);
                } catch (error) {
                  sections.push(entry[0] + ' unavailable: ' + error.message);
                  core.warning('Could not read Railway ' + entry[0] + ' for ' + deploymentId + ': ' + error.message);
                }
              }
              return sections.join('\\n\\n');
            }

            async function waitForDeployment(deploymentId, serviceId) {
              for (let attempt = 0; attempt < 90; attempt++) {
                const data = await railway(deploymentQuery, { id: deploymentId });
                const deployment = data.deployment;
                if (!deployment) {
                  throw new Error('Railway deployment query returned no deployment for id ' + deploymentId + ': ' + shortJson(data));
                }
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
              const deploymentData = await railway(deployMutation, {
                serviceId,
                environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                commitSha: process.env.GITHUB_SHA,
              });
              const deploymentId = requireString(deploymentData.serviceInstanceDeployV2, 'serviceInstanceDeployV2 deployment id');
              await waitForDeployment(deploymentId, serviceId);
            }
`,
        requiredSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
        requiredVariables,
      };
    }
    case 'cloudrun': {
      const jobNames = target.providerJobNames ?? [];
      const needsServiceNames = target.needsServiceNames ?? true;
      const needsJobNames = target.needsJobNames ?? false;
      const cloudRunServiceNames = target.providerServiceIds.length > 0
        ? yamlSingleQuoted(target.providerServiceIds.join(','))
        : needsServiceNames
          ? variableExpression('CLOUDRUN_SERVICE_NAMES')
          : "''";
      const cloudRunJobNames = jobNames.length > 0
        ? yamlSingleQuoted(jobNames.join(','))
        : needsJobNames
          ? variableExpression('CLOUDRUN_JOB_NAMES')
          : "''";
      const requiredVariables = [
        ...(target.providerServiceIds.length === 0 && needsServiceNames ? ['CLOUDRUN_SERVICE_NAMES'] : []),
        ...(jobNames.length === 0 && needsJobNames ? ['CLOUDRUN_JOB_NAMES'] : []),
      ];
      return {
        steps: `      - name: Resolve Cloud Run image URI
        id: image
        uses: actions/github-script@v8
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
        uses: actions/github-script@v8
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
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Deploy image to Cloud Run
        uses: actions/github-script@v8
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          CLOUDRUN_SERVICE_NAMES: ${cloudRunServiceNames}
          CLOUDRUN_JOB_NAMES: ${cloudRunJobNames}
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

            const required = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const token = await getAccessToken();
            const headers = {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            };
            const serviceNames = (process.env.CLOUDRUN_SERVICE_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            const jobNames = (process.env.CLOUDRUN_JOB_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceNames.length === 0 && jobNames.length === 0) {
              throw new Error('CLOUDRUN_SERVICE_NAMES and CLOUDRUN_JOB_NAMES are both empty');
            }

            async function googleJson(url, options, description) {
              const response = await fetch(url, options);
              const body = await response.text();
              let payload;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                payload = null;
              }
              if (!response.ok) {
                throw new Error(description + ' failed: ' + response.status + ' ' + body);
              }
              if (!payload) {
                throw new Error(description + ' returned non-JSON: ' + body);
              }
              return payload;
            }

            function shortJson(value) {
              if (value === null || value === undefined) return '';
              if (typeof value === 'string') return value;
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            }

            function conditionSummary(resource) {
              const condition = resource?.terminalCondition || (resource?.conditions || []).find((entry) => entry.type === 'Ready');
              if (!condition) return '';
              return [
                condition.type,
                condition.state || condition.status,
                condition.reason,
                condition.message,
              ].filter(Boolean).join(' ');
            }

            function readiness(resource, kind) {
              if (!resource) return { ready: false };
              const condition = resource.terminalCondition || (resource.conditions || []).find((entry) => entry.type === 'Ready');
              const state = condition?.state || condition?.status;
              const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
              const failed = state === 'CONDITION_FAILED' || state === 'False';
              const generationsMatch = !resource.generation || !resource.observedGeneration || String(resource.generation) === String(resource.observedGeneration);
              if (succeeded && generationsMatch && resource.reconciling !== true) return { ready: true };
              if (failed && resource.reconciling !== true) {
                const reason = condition?.reason ? condition.reason + ': ' : '';
                return { ready: false, error: reason + (condition?.message || 'Ready condition failed') };
              }
              if (kind === 'service' && !condition && resource.uri) return { ready: true };
              return { ready: false };
            }

            async function waitOperation(operation, description) {
              if (!operation?.name || !operation.name.includes('/operations/')) return operation;
              let current = operation;
              for (let attempt = 0; attempt < 120; attempt++) {
                if (current.done) {
                  if (current.error) {
                    throw new Error(
                      'Cloud Run ' + description + ' operation failed: '
                      + (current.error.status || current.error.code || 'unknown')
                      + ' ' + (current.error.message || '')
                    );
                  }
                  return current;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
                current = await googleJson(
                  'https://run.googleapis.com/v2/' + current.name,
                  { headers: { Authorization: 'Bearer ' + token } },
                  'Cloud Run ' + description + ' operation status check'
                );
              }
              throw new Error('Cloud Run ' + description + ' operation did not finish before timeout');
            }

            async function waitReady(url, name, kind) {
              let last;
              for (let attempt = 0; attempt < 120; attempt++) {
                last = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run ' + kind + ' readiness lookup for ' + name);
                const state = readiness(last, kind);
                const summary = conditionSummary(last);
                core.info('Cloud Run ' + kind + ' ' + name + ' readiness: ' + (state.ready ? 'ready' : last.reconciling ? 'reconciling' : 'pending') + (summary ? ' - ' + summary : ''));
                if (state.ready) return last;
                if (state.error) throw new Error('Cloud Run ' + kind + ' ' + name + ' is not ready: ' + state.error);
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
              throw new Error('Cloud Run ' + kind + ' ' + name + ' was not ready before timeout. Last state: ' + shortJson(last));
            }

            function primaryServiceContainer(service) {
              return service?.template?.containers?.[0] || service?.spec?.template?.spec?.containers?.[0] || {};
            }

            function primaryJobContainer(job) {
              return job?.template?.template?.containers?.[0] || {};
            }

            function withImage(containers, image) {
              const next = Array.isArray(containers) && containers.length > 0 ? [...containers] : [{}];
              next[0] = { ...next[0], image };
              return next;
            }

            for (const serviceName of serviceNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + encodeURIComponent(serviceName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run service lookup for ' + serviceName);
              const template = current.template || {};
              template.containers = withImage(template.containers || [primaryServiceContainer(current)], process.env.IMAGE_URI);
              const operation = await googleJson(url + '?updateMask=template.containers', {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ template }),
              }, 'Cloud Run service deployment for ' + serviceName);
              await waitOperation(operation, 'service ' + serviceName + ' deployment');
              await waitReady(url, serviceName, 'service');
            }

            for (const jobName of jobNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + encodeURIComponent(jobName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run job lookup for ' + jobName);
              const template = current.template || {};
              const taskTemplate = template.template || {};
              taskTemplate.containers = withImage(taskTemplate.containers || [primaryJobContainer(current)], process.env.IMAGE_URI);
              template.template = taskTemplate;
              const operation = await googleJson(url, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ template }),
              }, 'Cloud Run job deployment for ' + jobName);
              await waitOperation(operation, 'job ' + jobName + ' deployment');
              await waitReady(url, jobName, 'job');
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
