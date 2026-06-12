import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { SecretRotator } from '../domain/services/secret.rotator.js';
import { syncHostingEnvVars, readHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { SecretAccessLogRepository } from '../adapters/db/repositories/secret-mapping.repository.js';
import { parseSecretRef, type SecretManagerProvider } from '../domain/ports/secretmanager.port.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import type { ToolContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

const SECRET_MANAGERS = ['vault', 'aws-secrets', 'doppler', '1password', 'bitwarden'] as const;
const accessLogRepo = new SecretAccessLogRepository();

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 4, 12))}${value.slice(-2)}`;
}

async function managerAdapter(ctx: ToolContext, provider: (typeof SECRET_MANAGERS)[number]) {
  const connection = ctx.repos.connections.findByProvider(provider);
  if (!connection || connection.status !== 'verified') {
    throw new HvError('MISSING_CONNECTION', `No verified connection for ${provider}.`, {
      hint: `Connect it with hv_connect provider="${provider}".`,
    });
  }
  const credentials = ctx.secretStore.decryptObject(connection.credentialsEncrypted);
  const adapter = secretManagerRegistry.createAdapter(provider, credentials);
  await adapter.connect(credentials);
  return adapter;
}

function githubRepoForProject(project: Project, repoArg?: string): { owner: string; repo: string } {
  const full = repoArg ?? parseGitHubRepoFromRemote(project.gitRemoteUrl) ?? undefined;
  if (!full || !full.includes('/')) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/name" or set the project gitRemoteUrl.',
    });
  }
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

export function registerHvSecretsTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_secrets_set',
    'Set secrets and environment variables. target="hosting" (default) sets env vars on the deployed environment; "manager" stores values in a secret manager (vault/aws-secrets/doppler — 1password and bitwarden are resolve-only: manage values there, then use target="mapping"); "mapping" maps a secretRef to an env var resolved at deploy time (e.g. "1password://<vault>/<item>#<field>", "bitwarden://<secret-name>"); "github" sets a GitHub Actions repo secret. remove=true deletes (mapping/github targets).',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service to scope hosting env vars to (default: first service)'),
      target: z.enum(['hosting', 'manager', 'mapping', 'github']).optional().describe('Default "hosting"'),
      key: z.string().optional().describe('Variable/secret name'),
      value: z.string().optional().describe('Value for key'),
      vars: z.record(z.string()).optional().describe('Multiple key-value pairs (alternative to key/value)'),
      provider: z.enum(SECRET_MANAGERS).optional().describe('target=manager: secret manager provider'),
      path: z.string().optional().describe('target=manager: secret path'),
      secretRef: z.string().optional().describe('target=mapping: secret reference (e.g. "vault://app/prod#API_KEY")'),
      environments: z.array(z.string()).optional().describe('target=mapping: environments the mapping applies to'),
      repo: z.string().optional().describe('target=github: "owner/name" (defaults to project git remote)'),
      remove: z.boolean().optional().describe('Delete instead of set (mapping/github)'),
    },
    wrapHandler(async ({ project: projectRef, env, service, target = 'hosting', key, value, vars, provider, path, secretRef, environments, repo, remove }) => {
      const kv = vars ?? (key !== undefined && value !== undefined ? { [key]: value } : undefined);

      if (target === 'manager') {
        if (!provider || !path) throw new HvError('VALIDATION', 'provider and path are required for target="manager".');
        if (!kv) throw new HvError('VALIDATION', 'Provide key+value or vars.');
        const adapter = await managerAdapter(ctx, provider);
        const receipt = await adapter.setSecret(path, kv);
        accessLogRepo.create({ action: 'write', provider: provider as SecretManagerProvider, secretPath: path, success: true });
        return toolSuccess(
          { provider, path: receipt.path, keysStored: Object.keys(kv) },
          { hint: `Map to env vars with hv_secrets_set target="mapping" secretRef="${provider}://${path}#<KEY>".` }
        );
      }

      if (target === 'github') {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const { owner, repo: repoName } = githubRepoForProject(project, repo);
        if (!key) throw new HvError('VALIDATION', 'key is required for target="github".');
        const gh = getGitHubAdapter(`${owner}/${repoName}`);
        if ('error' in gh) return toolError('MISSING_CONNECTION', gh.error, { hint: 'Connect GitHub with hv_connect provider="github".' });
        if (remove) {
          await gh.adapter.deleteSecret(owner, repoName, key);
          ctx.repos.audit.create({ action: 'github.secret_deleted', resourceType: 'github_secret', resourceId: `${owner}/${repoName}/${key}`, details: { secretName: key } });
          return toolSuccess({ repository: `${owner}/${repoName}`, secretName: key, action: 'deleted' });
        }
        if (value === undefined) throw new HvError('VALIDATION', 'value is required to set a GitHub secret.');
        await gh.adapter.setRepositorySecret(owner, repoName, key, value);
        ctx.repos.audit.create({ action: 'github.secret_set', resourceType: 'github_secret', resourceId: `${owner}/${repoName}/${key}`, details: { secretName: key } });
        return toolSuccess({ repository: `${owner}/${repoName}`, secretName: key, action: 'set' });
      }

      if (target === 'mapping') {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        if (!key) throw new HvError('VALIDATION', 'key (the env var name) is required for target="mapping".');
        if (remove) {
          const deleted = ctx.repos.secretMappings.deleteByProjectAndEnvVar(project.id, key, service ?? null);
          if (!deleted) return toolError('NOT_FOUND', `No mapping found for ${key}.`);
          return toolSuccess({ removed: { envVar: key } });
        }
        if (!secretRef) throw new HvError('VALIDATION', 'secretRef is required to create a mapping.');
        if (!parseSecretRef(secretRef)) {
          throw new HvError('VALIDATION', `Malformed secretRef "${secretRef}".`, {
            hint: 'Format: provider://path/to/secret#KEY (e.g. "vault://apps/prod#API_KEY").',
          });
        }
        const mapping = ctx.repos.secretMappings.upsert({
          projectId: project.id,
          envVar: key,
          secretRef,
          environments: environments ?? [],
          serviceName: service,
        });
        return toolSuccess(
          { mapping: { envVar: mapping.envVar, secretRef: mapping.secretRef, environments: mapping.environments, service: mapping.serviceName } },
          { next: ['hv_secrets_sync'] }
        );
      }

      // target === 'hosting'
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);
      if (!kv) throw new HvError('VALIDATION', 'Provide key+value or vars.');
      const services = ctx.repos.services.findByProjectId(project.id);
      const targetService = service ? services.find((s) => s.name === service) : services[0];
      if (!targetService) {
        throw new HvError('NOT_FOUND', service ? `Service not found: ${service}` : 'No services found.');
      }
      const result = await syncHostingEnvVars({ project, environment, service: targetService, vars: kv });
      if (!result.success) {
        return toolError('PROVIDER_ERROR', result.error || result.message, {});
      }
      return toolSuccess({
        environment: environment.name,
        service: targetService.name,
        variables: Object.keys(kv),
      });
    })
  );

  server.tool(
    'hv_secrets_get',
    'Read a secret (from a secret manager) or a hosting env var. Values are masked unless reveal=true.',
    {
      project: projectField,
      env: envField,
      key: z.string().optional().describe('Env var name (hosting read) or secret key within the path'),
      provider: z.enum(SECRET_MANAGERS).optional().describe('Read from this secret manager instead of hosting'),
      path: z.string().optional().describe('Secret path (with provider)'),
      version: z.string().optional().describe('Secret version (manager reads)'),
      service: z.string().optional().describe('Service to read hosting vars from'),
      reveal: z.boolean().optional().describe('Return unmasked values (default false)'),
    },
    wrapHandler(async ({ project: projectRef, env, key, provider, path, version, service, reveal }) => {
      if (provider && path) {
        const adapter = await managerAdapter(ctx, provider);
        const secret = await adapter.getSecret(path, key, version);
        accessLogRepo.create({ action: 'read', provider: provider as SecretManagerProvider, secretPath: path, success: true });
        let secretRef = `${provider}://${path}`;
        if (key) secretRef += `#${key}`;
        return toolSuccess({
          secretRef,
          value: reveal ? secret.value : maskValue(secret.value),
          masked: !reveal,
          version: secret.version,
        });
      }

      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);
      const services = ctx.repos.services.findByProjectId(project.id);
      const targetService = service ? services.find((s) => s.name === service) : services[0];
      if (!targetService) {
        throw new HvError('NOT_FOUND', service ? `Service not found: ${service}` : 'No services found.');
      }
      const result = await readHostingEnvVars({ project, environment, service: targetService });
      if (!result.success) {
        return toolError('PROVIDER_ERROR', result.error, {});
      }
      const all = result.variables;
      if (key && !(key in all)) {
        return toolError('NOT_FOUND', `Variable ${key} not set in ${environment.name}.`, {
          details: { available: Object.keys(all) },
        });
      }
      const selected = key ? { [key]: all[key] } : all;
      const varsOut = Object.fromEntries(
        Object.entries(selected).map(([k, v]) => [k, reveal ? v : maskValue(v)])
      );
      return toolSuccess({ environment: environment.name, service: targetService.name, masked: !reveal, vars: varsOut });
    })
  );

  server.tool(
    'hv_secrets_list',
    'List secrets and secret plumbing: secret-manager paths, project mappings, access audit log, and GitHub repo secret names.',
    {
      project: projectField,
      provider: z.enum(SECRET_MANAGERS).optional().describe('List secrets in this manager'),
      pathPrefix: z.string().optional().describe('Filter manager secrets by path prefix'),
      include: z.array(z.enum(['mappings', 'audit', 'github'])).optional()
        .describe('Extra sections to include (default: mappings)'),
      repo: z.string().optional().describe('GitHub "owner/name" (defaults to project git remote)'),
      limit: z.number().int().min(1).max(200).optional().describe('Audit entries limit (default 50)'),
    },
    wrapHandler(async ({ project: projectRef, provider, pathPrefix, include, repo, limit = 50 }) => {
      const sections: Record<string, unknown> = {};

      if (provider) {
        const adapter = await managerAdapter(ctx, provider);
        const secrets = await adapter.listSecrets(pathPrefix);
        accessLogRepo.create({ action: 'list', provider: provider as SecretManagerProvider, secretPath: pathPrefix || '*', success: true });
        sections.manager = { provider, count: secrets.length, secrets: secrets.map((s) => ({ path: s.path, keys: s.keys })) };
      }

      const wanted = new Set(include ?? ['mappings']);
      if (wanted.has('mappings')) {
        const project = ctx.resolveProject({ project: projectRef });
        sections.mappings = project
          ? ctx.repos.secretMappings.findByProjectId(project.id).map((m) => ({
            envVar: m.envVar, secretRef: m.secretRef, environments: m.environments, service: m.serviceName,
          }))
          : [];
      }
      if (wanted.has('audit')) {
        sections.audit = accessLogRepo.findRecent(limit);
      }
      if (wanted.has('github')) {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const { owner, repo: repoName } = githubRepoForProject(project, repo);
        const gh = getGitHubAdapter(`${owner}/${repoName}`);
        if ('error' in gh) return toolError('MISSING_CONNECTION', gh.error, {});
        const ghSecrets = await gh.adapter.listSecrets(owner, repoName);
        sections.github = { repository: `${owner}/${repoName}`, secrets: ghSecrets.secrets.map((s) => s.name) };
      }

      return toolSuccess(sections);
    })
  );

  server.tool(
    'hv_secrets_sync',
    'Resolve secret mappings and sync them to hosting environment(s). Optionally rotate a secret first (providers that support rotation) and propagate the new value.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service to set vars on (default: based on mappings)'),
      dryRun: z.boolean().optional().describe('Show what would sync without applying'),
      rotate: z.object({
        provider: z.enum(SECRET_MANAGERS),
        path: z.string(),
      }).optional().describe('Rotate this secret first, then sync mapped environments'),
    },
    wrapHandler(async ({ project: projectRef, env, service, dryRun, rotate }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      if (rotate) {
        const capabilities = secretManagerRegistry.getCapabilities(rotate.provider);
        if (!capabilities?.supportsRotation) {
          return toolError('UNSUPPORTED', `Provider '${rotate.provider}' does not support rotation.`, {
            hint: 'Update the secret value manually, then run hv_secrets_sync.',
          });
        }
        const rotator = new SecretRotator();
        const result = await rotator.rotateAndSync(rotate.provider as SecretManagerProvider, rotate.path);
        return toolSuccess({
          rotation: {
            path: result.rotation.path,
            oldVersion: result.rotation.oldVersion,
            newVersion: result.rotation.newVersion,
            success: result.rotation.success,
            error: result.rotation.error,
          },
          synced: result.synced,
        });
      }

      let environments = ctx.repos.environments.findByProjectId(project.id);
      if (env) {
        environments = environments.filter((e) => e.name === env.trim());
        if (environments.length === 0) {
          throw new HvError('NOT_FOUND', `Environment not found: ${env}`);
        }
      }

      const resolver = new SecretResolver();
      const results: Array<{ environment: string; resolved: number; failed: number; errors: Array<{ envVar: string; error: string }>; synced: boolean }> = [];

      for (const environment of environments) {
        const resolved = await resolver.resolveForEnvironment({
          projectId: project.id,
          environmentName: environment.name,
          serviceName: service,
        });
        if (resolved.resolved === 0 && resolved.failed === 0) continue;

        const entry = {
          environment: environment.name,
          resolved: resolved.resolved,
          failed: resolved.failed,
          errors: resolved.errors.map((e) => ({ envVar: e.envVar, error: e.error })),
          synced: false,
        };

        if (!dryRun && resolved.resolved > 0) {
          const services = ctx.repos.services.findByProjectId(project.id);
          const targetService = service ? services.find((s) => s.name === service) : services[0];
          if (!targetService) {
            entry.errors.push({ envVar: '*', error: 'No service found to set environment variables on' });
          } else {
            const syncResult = await syncHostingEnvVars({ project, environment, service: targetService, vars: resolved.vars });
            entry.synced = syncResult.success;
            if (!syncResult.success) {
              entry.errors.push({ envVar: '*', error: syncResult.error || syncResult.message });
            } else {
              ctx.repos.audit.create({
                action: 'secrets.synced',
                resourceType: 'environment',
                resourceId: environment.id,
                details: { varsSet: Object.keys(resolved.vars), count: resolved.resolved },
              });
            }
          }
        }
        results.push(entry);
      }

      return toolSuccess({
        dryRun: dryRun ?? false,
        environments: results,
        totalResolved: results.reduce((sum, r) => sum + r.resolved, 0),
        totalFailed: results.reduce((sum, r) => sum + r.failed, 0),
      });
    })
  );
}
