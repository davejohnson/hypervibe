import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { saveConnection, verifyConnection, deleteConnection } from '../domain/services/connection-ops.service.js';
import type { ToolContext } from './context.js';
import { projectField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler } from './respond.js';

export function registerConnectionsTools(server: McpServer, ctx: ToolContext): void {
  const providerNames = providerRegistry.names();
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  server.tool(
    'hv_connect',
    'Manage provider connections. action="add" (default) stores credentials and immediately verifies them; action="verify" re-verifies an existing connection; action="remove" deletes one; action="prepare" runs one-time cloud account preparation (Cloud Run: enables required GCP APIs and grants deploy IAM roles using one-time admin credentials that are never stored — preview first, then pass confirm=true). Credentials are encrypted at rest and never returned.',
    {
      provider: z.enum(providerNames as [string, ...string[]]).describe('Provider name (see hv_connections_list for what is available)'),
      action: z.enum(['add', 'verify', 'remove', 'prepare']).optional().describe('What to do (default: "add")'),
      credentials: z.record(z.unknown()).optional().describe('Provider-specific credentials object (required for action="add")'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global.'),
      project: projectField,
      gcpProjectId: z.string().optional().describe('action="prepare": GCP project ID (defaults to the Cloud Run connection projectId)'),
      deployServiceAccountEmail: z.string().optional().describe('action="prepare": deploy service account email (defaults to the Cloud Run connection service account)'),
      adminCredentialsJson: z.string().optional().describe('action="prepare": one-time admin service account JSON. Not stored.'),
      adminAccessToken: z.string().optional().describe('action="prepare": one-time OAuth admin access token. Not stored.'),
      confirm: confirmField,
    },
    wrapHandler(async ({ provider, action = 'add', credentials, scope, project: projectRef, gcpProjectId, deployServiceAccountEmail, adminCredentialsJson, adminAccessToken, confirm }) => {
      if (action === 'prepare') {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const payload = await runCloudPrepare({
          project,
          provider,
          gcpProjectId,
          deployServiceAccountEmail,
          adminCredentialsJson,
          adminAccessToken,
          confirm,
        });
        if (!payload.success) {
          return toolError('PROVIDER_ERROR', String(payload.error ?? 'Cloud preparation failed'), { details: payload });
        }
        return toolSuccess(payload, payload.mode === 'preview'
          ? { hint: 'Re-run with confirm=true plus adminCredentialsJson or adminAccessToken to execute.' }
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
        if (!credentials) {
          return toolError('VALIDATION', 'credentials are required for action="add".', {
            hint: 'Pass the provider-specific credentials object (e.g. { "apiToken": "..." } for Railway).',
          });
        }

        const saved = await saveConnection(provider, credentials, scope);
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

        return toolSuccess({
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          ...verified.data,
          ...(saved.dependenciesInstalled ? { dependenciesInstalled: saved.dependenciesInstalled } : {}),
          ...(saved.dependencyErrors ? { dependencyErrors: saved.dependencyErrors } : {}),
        });
      }

      // action === 'verify'
      const verified = await verifyConnection(provider, scope);
      switch (verified.kind) {
        case 'verified':
          return toolSuccess({
            provider,
            scope: scope || 'global',
            status: 'verified',
            message: verified.message,
            ...verified.data,
          });
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

      return toolSuccess(
        { connections, availableProviders },
        {
          hint: connections.length === 0
            ? 'No connections yet. Add one with hv_connect provider="<name>" credentials={...}.'
            : undefined,
        }
      );
    })
  );
}
