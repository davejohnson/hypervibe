import os from 'os';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { gcpEngineAuthentication, gcpEngineBackend } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { AwsEngineCredentialsSchema } from '../adapters/providers/aws/aws-engine.adapter.js';
import { awsEngineAuthentication, awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { AzureEngineCredentialsSchema } from '../adapters/providers/azure/azure-engine.adapter.js';
import { azureEngineAuthentication, azureEngineBackend, azureResourceGroupId } from '../adapters/providers/azure/tofu/azure-engine.backend.js';

export type EngineAuthProbeResult =
  | { status: 'verified'; identity: string; projectId: string; projectNumber: string }
  | { status: 'missing_connection' | 'permission_denied' | 'scope_mismatch' | 'engine_unavailable' | 'engine_error'; message: string };

/**
 * Read-only proof that the OpenTofu Google provider authenticates as the
 * Hypervibe-generated deployment identity of a saved connection and can see
 * exactly that connection's project. Plans data sources only; no state is
 * written and no resource can change.
 */
export async function probeGcpEngineAuthentication(params: { scope: string | null; signal?: AbortSignal }): Promise<EngineAuthProbeResult> {
  const connection = new ConnectionRepository().findBestVerifiedMatch('cloudrun', params.scope);
  if (!connection) {
    return { status: 'missing_connection', message: 'No verified GCP connection exists for this scope. Connect GCP with hv_connections action="bootstrap".' };
  }
  const credentials = getSecretStore().decryptObject<{ projectId?: string; credentials?: string }>(connection.credentialsEncrypted);
  if (!credentials.projectId || !credentials.credentials) {
    return { status: 'missing_connection', message: 'The GCP connection does not hold a deployment service account. Re-run the GCP bootstrap.' };
  }
  let auth;
  try {
    auth = gcpEngineAuthentication({ projectId: credentials.projectId, credentials: credentials.credentials });
  } catch (error) {
    return { status: 'missing_connection', message: error instanceof Error ? error.message : String(error) };
  }
  const expectedIdentity = (JSON.parse(credentials.credentials) as { client_email: string }).client_email;
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { status: 'engine_unavailable', message: binary.error };
  const engine = new OpenTofuEngine({
    binary: binary.binary,
    cipher: getSecretStore(),
    pluginCacheDir: enginePluginCacheDir(),
    timeoutMs: 5 * 60 * 1000,
    signal: params.signal,
  });
  const result = await engine.probeAuthentication({ backend: gcpEngineBackend, projectId: credentials.projectId, auth });
  if (!result.ok) {
    if (result.stage === 'version') return { status: 'engine_unavailable', message: result.error };
    const permission = /\b403\b|PERMISSION_DENIED|does not have .*permission|forbidden/i.test(result.error);
    return { status: permission ? 'permission_denied' : 'engine_error', message: result.error.replaceAll(os.homedir(), '~') };
  }
  const identity = String(result.outputs.identity ?? '');
  const projectId = String(result.outputs.project_id ?? '');
  if (identity !== expectedIdentity || projectId !== credentials.projectId) {
    return { status: 'scope_mismatch', message: 'OpenTofu authenticated, but not as the connection identity or not in its project. Nothing was changed.' };
  }
  return { status: 'verified', identity, projectId, projectNumber: String(result.outputs.project_number ?? '') };
}

/**
 * Read-only proof that the OpenTofu AWS provider runs as the project's
 * Hypervibe deploy role in exactly the connection's account and region.
 */
export async function probeAwsEngineAuthentication(params: { scope: string | null; signal?: AbortSignal }): Promise<
  | { status: 'verified'; identity: string; accountId: string; region: string }
  | { status: 'missing_connection' | 'permission_denied' | 'scope_mismatch' | 'engine_unavailable' | 'engine_error'; message: string }> {
  const connection = new ConnectionRepository().findBestVerifiedMatch('aws', params.scope);
  if (!connection) return { status: 'missing_connection', message: 'No verified AWS connection exists for this project. Connect AWS with hv_connections provider="aws" action="connect".' };
  const parsed = AwsEngineCredentialsSchema.safeParse(getSecretStore().decryptObject(connection.credentialsEncrypted));
  if (!parsed.success) return { status: 'missing_connection', message: 'The AWS connection is not Hypervibe\'s deploy access. Run AWS setup again.' };
  let auth;
  try { auth = await awsEngineAuthentication(parsed.data); } catch (error) {
    return { status: 'permission_denied', message: error instanceof Error ? error.message : String(error) };
  }
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { status: 'engine_unavailable', message: binary.error };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), timeoutMs: 5 * 60 * 1000, signal: params.signal });
  const result = await engine.probeAuthentication({ backend: awsEngineBackend, projectId: parsed.data.accountId, auth });
  if (!result.ok) {
    if (result.stage === 'version') return { status: 'engine_unavailable', message: result.error };
    return { status: /AccessDenied|not authorized/i.test(result.error) ? 'permission_denied' : 'engine_error', message: result.error.replaceAll(os.homedir(), '~') };
  }
  const identity = String(result.outputs.identity ?? '');
  const roleName = parsed.data.roleArn.split('/').pop();
  if (String(result.outputs.project_id) !== parsed.data.accountId || !identity.includes(`:assumed-role/${roleName}/`) || String(result.outputs.region) !== parsed.data.region) {
    return { status: 'scope_mismatch', message: 'OpenTofu authenticated, but not as the deploy role in the connection\'s account and region. Nothing was changed.' };
  }
  return { status: 'verified', identity, accountId: parsed.data.accountId, region: parsed.data.region };
}

/**
 * Read-only proof that the OpenTofu azurerm provider runs as the project's
 * Hypervibe deploy identity and sees exactly the connection's resource group.
 */
export async function probeAzureEngineAuthentication(params: { scope: string | null; signal?: AbortSignal }): Promise<
  | { status: 'verified'; identity: string; resourceGroupId: string; location: string }
  | { status: 'missing_connection' | 'permission_denied' | 'scope_mismatch' | 'engine_unavailable' | 'engine_error'; message: string }> {
  const connection = new ConnectionRepository().findBestVerifiedMatch('azure', params.scope);
  if (!connection) return { status: 'missing_connection', message: 'No verified Azure connection exists for this project. Connect Azure with hv_connections provider="azure" action="connect".' };
  const parsed = AzureEngineCredentialsSchema.safeParse(getSecretStore().decryptObject(connection.credentialsEncrypted));
  if (!parsed.success) return { status: 'missing_connection', message: 'The Azure connection is not Hypervibe\'s deploy access. Run Azure setup again.' };
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { status: 'engine_unavailable', message: binary.error };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), timeoutMs: 5 * 60 * 1000, signal: params.signal });
  const resourceGroupId = azureResourceGroupId(parsed.data.subscriptionId, parsed.data.resourceGroup);
  const result = await engine.probeAuthentication({ backend: azureEngineBackend, projectId: resourceGroupId, auth: azureEngineAuthentication(parsed.data) });
  if (!result.ok) {
    if (result.stage === 'version') return { status: 'engine_unavailable', message: result.error };
    return { status: /AuthorizationFailed|\b403\b|AADSTS7000215|invalid_client/i.test(result.error) ? 'permission_denied' : 'engine_error', message: result.error.replaceAll(os.homedir(), '~') };
  }
  if (String(result.outputs.client_id) !== parsed.data.clientId || String(result.outputs.identity) !== parsed.data.deployPrincipalId
    || String(result.outputs.tenant_id) !== parsed.data.tenantId || String(result.outputs.project_id).toLowerCase() !== resourceGroupId.toLowerCase()) {
    return { status: 'scope_mismatch', message: 'OpenTofu authenticated, but not as the deploy identity or not in the connection\'s resource group. Nothing was changed.' };
  }
  return { status: 'verified', identity: String(result.outputs.identity), resourceGroupId, location: String(result.outputs.location ?? '') };
}
