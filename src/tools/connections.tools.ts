import { redactExactValues } from '../utils/redact-exact-values.js';
import { connectionRoles } from '../domain/services/connection-roles.js';
import { requiredConnectionChecklist } from '../application/spec-connections.js';
import { cloudEngineForConnection, cloudEngineForProjectRemoval } from '../application/cloud-engines.js';
import { parseCredentialRef, resolveLocalSecretRef, type ResolvedCredentialSource } from '../application/credential-reference.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import {
  migrationAccessModes, providerRegistry,
  type ProviderMetadata,
} from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { prepareSecretScopeAccess } from '../application/secret-scope-access.js';
import { existingRepositoryGcpProjectId, runGcpBootstrap } from '../domain/services/gcp-bootstrap.service.js';
import { gcpEnvironmentBindingConflict } from '../domain/services/gcp-environment-target.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { connectCloudflareInBrowser } from '../application/local-connect-page.js';
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

const MIGRATION_ACCESS_OPTIONS = new Set(['action', 'provider', 'project', 'environment', 'migrationAccess',
  'migrationSourceEnvironment', 'migrationStorage', 'gcpProjectId', 'region', 'confirm', 'gcpSetupPlanId']);

/** Resolve an environment's declared GCP target before admin secrets or provider operations. */
function gcpSetupSelection(ctx: CommandContext, project: Project, input: {
  environment?: string; gcpProjectId?: string; scope?: string; region?: string; planningOrConfirming?: boolean;
  migrationSourceEnvironment?: string; transferSourceProvider?: string;
}): { environmentProjectId?: string; region?: string } {
  const { environment, gcpProjectId, planningOrConfirming } = input;
  if (environment === undefined && !(planningOrConfirming && gcpProjectId !== undefined)) {
    return input.region ? { region: input.region } : {};
  }
  const environments = new SpecStore().get(project)?.spec.environments ?? {};
  if (input.migrationSourceEnvironment !== undefined && (input.migrationSourceEnvironment === environment
    || !Object.hasOwn(environments, input.migrationSourceEnvironment)
    || environments[input.migrationSourceEnvironment].hosting.provider !== input.transferSourceProvider)) {
    throw new HvError('VALIDATION', `Select an existing source environment hosted by ${input.transferSourceProvider} and a separate Cloud Run destination in this project.`);
  }
  if (environment !== undefined && !Object.hasOwn(environments, environment)) {
    throw new HvError('VALIDATION', 'The selected environment is missing from this project’s spec. Choose an existing environment.');
  }
  const hosting = environment === undefined ? undefined : environments[environment].hosting;
  if (hosting && hosting.provider !== 'cloudrun') {
    throw new HvError('VALIDATION', 'Choose a Cloud Run environment for Google Cloud setup.');
  }
  if (hosting?.gcpProjectId && input.region && input.region !== (hosting.region ?? 'us-central1')) {
    throw new HvError('VALIDATION', 'The requested Google Cloud region differs from the region declared for the selected environment.');
  }
  const region = input.region ?? hosting?.region;
  const placement = region ? { region } : {};
  const environmentProjectId = hosting?.gcpProjectId;
  if (environment !== undefined && environmentProjectId !== undefined) {
    if (gcpProjectId !== undefined && gcpProjectId !== environmentProjectId) {
      throw new HvError('VALIDATION', 'The requested gcpProjectId differs from hosting.gcpProjectId for the selected environment.');
    }
    const bindings = ctx.repos.environments.findByProjectAndName(project.id, environment)?.platformBindings;
    const conflict = gcpEnvironmentBindingConflict(bindings, environmentProjectId, region ?? 'us-central1');
    if (conflict) throw new HvError('VALIDATION', conflict);
    return { environmentProjectId, ...placement };
  }

  // Preserve repository access when one environment uses a dedicated project and another uses the legacy scope.
  const dedicated = Object.values(environments).filter(env => env.hosting.gcpProjectId !== undefined);
  if (gcpProjectId === undefined || !dedicated.length) return placement;
  if (dedicated.some(env => env.hosting.gcpProjectId === gcpProjectId.trim())) {
    throw new HvError('VALIDATION', 'Select the environment that declares this hosting.gcpProjectId to set up its dedicated project.');
  }
  if (planningOrConfirming) {
    const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl) ?? input.scope?.trim();
    const existing = repository ? existingRepositoryGcpProjectId(repository) : undefined;
    if (existing && (!existing.success || existing.value !== gcpProjectId.trim())) {
      throw new HvError('VALIDATION', 'This setup would replace existing repository GCP access. Declare hosting.gcpProjectId on the intended environment and select that environment.');
    }
  }
  return placement;
}

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
    [CONTEXTUAL_SETUP_HINT, '{} lists every connection/provider. {project} lists the same saved connections and provider catalog with contextual setup links. Use repositoryContext to select the current repository. Use view="requirements" to see the connections a project needs, optionally filtered by environment. Pass provider to manage a connection. With provider, action="add" is the default. Use action="bootstrap" with provider="cloudrun" for the short, opinionated GCP setup; "verify", "remove", and "prepare" remain explicit advanced operations. Project context alone never changes provider scope. For GCP bootstrap and prepare, select the environment to use its declared project. Credentials are encrypted at rest and never returned; credentialsRef is preferred. Providers and credential sources that declare native CLI authentication may omit credentials to use the active local/default credential chain.'].join(' '),
    {
      view: z.enum(['catalog', 'requirements']).optional().describe('Read-only list view. The default catalog includes saved connections and available providers. Use requirements with a selected project or initialized repository and an optional environment filter.'),
      role: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('action="describe": select one or more connection credential fields, such as GitHub packageReadToken.'),
      provider: z.string().optional().describe(`Omit to list. Otherwise select a provider (available: ${providerNames.join(', ')}). action="remove" also accepts unregistered providers so stale connections can be deleted.`),
      action: z.enum(['add', 'describe', 'verify', 'remove', 'prepare', 'bootstrap', 'connect', 'remove-project']).optional().describe('With provider: operation to perform (default: "add"). "describe" returns contextual forms without resolving credentials, observing providers, or writing state. For GCP, "bootstrap" is the recommended one-time setup. For Cloudflare, "connect" with scope=<domain> is the recommended setup: it opens a local page in the user\'s browser that links to a pre-filled Cloudflare token form and receives the token directly, never through chat. For GCP, "remove-project" deletes a Google project that bootstrap created, once every environment in it is torn down and nothing else is left in it: preview first, then confirm with the previewId. For Azure, "remove-project" with project removes what one-time setup created (resource group, Key Vault, deploy app and its roles) once every environment is torn down: it opens a browser sign-in, previews, then confirms with azureSubscriptionId and the previewId.'),
      credentials: z.record(z.string(), z.unknown()).optional().describe('action="add": provider-specific credentials object. Omit for providers supporting native CLI/default authentication. credentialsRef is recommended for explicit credentials, but raw credentials are accepted when intentional.'),
      credentialsRef: z.string().optional().describe('action="add": recommended credential reference resolved by Hypervibe. Supports env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path for token/JSON files, secret-manager refs like aws-secrets://name#key, or an already-pulled active Stripe Projects environment with stripe-projects://<environment>/<provider>/<service>. The resolved value may be a JSON credentials object or a scalar.'),
      credentialsKey: z.string().optional().describe('action="add": wraps a scalar credentialsRef value under this provider credential key, e.g. apiToken or accessToken. GitHub packageReadToken alone updates an existing verified exact-scope connection while preserving its primary API credential. Optional for common single-token providers.'),
      credentialsMap: z.record(z.string(), z.string()).optional().describe('action="add": for dotenv or structured secret-manager references, maps provider credential keys to source fields, e.g. {"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}.'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global except action="bootstrap", which derives an exact repository scope from the selected project when omitted and never creates global GCP access.'),
      project: projectField.describe('Hypervibe project name/id for validated context. Required explicitly for action="bootstrap". With no provider, project-only still lists. Omit for an unscoped list. For GCP bootstrap or prepare, specify environment to select its declared GCP project.'),
      repositoryContext: z.boolean().optional().describe('Read-only discovery/describe only: resolve the current client repository without importing its spec or bindings. Do not combine with project. A fresh repository may supply Git-remote context for form labels and owner prefill, but remains unscoped. Ambiguous or unrecorded committed identities remain blocked.'),
      gcpProjectId: z.string().optional().describe('Exact GCP project ID. An environment with hosting.gcpProjectId uses its declared project. Otherwise bootstrap preview reuses repository-scoped access or derives a stable name, and prepare defaults to the Cloud Run connection projectId. Confirm bootstrap using the exact ID returned by preview.'),
      region: z.string().trim().min(1).optional().describe('GCP bootstrap/prepare target region for shared build resources; defaults to us-central1. Each region is reviewed and retained independently.'),
      billingAccountName: z.string().optional().describe('action="bootstrap": exact open billing account name chosen from discovery. Preview again with this account, then confirm the saved infrastructure plan separately.'),
      recoverProjectState: z.string().trim().min(1).optional().describe('For a Google Cloud bootstrap preview that returned projectRecovery, pass its exact recovery reference to repair the local project record and preview again. Omit confirm.'),
      gcpSetupPlanId: z.string().min(1).optional().describe('Exact saved Google Cloud setup or access-check plan. Supply it without confirm to continue using its recorded browser approval.'),
      deployServiceAccountEmail: z.string().optional().describe('action="prepare": deploy service account email (defaults to the Cloud Run connection service account)'),
      gcsAccess: z.enum(['inspect', 'lifecycle', 's3']).optional().describe('action="prepare" for cloudrun: explicitly add project-scoped GCS access. "inspect" grants the deploy identity roles/storage.viewer; "lifecycle" grants it roles/storage.admin and grants the distinct configured runtime identity roles/storage.objectUser in this GCP project with any approved migration exclusions preserved; "s3" grants it roles/storage.hmacKeyAdmin so S3-compatible bucket access keys can be created.'),
      memorystoreAccess: z.enum(['inspect', 'lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly add Memorystore access to the reused service account. "inspect" grants roles/redis.viewer; "lifecycle" grants roles/redis.admin.'),
      queueAccess: z.enum(['lifecycle', 'remove']).optional().describe('action="prepare" for cloudrun: explicitly grant Pub/Sub queue lifecycle access or remove that exact role from the reused service account.'),
      migrationAccess: z.enum(migrationAccessModes).optional().describe('With action="prepare" and provider="cloudrun", reserve an empty secret and copy account, restrict app access, test both accounts with disposable data, retest file access, or prepare a documents copy job for one selected storage bucket. Select project, migrationSourceEnvironment and destination environment. Each operation has its own saved plan and uses existing Google Application Default Credentials.'),
      migrationStorage: z.string().optional().describe('For prepare-bucket-copy, select the one declared data bucket to copy.'),
      migrationSourceEnvironment: z.string().min(1).optional().describe('Existing source environment in the selected project for migration access preparation.'),
      purpose: z.string().max(160).optional().describe('action="connect": what Hypervibe will do with this access, as a short phrase that follows "so it can", for example "move staging.example.com to Google Cloud". Shown on the connect page.'),
      environment: z.string().optional().describe('Filter view="requirements" by environment or select the environment for setup guidance. For GCP bootstrap and prepare, this selects the declared hosting.gcpProjectId and default region. For connect, the environment appears on the connect page.'),
      awsAccountId: z.string().regex(/^\d{12}$/).optional().describe('provider="aws" action="connect": the exact accountId from the preview, passed only after the user approves its changes.'),
      azureSubscriptionId: z.string().uuid().optional().describe('provider="azure" action="connect": the subscription the user chose (when they have several), or the subscriptionId from the preview. action="remove-project": the subscriptionId from the removal preview, required to confirm.'),
      azureApproved: z.literal(true).optional().describe('provider="azure" action="connect": set only after the user approves the preview\'s changes, together with its azureSubscriptionId.'),
      workerAccess: z.enum(['lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly grant on-demand worker access: Google Workflows for the deployment identity, plus permission for the app runtime to run the worker waker and read pending work through the Cloud SQL Data API.'),
      secretScopeAccess: z.enum(['lifecycle']).optional().describe('action="prepare" for cloudrun, with environment: make secrets limited to named services (secret "services" in the spec) an access boundary. Creates one Google service identity per named service and narrows Secret Manager access so other identities cannot read those secrets. Needs a Google Cloud administrator sign-in (adminAuth="default" or adminAccessTokenRef). Preview, then confirm; hv_plan says when to run it again.'),
      adminAuth: z.literal('default').optional().describe('Use existing Google Application Default Credentials for bootstrap or confirmed ordinary prepare. Migration access preparation uses these credentials automatically.'),
      adminCredentialsJson: z.string().optional().describe('action="prepare": one-time admin service account JSON. Not stored.'),
      adminCredentialsJsonRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time admin service account JSON. Not stored.'),
      adminAccessToken: z.string().optional().describe('action="prepare": one-time OAuth admin access token. Not stored.'),
      adminAccessTokenRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time OAuth admin access token. Not stored.'),
      previewId: z.string().uuid().optional().describe('action="remove-project": the previewId returned by the removal preview. Required with confirm=true.'),
      confirm: confirmField.describe('For action="bootstrap" or action="prepare", omit for a read-only preview and set true only after reviewing that preview. Other connection actions do not accept confirm.'),
    },
    wrapCommandHandler(async (input) => {
      const {
        provider,
        view,
        role,
        action,
        credentials,
        credentialsRef,
        credentialsKey,
        credentialsMap,
        scope,
        project: projectRef,
        repositoryContext,
        gcpProjectId,
        region,
        billingAccountName,
        recoverProjectState,
        gcpSetupPlanId,
        deployServiceAccountEmail,
        gcsAccess,
        memorystoreAccess,
        queueAccess,
        migrationAccess,
        migrationSourceEnvironment,
        migrationStorage,
        workerAccess,
        secretScopeAccess,
        purpose,
        environment,
        awsAccountId,
        azureSubscriptionId,
        azureApproved,
        adminAuth,
        adminCredentialsJson,
        adminCredentialsJsonRef,
        adminAccessToken,
        adminAccessTokenRef,
        previewId,
        confirm: explicitConfirmation,
      } = input;
      if (action === 'remove-project' || previewId !== undefined) {
        // Deletes a whole Google project or a project's Azure setup, so it accepts nothing but its own fields.
        const extra = suppliedOptionNames(input).filter((name) => !['provider', 'action', 'project', 'gcpProjectId', 'adminAuth', 'azureSubscriptionId', 'previewId', 'confirm'].includes(name));
        const remover = provider ? cloudEngineForProjectRemoval(provider)?.removeProject : undefined;
        // Google names the project and uses the administrator's default sign-in. Azure signs in through the browser and learns the subscription from the preview.
        const azureRemoval = provider === 'azure';
        const fieldsFit = azureRemoval ? gcpProjectId === undefined && adminAuth === undefined
          : provider === 'cloudrun' && azureSubscriptionId === undefined && Boolean(gcpProjectId?.trim()) && adminAuth === 'default';
        if (action !== 'remove-project' || !remover || extra.length || !projectRef?.trim() || !fieldsFit) {
          return commandError('VALIDATION', azureRemoval
            ? 'action="remove-project" with provider="azure" takes project only; to confirm, add the preview\'s subscriptionId as azureSubscriptionId, its previewId and confirm=true.'
            : 'action="remove-project" takes provider="cloudrun", project, the exact gcpProjectId and adminAuth="default"; add previewId and confirm=true only after reviewing its preview.');
        }
        const owner = ctx.resolveProjectOrThrow({ project: projectRef });
        const removal = await remover({ project: owner, cloudProjectId: (azureRemoval ? azureSubscriptionId : gcpProjectId) ?? '', previewId, confirm: explicitConfirmation === true });
        const { success: _success, error, ...data } = removal;
        if (!removal.success) {
          return commandError(removal.status === 'blocked' ? 'VALIDATION' : 'PROVIDER_ERROR', error ?? (azureRemoval ? 'Hypervibe\'s Azure setup was not removed.' : 'The Google project was not removed.'), { details: data, next: ['hv_connections'] });
        }
        // Deleting is the user's decision: the preview goes to them, and no ready-made confirm call is handed back.
        return commandSuccess({ project: { id: owner.id, name: owner.name }, ...data }, removal.mode === 'preview' ? {
          hint: `To confirm, call this again with the same fields plus ${azureRemoval ? 'azureSubscriptionId (the preview\'s subscriptionId), ' : ''}previewId and confirm=true. The preview lasts ten minutes.`,
          agentInstruction: { action: 'ask_user', message: azureRemoval
            ? `Show the user this preview for ${owner.name}: everything in willDelete, everything in willPurge (permanent), what is left behind and every warning. Ask whether to remove Hypervibe's Azure setup. Confirm only after they say yes to exactly this list.`
            : `Show the user this preview for Google project ${gcpProjectId}: what was checked, what was not checked and every warning. Ask whether to delete the whole Google project. Confirm only after they say yes to deleting this exact project.` },
        } : undefined);
      }
      const requireBrowserApproval = gcpSetupPlanId !== undefined && (explicitConfirmation === undefined || (explicitConfirmation && migrationAccess === 'prepare-bucket-copy'));
      const confirm = requireBrowserApproval || explicitConfirmation;
      if (requireBrowserApproval && !/^(?:setup|probe)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(gcpSetupPlanId!)) {
        return commandError('VALIDATION', 'Use the exact saved plan ID from the browser review.');
      }
      const transferAccess = migrationAccess && provider ? providerRegistry.get(provider)?.migrationAccess : undefined;
      if ((migrationAccess === 'prepare-bucket-copy') !== (migrationStorage !== undefined) ||
          (migrationStorage !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(migrationStorage))) {
        return commandError('VALIDATION', 'Supply migrationStorage only for prepare-bucket-copy, selecting the exact declared data bucket.');
      }
      if (migrationAccess !== undefined) {
        if (action !== 'prepare' || !transferAccess) {
          return commandError('VALIDATION', 'Use migrationAccess only with action="prepare" and provider="cloudrun".');
        }
        if (!projectRef?.trim() || !environment?.trim() || !migrationSourceEnvironment?.trim()) {
          return commandError('VALIDATION', 'Migration access preparation requires project, migrationSourceEnvironment and destination environment.');
        }
        const extra = suppliedOptionNames(input).filter(name => !MIGRATION_ACCESS_OPTIONS.has(name));
        if (extra.length) {
          return commandError('VALIDATION', `Migration access preparation does not accept ${extra.join(', ')}.`);
        }
        if (confirm && !gcpSetupPlanId?.trim()) {
          return commandError('VALIDATION', 'Confirm this migration access change with the exact gcpSetupPlanId from its preview.');
        }
      } else if (migrationSourceEnvironment !== undefined) {
        return commandError('VALIDATION', 'Use migrationSourceEnvironment with a migrationAccess mode.');
      }
      if (gcpSetupPlanId !== undefined && (!confirm || provider !== 'cloudrun' || recoverProjectState !== undefined
        || (action !== 'bootstrap' && action !== 'prepare'))) {
        return commandError('VALIDATION', 'Use gcpSetupPlanId for a Cloud Run bootstrap or preparation plan. Omit recoverProjectState. Omit confirm to use its saved browser approval.');
      }
      if (recoverProjectState !== undefined && (action !== 'bootstrap' || provider !== 'cloudrun'
        || confirm === true || !billingAccountName?.trim() || !gcpProjectId?.trim())) {
        return commandError('VALIDATION', 'Use recoverProjectState only for a Cloud Run bootstrap preview with its exact project ID and billing account. Omit confirm.');
      }
      if (view && provider) return commandError('VALIDATION', 'view is only available when listing connections. Omit provider.');
      const selectedRoles = role === undefined ? undefined : [...new Set(Array.isArray(role) ? role : [role])];
      if (selectedRoles && (!provider || action !== 'describe' || connectionRoles(provider, selectedRoles).length !== selectedRoles.length)) {
        return commandError('VALIDATION', 'Use role with a registered credential field and action="describe".');
      }
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
          || credentialsKey !== undefined
          || credentialsMap !== undefined
          || scope !== undefined
          || region !== undefined
          || gcpProjectId !== undefined
          || billingAccountName !== undefined
          || deployServiceAccountEmail !== undefined
          || gcsAccess !== undefined
          || memorystoreAccess !== undefined
          || queueAccess !== undefined
          || workerAccess !== undefined
          || secretScopeAccess !== undefined
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
        if (view !== 'requirements') {
          if (environment !== undefined) return commandError('VALIDATION', 'Use view="requirements" to filter project connection requirements by environment.');
          return listConnections(project, context);
        }
        if (!project) return commandError('VALIDATION', 'Select a project or an initialized repository to list its connection requirements.');
        const spec = new SpecStore().preview(project);
        if (environment !== undefined && !Object.hasOwn(spec?.environments ?? {}, environment)) {
          return commandError('NOT_FOUND', `Environment "${environment}" has no recorded spec in ${project.name}.`);
        }
        const required = spec ? requiredConnectionChecklist(ctx, spec, {
          environments: environment ? [environment] : undefined, gitRemoteUrl: project.gitRemoteUrl,
        }).required : [];
        return commandSuccess({ project: { id: project.id, name: project.name }, connections: required },
          { hint: 'Follow each returned connectionAction with hv_connections. For other missing connections use action="describe" with the provider, project and scope.' });
      }

      const requestedAction = action ?? 'add';
      const connecting = requestedAction === 'connect' ? cloudEngineForConnection(provider) : undefined;
      if (connecting?.connect) {
        const { project: connectProject } = await resolveGuidanceContext().catch(() => ({ project: undefined }));
        if (!connectProject) return commandError('VALIDATION', `provider="${provider}" action="connect" needs the project (run it from the app repository or pass project).`, { next: ['hv_connections'] });
        const specResult = new SpecStore().get(connectProject);
        const step = await connecting.connect({ project: connectProject, ...(specResult ? { spec: specResult.spec } : {}),
          input: { awsAccountId, azureSubscriptionId, azureApproved } });
        if (step.status === 'invalid') return commandError('VALIDATION', step.message ?? 'The connection input is invalid.', { next: ['hv_connections'] });
        if (step.status === 'failed') return commandError('PROVIDER_ERROR', step.message ?? 'The connection did not complete.', { next: ['hv_connections'] });
        if (step.status === 'connected') return commandSuccess(step.result, { ...(step.next ? { next: step.next } : {}) });
        return commandSuccess(step.result, { ...(step.hint ? { hint: step.hint } : {}),
          ...(step.ask ? { agentInstruction: { action: 'ask_user', message: step.ask } } : {}), next: ['hv_connections'] });
      }
      if (requestedAction === 'connect') {
        if (provider !== 'cloudflare' || !scope?.trim()) {
          return commandError('VALIDATION', 'action="connect" currently supports provider="cloudflare" with scope set to the domain to manage.', { next: ['hv_connections'] });
        }
        const { project: contextProject } = await resolveGuidanceContext().catch(() => ({ project: undefined }));
        const repository = contextProject?.gitRemoteUrl ? parseGitHubRepoFromRemote(contextProject.gitRemoteUrl) : undefined;
        const result = await connectCloudflareInBrowser({ domain: scope, context: {
          ...(contextProject?.name ? { project: contextProject.name } : {}), ...(repository ? { repository } : {}),
          ...(environment ? { environment } : {}), ...(purpose ? { purpose } : {}),
        } });
        return result.status === 'connected'
          ? commandSuccess(result, { next: ['hv_launch', 'hv_plan'] })
          : commandSuccess(result, {
            hint: 'Tell the user a Cloudflare page is open in their browser and give them the link in case it did not open. Call action="connect" again after they finish.',
            agentInstruction: { action: 'ask_user', message: 'Ask the user to finish connecting Cloudflare in the browser tab that opened, then continue.' },
            next: ['hv_connections'],
          });
      }
      // Stale connections for unregistered providers must stay removable.
      if (requestedAction !== 'remove' && !providerNames.includes(provider)) {
        return commandError('VALIDATION', `Unknown provider: ${provider}.`, {
          hint: `Available providers: ${providerNames.join(', ')}`,
        });
      }
      if (requestedAction === 'describe') {
        const incompatible = suppliedOptionNames({ credentials, credentialsRef, credentialsKey, credentialsMap,
          gcpProjectId, region, billingAccountName, deployServiceAccountEmail,
          gcsAccess, memorystoreAccess, queueAccess, workerAccess, secretScopeAccess, adminAuth, adminCredentialsJson,
          adminCredentialsJsonRef, adminAccessToken, adminAccessTokenRef, confirm });
        if (incompatible.length) return commandError('VALIDATION', `describe does not accept: ${incompatible.join(', ')}.`);
        const { context: repositoryGuidance } = await resolveGuidanceContext();
        const context: ConnectionGuidanceContext = {
          ...repositoryGuidance,
          ...(environment ? { environment } : {}),
          ...(scope ? { scope } : {}),
        };
        const metadata = providerRegistry.getMetadata(provider) ?? secretManagerRegistry.getMetadata(provider)!;
        return commandSuccess({
          provider: role ? { name: provider, displayName: metadata.displayName } : providerDiscoveryEntry(metadata, context),
          connectionSetup: connectionSetupDetails(provider, { ...context, ...(selectedRoles ? { requiredCredentialKeys: selectedRoles } : {}) }),
        }, { hint: 'Setup guidance only; no credential was resolved, connection verified, or setup preview created. Provider-owned bootstrap takes precedence. Preserve the complete returned URL and review the remaining manual fields.' });
      }
      const sharedGcpFields = {
        gcpProjectId,
        region,
        adminAuth,
      };
      const prepareOnlyFields = {
        deployServiceAccountEmail,
        gcsAccess,
        memorystoreAccess,
        queueAccess,
        workerAccess,
        secretScopeAccess,
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
      if (requestedAction === 'prepare' && region && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'region is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && gcsAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'gcsAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && memorystoreAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'memorystoreAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && workerAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'workerAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && secretScopeAccess) {
        if (provider !== 'cloudrun' || !environment) return commandError('VALIDATION', 'secretScopeAccess is supported only when preparing cloudrun for one named environment.');
        const other = suppliedOptionNames({ gcsAccess, memorystoreAccess, queueAccess, workerAccess, migrationAccess, deployServiceAccountEmail, adminCredentialsJson, adminCredentialsJsonRef });
        if (other.length) return commandError('VALIDATION', `secretScopeAccess is reviewed on its own and signs in with adminAuth="default" or an access token; remove: ${other.join(', ')}.`);
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
      if (requestedAction === 'prepare' && !migrationAccess && confirm && !adminJsonSupplied && !adminTokenSupplied && !adminDefaultSupplied) {
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
          ...gcpSetupSelection(ctx, targetProject, { environment, gcpProjectId, scope, region, planningOrConfirming: Boolean(billingAccountName || confirm) }),
          ...(environment !== undefined ? { environment } : {}),
          gcpProjectId,
          scope,
          billingAccountName,
          ...(recoverProjectState ? { recoverProjectState } : {}),
          ...(gcpSetupPlanId ? { gcpSetupPlanId } : {}),
          ...(requireBrowserApproval && { requireBrowserApproval: true }),
          confirm,
        });
        if (!payload.success) {
          if (payload.projectRecovery) {
            const recovery = payload.projectRecovery;
            const message = `Google reports that project ${recovery.projectId} (${recovery.projectNumber}) is active with no billing account attached. Repair Hypervibe’s local record for this project and preview the setup again?`;
            return {
              ...commandError('CONFIRM_REQUIRED', String(payload.error), {
                details: payload,
                hint: `After approval, repeat the bootstrap preview with --recover-project-state ${recovery.recoverProjectState} or use projectRecovery.retryCall. Review the new plan before applying any cloud changes.`,
                agentInstruction: { action: 'ask_user', message },
              }),
              confirmation: { message, retryInput: recovery.retryCall, completeInput: true },
            };
          }
          return commandError('PROVIDER_ERROR', String(payload.error ?? 'GCP setup failed.'), {
            details: payload,
          });
        }
        if (payload.mode === 'preview') {
          if (payload.requiresPlanId) {
            const confirmCall = payload.confirmCall;
            if (!confirmCall || !payload.planId || confirmCall.gcpSetupPlanId !== payload.planId) {
              return commandError('PROVIDER_ERROR', 'The bootstrap preview did not identify the exact cloud plan to confirm. Preview again.');
            }
            const planId = confirmCall.gcpSetupPlanId;
            const message = `Apply the changes shown in Google Cloud setup plan ${planId} for ${confirmCall.gcpProjectId}?`;
            return {
              ...commandSuccess({ project: { id: targetProject.id, name: targetProject.name }, ...payload }, {
                hint: `Review the fresh setup plan and its costs and permissions. After approval, omit recoverProjectState and use the returned confirmCall, or repeat the bootstrap CLI call with --confirm --gcp-setup-plan-id ${planId}.`,
                agentInstruction: { action: 'ask_user', message: `Show the changes and costs in plan ${planId}. After approval, submit its exact confirmCall.` },
              }),
              confirmation: { message, retryInput: confirmCall, completeInput: true },
            };
          }
          const accountNames = Array.isArray(payload.openBillingAccounts)
            ? payload.openBillingAccounts
              .map((account) => account && typeof account === 'object'
                ? (account as Record<string, unknown>).name
                : undefined)
              .filter((name): name is string => typeof name === 'string')
            : [];
          const hint = recoverProjectState
            ? 'Review the fresh setup plan and its costs and permissions. After approval, omit recoverProjectState and repeat the other inputs with confirm=true.'
            : billingAccountName
            ? 'Review the exact saved infrastructure plan and its costs and permissions. After approval, repeat these inputs with confirm=true; do not create a new preview in between.'
            : accountNames.length === 0
              ? 'No open billing accounts are visible. Give this Google login access to an open billing account, then repeat discovery.'
              : `Ask which billing account should pay (${accountNames.join(', ')}), then preview again with that billingAccountName. Infrastructure can create costs; choosing billing does not approve it.`;
          const agentMessage = billingAccountName
            ? 'Show the saved setup plan and ask for approval of its exact changes before confirming. Billing selection alone is not approval.'
            : 'Ask the user to choose a billing account. Never choose it for them; preview its infrastructure separately before confirmation.';
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
        const selection = gcpSetupSelection(ctx, targetProject, { environment, gcpProjectId, region, planningOrConfirming: true, migrationSourceEnvironment,
          transferSourceProvider: transferAccess?.sourceProvider });
        const resolvedAdminCredentialsJson = adminCredentialsJsonRef
          ? resolveLocalSecretRef(adminCredentialsJsonRef)
          : adminCredentialsJson;
        const resolvedAdminAccessToken = adminAccessTokenRef
          ? resolveLocalSecretRef(adminAccessTokenRef)
          : adminAccessToken;
        if (secretScopeAccess) {
          const scoped = await prepareSecretScopeAccess(ctx, { project: targetProject, spec: new SpecStore().get(targetProject)?.spec, environmentName: environment!,
            requestedGcpProjectId: gcpProjectId, adminAccessToken: resolvedAdminAccessToken, confirm });
          if (!scoped.success) return commandError('PROVIDER_ERROR', String(scoped.error ?? 'Service identity setup failed'), { details: scoped });
          return commandSuccess({ project: { id: targetProject.id, name: targetProject.name }, ...scoped }, { next: confirm ? ['hv_plan'] : ['hv_connections'] });
        }
        const payload = await runCloudPrepare({
          project: targetProject,
          ...selection,
          ...(environment !== undefined ? { environmentName: environment } : {}),
          provider,
          gcpProjectId,
          deployServiceAccountEmail,
          gcsAccess,
          memorystoreAccess,
          queueAccess,
          workerAccess,
          ...(migrationAccess ? { migrationAccess, migrationSourceEnvironment, ...(migrationStorage && { migrationStorage }) } : {}),
          ...(gcpSetupPlanId && { gcpSetupPlanId }),
          ...(requireBrowserApproval && { requireBrowserApproval: true }),
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
        if (migrationAccess && !confirm) {
          if (payload.mode !== 'preview' || typeof payload.planId !== 'string' || !payload.planId.trim()) {
            return commandError('PROVIDER_ERROR', 'The migration access preview did not return a saved plan ID. Preview again.');
          }
          let message: string;
          let review: string;
          switch (migrationAccess) {
            case 'verify-copy-access':
            case 'verify-export-file-access': {
              if (typeof payload.htmlPath !== 'string' || !payload.htmlPath.trim()) {
                return commandError('PROVIDER_ERROR', 'The access check preview did not return its saved HTML report. Preview again.');
              }
              const retention = typeof payload.softDeleteSeconds === 'number' && payload.softDeleteSeconds > 0
                ? ` Google keeps the deleted test object recoverable for ${payload.softDeleteSeconds / 86400} days.`
                : '';
              if (migrationAccess === 'verify-export-file-access') {
                message = `Run one temporary Cloud Run job as the app account in ${environment} for ${targetProject.name} to check whether it can read a disposable export file? Google Cloud charges may apply. Cleanup removes the job and test file.${retention}`;
                review = 'Review the app account, test file, cleanup and retention in the saved HTML. This approval covers one export file access check.';
              } else {
                message = `Run two temporary Cloud Run jobs in ${environment} for ${targetProject.name} to test access to a disposable secret version and export object? Google Cloud charges may apply. Cleanup removes the jobs and test data.${retention}`;
                review = 'Review the saved HTML for the exact app and copy accounts, test data, cleanup and retention. This approval covers one access check.';
              }
              break;
            }
            case 'restrict-app-access':
              message = `Apply plan ${payload.planId} to restrict the app’s access to the transfer secret and database dump location in ${environment} for ${targetProject.name}?`;
              review = 'Review the two project IAM grants for the app runtime. The plan excludes the selected transfer secret and dump location.';
              break;
            case 'prepare-bucket-copy':
              message = `Prepare the copy job for ${migrationStorage} from ${migrationSourceEnvironment} to ${environment}? Its account will be able to read and add objects in the selected Google Cloud bucket.`;
              review = 'Review the unscheduled job and the bucket permissions. Running the job and sending source credentials require a separate approval.';
              break;
            case 'empty-transfer-slot':
              message = `Apply plan ${payload.planId} to prepare access for a future data copy from ${migrationSourceEnvironment} to ${environment} in ${targetProject.name}?`;
              review = 'Review the copy job’s account and its permission to read the empty secret reserved for connection details.';
              break;
          }
          const retryInput = {
            action: 'prepare', provider, project: projectRef!, environment: environment!,
            migrationSourceEnvironment: migrationSourceEnvironment!, migrationAccess,
            ...(migrationStorage && { migrationStorage }),
            ...(gcpProjectId !== undefined ? { gcpProjectId } : {}), ...(region !== undefined ? { region } : {}),
            ...(migrationAccess !== 'prepare-bucket-copy' && { confirm: true }), gcpSetupPlanId: payload.planId,
          };
          return {
            ...commandSuccess({ ...projectContext, ...payload }, {
              hint: `${review} After approval, repeat this call with ${migrationAccess === 'prepare-bucket-copy' ? '' : '--confirm '}--gcp-setup-plan-id ${payload.planId}.`,
              agentInstruction: { action: 'ask_user', message },
            }),
            confirmation: { message, retryInput, completeInput: true },
          };
        }
        if (migrationAccess) return commandSuccess({ ...projectContext, ...payload });
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
            hint: `Use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, a secret-manager ref like aws-secrets://name#key, or stripe-projects://<environment>/<provider>/<service> for an already-pulled active Stripe Projects environment. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, guidanceContext)}`,
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
        const verified = saved.verification ?? await verifyConnection(provider, scope);
        if (verified.kind !== 'verified') {
          return commandError('PROVIDER_ERROR', verified.error ?? 'Verification failed.', {
            details: { connection: saved.connection, ...setupDetails(provider, guidanceContext) },
            hint: `The connection was saved but failed verification. Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="verify" or action="add" with corrected credentials. ${formatConnectionGuidance(provider, guidanceContext)}`,
          });
        }

        const roles = connectionRoles(provider, Object.keys(credentialsToSave));
        const data = {
          ...projectContext,
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          credentialsSource,
          ...(roles.length ? { configuredRoles: redactExactValues(roles.map(role => {
            const source = credentialsResolution[role.credentialKey!];
            const sourceField = source?.sourceField ?? source?.sourceKey;
            return { issuer: role.issuer, ...(sourceField ? { sourceField } : {}),
              destinationRole: role.destinationRole, connectionField: role.credentialKey, scope: scope ?? 'global' };
          }), Object.values(credentialsToSave).filter((value): value is string => typeof value === 'string')) } : {}),
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

      const discoveryHint = CONTEXTUAL_SETUP_HINT + ' This list is credential discovery only, not completed scoped setup. If a concrete task is blocked, use hv_connections with provider only when a safe credentialsRef is already available, the provider declares a native/default credential chain, or the user requested the bounded first-GCP bootstrap. Otherwise offer to help connect credentials the user already controls or prepare a value-free handoff naming the provider, scope, and blocked task for the person who manages that access. Do not assume provider membership or run hv_plan, hv_apply, or hv_deploy to bypass the missing connection.';
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
