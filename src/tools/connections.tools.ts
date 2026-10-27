import { runtimeMailProbeSchema } from '../domain/ports/runtime-mail-authentication.port.js';
import { verifyRuntimeMailConnection } from '../application/runtime-mail-authentication.js';
import { parseCredentialRef, resolveLocalSecretRef, type ResolvedCredentialSource } from '../application/credential-reference.js';
import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import {
  providerRegistry,
  type ProviderMetadata,
} from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { saveConnection, verifyConnection, deleteConnection } from '../domain/services/connection-ops.service.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import {
  credentialFieldsFromSchema,
  connectionSetupDetails,
  formatConnectionGuidance,
  getConnectionGuidance,
} from '../domain/services/connection-guidance.js';
import type { ConnectionGuidanceContext, CredentialFieldDescriptor } from '../domain/services/connection-guidance.js';
import type { CommandContext } from '../application/context.js';
import { projectField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';
import { suppliedOptionNames } from '../application/command-options.js';
import type { Project } from '../domain/entities/project.entity.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity } from '../lib/git-remote.js';
import { currentWorkspaceDirectories, primaryWorkspaceDirectory, runWithWorkspaceDirectories } from '../lib/workspace-context.js';

const CONTEXTUAL_SETUP_HINT = 'Provider-owned bootstrap takes precedence. When the provider is known and a human form is needed, call hv_connections with action="describe", provider and the known non-secret scope before presenting a credential form; include project only if already known, and omit unknown optional fields. Do not supply credentials, credentialsRef or confirmation to describe; the read-only contextual call returns connectionSetup guidance. Copy the returned recommendedSetupUrl verbatim with its complete query string; do not construct or edit credential URLs yourself. Do not repeat a generic provider list as a substitute. Do not initialize a project solely to obtain setup guidance.';

function refKind(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('file:')) return 'file';
  if (trimmed.startsWith('env:')) return 'env';
  if (trimmed.startsWith('dotenv:')) return 'dotenv';
  const secretRef = parseSecretRef(trimmed);
  if (secretRef?.provider === 'stripe-projects') return 'stripe-projects';
  if (secretRef) return 'secret-manager';
  return 'unknown';
}

function warningExtras(data: Record<string, unknown>): { warnings: string[] } | undefined {
  return typeof data.warning === 'string' && data.warning.trim()
    ? { warnings: [data.warning] }
    : undefined;
}

function setupDetails(provider: string, context: ConnectionGuidanceContext) {
  return { connectionSetup: connectionSetupDetails(provider, context) };
}

type ProviderDiscoveryEntry = {
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
  maturity?: ProviderMetadata['maturity'];
  lifecycle?: ProviderMetadata['lifecycle'];
};

function providerDiscoveryEntry(metadata: Pick<
  ProviderMetadata,
  'name' | 'displayName' | 'setupHelpUrl' | 'credentialsSchema' | 'credentials' | 'maturity' | 'lifecycle'
>, context: ConnectionGuidanceContext = {}): ProviderDiscoveryEntry {
  const guidance = getConnectionGuidance(metadata.name, context);
  const credentialFields = credentialFieldsFromSchema(metadata.credentialsSchema, {
    exclude: metadata.credentials?.agentManagedKeys,
    excludeChoices: metadata.credentials?.agentManagedChoices,
  });
  return {
    name: metadata.name,
    displayName: metadata.displayName,
    ...(metadata.maturity ? { maturity: metadata.maturity } : {}),
    ...(metadata.lifecycle ? { lifecycle: metadata.lifecycle } : {}),
    ...(credentialFields !== undefined ? { credentialFields } : {}),
    ...(metadata.credentials?.defaultScalarKey ? { defaultScalarKey: metadata.credentials.defaultScalarKey } : {}),
    ...(metadata.credentials?.environmentVariableAliases?.length
      ? { environmentVariableAliases: metadata.credentials.environmentVariableAliases }
      : {}),
    ...(guidance?.setupUrl || metadata.setupHelpUrl ? { setupHelpUrl: guidance?.setupUrl ?? metadata.setupHelpUrl } : {}),
    ...(guidance?.setupUrls?.length ? { setupHelpUrls: guidance.setupUrls } : {}),
    ...(guidance ? {
      tokenType: guidance.tokenType,
      requiredPermissions: guidance.permissions,
      credentialExample: guidance.credentialExample,
      ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
    } : {}),
  };
}

export function registerConnectionsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  const providerNames = [...new Set([...providerRegistry.names(), ...secretManagerRegistry.names()])];
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  commands.register(
    'hv_connections',
    [CONTEXTUAL_SETUP_HINT, 'For new AWS, Azure or GCP secret-manager connections, use hv_cloud_connections purpose="connect-cloud" for browser installation without local cloud credentials or manually prepared writers. Connection modes here: {} lists every connection/provider; {project} lists in validated project context; {provider,...} manages existing access. With provider, action="add" is the default. The explicit legacy action="bootstrap" with provider="cloudrun" creates a deployment service-account key; it is not the Connect Cloud onboarding path. "verify", "remove", and "prepare" remain explicit advanced operations. Project context never changes provider scope. Credentials are encrypted at rest and never returned; use credentialsRef for credentials the user already controls. Providers and credential sources that declare native CLI authentication may omit credentials to use the active local/default credential chain.'].join(' '),
    {
      provider: z.string().optional().describe(`Omit to list. Otherwise select a provider (available: ${providerNames.join(', ')}). action="remove" also accepts unregistered providers so stale connections can be deleted.`),
      action: z.enum(['add', 'describe', 'verify', 'remove', 'prepare', 'bootstrap']).optional().describe('With provider: operation to perform (default: "add"). "describe" returns contextual forms without resolving credentials, observing providers, or writing state. GCP "bootstrap" is an explicit legacy setup that creates a deployment service-account key. New Connect Cloud customers use hv_cloud_connections purpose="connect-cloud".'),
      credentials: z.record(z.string(), z.unknown()).optional().describe('action="add": provider-specific credentials object. Omit for providers supporting native CLI/default authentication. credentialsRef is recommended for explicit credentials, but raw credentials are accepted when intentional.'),
      credentialsRef: z.string().optional().describe('action="add", or action="verify" with runtimeMail: recommended credential reference resolved privately by Hypervibe. Supports env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path for token/JSON files, secret-manager refs like 1password://vault/item#field, or an already-pulled active Stripe Projects environment with stripe-projects://<environment>/<provider>/<service>. The resolved value may be a JSON credentials object or a scalar.'),
      runtimeMail: runtimeMailProbeSchema.optional().describe('action="verify" with an explicit private credentialsRef: validate a fixed sandbox Mail Send request without sending email or saving a connection. Requires sender and a consenting test recipient; does not prove least privilege, sender authorization or live delivery.'),
      credentialsKey: z.string().optional().describe('action="add": wraps a scalar credentialsRef value under this provider credential key, e.g. apiToken or accessToken. Optional for common single-token providers.'),
      credentialsMap: z.record(z.string(), z.string()).optional().describe('action="add": for dotenv or structured secret-manager references, maps provider credential keys to source fields, e.g. {"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}.'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global except action="bootstrap", which derives an exact repository scope from the selected project when omitted and never creates global GCP access.'),
      project: projectField.describe('Hypervibe project name/id for validated context. Required explicitly for action="bootstrap". With no provider, project-only still lists. Omit for an unscoped list. This never changes provider credential scope.'),
      repositoryContext: z.boolean().optional().describe('Read-only discovery/describe only: resolve the current client repository without importing its spec or bindings. Do not combine with project. A fresh repository may supply Git-remote context for form labels and owner prefill, but remains unscoped. Ambiguous or unrecorded committed identities remain blocked.'),
      gcpProjectId: z.string().optional().describe('Exact GCP project ID. Bootstrap preview reuses verified repository-scoped access or derives a stable name when omitted; confirmation requires the exact ID returned by that preview. Prepare defaults to the Cloud Run connection projectId.'),
      billingAccountName: z.string().optional().describe('action="bootstrap" with confirm=true: exact open billing account name returned by the preview, such as billingAccounts/AAAAAA-BBBBBB-CCCCCC.'),
      deployServiceAccountEmail: z.string().optional().describe('action="prepare": deploy service account email (defaults to the Cloud Run connection service account)'),
      gcsAccess: z.enum(['inspect', 'lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly add project-scoped GCS access. "inspect" grants the deploy identity roles/storage.viewer; "lifecycle" grants it roles/storage.admin and grants the distinct configured runtime identity roles/storage.objectUser across this GCP project.'),
      memorystoreAccess: z.enum(['inspect', 'lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly add Memorystore access to the reused service account. "inspect" grants roles/redis.viewer; "lifecycle" grants roles/redis.admin.'),
      queueAccess: z.enum(['lifecycle', 'remove']).optional().describe('action="prepare" for cloudrun: explicitly grant Pub/Sub queue lifecycle access or remove that exact role from the reused service account.'),
      adminAuth: z.literal('default').optional().describe('Required for action="bootstrap" and confirmed action="prepare": use existing Google Application Default Credentials for the one-time admin operation. Not stored.'),
      adminCredentialsJson: z.string().optional().describe('action="prepare": one-time admin service account JSON. Not stored.'),
      adminCredentialsJsonRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time admin service account JSON. Not stored.'),
      adminAccessToken: z.string().optional().describe('action="prepare": one-time OAuth admin access token. Not stored.'),
      adminAccessTokenRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time OAuth admin access token. Not stored.'),
      confirm: confirmField.describe('For action="bootstrap" or action="prepare", omit for a read-only preview and set true only after reviewing that preview. Other connection actions do not accept confirm.'),
    },
    wrapCommandHandler(async ({
      provider,
      action,
      credentials,
      credentialsRef,
      runtimeMail,
      credentialsKey,
      credentialsMap,
      scope,
      project: projectRef,
      repositoryContext,
      gcpProjectId,
      billingAccountName,
      deployServiceAccountEmail,
      gcsAccess,
      memorystoreAccess,
      queueAccess,
      adminAuth,
      adminCredentialsJson,
      adminCredentialsJsonRef,
      adminAccessToken,
      adminAccessTokenRef,
      confirm,
    }) => {
      if (repositoryContext && projectRef !== undefined) {
        return commandError('VALIDATION', 'Choose project or repositoryContext, not both.');
      }
      if (repositoryContext !== undefined && provider && action !== 'describe') {
        return commandError('VALIDATION', 'repositoryContext is accepted only for discovery or describe.');
      }
      const resolveGuidanceContext = async () => {
        let project: Project | null;
        let repositoryUrl: string | undefined;
        if (!repositoryContext) {
          project = projectRef ? await ctx.resolveProjectOrThrow({ project: projectRef, readOnly: true }) : null;
        } else {
          const directories = currentWorkspaceDirectories() ?? [primaryWorkspaceDirectory()];
          if (directories.length !== 1) throw new HvError('VALIDATION', 'repositoryContext requires one unambiguous client repository. Select a project explicitly when multiple repositories are open.');
          // Explicit workspace context disables the legacy sole-project fallback.
          project = await runWithWorkspaceDirectories(directories, async () => ctx.resolveProject({ readOnly: true }));
          if (!project) {
            repositoryUrl = detectGitRemoteUrl(directories[0]) ?? undefined;
            if (repositoryUrl && !normalizeGitRemoteIdentity(repositoryUrl)) {
              throw new HvError('VALIDATION', 'The current repository origin is not a supported remote URL. Supply an explicit non-secret scope for setup guidance.');
            }
          }
        }
        const context: ConnectionGuidanceContext = {
          ...(project ? { project: project.name, repositoryUrl: project.gitRemoteUrl } : {}),
          ...(repositoryUrl ? { repositoryUrl } : {}),
        };
        return { project, context };
      };
      if (!provider) {
        const mutationInput = action !== undefined
          || credentials !== undefined
          || credentialsRef !== undefined
          || runtimeMail !== undefined
          || credentialsKey !== undefined
          || credentialsMap !== undefined
          || scope !== undefined
          || gcpProjectId !== undefined
          || billingAccountName !== undefined
          || deployServiceAccountEmail !== undefined
          || gcsAccess !== undefined
          || memorystoreAccess !== undefined
          || queueAccess !== undefined
          || adminAuth !== undefined
          || adminCredentialsJson !== undefined
          || adminCredentialsJsonRef !== undefined
          || adminAccessToken !== undefined
          || adminAccessTokenRef !== undefined
          || confirm !== undefined;
        if (mutationInput) {
          return commandError('VALIDATION', 'provider is required when connection operation parameters are supplied.', {
          hint: 'Use hv_connections({}) to list globally, hv_connections({project}) to list in validated project context, or pass provider to add, verify, remove, prepare, or bootstrap.',
          });
        }
        const { project, context } = await resolveGuidanceContext();
        return listConnections(project, context);
      }

      const requestedAction = action ?? 'add';
      // Stale connections for unregistered providers must stay removable.
      if (requestedAction !== 'remove' && !providerNames.includes(provider)) {
        return commandError('VALIDATION', `Unknown provider: ${provider}.`, {
          hint: `Available providers: ${providerNames.join(', ')}`,
        });
      }
      if (runtimeMail !== undefined) {
        const incompatible = suppliedOptionNames({ credentials, credentialsKey, credentialsMap, scope, project: projectRef, repositoryContext,
          gcpProjectId, billingAccountName, deployServiceAccountEmail, gcsAccess, memorystoreAccess, queueAccess,
          adminAuth, adminCredentialsJson, adminCredentialsJsonRef, adminAccessToken, adminAccessTokenRef, confirm });
        if (requestedAction !== 'verify' || !credentialsRef || incompatible.length)
          return commandError('VALIDATION', 'runtimeMail requires action="verify", an explicit private credentialsRef, and no saved scope, raw credentials or setup options.');
        return verifyRuntimeMailConnection(provider, credentialsRef, runtimeMail);
      }
      if (requestedAction === 'describe') {
        const incompatible = suppliedOptionNames({ credentials, credentialsRef, credentialsKey, credentialsMap,
          gcpProjectId, billingAccountName, deployServiceAccountEmail,
          gcsAccess, memorystoreAccess, queueAccess, adminAuth, adminCredentialsJson,
          adminCredentialsJsonRef, adminAccessToken, adminAccessTokenRef, confirm });
        if (incompatible.length) return commandError('VALIDATION', `describe does not accept: ${incompatible.join(', ')}.`);
        const { context: repositoryGuidance } = await resolveGuidanceContext();
        const context: ConnectionGuidanceContext = {
          ...repositoryGuidance,
          ...(scope ? { scope } : {}),
        };
        const metadata = providerRegistry.getMetadata(provider) ?? secretManagerRegistry.getMetadata(provider)!;
        return commandSuccess({
          provider: providerDiscoveryEntry(metadata, context),
          connectionSetup: connectionSetupDetails(provider, context),
        }, { hint: 'Setup guidance only; no credential was resolved, connection verified, or setup preview created. Provider-owned bootstrap takes precedence. Preserve the complete returned URL and review the remaining manual fields.' });
      }
      const sharedGcpFields = {
        gcpProjectId,
        adminAuth,
      };
      const prepareOnlyFields = {
        deployServiceAccountEmail,
        gcsAccess,
        memorystoreAccess,
        queueAccess,
        adminCredentialsJson,
        adminCredentialsJsonRef,
        adminAccessToken,
        adminAccessTokenRef,
      };
      const bootstrapOnlyFields = { billingAccountName };
      const credentialFields = { credentials, credentialsRef, credentialsKey, credentialsMap };
      const incompatible = suppliedOptionNames(requestedAction === 'prepare'
        ? { ...credentialFields, ...bootstrapOnlyFields, scope }
        : requestedAction === 'bootstrap'
          ? { ...credentialFields, ...prepareOnlyFields }
        : requestedAction === 'remove' || requestedAction === 'verify'
          ? {
            ...credentialFields,
            ...sharedGcpFields,
            ...prepareOnlyFields,
            ...bootstrapOnlyFields,
            confirm,
          }
          : {
            ...sharedGcpFields,
            ...prepareOnlyFields,
            ...bootstrapOnlyFields,
            confirm,
          });
      if (incompatible.length > 0) {
        return commandError(
          'VALIDATION',
          `action="${requestedAction}" received options for another connection action: ${incompatible.join(', ')}.`,
          { hint: `Remove the listed options and pass only fields documented for action="${requestedAction}".` }
        );
      }
      if (requestedAction === 'add' && !credentialsRef && (credentialsKey !== undefined || credentialsMap !== undefined)) {
        return commandError('VALIDATION', 'credentialsKey and credentialsMap require credentialsRef for action="add".');
      }
      if (requestedAction === 'add' && credentialsKey !== undefined && credentialsMap !== undefined) {
        return commandError('VALIDATION', 'Pass either credentialsKey or credentialsMap for action="add", not both.');
      }
      if (requestedAction === 'prepare' && adminCredentialsJson && adminCredentialsJsonRef) {
        return commandError('VALIDATION', 'Pass either adminCredentialsJson or adminCredentialsJsonRef, not both.');
      }
      if (requestedAction === 'prepare' && adminAccessToken && adminAccessTokenRef) {
        return commandError('VALIDATION', 'Pass either adminAccessToken or adminAccessTokenRef, not both.');
      }
      if (requestedAction === 'prepare' && gcsAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'gcsAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && memorystoreAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'memorystoreAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && queueAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'queueAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && queueAccess === 'remove' && (gcsAccess || memorystoreAccess)) {
        return commandError(
          'VALIDATION',
          'queueAccess="remove" is an exact removal-only operation and cannot be combined with GCS or Memorystore grants.'
        );
      }
      const adminJsonSupplied = adminCredentialsJson !== undefined || adminCredentialsJsonRef !== undefined;
      const adminTokenSupplied = adminAccessToken !== undefined || adminAccessTokenRef !== undefined;
      const adminDefaultSupplied = adminAuth === 'default';
      if (requestedAction === 'prepare' && [adminJsonSupplied, adminTokenSupplied, adminDefaultSupplied].filter(Boolean).length > 1) {
        return commandError('VALIDATION', 'Pass one admin authentication method for action="prepare": default Google credentials, service-account JSON, or an access token.');
      }
      if (requestedAction === 'prepare' && !confirm && (adminJsonSupplied || adminTokenSupplied || adminDefaultSupplied)) {
        return commandError('VALIDATION', 'Admin credentials are accepted only with confirm=true for action="prepare".', {
          hint: 'Run the credential-free preview first, then pass adminAuth="default" or exactly one admin credential reference with confirm=true.',
        });
      }
      if (requestedAction === 'prepare' && confirm && !adminJsonSupplied && !adminTokenSupplied && !adminDefaultSupplied) {
        return commandError('VALIDATION', 'confirm=true requires one admin authentication method for action="prepare".', {
          hint: 'Prefer adminAuth="default" to use existing Google Application Default Credentials. Explicit adminCredentialsJsonRef or adminAccessTokenRef remain available when intentional.',
        });
      }
      if (requestedAction === 'bootstrap' && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'action="bootstrap" is supported only with provider="cloudrun". It creates both Cloud Run and Cloud SQL connections.');
      }
      if (requestedAction === 'bootstrap' && confirm && !gcpProjectId?.trim()) {
        return commandError('VALIDATION', 'Confirmed bootstrap requires the exact gcpProjectId returned by the preview.');
      }
      if (requestedAction === 'bootstrap' && !projectRef?.trim()) {
        return commandError('VALIDATION', 'project is required for action="bootstrap" so Hypervibe never stores GCP access against an inferred project.');
      }
      if (requestedAction === 'bootstrap' && adminAuth !== 'default') {
        return commandError('VALIDATION', 'adminAuth="default" is required for action="bootstrap".', {
          hint: 'Hypervibe uses your current Google Application Default Credentials in memory for this one-time setup and never stores them.',
        });
      }
      if (requestedAction === 'bootstrap' && !confirm && billingAccountName !== undefined) {
        return commandError('VALIDATION', 'billingAccountName is accepted only with confirm=true for action="bootstrap".', {
          hint: 'Run the preview first. It lists the exact open billing accounts available to your current Google login.',
        });
      }
      if (requestedAction === 'bootstrap' && confirm && !billingAccountName?.trim()) {
        return commandError('VALIDATION', 'confirm=true requires the exact billingAccountName returned by the bootstrap preview.', {
          hint: 'Run the same bootstrap call without confirm first, then choose one exact openBillingAccounts[].name value.',
        });
      }
      const project = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : null;
      const guidanceContext = { scope, project: project?.name, repositoryUrl: project?.gitRemoteUrl };
      const projectContext = project
        ? { project: { id: project.id, name: project.name } }
        : {};

      if (requestedAction === 'bootstrap') {
        const targetProject = project!;
        const payload = await runGcpBootstrap({
          project: targetProject,
          gcpProjectId,
          scope,
          billingAccountName,
          confirm,
        });
        if (!payload.success) {
          return commandError('PROVIDER_ERROR', String(payload.error ?? 'GCP setup failed.'), {
            details: payload,
          });
        }
        if (payload.mode === 'preview') {
          const accountNames = Array.isArray(payload.openBillingAccounts)
            ? payload.openBillingAccounts
              .map((account) => account && typeof account === 'object'
                ? (account as Record<string, unknown>).name
                : undefined)
              .filter((name): name is string => typeof name === 'string')
            : [];
          const hint = accountNames.length === 0
            ? 'No open billing accounts are visible to the current Google login. Give that login access to an open GCP billing account, then run this preview again.'
            : accountNames.length === 1
              ? `Review the preview, then ask the user to approve billing account ${accountNames[0]}. Re-run with that exact billingAccountName and confirm=true only after approval; linking billing can create costs.`
              : 'Review the preview and ask the user to choose one exact openBillingAccounts[].name. Re-run with that billingAccountName and confirm=true only after approval; linking billing can create costs.';
          const agentMessage = accountNames.length === 0
            ? 'No open GCP billing account is available. Ask the user to grant the current Google login access to an open billing account, then run the preview again. Do not confirm or try alternate infrastructure tools.'
            : 'Show the GCP setup preview and open billing accounts. Ask the user to approve one exact billing account before confirming. Never choose or confirm a billable account on their behalf.';
          return commandSuccess(
            { project: { id: targetProject.id, name: targetProject.name }, ...payload },
            {
              hint,
              agentInstruction: {
                action: 'ask_user',
                message: agentMessage,
              },
            }
          );
        }
        return commandSuccess(
          { project: { id: targetProject.id, name: targetProject.name }, ...payload },
          { next: ['hv_plan'] }
        );
      }

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
          gcsAccess,
          memorystoreAccess,
          queueAccess,
          adminAuth,
          adminCredentialsJson: resolvedAdminCredentialsJson,
          adminAccessToken: resolvedAdminAccessToken,
          adminCredentialSource: adminAuth === 'default'
            ? 'application-default'
            : adminCredentialsJsonRef
              ? `service-account-${refKind(adminCredentialsJsonRef)}`
              : adminCredentialsJson
                ? 'service-account-inline'
                : adminAccessTokenRef
                  ? `access-token-${refKind(adminAccessTokenRef)}`
                  : adminAccessToken
                    ? 'access-token-inline'
                    : undefined,
          confirm,
        });
        if (!payload.success) {
          return commandError('PROVIDER_ERROR', String(payload.error ?? 'Cloud preparation failed'), { details: payload });
        }
        return commandSuccess({ ...projectContext, ...payload }, payload.mode === 'preview'
          ? { hint: 'Recommended: re-run with confirm=true and adminAuth="default" to use existing Google Application Default Credentials. Explicit adminCredentialsJsonRef or adminAccessTokenRef remain available when intentional.' }
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
        const nativeCliAuth = providerRegistry.getMetadata(provider)?.credentials?.supportsNativeCliAuth === true
          || secretManagerRegistry.getMetadata(provider)?.credentials?.supportsNativeCliAuth === true;
        if (!credentials && !credentialsRef && !nativeCliAuth) {
          return commandError('VALIDATION', 'credentials are required for action="add".', {
            details: setupDetails(provider, guidanceContext),
            hint: `Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        }

        let credentialsToSave: Record<string, unknown>;
        const credentialsResolution: Record<string, ResolvedCredentialSource> = {};
        try {
          const projectForSecretRef = project ?? ctx.resolveProject({});
          credentialsToSave = credentialsRef
            ? await parseCredentialRef(provider, credentialsRef, credentialsKey, credentialsMap, {
              ...(projectForSecretRef ? { projectId: projectForSecretRef.id } : {}),
              onResolved: (key, source) => { credentialsResolution[key] = source; },
            })
            : credentials ?? { authMode: 'default' };
        } catch (error) {
          return commandError('VALIDATION', error instanceof Error ? error.message : String(error), {
            details: setupDetails(provider, guidanceContext),
            hint: `Use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, a secret-manager ref like 1password://vault/item#field, or stripe-projects://<environment>/<provider>/<service> for an already-pulled active Stripe Projects environment. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        }

        const credentialsSource = credentialsRef
          ? refKind(credentialsRef)
          : !credentials && nativeCliAuth
            ? 'native-cli'
            : 'inline';
        const saved = await saveConnection(provider, credentialsToSave, scope, { credentialsSource, credentialsRef, credentialsKey, credentialsMap,
          ...(Object.keys(credentialsResolution).length ? { credentialsResolution } : {}) });
        if (!saved.success) {
          return commandError('VALIDATION', saved.error!, {
            details: setupDetails(provider, guidanceContext),
            hint: `Fix the credentials object to match the provider schema and retry. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        }

        // Auto-verify so one call does add + verify.
        const verified = await verifyConnection(provider, scope);
        if (verified.kind !== 'verified') {
          return commandError('PROVIDER_ERROR', verified.error ?? 'Verification failed.', {
            details: { connection: saved.connection, ...setupDetails(provider, guidanceContext) },
            hint: `The connection was saved but failed verification. Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="verify" or action="add" with corrected credentials. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        }

        const data = {
          ...projectContext,
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          credentialsSource,
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
            details: setupDetails(provider, guidanceContext),
            hint: `Add the connection first with hv_connections provider="${provider}" action="add". ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        case 'unknown_provider':
          return commandError('UNSUPPORTED', verified.error);
        default:
          return commandError('PROVIDER_ERROR', verified.error, {
            details: setupDetails(provider, guidanceContext),
            hint: `Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="add" with corrected credentials. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
      }
    })
  );

  async function listConnections(project: Project | null, guidanceContext: ConnectionGuidanceContext) {
      const connections = ctx.repos.connections.findAll().map((c) => ({
        provider: c.provider,
        scope: c.scope ?? 'global',
        status: c.status,
        lastVerifiedAt: c.lastVerifiedAt,
      }));

      const availableProviders: Record<string, ProviderDiscoveryEntry[]> = {};
      for (const p of providerRegistry.all()) {
        const category = p.metadata.category;
        availableProviders[category] = availableProviders[category] ?? [];
        availableProviders[category].push(providerDiscoveryEntry(p.metadata, guidanceContext));
      }
      for (const p of secretManagerRegistry.all()) {
        availableProviders['secrets'] = availableProviders['secrets'] ?? [];
        availableProviders['secrets'].push(providerDiscoveryEntry(p.metadata, guidanceContext));
      }

      const discoveryHint = CONTEXTUAL_SETUP_HINT + ' This list is credential discovery only, not completed scoped setup. For new AWS, Azure or GCP secret-manager connections, use hv_cloud_connections purpose="connect-cloud" with the exact env: start browser device approval, check status, then connect to browser provider selection and administrator installation. No local cloud credentials or manually prepared writer are required. Installation, collection and deployment require separate authorization. If hosted setup is unavailable, report its prerequisite without substituting credential uploads or key creation. Use hv_connections with provider only when a safe credentialsRef is already available, the provider declares a native/default credential chain, or the user explicitly requested legacy GCP bootstrap that creates a deployment service-account key. Otherwise offer to help connect credentials the user already controls or prepare a value-free handoff naming the provider, scope, and blocked task for the person who manages that access. Do not assume provider membership or run hv_plan, hv_apply, or hv_deploy to bypass the missing connection.';
      return commandSuccess(
        {
          ...(project ? { project: { id: project.id, name: project.name } } : {}),
          connections,
          availableProviders,
        },
        {
          hint: connections.length === 0
            ? `No connections yet. ${discoveryHint} For credentials the user already controls, private references include credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" for JSON credentials. Never request credential values in chat.`
            : discoveryHint,
        }
      );
  }
}
