import os from 'os';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { gcpEngineAuthentication, gcpEngineBackend } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';

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
