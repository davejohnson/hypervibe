import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { saveConnection, verifyConnection, deleteConnection } from '../domain/services/connection-ops.service.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import { parseEnvFile } from '../utils/env-parser.js';
import type { ToolContext } from './context.js';
import { projectField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler } from './respond.js';

function resolveLocalSecretRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice('env:'.length).trim();
    if (!name) {
      throw new Error('credentialsRef env: reference is missing the environment variable name.');
    }
    const value = process.env[name];
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

function splitFragment(value: string): { target: string; fragment?: string } {
  const hashIndex = value.lastIndexOf('#');
  if (hashIndex === -1) {
    return { target: value };
  }
  return {
    target: value.slice(0, hashIndex),
    fragment: value.slice(hashIndex + 1),
  };
}

function defaultScalarCredentialKey(provider: string): string | undefined {
  switch (provider) {
    case 'cloudflare':
    case 'digitalocean':
    case 'github':
    case 'railway':
      return 'apiToken';
    case 'database':
      return 'connectionUrl';
    case 'doppler':
    case 'vercel':
      return 'token';
    case 'heroku':
    case 'render':
      return 'apiKey';
    case '1password':
      return 'serviceAccountToken';
    case 'sendgrid':
      return 'apiKey';
    case 'supabase':
      return 'accessToken';
    default:
      return undefined;
  }
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
      if (!(envKey in values)) {
        throw new Error(`credentialsMap key "${providerKey}" references missing .env variable "${envKey}".`);
      }
      output[providerKey] = values[envKey];
    }
    return output;
  }

  if (!fragment) {
    throw new Error('credentialsRef dotenv: references must include #ENV_VAR, or pass credentialsMap for multiple values.');
  }
  if (!(fragment in values)) {
    throw new Error(`.env variable "${fragment}" was not found.`);
  }
  return scalarCredentialObject(provider, values[fragment], credentialsKey, `dotenv:${filePath}#${fragment}`);
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

  const raw = resolveLocalSecretRef(ref);
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

export function registerConnectionsTools(server: McpServer, ctx: ToolContext): void {
  const providerNames = [...new Set([...providerRegistry.names(), ...secretManagerRegistry.names()])];
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  server.tool(
    'hv_connect',
    'Manage provider connections. action="add" (default) stores credentials and immediately verifies them; action="verify" re-verifies an existing connection; action="remove" deletes one; action="prepare" runs one-time cloud account preparation (Cloud Run: enables required GCP APIs and grants deploy IAM roles using one-time admin credentials that are never stored — preview first, then pass confirm=true). Credentials are encrypted at rest and never returned. Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, or a secret-manager ref like 1password://vault/item#field. Raw credentials={...} is still accepted if the user intentionally wants to enter credentials in chat.',
    {
      provider: z.enum(providerNames as [string, ...string[]]).describe('Provider name (see hv_connections_list for what is available)'),
      action: z.enum(['add', 'verify', 'remove', 'prepare']).optional().describe('What to do (default: "add")'),
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
    wrapHandler(async ({
      provider,
      action = 'add',
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
      if (action === 'prepare') {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const resolvedAdminCredentialsJson = adminCredentialsJsonRef
          ? resolveLocalSecretRef(adminCredentialsJsonRef)
          : adminCredentialsJson;
        const resolvedAdminAccessToken = adminAccessTokenRef
          ? resolveLocalSecretRef(adminAccessTokenRef)
          : adminAccessToken;
        const payload = await runCloudPrepare({
          project,
          provider,
          gcpProjectId,
          deployServiceAccountEmail,
          adminCredentialsJson: resolvedAdminCredentialsJson,
          adminAccessToken: resolvedAdminAccessToken,
          confirm,
        });
        if (!payload.success) {
          return toolError('PROVIDER_ERROR', String(payload.error ?? 'Cloud preparation failed'), { details: payload });
        }
        return toolSuccess(payload, payload.mode === 'preview'
          ? { hint: 'Recommended: export admin tokens or save service-account JSON to a local file, then re-run with confirm=true plus adminCredentialsJsonRef or adminAccessTokenRef. If the user intentionally wants to enter credentials in chat, adminCredentialsJson/adminAccessToken are still accepted.' }
          : { next: ['hv_plan'] });
      }

      if (action === 'remove') {
        const result = deleteConnection(provider, scope);
        if (!result.success) {
          return toolError('NOT_FOUND', result.error!);
        }
        return toolSuccess({ provider, scope: scope || 'global', removed: true });
      }

      if (action === 'add') {
        if (credentials && credentialsRef) {
          return toolError('VALIDATION', 'Pass either credentials or credentialsRef, not both.');
        }
        if (!credentials && !credentialsRef) {
          return toolError('VALIDATION', 'credentials are required for action="add".', {
            hint: 'Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional.',
          });
        }

        let credentialsToSave: Record<string, unknown>;
        try {
          const projectForSecretRef = projectRef
            ? ctx.resolveProject({ project: projectRef })
            : ctx.resolveProject({});
          credentialsToSave = credentialsRef
            ? await parseCredentialRef(provider, credentialsRef, credentialsKey, credentialsMap, {
              ...(projectForSecretRef ? { projectId: projectForSecretRef.id } : {}),
            })
            : credentials!;
        } catch (error) {
          return toolError('VALIDATION', error instanceof Error ? error.message : String(error), {
            hint: 'Use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, or a secret-manager ref like 1password://vault/item#field. Raw credentials={...} is still accepted if intentional.',
          });
        }

        const saved = await saveConnection(provider, credentialsToSave, scope);
        if (!saved.success) {
          return toolError('VALIDATION', saved.error!, {
            hint: 'Fix the credentials object to match the provider schema and retry.',
          });
        }

        // Auto-verify so one call does add + verify.
        const verified = await verifyConnection(provider, scope);
        if (verified.kind !== 'verified') {
          return toolError('PROVIDER_ERROR', verified.error ?? 'Verification failed.', {
            details: { connection: saved.connection },
            hint: 'The connection was saved but failed verification. Check the credentials and re-run hv_connect action="verify" (or "add" with corrected credentials).',
          });
        }

        const data = {
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          ...(credentialsRef ? { credentialsSource: refKind(credentialsRef) } : {}),
          ...verified.data,
          ...(saved.dependenciesInstalled ? { dependenciesInstalled: saved.dependenciesInstalled } : {}),
          ...(saved.dependencyErrors ? { dependencyErrors: saved.dependencyErrors } : {}),
        };
        return toolSuccess(data, warningExtras(data));
      }

      // action === 'verify'
      const verified = await verifyConnection(provider, scope);
      switch (verified.kind) {
        case 'verified':
        {
          const data = {
            provider,
            scope: scope || 'global',
            status: 'verified',
            message: verified.message,
            ...verified.data,
          };
          return toolSuccess(data, warningExtras(data));
        }
        case 'not_found':
          return toolError('NOT_FOUND', verified.error, {
            hint: 'Add the connection first with hv_connect action="add".',
          });
        case 'unknown_provider':
          return toolError('UNSUPPORTED', verified.error);
        default:
          return toolError('PROVIDER_ERROR', verified.error, {
            hint: 'Check the credentials and re-run hv_connect action="add" with corrected credentials.',
          });
      }
    })
  );

  server.tool(
    'hv_connections_list',
    'List stored provider connections (provider, scope, status, last verified — never credentials) plus all connectable providers grouped by category.',
    {},
    wrapHandler(async () => {
      const connections = ctx.repos.connections.findAll().map((c) => ({
        provider: c.provider,
        scope: c.scope ?? 'global',
        status: c.status,
        lastVerifiedAt: c.lastVerifiedAt,
      }));

      const availableProviders: Record<string, Array<{ name: string; displayName: string; setupHelpUrl?: string }>> = {};
      for (const p of providerRegistry.all()) {
        const category = p.metadata.category;
        availableProviders[category] = availableProviders[category] ?? [];
        availableProviders[category].push({
          name: p.metadata.name,
          displayName: p.metadata.displayName,
          ...(p.metadata.setupHelpUrl ? { setupHelpUrl: p.metadata.setupHelpUrl } : {}),
        });
      }
      for (const p of secretManagerRegistry.all()) {
        availableProviders['secrets'] = availableProviders['secrets'] ?? [];
        availableProviders['secrets'].push({
          name: p.metadata.name,
          displayName: p.metadata.displayName,
          ...(p.metadata.setupHelpUrl ? { setupHelpUrl: p.metadata.setupHelpUrl } : {}),
        });
      }

      return toolSuccess(
        { connections, availableProviders },
        {
          hint: connections.length === 0
            ? 'No connections yet. Recommended: hv_connect provider="<name>" credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if the user intentionally wants chat entry.'
            : undefined,
        }
      );
    })
  );
}
