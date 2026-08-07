import type { CommandRegistrar } from '../application/commands.js';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { saveConnection, verifyConnection, deleteConnection } from '../domain/services/connection-ops.service.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import { parseEnvFile } from '../utils/env-parser.js';
import {
  credentialFieldsFromSchema,
  connectionSetupDetails,
  formatConnectionGuidance,
  getConnectionGuidance,
} from '../domain/services/connection-guidance.js';
import type { CredentialFieldDescriptor } from '../domain/services/connection-guidance.js';
import type { CommandContext } from '../application/context.js';
import { projectField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler } from '../application/results.js';
import { splitFragment } from '../utils/split-fragment.js';
import type { Project } from '../domain/entities/project.entity.js';

function resolveEnvironmentCredential(
  provider: string,
  requestedName: string,
  values: Record<string, string | undefined>
): string | undefined {
  if (values[requestedName] !== undefined) {
    return values[requestedName];
  }

  const aliasGroup = providerRegistry
    .getMetadata(provider)
    ?.credentials
    ?.environmentVariableAliases
    ?.find((aliases) => aliases.includes(requestedName));
  if (!aliasGroup) {
    return undefined;
  }

  const candidates = aliasGroup
    .filter((name) => values[name] !== undefined)
    .map((name) => ({ name, value: values[name]! }));
  if (candidates.length === 0) {
    return undefined;
  }
  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    throw new Error(
      `Environment variable ${requestedName} is not set and its accepted aliases `
      + `(${aliasGroup.join(', ')}) contain different values. Set ${requestedName} explicitly.`
    );
  }
  return candidates[0].value;
}

function resolveLocalSecretRef(ref: string, provider?: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice('env:'.length).trim();
    if (!name) {
      throw new Error('credentialsRef env: reference is missing the environment variable name.');
    }
    const value = provider
      ? resolveEnvironmentCredential(provider, name, process.env)
      : process.env[name];
    if (value === undefined) {
      throw new Error(`Environment variable ${name} is not set.`);
    }
    return value;
  }
  if (trimmed.startsWith('file:')) {
    const filePath = trimmed.slice('file:'.length).trim();
    if (!filePath) {
      throw new Error('credentialsRef file: reference is missing the file path.');
    }
    return readFileSync(filePath, 'utf8').trim();
  }
  throw new Error('Unsupported credentialsRef. Use env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path, or a secret-manager ref like 1password://vault/item#field.');
}

function defaultScalarCredentialKey(provider: string): string | undefined {
  return providerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey
    ?? secretManagerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey;
}

function scalarCredentialObject(provider: string, value: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const key = credentialsKey ?? defaultScalarCredentialKey(provider);
  if (!key) {
    throw new Error(`${source} resolved to a scalar value. Pass credentialsKey to map it into the provider credentials object.`);
  }
  return { [key]: value };
}

function parseRawCredentialValue(provider: string, raw: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${source} JSON must resolve to an object.`);
    }
    return parsed as Record<string, unknown>;
  }
  return scalarCredentialObject(provider, trimmed, credentialsKey, source);
}

function parseDotenvCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>
): Record<string, unknown> {
  const raw = ref.slice('dotenv:'.length).trim();
  const { target: filePath, fragment } = splitFragment(raw);
  if (!filePath) {
    throw new Error('credentialsRef dotenv: reference is missing the .env file path.');
  }
  if (credentialsMap && fragment) {
    throw new Error('Pass either credentialsMap or a dotenv #KEY fragment, not both.');
  }

  const values = parseEnvFile(filePath);
  if (credentialsMap) {
    const output: Record<string, unknown> = {};
    for (const [providerKey, envKey] of Object.entries(credentialsMap)) {
      const value = resolveEnvironmentCredential(provider, envKey, values);
      if (value === undefined) {
        throw new Error(`credentialsMap key "${providerKey}" references missing .env variable "${envKey}".`);
      }
      output[providerKey] = value;
    }
    return output;
  }

  if (!fragment) {
    throw new Error('credentialsRef dotenv: references must include #ENV_VAR, or pass credentialsMap for multiple values.');
  }
  const value = resolveEnvironmentCredential(provider, fragment, values);
  if (value === undefined) {
    throw new Error(`.env variable "${fragment}" was not found.`);
  }
  return scalarCredentialObject(provider, value, credentialsKey, `dotenv:${filePath}#${fragment}`);
}

async function parseCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>,
  context?: { projectId?: string }
): Promise<Record<string, unknown>> {
  if (ref.trim().startsWith('dotenv:')) {
    return parseDotenvCredentialRef(provider, ref, credentialsKey, credentialsMap);
  }
  if (credentialsMap) {
    throw new Error('credentialsMap is only supported with credentialsRef="dotenv:/path/.env".');
  }

  const secretRef = parseSecretRef(ref.trim());
  if (secretRef) {
    const resolved = await new SecretResolver().resolveSecret(secretRef.raw, context);
    if ('error' in resolved) {
      throw new Error(`Failed to resolve credentialsRef secret: ${resolved.error}`);
    }
    return parseRawCredentialValue(provider, resolved.value, credentialsKey, 'credentialsRef secret');
  }

  const raw = resolveLocalSecretRef(ref, provider);
  return parseRawCredentialValue(provider, raw, credentialsKey, 'credentialsRef');
}

function refKind(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('file:')) return 'file';
  if (trimmed.startsWith('env:')) return 'env';
  if (trimmed.startsWith('dotenv:')) return 'dotenv';
  if (parseSecretRef(trimmed)) return 'secret-manager';
  return 'unknown';
}

function warningExtras(data: Record<string, unknown>): { warnings: string[] } | undefined {
  return typeof data.warning === 'string' && data.warning.trim()
    ? { warnings: [data.warning] }
    : undefined;
}

function setupDetails(provider: string, scope?: string) {
  return { connectionSetup: connectionSetupDetails(provider, { scope }) };
}

export function registerConnectionsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  const providerNames = [...new Set([...providerRegistry.names(), ...secretManagerRegistry.names()])];
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  commands.register(
    'hv_connections',
    'List provider connections and available providers by default. Pass project to select and validate project context while listing. Pass provider to manage one: action="add" (default) stores and verifies credentials, action="verify" re-verifies, action="remove" deletes, and action="prepare" performs confirm-gated cloud account preparation. Credentials are encrypted at rest and never returned; credentialsRef is preferred.',
    {
      provider: z.string().optional().describe(`Omit to list. Otherwise select a provider (available: ${providerNames.join(', ')}). action="remove" also accepts unregistered providers so stale connections can be deleted.`),
      action: z.enum(['add', 'verify', 'remove', 'prepare']).optional().describe('With provider: operation to perform (default: "add")'),
      credentials: z.record(z.unknown()).optional().describe('action="add": provider-specific credentials object. credentialsRef is recommended, but raw credentials are accepted when the user intentionally wants to enter them in chat.'),
      credentialsRef: z.string().optional().describe('action="add": recommended credential reference resolved by Hypervibe. Supports env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path for token/JSON files, or secret-manager refs like 1password://vault/item#field. The resolved value may be a JSON credentials object or a scalar.'),
      credentialsKey: z.string().optional().describe('action="add": wraps a scalar credentialsRef value under this provider credential key, e.g. apiToken or accessToken. Optional for common single-token providers.'),
      credentialsMap: z.record(z.string()).optional().describe('action="add": for credentialsRef="dotenv:/path/.env", maps provider credential keys to .env variable names, e.g. {"apiToken":"GITHUB_TOKEN","packageReadToken":"GITHUB_PACKAGES_TOKEN"}.'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global.'),
      project: projectField,
      gcpProjectId: z.string().optional().describe('action="prepare": GCP project ID (defaults to the Cloud Run connection projectId)'),
      deployServiceAccountEmail: z.string().optional().describe('action="prepare": deploy service account email (defaults to the Cloud Run connection service account)'),
      adminCredentialsJson: z.string().optional().describe('action="prepare": one-time admin service account JSON. Not stored.'),
      adminCredentialsJsonRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time admin service account JSON. Not stored.'),
      adminAccessToken: z.string().optional().describe('action="prepare": one-time OAuth admin access token. Not stored.'),
      adminAccessTokenRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time OAuth admin access token. Not stored.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({
      provider,
      action,
      credentials,
      credentialsRef,
      credentialsKey,
      credentialsMap,
      scope,
      project: projectRef,
      gcpProjectId,
      deployServiceAccountEmail,
      adminCredentialsJson,
      adminCredentialsJsonRef,
      adminAccessToken,
      adminAccessTokenRef,
      confirm,
    }) => {
      if (!provider) {
        const mutationInput = action !== undefined
          || credentials !== undefined
          || credentialsRef !== undefined
          || credentialsKey !== undefined
          || credentialsMap !== undefined
          || scope !== undefined
          || gcpProjectId !== undefined
          || deployServiceAccountEmail !== undefined
          || adminCredentialsJson !== undefined
          || adminCredentialsJsonRef !== undefined
          || adminAccessToken !== undefined
          || adminAccessTokenRef !== undefined
          || confirm !== undefined;
        if (mutationInput) {
          return commandError('VALIDATION', 'provider is required when connection operation parameters are supplied.', {
            hint: 'Omit all parameters to list connections, or pass provider to add, verify, remove, or prepare one.',
          });
        }
        const project = projectRef
          ? ctx.resolveProjectOrThrow({ project: projectRef })
          : null;
        return listConnections(project);
      }

      const requestedAction = action ?? 'add';
      // Stale connections for unregistered providers must stay removable.
      if (requestedAction !== 'remove' && !providerNames.includes(provider)) {
        return commandError('VALIDATION', `Unknown provider: ${provider}.`, {
          hint: `Available providers: ${providerNames.join(', ')}`,
        });
      }
      const project = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : null;
      const projectContext = project
        ? { project: { id: project.id, name: project.name } }
        : {};

      if (requestedAction === 'prepare') {
        const targetProject = project ?? ctx.resolveProjectOrThrow();
        const resolvedAdminCredentialsJson = adminCredentialsJsonRef
          ? resolveLocalSecretRef(adminCredentialsJsonRef)
          : adminCredentialsJson;
        const resolvedAdminAccessToken = adminAccessTokenRef
          ? resolveLocalSecretRef(adminAccessTokenRef)
          : adminAccessToken;
        const payload = await runCloudPrepare({
          project: targetProject,
          provider,
          gcpProjectId,
          deployServiceAccountEmail,
          adminCredentialsJson: resolvedAdminCredentialsJson,
          adminAccessToken: resolvedAdminAccessToken,
          confirm,
        });
        if (!payload.success) {
          return commandError('PROVIDER_ERROR', String(payload.error ?? 'Cloud preparation failed'), { details: payload });
        }
        return commandSuccess({ ...projectContext, ...payload }, payload.mode === 'preview'
          ? { hint: 'Recommended: export admin tokens or save service-account JSON to a local file, then re-run with confirm=true plus adminCredentialsJsonRef or adminAccessTokenRef. If the user intentionally wants to enter credentials in chat, adminCredentialsJson/adminAccessToken are still accepted.' }
          : { next: ['hv_plan'] });
      }

      if (requestedAction === 'remove') {
        const result = deleteConnection(provider, scope);
        if (!result.success) {
          return commandError('NOT_FOUND', result.error!);
        }
        return commandSuccess({ ...projectContext, provider, scope: scope || 'global', removed: true });
      }

      if (requestedAction === 'add') {
        if (credentials && credentialsRef) {
          return commandError('VALIDATION', 'Pass either credentials or credentialsRef, not both.');
        }
        if (!credentials && !credentialsRef) {
          return commandError('VALIDATION', 'credentials are required for action="add".', {
            details: setupDetails(provider, scope),
            hint: `Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        let credentialsToSave: Record<string, unknown>;
        try {
          const projectForSecretRef = project ?? ctx.resolveProject({});
          credentialsToSave = credentialsRef
            ? await parseCredentialRef(provider, credentialsRef, credentialsKey, credentialsMap, {
              ...(projectForSecretRef ? { projectId: projectForSecretRef.id } : {}),
            })
            : credentials!;
        } catch (error) {
          return commandError('VALIDATION', error instanceof Error ? error.message : String(error), {
            details: setupDetails(provider, scope),
            hint: `Use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, or a secret-manager ref like 1password://vault/item#field. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        const saved = await saveConnection(provider, credentialsToSave, scope);
        if (!saved.success) {
          return commandError('VALIDATION', saved.error!, {
            details: setupDetails(provider, scope),
            hint: `Fix the credentials object to match the provider schema and retry. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        // Auto-verify so one call does add + verify.
        const verified = await verifyConnection(provider, scope);
        if (verified.kind !== 'verified') {
          return commandError('PROVIDER_ERROR', verified.error ?? 'Verification failed.', {
            details: { connection: saved.connection, ...setupDetails(provider, scope) },
            hint: `The connection was saved but failed verification. Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="verify" or action="add" with corrected credentials. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        const data = {
          ...projectContext,
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          ...(credentialsRef ? { credentialsSource: refKind(credentialsRef) } : {}),
          ...verified.data,
          ...(saved.dependenciesInstalled ? { dependenciesInstalled: saved.dependenciesInstalled } : {}),
          ...(saved.dependencyErrors ? { dependencyErrors: saved.dependencyErrors } : {}),
        };
        return commandSuccess(data, warningExtras(data));
      }

      // action === 'verify'
      const verified = await verifyConnection(provider, scope);
      switch (verified.kind) {
        case 'verified':
        {
          const data = {
            ...projectContext,
            provider,
            scope: scope || 'global',
            status: 'verified',
            message: verified.message,
            ...verified.data,
          };
          return commandSuccess(data, warningExtras(data));
        }
        case 'not_found':
          return commandError('NOT_FOUND', verified.error, {
            details: setupDetails(provider, scope),
            hint: `Add the connection first with hv_connections provider="${provider}" action="add". ${formatConnectionGuidance(provider, { scope })}`,
          });
        case 'unknown_provider':
          return commandError('UNSUPPORTED', verified.error);
        default:
          return commandError('PROVIDER_ERROR', verified.error, {
            details: setupDetails(provider, scope),
            hint: `Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="add" with corrected credentials. ${formatConnectionGuidance(provider, { scope })}`,
          });
      }
    })
  );

  async function listConnections(project: Project | null) {
      const connections = ctx.repos.connections.findAll().map((c) => ({
        provider: c.provider,
        scope: c.scope ?? 'global',
        status: c.status,
        lastVerifiedAt: c.lastVerifiedAt,
      }));

      const availableProviders: Record<string, Array<{
        name: string;
        displayName: string;
        setupHelpUrl?: string;
        setupHelpUrls?: Array<{ label: string; url: string }>;
        tokenType?: string;
        requiredPermissions?: string[];
        credentialExample?: string;
        notes?: string[];
        credentialFields?: CredentialFieldDescriptor[];
        defaultScalarKey?: string;
        environmentVariableAliases?: string[][];
      }>> = {};
      for (const p of providerRegistry.all()) {
        const category = p.metadata.category;
        const guidance = getConnectionGuidance(p.metadata.name);
        const credentialFields = credentialFieldsFromSchema(p.metadata.credentialsSchema);
        availableProviders[category] = availableProviders[category] ?? [];
        availableProviders[category].push({
          name: p.metadata.name,
          displayName: p.metadata.displayName,
          ...(credentialFields !== undefined ? { credentialFields } : {}),
          ...(p.metadata.credentials?.defaultScalarKey ? { defaultScalarKey: p.metadata.credentials.defaultScalarKey } : {}),
          ...(p.metadata.credentials?.environmentVariableAliases?.length
            ? { environmentVariableAliases: p.metadata.credentials.environmentVariableAliases }
            : {}),
          ...(guidance?.setupUrl || p.metadata.setupHelpUrl ? { setupHelpUrl: guidance?.setupUrl ?? p.metadata.setupHelpUrl } : {}),
          ...(guidance?.setupUrls?.length ? { setupHelpUrls: guidance.setupUrls } : {}),
          ...(guidance ? {
            tokenType: guidance.tokenType,
            requiredPermissions: guidance.permissions,
            credentialExample: guidance.credentialExample,
            ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
          } : {}),
        });
      }
      for (const p of secretManagerRegistry.all()) {
        const guidance = getConnectionGuidance(p.metadata.name);
        const credentialFields = credentialFieldsFromSchema(p.metadata.credentialsSchema);
        availableProviders['secrets'] = availableProviders['secrets'] ?? [];
        availableProviders['secrets'].push({
          name: p.metadata.name,
          displayName: p.metadata.displayName,
          ...(credentialFields !== undefined ? { credentialFields } : {}),
          ...(p.metadata.credentials?.defaultScalarKey ? { defaultScalarKey: p.metadata.credentials.defaultScalarKey } : {}),
          ...(guidance?.setupUrl || p.metadata.setupHelpUrl ? { setupHelpUrl: guidance?.setupUrl ?? p.metadata.setupHelpUrl } : {}),
          ...(guidance?.setupUrls?.length ? { setupHelpUrls: guidance.setupUrls } : {}),
          ...(guidance ? {
            tokenType: guidance.tokenType,
            requiredPermissions: guidance.permissions,
            credentialExample: guidance.credentialExample,
            ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
          } : {}),
        });
      }

      const discoveryHint = 'This list is credential discovery only. If a concrete task is blocked, use hv_connections with provider only when a safe credentialsRef is already available. Otherwise offer to help connect credentials the user already controls or prepare a value-free handoff naming the provider, scope, and blocked task for the person who manages that access. Do not assume provider membership or run hv_plan, hv_apply, or hv_deploy to bypass the missing connection.';
      return commandSuccess(
        {
          ...(project ? { project: { id: project.id, name: project.name } } : {}),
          connections,
          availableProviders,
        },
        {
          hint: connections.length === 0
            ? `No connections yet. Recommended: hv_connections provider="<name>" credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if the user intentionally wants chat entry. ${discoveryHint}`
            : discoveryHint,
        }
      );
  }
}
