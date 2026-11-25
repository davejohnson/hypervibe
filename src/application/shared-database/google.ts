import { sqlAdmin } from '../../adapters/providers/gcp/gcp-data.client.js';
import { readSecretVersionValue } from '../../adapters/providers/gcp/gcp-secret-manager.client.js';
import { setCloudSqlLoginPassword, withCloudSqlSession } from '../infrastructure-engine-database.js';
import { runTransferJob } from '../migration-transfer-gcp.js';
import { observeRecordedSecret } from '../gcp-secret-recorded.js';
import { recordSecretVersionMetadata, writeSecretVersion } from '../infrastructure-engine.js';
import { SERVER_BUSY } from './administrator.js';
import type { SeenServer, SharedDatabaseCloud } from './ports.js';

interface ListedInstance { name?: string; region?: string; state?: string; settings?: { userLabels?: Record<string, string>; deletionProtectionEnabled?: boolean } }

/**
 * Google Cloud behind the module's ports: Cloud SQL's admin interface, Secret
 * Manager and the Cloud SQL connector, all as the app's deployment identity.
 * `credentials` is read only when a SQL session is opened.
 */
export function googleSharedDatabaseCloud(access: { token: string; credentials: () => Record<string, unknown>; jobs?: { region: string; runtimeServiceAccountEmail: string; environmentLabel: string } }): SharedDatabaseCloud {
  const { token } = access;
  return {
    async listServers(gcpProjectId) {
      const servers: SeenServer[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 50; page++) {
        let response: Response;
        try {
          response = await sqlAdmin(token, gcpProjectId, `instances${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        } catch {
          return { state: 'unknown', reason: 'Google could not be reached to list this project\'s database servers. Nothing was planned; try again.' };
        }
        if (!response.ok) return { state: 'unknown', reason: `Google did not list this project's database servers (HTTP ${response.status}). Nothing was planned.` };
        const body = await response.json() as { items?: ListedInstance[]; nextPageToken?: string; warnings?: unknown[] };
        // Google answers 200 with warnings when a region could not be reached: the list is then not the whole list.
        if (Array.isArray(body.warnings) && body.warnings.length) return { state: 'unknown', reason: 'Google could not reach every region while listing this project\'s database servers, so the list may be incomplete. Nothing was planned; try again.' };
        for (const item of body.items ?? []) {
          if (typeof item.name !== 'string' || typeof item.region !== 'string') return { state: 'unknown', reason: 'Google listed a database server without a name or region. Nothing was planned.' };
          servers.push({ instanceName: item.name, region: item.region, runnable: item.state === 'RUNNABLE', deletionProtection: item.settings?.deletionProtectionEnabled !== false, labels: item.settings?.userLabels ?? {} });
        }
        pageToken = body.nextPageToken;
        if (!pageToken) return { state: 'listed', servers };
      }
      return { state: 'unknown', reason: 'This project has more database servers than Hypervibe could list. Nothing was planned.' };
    },

    async setServerLogin(gcpProjectId, instanceName, login, password) {
      const users = await sqlAdmin(token, gcpProjectId, `instances/${instanceName}/users`);
      if (!users.ok) return { success: false, status: 'blocked', message: `Listing the shared database server's logins returned HTTP ${users.status}.` };
      const exists = ((await users.json() as { items?: Array<{ name?: string }> }).items ?? []).some((item) => item.name === login);
      const set = await setCloudSqlLoginPassword(token, gcpProjectId, instanceName, login, password, exists);
      if (set === 'done') return undefined;
      // Cloud SQL runs one change per server at a time; a second one is turned away, not queued.
      return set.error === 'HTTP 409' ? { success: false, status: 'pending', message: SERVER_BUSY } : set;
    },

    observeConnectionSecret: (gcpProjectId, secretId) => observeRecordedSecret(token, gcpProjectId, secretId),

    readSecretVersion: (gcpProjectId, secretId, version) => readSecretVersionValue(token, gcpProjectId, secretId, version),
    publishConnectionSecret: (gcpProjectId, secretId, labels, value) => writeSecretVersion(token, gcpProjectId, secretId, labels, value),
    relabelConnectionSecret: recordSecretVersionMetadata,

    withSession: (target, work) => withCloudSqlSession(access.credentials(), target.connectionName, target.user, target.password, target.database,
      (client) => work({ query: (text, values) => client.query(text, values) })),

    async runCopyJob(gcpProjectId, job) {
      if (!access.jobs) return undefined;
      return runTransferJob<{ ok: boolean }>({ token: async () => token, gcpProjectId, ...access.jobs }, job) as Promise<Record<string, unknown>>;
    },
  };
}
