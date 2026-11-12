import { z } from 'zod';
import { rotateSecrets, secretAges } from '../application/secret-rotation.js';
import { collectOutsideKeys } from '../application/engine-secrets.js';
import { localRepositoryFor } from '../application/local-repository.js';
import { isEngineManaged } from '../application/infrastructure-engine.js';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { commandError, commandSuccess, HvError, wrapCommandHandler } from '../application/results.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Service } from '../domain/entities/service.entity.js';
import {
  SECRET_MANAGER_PROVIDERS,
} from '../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { readHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { envField, projectField } from './schemas.js';
import { suppliedOptionNames } from '../application/command-options.js';
import { credentialInventory } from '../application/credential-inventory.js';

const REDACTED = '[redacted]';

async function managerAdapter(
  ctx: CommandContext,
  provider: (typeof SECRET_MANAGER_PROVIDERS)[number],
  project?: string
) {
  const connection = ctx.repos.connections.findByProvider(provider);
  if (!connection || connection.status !== 'verified') {
    throw new HvError('MISSING_CONNECTION', `No verified connection for ${provider}.`, {
      ...connectionSetupOptions(provider, { project }),
    });
  }
  const credentials = ctx.secretStore.decryptObject(connection.credentialsEncrypted);
  const adapter = secretManagerRegistry.createAdapter(provider, credentials);
  await adapter.connect(credentials);
  return adapter;
}

function githubRepoForProject(project: Project | null, repoArg?: string): { owner: string; repo: string } {
  const full = repoArg ?? (project ? parseGitHubRepoFromRemote(project.gitRemoteUrl) : null) ?? undefined;
  if (!full || !full.includes('/')) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/name" or set the project gitRemoteUrl.',
    });
  }
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

function resolveHostingService(
  ctx: CommandContext,
  project: Project,
  environmentName: string,
  requestedService?: string
): Service {
  const requested = requestedService?.trim();
  const stored = ctx.repos.services.findByProjectId(project.id)
    .find((candidate, index) => requested ? candidate.name === requested : index === 0);
  if (stored) return stored;

  const environmentSpec = new SpecStore().get(project)?.spec.environments[environmentName];
  const serviceName = requested || Object.keys(environmentSpec?.services ?? {})[0];
  const serviceSpec = serviceName ? environmentSpec?.services[serviceName] : undefined;
  if (!serviceName || !serviceSpec) {
    throw new HvError('NOT_FOUND', requested ? `Service not found: ${requested}` : 'No services found.');
  }

  const timestamp = new Date(0);
  return {
    id: `desired:${project.id}:${serviceName}`,
    projectId: project.id,
    name: serviceName,
    buildConfig: { ...serviceSpec },
    envVarSpec: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function registerHvSecretsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_secrets',
    'Secret read modes: {project?,env,view:"inventory"} reports credential sources, exact consumers, configuration, rollout and evidence gaps without writes; {} or {project} lists sources; {provider,pathPrefix?} lists one manager; {provider,path,key?,version?} checks one manager value; {include:["github"],project?,repo?} lists GitHub Actions names; {project?,env,service?,key?} inspects masked hosting variables. Hosting mode requires explicit env; inventory also requires env. Values and private fingerprints are never returned. {project?,env,action:"collect",key?|keys?,purpose?} opens one Hypervibe local page where the user pastes keys an outside service issues for an OpenTofu-managed environment (GCP or AWS), each with a link to the issuing service\'s key page and a live check where known; values go straight to the environment\'s secret store, never through chat. Without key/keys it asks for every declared or imported key that has no value yet. Then run hv_launch to roll services onto them.',
    {
      project: projectField.describe('Optional Hypervibe project name/id for validated context. Project-only still lists sources. Omit to use no project context for source/manager lists or auto-detect only in GitHub/hosting modes.'),
      action: z.enum(['collect', 'rotate', 'ages']).optional().describe('OpenTofu-managed environments. collect: one local page to add the missing outside keys (or the given key/keys). rotate: replace every secret in env (or keys) now: new generated values, a no-downtime database login change, one local page for all third-party keys, services moved onto them, old versions disabled. Call again after any stop; it resumes. ages: read-only list of each secret, its kind and age.'),
      keys: z.array(z.string().min(1)).optional().describe('action="rotate": only these settings (default: all rotatable). action="collect": these keys (default: every missing one).'),
      generateInternal: z.boolean().optional().describe('action="rotate": replace app-internal secrets (no outside service issued them, for example JWT_SECRET) with generated values instead of asking. Signing secrets sign everyone out.'),
      confirmActions: z.array(z.string().min(1)).optional().describe('action="rotate": exact confirmActions from a needs_confirmation result, after the user approved them.'),
      purpose: z.string().max(160).optional().describe('action="collect": why the value is needed, as a phrase after "to", shown on the page.'),
      view: z.literal('inventory').optional().describe('Read-only credential inventory for the exact project/environment. Cannot combine with other secret-mode selectors. Does not adopt, synchronize, validate credentials, or deploy.'),
      env: envField.describe('Exact environment for hosting-variable inspection or credential inventory. Required in both modes; never inferred from project alone.'),
      key: z.string().min(1).optional().describe('Hosting variable name or key within a manager secret'),
      provider: z.enum(SECRET_MANAGER_PROVIDERS).optional(),
      path: z.string().min(1).optional().describe('Secret-manager path'),
      version: z.string().min(1).optional().describe('Secret-manager version'),
      service: z.string().min(1).optional().describe('Hosting service name'),
      pathPrefix: z.string().min(1).optional().describe('With provider and no path: restrict listed manager paths'),
      include: z.array(z.literal('github')).optional().describe('Also list GitHub Actions secret names'),
      repo: z.string().min(1).optional().describe('GitHub owner/name; defaults to the project git remote'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, view, key, provider, path, version, service, pathPrefix, include, repo, action, purpose, keys, confirmActions, generateInternal }) => {
      if (action === 'rotate' || action === 'ages') {
        if (!env) throw new HvError('VALIDATION', `action="${action}" requires env.`);
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        if (action === 'ages') {
          const specResult = new SpecStore().get(project);
          if (!specResult) throw new HvError('NOT_FOUND', `Project "${project.name}" has no spec.`);
          const ages = await secretAges(ctx, project, specResult.spec, env);
          if ('blocked' in ages) return commandError('VALIDATION', ages.blocked);
          const overdue = ages.secrets.filter((secret) => secret.overdue).map((secret) => secret.key);
          return commandSuccess(ages, { hint: overdue.length ? `${overdue.length} secret(s) are older than ${ages.everyDays} days. Rotate them with action="rotate".` : `Every secret is newer than ${ages.everyDays} days.` });
        }
        const rotated = await rotateSecrets(ctx, { project, environmentName: env, ...(keys?.length ? { keys } : {}), ...(confirmActions?.length ? { confirmActions } : {}), ...(generateInternal ? { generateInternal } : {}) });
        if (rotated.status === 'blocked') return commandError('VALIDATION', rotated.message);
        if (rotated.status === 'needs_input') {
          return commandSuccess(rotated, { hint: 'Tell the user the page for the new keys is open in their browser (give the link). Call action="rotate" again after they finish.',
            agentInstruction: { action: 'ask_user', message: 'Ask the user to create and paste each new key on the page that opened, then continue.' } });
        }
        if (rotated.status === 'rotated') return commandSuccess(rotated, { hint: rotated.message, next: ['hv_status', 'hv_health'] });
        return commandSuccess(rotated, { hint: 'The rollout stopped for a decision; show it to the user, then call action="rotate" again with what they approved.', next: ['hv_secrets'] });
      }
      if (action === 'collect') {
        if (!env) throw new HvError('VALIDATION', 'action="collect" requires env.');
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const specResult = new SpecStore().get(project);
        if (!specResult) throw new HvError('NOT_FOUND', `Project "${project.name}" has no spec.`);
        if (!isEngineManaged(specResult.spec.environments[env])) throw new HvError('VALIDATION', `${env} is not an OpenTofu-managed environment.`);
        const environment = ctx.repos.environments.findByProjectAndName(project.id, env);
        const imported = (environment?.platformBindings as { engine?: { importedSecrets?: string[] } } | undefined)?.engine?.importedSecrets;
        const requested = [...(key ? [key] : []), ...(keys ?? [])];
        const result = await collectOutsideKeys(ctx, { project, spec: specResult.spec, environmentName: env, ...(imported ? { importedSecrets: imported } : {}),
          ...(requested.length ? { keys: requested } : {}), ...(purpose ? { purpose } : {}),
          ...(localRepositoryFor(project, specResult.source) ? { sourceDirectory: localRepositoryFor(project, specResult.source)! } : {}) });
        if (result.status === 'blocked') return commandError('VALIDATION', result.message);
        if (result.status === 'collected') {
          return commandSuccess(result, { hint: result.keys.length
            ? `Saved ${result.keys.join(', ')}. Run hv_launch env="${env}" (or hv_plan scope="infrastructure" and hv_apply) to move its services onto them.`
            : `Every key ${env} needs already has a value.`, next: ['hv_launch'] });
        }
        return commandSuccess(result, { hint: 'Tell the user the page is open in their browser and give them the link. Call again after they finish.',
          agentInstruction: { action: 'ask_user', message: 'Ask the user to add each key on the page that opened (never in chat), then continue.' } });
      }
      if (view === 'inventory') {
        const incompatible = suppliedOptionNames({ key, provider, path, version, service, pathPrefix, include, repo });
        if (!env || incompatible.length) throw new HvError('VALIDATION', 'Inventory requires env and accepts only project, env, and view.');
        const project = ctx.resolveProjectOrThrow({ project: projectRef, readOnly: true });
        return commandSuccess(await credentialInventory(ctx, project, env));
      }
      const selectedProject = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : null;
      const managerLookup = path !== undefined || version !== undefined || (provider !== undefined && key !== undefined);
      if (managerLookup) {
        const incompatible = suppliedOptionNames({ env, service, pathPrefix, include, repo });
        if (incompatible.length > 0) {
          throw new HvError('VALIDATION', `Manager value lookup received options for another secret mode: ${incompatible.join(', ')}.`);
        }
        if (!provider || !path) throw new HvError('VALIDATION', 'provider and path must be passed together.');
        const secret = await (await managerAdapter(ctx, provider, selectedProject?.name)).getSecret(path, key, version);
        return commandSuccess({
          secretRef: `${provider}://${path}${key ? `#${key}` : ''}${version ? `@${version}` : ''}`,
          value: REDACTED,
          present: secret.value.length > 0,
          version: secret.version,
        });
      }

      if (provider || pathPrefix !== undefined || include !== undefined || repo !== undefined) {
        const incompatible = suppliedOptionNames({ env, service, key });
        if (incompatible.length > 0) {
          throw new HvError('VALIDATION', `Secret listing received hosting lookup options: ${incompatible.join(', ')}.`, {
            hint: 'Remove the listed options to enumerate names, or remove provider/include/repo/pathPrefix and pass env for masked hosting-variable inspection.',
          });
        }
        return listSecrets({ selectedProject, provider, pathPrefix, include, repo });
      }

      const hostingLookup = env !== undefined || key !== undefined || service !== undefined;
      if (!hostingLookup) {
        const sources = [...SECRET_MANAGER_PROVIDERS, 'github'].map((source) => {
          const connections = ctx.repos.connections.findAllByProvider(source);
          return {
            source,
            status: connections.some((connection) => connection.status === 'verified')
              ? 'verified'
              : connections.length > 0 ? 'unverified' : 'missing',
          };
        });
        return commandSuccess({
          ...(selectedProject ? { project: { id: selectedProject.id, name: selectedProject.name } } : {}),
          sources,
        }, {
          hint: 'Pass provider to list manager paths, include=["github"] plus project/repo to list GitHub names, or project/env/service to inspect masked hosting variables.',
        });
      }

      if (!env) {
        throw new HvError('VALIDATION', 'env is required for hosting-variable inspection.', {
          hint: 'Pass project (optional), env (required), and optional service/key. Use project alone to list secret sources.',
        });
      }

      const project = selectedProject ?? ctx.resolveProjectOrThrow();
      const environment = ctx.resolveEnvironmentOrThrow(project, env);
      const targetService = resolveHostingService(ctx, project, environment.name, service);
      const result = await readHostingEnvVars({ project, environment, service: targetService });
      if (!result.success) {
        if (result.connectionUnavailable) {
          const scope = getProjectScopeHints(project)
            .find((hint) => !hint.includes('://') && !hint.includes('github.com/'));
          return commandError('MISSING_CONNECTION', result.error, {
            ...connectionSetupOptions(result.provider, { project: project.name, scope }),
          });
        }
        return commandError('PROVIDER_ERROR', result.error);
      }
      const presentNames = [...new Set([...Object.keys(result.variables), ...(result.unresolvedKeys ?? [])])].sort();
      if (key && !presentNames.includes(key)) {
        return commandError('NOT_FOUND', `Variable ${key} not set in ${environment.name}.`, {
          details: { available: presentNames },
        });
      }
      const names = key ? [key] : presentNames;
      return commandSuccess({
        environment: environment.name,
        service: targetService.name,
        vars: Object.fromEntries(names.map((name) => [name, REDACTED])),
        ...(result.unresolvedKeys?.some(name => names.includes(name)) ? { unresolvedKeys: result.unresolvedKeys.filter(name => names.includes(name)) } : {}),
      });
    })
  );

  async function listSecrets({
    selectedProject,
    provider,
    pathPrefix,
    include,
    repo,
  }: {
    selectedProject: Project | null;
    provider?: (typeof SECRET_MANAGER_PROVIDERS)[number];
    pathPrefix?: string;
    include?: 'github'[];
    repo?: string;
  }) {
      if (!provider && !include?.includes('github')) {
        throw new HvError('VALIDATION', 'Pass provider to list manager paths or include=["github"].');
      }
      const sections: Record<string, unknown> = {};
      if (provider) {
        const secrets = await (await managerAdapter(ctx, provider, selectedProject?.name)).listSecrets(pathPrefix);
        sections.manager = {
          provider,
          count: secrets.length,
          secrets: secrets.map(({ path, keys }) => ({ path, keys })),
        };
      }
      if (include?.includes('github')) {
        const project = selectedProject ?? (repo ? null : ctx.resolveProjectOrThrow());
        const { owner, repo: repoName } = githubRepoForProject(project, repo);
        const gh = getGitHubAdapter(`${owner}/${repoName}`);
        if ('error' in gh) {
          return commandError('MISSING_CONNECTION', gh.error, {
            ...connectionSetupOptions('github', {
              project: project?.name,
              scope: `${owner}/${repoName}`,
            }),
          });
        }
        const secrets = await gh.adapter.listSecrets(owner, repoName);
        sections.github = {
          repository: `${owner}/${repoName}`,
          secrets: secrets.secrets.map((secret) => secret.name),
        };
      }
      return commandSuccess(sections);
  }
}
