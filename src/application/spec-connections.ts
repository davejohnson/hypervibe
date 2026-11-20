import { githubPackagePullSetupKeys, githubPackagePullSource } from '../adapters/providers/github/package-pull.js';
import type { CommandContext } from './context.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { cloudflareScopeHintsForDomain } from '../domain/services/domain-scope.js';
import { usesGcpEnvironmentConnection } from '../domain/services/adapter.factory.js';
import { gcpConnectionScope, gcpCredentialsMatchProject } from '../domain/services/gcp-environment-target.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';

type ConnectionUse = { environment: string; reason: string; packagePull: boolean };
type ChecklistItem = {
  provider: string;
  status: string;
  scope?: string;
  environments: string[];
  reasons: string[];
  guidance?: string;
  requiredCredentialKeys?: string[];
  missingCredentialKeys?: string[];
  connectionAction?: { project: string; provider: string; scope?: string; action: 'verify' | 'describe'; role?: string | string[] };
};

function summarizeUses(uses: ConnectionUse[]) {
  return {
    environments: [...new Set(uses.map(use => use.environment))].sort(),
    reasons: [...new Set(uses.map(use => use.reason))].sort(),
  };
}

export function requiredConnectionChecklist(ctx: CommandContext, spec: ProjectSpec, options: {
  environments?: readonly string[];
  gitRemoteUrl?: string;
} = {}) {
  const repository = parseGitHubRepoFromRemote(options.gitRemoteUrl ?? spec.gitRemoteUrl);
  const required = new Map<string, { provider: string; gcpProjectId?: string; scopeHints: string[]; uses: ConnectionUse[] }>();
  const add = (provider: string, environment: string, reason: string, scopeHints: string[] = [], packagePull = false) => {
    if (options.environments && !options.environments.includes(environment)) return;
    const gcpProjectId = usesGcpEnvironmentConnection(provider) ? spec.environments[environment]?.hosting.gcpProjectId : undefined;
    const key = `${provider}:${gcpProjectId ?? ''}:${scopeHints.join('|')}`;
    const entry = required.get(key) ?? { provider, gcpProjectId, scopeHints, uses: [] };
    entry.uses.push({ environment, reason, packagePull });
    required.set(key, entry);
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
      const packagePull = devops.ci.provider === 'github-actions'
        && providerRegistry.getMetadata(envSpec.hosting.provider)?.orchestration?.ci?.requiresGitHubPackagePull === true;
      add(
        registration?.connectionProvider ?? devops.ci.provider,
        envName,
        `${devops.ci.provider} deploy workflow`,
        [devops.code.scope], packagePull
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
    .flatMap((entry): ChecklistItem[] => {
      const connectionProviders = providerRegistry.connectionProviders(entry.provider);
      const candidates = connectionProviders.flatMap((connectionProvider) =>
        ctx.repos.connections.findAllByProvider(connectionProvider)
      );
      const { gcpProjectId, scopeHints } = entry;
      if (gcpProjectId) {
        const scope = repository ? gcpConnectionScope(repository, gcpProjectId) : undefined;
        const scoped = scope ? candidates.filter(connection => connection.scope === scope) : [];
        const verified = scoped.some(connection => {
          if (connection.status !== 'verified') return false;
          try {
            const credentials = ctx.secretStore.decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
            return gcpCredentialsMatchProject(credentials, gcpProjectId);
          } catch {
            return false;
          }
        });
        const status = verified ? 'verified' : scoped.length ? 'unverified' : 'missing';
        return [{ provider: entry.provider, status, ...(scope ? { scope } : {}), ...summarizeUses(entry.uses) }];
      }
      const connections = usesGcpEnvironmentConnection(entry.provider)
        ? candidates.filter(connection => !connection.scope?.includes('#gcp:'))
        : candidates;
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
      const base = { provider: entry.provider, ...(scope ? { scope } : {}), ...summarizeUses(entry.uses), status };
      const pulls = entry.uses.filter(use => use.packagePull);
      if (!pulls.length || !scope) return [base];

      const actionContext = { project: spec.project, provider: entry.provider };
      const primaryOnly = entry.uses.filter(use => !use.packagePull);
      const fulfilled = verified && primaryOnly.length ? [{ ...base, ...summarizeUses(primaryOnly) }] : [];
      const pending = verified ? { ...base, ...summarizeUses(pulls) } : base;
      if (verified) {
        try {
          if (githubPackagePullSource({ githubRepo: scope })) return [base];
        } catch {
          return [...fulfilled, {
            ...pending,
            status: 'unverified',
            requiredCredentialKeys: [],
            guidance: 'Hypervibe could not read the saved GitHub credential. Restore local credential access and check the project requirements again.',
          }];
        }
      }
      if (scopedConnection && scopedConnection.status !== 'verified') {
        return [...fulfilled, {
          ...pending,
          status: 'unverified',
          requiredCredentialKeys: [],
          guidance: 'Verify the saved GitHub connection, then check the project requirements again.',
          connectionAction: { ...actionContext, action: 'verify', ...(scopedConnection.scope ? { scope: scopedConnection.scope } : {}) },
        }];
      }
      const requiredCredentialKeys = githubPackagePullSetupKeys(scope);
      return [...fulfilled, {
        ...pending,
        status: 'missing',
        requiredCredentialKeys,
        missingCredentialKeys: verified ? ['packageReadToken'] : requiredCredentialKeys,
        guidance: requiredCredentialKeys.length === 1
          ? 'The image pull needs read:packages. Add packageReadToken to this repository’s verified GitHub connection.'
          : 'Set up this repository’s GitHub connection with apiToken for workflow management and packageReadToken for image pulls. A combined classic token can be explicitly mapped to both roles.',
        connectionAction: {
          ...actionContext, action: 'describe', scope,
          role: requiredCredentialKeys.length === 1 ? requiredCredentialKeys[0] : requiredCredentialKeys,
        },
      }];
    });

  return {
    required: items,
    missing: items.filter((item) => item.status !== 'verified'),
  };
}
