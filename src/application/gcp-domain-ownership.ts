import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { domainEngineKey, gcpEngineBackend } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { EngineContext } from './infrastructure-engine.js';
import type { DomainMappingObservation } from './infrastructure-engine-domain.js';

interface MappingIdentity { id: string; namespace: string; uid: string; routeName: string }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Project only exact native ownership; unrelated state and its secrets stay private. */
function projectMapping(state: unknown, address: string): MappingIdentity | undefined {
  const document = object(state);
  if (typeof document?.format_version !== 'string') throw new Error('Unreadable engine state.');
  const root = object(object(document.values)?.root_module);
  if (!root || !Array.isArray(root.resources)) return undefined;
  const matches = root.resources.map(object).filter(resource => resource?.address === address);
  if (matches.length !== 1) return undefined;
  const resource = matches[0]!;
  if (resource.mode !== 'managed' || resource.type !== 'google_cloud_run_domain_mapping' || resource.tainted === true) return undefined;
  const values = object(resource.values);
  const metadata = Array.isArray(values?.metadata) && values.metadata.length === 1 ? object(values.metadata[0]) : undefined;
  const spec = Array.isArray(values?.spec) && values.spec.length === 1 ? object(values.spec[0]) : undefined;
  const fields = [values?.id, metadata?.namespace, metadata?.uid, spec?.route_name];
  if (fields.some(value => typeof value !== 'string' || !value || /[\r\n]/.test(value))) return undefined;
  return { id: fields[0] as string, namespace: fields[1] as string, uid: fields[2] as string, routeName: fields[3] as string };
}

/** A matching hostname is insufficient: scoped engine state must own this immutable mapping UID. */
export async function verifyGcpDomainEngineOwnership(context: EngineContext, domain: string, live: DomainMappingObservation): Promise<{ ready: boolean; reason?: string }> {
  const stop = (reason: string) => ({ ready: false, reason });
  if (live.state !== 'present') return stop('The exact Cloud Run mapping is not present or could not be observed.');
  if (live.domain !== domain || !live.uid || !live.serviceName
    || live.namespace !== context.gcpProjectId && !/^\d+$/.test(live.namespace)) return stop('The observed Cloud Run mapping has a different or incomplete native scope.');
  try {
    const binary = await ensureEngineBinary();
    if (!binary.ok) return stop('The managed engine is unavailable for verifying domain ownership.');
    const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
    const inspected = await engine.inspectState({ backend: gcpEngineBackend, configuration: { files: {}, resources: {} },
      auth: context.auth, state: context.state,
      project: state => projectMapping(state, `google_cloud_run_domain_mapping.${domainEngineKey(domain)}`) });
    if (!inspected.ok || !inspected.present || !inspected.value) return stop('The private engine state does not establish ownership of this Cloud Run mapping. Preserve the claim and reconcile its exact state before changing DNS.');
    const saved = inspected.value;
    const expectedId = `locations/${context.region}/namespaces/${context.gcpProjectId}/domainmappings/${domain}`;
    // Google 8.9.0 normalizes state namespace to project ID; REST may use the
    // project number. The scoped native ID and immutable UID correlate the
    // response already read from this project's exact API endpoint.
    if (saved.id !== expectedId || saved.namespace !== context.gcpProjectId || saved.uid !== live.uid || saved.routeName !== live.serviceName) {
      return stop('The live Cloud Run mapping differs from the exact identity owned by this environment’s engine state. Preserve it and review ownership before changing DNS.');
    }
    return { ready: true };
  } catch { return stop('Cloud Run mapping ownership could not be verified from private engine state. Preserve it and retry observation.'); }
}
