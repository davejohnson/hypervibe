import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ProviderRuntimeLogsRequest, ProviderRuntimeLogsResult } from '../../../domain/ports/provider-logs.port.js';
import { stateResources, stateString, workloadBinding, type EngineWorkloadBinding, type WorkloadDeploymentObservation } from '../../../domain/ports/workload-diagnostics.port.js';
import { redactEngineOutput } from '../../engine/opentofu/runner.js';
import type { AzureEngineCredentials } from './azure-engine.adapter.js';
import { ARM, AZURE_SCOPES, AzureTokens, azureRest } from './azure-ops.client.js';
const APPS_API = 'api-version=2025-01-01';

import { azureKey } from './tofu/azure-engine.config.js';
export function projectAzureWorkloadBindings(state: unknown, services: Record<string, { workloadKind?: string }>, scope: { subscriptionId: string; resourceGroup: string; location: string },
  /** The shared app environment and its log workspace, read from the shared state. */
  shared: { managedEnvironmentId?: string; workspaceId?: string } = {}): Record<string, EngineWorkloadBinding> {
  const resources = stateResources(state); const result: Record<string, EngineWorkloadBinding> = {};
  const workspaceId = shared.workspaceId;
  for (const [name, spec] of Object.entries(services)) {
    const kind = spec.workloadKind ?? 'web'; const resource = resources.get(`${kind === 'cron' ? 'azurerm_container_app_job' : 'azurerm_container_app'}.${azureKey(name)}`);
    const serviceId = stateString(resource?.id); if (!serviceId) continue;
    const prefix = `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/Microsoft.App/${kind === 'cron' ? 'jobs' : 'containerApps'}/`;
    if (!serviceId.toLowerCase().startsWith(prefix.toLowerCase()) || serviceId.slice(prefix.length).includes('/')) throw new Error('Engine workload identity is outside the reviewed Azure scope.');
    // Only the environment the workload actually runs in is recorded for it.
    const managedEnvironmentId = shared.managedEnvironmentId && (stateString(resource?.container_app_environment_id) ?? '').toLowerCase() === shared.managedEnvironmentId.toLowerCase() ? shared.managedEnvironmentId : undefined;
    const ingress = resource?.ingress as Array<{ fqdn?: string }> | undefined;
    result[name] = { serviceId, workloadKind: kind, resourceType: kind === 'cron' ? 'container-job' : 'container-app', region: scope.location,
      ...(managedEnvironmentId ? { managedEnvironmentId, ...(workspaceId ? { workspaceId } : {}) } : {}), ...(ingress?.[0]?.fqdn ? { url: `https://${ingress[0].fqdn}` } : {}) };
  }
  return result;
}
/** The shared app environment and its log workspace, as the shared state records them. */
export function projectAzureSharedApps(state: unknown): { managedEnvironmentId?: string; workspaceId?: string } {
  const resources = stateResources(state);
  const managedEnvironmentId = stateString(resources.get('azurerm_container_app_environment.main')?.id);
  const workspaceId = stateString(resources.get('azurerm_log_analytics_workspace.logs')?.workspace_id);
  return { ...(managedEnvironmentId ? { managedEnvironmentId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class AzureWorkloadDiagnostics {
  private readonly tokens: AzureTokens;
  private readonly secrets: string[];
  constructor(private readonly connection: AzureEngineCredentials) { this.tokens = new AzureTokens(connection); this.secrets = [connection.clientSecret]; }
  private binding(environment: Environment, name: string): EngineWorkloadBinding {
    const b = workloadBinding(environment, name); const prefix = `/subscriptions/${this.connection.subscriptionId}/resourceGroups/${this.connection.resourceGroup}/providers/Microsoft.App/`;
    const type = b.resourceType === 'container-app' ? 'containerApps' : b.resourceType === 'container-job' ? 'jobs' : undefined;
    const expected = `${prefix}${type}/`;
    if (!type || !b.serviceId.toLowerCase().startsWith(expected.toLowerCase()) || !/^[a-zA-Z0-9-]+$/.test(b.serviceId.slice(expected.length))
      || !b.managedEnvironmentId?.toLowerCase().startsWith(`${prefix}managedEnvironments/`.toLowerCase())
      || !/^[a-zA-Z0-9-]+$/.test(b.managedEnvironmentId.slice(`${prefix}managedEnvironments/`.length))) throw new Error('The workload binding does not match the connected Azure subscription and resource group.');
    return b;
  }
  private async get(id: string) {
    const token = await this.tokens.get(AZURE_SCOPES.arm); this.secrets.push(token);
    const r = await azureRest(this.tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${id}?${APPS_API}`);
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`Azure resource observation failed (HTTP ${r.status}).`);
    if (typeof r.body.id !== 'string' || r.body.id.toLowerCase() !== id.toLowerCase()) throw new Error('Azure returned a different or missing native resource identity.');
    return r.body;
  }
  private async workload(b: EngineWorkloadBinding) {
    const resource = await this.get(b.serviceId);
    if (resource) {
      const properties = record(resource.properties);
      const environmentId = properties.environmentId ?? properties.managedEnvironmentId;
      if (typeof environmentId !== 'string' || environmentId.toLowerCase() !== b.managedEnvironmentId!.toLowerCase()
        || typeof resource.location !== 'string' || resource.location.toLowerCase() !== b.region.toLowerCase()) throw new Error('Azure did not confirm the recorded workload environment and location.');
    }
    return resource;
  }
  async readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult> {
    try {
      const b = this.binding(request.environment, request.serviceName);
      if (!await this.workload(b)) throw new Error('Azure reports that the exact bound workload is absent; this is not an empty log result.');
      if (!b.workspaceId || !/^[0-9a-f-]{36}$/i.test(b.workspaceId)) throw new Error('The exact Log Analytics workspace identity is missing.');
      const env = await this.get(b.managedEnvironmentId!);
      const config = record(record(record(env?.properties).appLogsConfiguration).logAnalyticsConfiguration);
      if (config.customerId !== b.workspaceId) throw new Error('Azure did not confirm the bound Log Analytics workspace.');
      const scope = 'https://api.loganalytics.io/.default'; const token = await this.tokens.get(scope); this.secrets.push(token);
      // The project's testing environments share this workspace, so the query names the
      // exact workload. The GET above proves its native name; it is never a discovery/adoption fallback.
      const name = b.serviceId.split('/').at(-1)!; const limit = Math.max(1, Math.min(500, request.limit));
      const query = `ContainerAppConsoleLogs_CL | where ${b.resourceType === 'container-job' ? 'ContainerJobName_s' : 'ContainerAppName_s'} == '${name}' | top ${limit} by TimeGenerated desc | project TimeGenerated, Message=Log_s, Severity=tostring(column_ifexists('LogLevel_s', ''))`;
      const until = new Date().toISOString(); const since = new Date(Date.parse(until) - 24 * 60 * 60_000).toISOString();
      const response = await this.tokens.fetchImpl(`https://api.loganalytics.azure.com/v1/workspaces/${b.workspaceId}/query`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, timespan: `${since}/${until}` }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json() as { error?: unknown; tables?: Array<{ name?: string; columns?: Array<{ name: string }>; rows?: unknown[][] }> };
      if (!response.ok || body.error) throw new Error(`Azure log query failed or returned partial data (HTTP ${response.status}).`);
      const table = body.tables?.find((t) => t.name === 'PrimaryResult');
      const columns = ['TimeGenerated', 'Message', 'Severity'].map((name) => table?.columns?.findIndex((c) => c.name === name) ?? -1);
      if (!table || !Array.isArray(table.rows) || columns.some((c) => c < 0)) throw new Error('Azure log query did not return the requested result table.');
      const logs = table.rows.slice(0, limit).map((row) => {
        const [timestamp, message, severity] = columns.map((i) => row[i]);
        if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || typeof message !== 'string' || typeof severity !== 'string') throw new Error('Azure returned a malformed log row.');
        const safeMessage = redactEngineOutput(message, this.secrets);
        return { timestamp, message: safeMessage.slice(0, 4096), ...(safeMessage.length > 4096 ? { truncated: true as const } : {}), severity: redactEngineOutput(severity, this.secrets).slice(0, 80) };
      }).reverse();
      return { logs, window: { since, until } };
    } catch (error) { throw new Error(redactEngineOutput(error instanceof Error ? error.message : String(error), this.secrets)); }
  }
  async readDeployment(environment: Environment, serviceName: string): Promise<WorkloadDeploymentObservation> {
    try {
      const b = this.binding(environment, serviceName); const resource = await this.workload(b);
      if (!resource) return { presence: 'absent', status: 'failed', reason: 'Azure reports that the bound workload is missing.' };
      const properties = record(resource.properties);
      if (properties.provisioningState === 'Failed' || properties.provisioningState === 'Canceled') return { presence: 'present', status: 'failed' };
      if (b.resourceType === 'container-job') {
        // Definition provisioning is deliberately distinct from successful execution.
        const executions: Array<Record<string, unknown>> = []; const base = `${ARM}${b.serviceId}/executions`; let url: string | undefined = `${base}?${APPS_API}`; const seen = new Set<string>();
        for (let page = 0; url && page < 10; page++) {
          if (seen.has(url) || !url.startsWith(`${base}?`)) throw new Error('Azure execution pagination left the exact job scope or repeated a page.');
          seen.add(url); const r = await azureRest(this.tokens, AZURE_SCOPES.arm, 'GET', url);
          if (r.status !== 200 || !Array.isArray(r.body.value)) throw new Error('Azure did not return readable job execution history.');
          for (const raw of r.body.value) {
            const execution = record(raw);
            const executionId = typeof execution.id === 'string' ? execution.id : typeof execution.name === 'string' && /^[a-zA-Z0-9-]+$/.test(execution.name) ? `${b.serviceId}/executions/${execution.name}` : undefined;
            if (!executionId || !executionId.toLowerCase().startsWith(`${b.serviceId}/executions/`.toLowerCase()) || executionId.slice(`${b.serviceId}/executions/`.length).includes('/')) throw new Error('Azure returned an execution outside the exact job scope.');
            executions.push(execution);
          }
          if (r.body.nextLink != null && typeof r.body.nextLink !== 'string') throw new Error('Azure returned malformed execution pagination.');
          url = typeof r.body.nextLink === 'string' ? r.body.nextLink : undefined;
          if (executions.length > 1000) throw new Error('Azure execution history exceeded its bounded read.');
        }
        if (url) throw new Error('Azure execution history is incomplete.');
        const rows = executions.map((r) => record(r.properties));
        if (rows.some((r) => typeof r.startTime !== 'string' || !Number.isFinite(Date.parse(r.startTime)))) throw new Error('Azure execution history has no reliable ordering.');
        rows.sort((a, b) => Date.parse(String(b.startTime)) - Date.parse(String(a.startTime)));
        const latest = rows[0];
        const images = (template: unknown) => {
          const containers = record(template).containers;
          if (!Array.isArray(containers) || !containers.length) return undefined;
          const entries = containers.map((value) => record(value));
          if (entries.some((c) => typeof c.name !== 'string' || typeof c.image !== 'string')) return undefined;
          return JSON.stringify(entries.map((c) => [c.name, c.image]).sort());
        };
        const expectedImages = images(properties.template);
        if (latest && (!expectedImages || images(latest.template) !== expectedImages)) return { presence: 'present', status: 'unknown', reason: 'The latest job execution does not prove the current workload image.' };
        const status = latest?.status;
        return { presence: 'present', status: status === 'Succeeded' ? 'succeeded' : status === 'Failed' || status === 'Degraded' ? 'failed' : 'unknown', ...(rows.length ? {} : { reason: 'No job executions were returned; a provisioned definition is not execution success.' }) };
      }
      const revisionName = properties.latestRevisionName;
      if (typeof revisionName !== 'string' || !/^[a-z0-9-]+$/.test(revisionName)) return { presence: 'present', status: 'unknown', reason: 'Azure has not reported the current revision identity.' };
      const revision = await this.get(`${b.serviceId}/revisions/${revisionName}`); const current = record(revision?.properties);
      return { presence: 'present', status: current.healthState === 'Unhealthy' || current.provisioningState === 'Failed' || current.runningState === 'Failed' ? 'failed'
        : properties.provisioningState === 'Succeeded' && current.provisioningState === 'Provisioned' && current.healthState === 'Healthy' && properties.latestReadyRevisionName === revisionName ? 'ready' : 'unknown' };
    } catch (error) { throw new Error(redactEngineOutput(error instanceof Error ? error.message : String(error), this.secrets)); }
  }
}
