import type { CommandContext } from './context.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { cloudflareScopeHintsForDomain } from '../domain/services/domain-scope.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';

export function requiredConnectionChecklist(ctx: CommandContext, spec: ProjectSpec, selected?: readonly string[]) {
  const required = new Map<string, { provider: string; environments: Set<string>; reasons: Set<string>; scopeHints: Set<string> }>();
  const add = (provider: string, environment: string, reason: string, scopeHints: string[] = []) => {
    if (selected && !selected.includes(environment)) return;
    const key = `${provider}:${scopeHints.length > 0 ? scopeHints.join('|') : '*'}`;
    const existing = required.get(key) ?? {
      provider,
      environments: new Set<string>(),
      reasons: new Set<string>(),
      scopeHints: new Set<string>(),
    };
    existing.environments.add(environment);
    existing.reasons.add(reason);
    scopeHints.forEach((scopeHint) => existing.scopeHints.add(scopeHint));
    required.set(key, existing);
  };

  const devops = resolveDevOpsSelection(spec);
  if (devops?.ci && Object.keys(spec.devops?.ci?.repositoryVariables ?? {}).length > 0) {
    const registration = devOpsProviderRegistry.ciProvider(devops.ci.provider);
    add(registration?.connectionProvider ?? devops.ci.provider,
      spec.devops?.canonicalEnvironment ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0] ?? 'repository'),
      'Repository configuration variables', [devops.code.scope]);
  }
  for (const [envName, envSpec] of Object.entries(spec.environments)) {
    add(envSpec.hosting.provider, envName, 'hosting');
    if (envSpec.database) add(envSpec.database.provider, envName, 'database');
    if (envSpec.cache) add(envSpec.cache.provider, envName, 'cache');
    if (envSpec.domain) {
      add('cloudflare', envName, envSpec.domainRegistration ? 'domain registration and DNS' : 'domain DNS', [
        ...cloudflareScopeHintsForDomain(envSpec.domain),
      ]);
    }
    if (envSpec.email.enabled) add('sendgrid', envName, 'transactional email');
    if (envSpec.deploy?.strategy === 'branch' && envSpec.deploy.trigger !== 'native' && devops?.ci) {
      const registration = devOpsProviderRegistry.ciProvider(devops.ci.provider);
      add(
        registration?.connectionProvider ?? devops.ci.provider,
        envName,
        `${devops.ci.provider} deploy workflow`,
        [devops.code.scope]
      );
    }
    if (envSpec.ios) add('appstoreconnect', envName, 'iOS bundle ID / TestFlight', [envSpec.ios.bundleId]);
    if (envSpec.queues && Object.keys(envSpec.queues).length > 0) add(envSpec.hosting.provider, envName, 'queues');
    for (const storage of Object.values(envSpec.storage ?? {})) add(storage.provider, envName, 'object storage');
  }

  if (spec.github && spec.github.enabled !== false) {
    const repository = spec.github.repository ?? parseGitHubRepoFromRemote(spec.gitRemoteUrl);
    const environment = spec.github.canonicalEnvironment
      ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0] ?? 'repository');
    add('github', environment, 'GitHub repository infrastructure', repository ? [repository] : []);
  }

  const items = Array.from(required.values())
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => {
      const connectionProviders = providerRegistry.connectionProviders(entry.provider);
      const connections = connectionProviders.flatMap((connectionProvider) =>
        ctx.repos.connections.findAllByProvider(connectionProvider)
      );
      const scopeHints = Array.from(entry.scopeHints);
      const scopedConnection = scopeHints.length > 0
        ? connectionProviders
          .map((connectionProvider) => ctx.repos.connections.findBestMatchFromHints(connectionProvider, scopeHints))
          .find((candidate) => candidate !== null) ?? null
        : null;
      const verifiedScopedConnection = scopeHints.length > 0
        ? connectionProviders
          .map((connectionProvider) => ctx.repos.connections.findBestVerifiedMatchFromHints(connectionProvider, scopeHints))
          .find((candidate) => candidate !== null) ?? null
        : null;
      const verified = scopeHints.length > 0
        ? Boolean(verifiedScopedConnection)
        : connections.some((connection) => connection.status === 'verified');
      const scope = scopeHints[0];
      let status = 'missing';
      if (verified) {
        status = 'verified';
      } else if (scopeHints.length > 0 && scopedConnection) {
        status = 'unverified';
      } else if (scopeHints.length === 0 && connections.length > 0) {
        status = 'unverified';
      }
      return {
        provider: entry.provider,
        status,
        environments: Array.from(entry.environments).sort(),
        reasons: Array.from(entry.reasons).sort(),
        ...(scope ? { scope } : {}),

      };
    });

  return {
    required: items,
    missing: items.filter((item) => item.status !== 'verified'),
  };
}
