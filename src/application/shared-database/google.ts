import { sqlAdmin } from '../../adapters/providers/gcp/gcp-data.client.js';
import { accessLatestSecretVersion, addSecretVersion, readSecretContainer } from '../../adapters/providers/gcp/gcp-secret-manager.client.js';
import { setCloudSqlLoginPassword, withCloudSqlSession } from '../infrastructure-engine-database.js';
import { observeSecret, recordSecretVersionMetadata, writeSecretVersion } from '../infrastructure-engine.js';
import type { SeenServer, SharedDatabaseCloud } from './ports.js';

interface ListedInstance { name?: string; region?: string; state?: string; settings?: { userLabels?: Record<string, string>; deletionProtectionEnabled?: boolean } }

/**
 * Google Cloud behind the module's ports: Cloud SQL's admin interface, Secret
 * Manager and the Cloud SQL connector, all as the app's deployment identity.
 * `credentials` is read only when a SQL session is opened.
 */
export function googleSharedDatabaseCloud(access: { token: string; credentials: () => Record<string, unknown> }): SharedDatabaseCloud {
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
        const body = await response.json() as { items?: ListedInstance[]; nextPageToken?: string };
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
      return set === 'done' ? undefined : set;
    },

    async readAdministratorSecret(gcpProjectId, secretId) {
      const container = await readSecretContainer(token, gcpProjectId, secretId);
      if (container.state !== 'present') return container;
      if (!container.value.hasEnabledVersion) return { state: 'present', value: { labels: container.value.labels } };
      const response = await accessLatestSecretVersion(token, gcpProjectId, secretId);
      if (!response.ok) return { state: 'unknown', reason: `Reading the shared database server's administrator secret returned HTTP ${response.status}.` };
      const data = (await response.json() as { payload?: { data?: string } }).payload?.data;
      if (!data) return { state: 'unknown', reason: 'The shared database server\'s administrator secret came back empty.' };
      return { state: 'present', value: { labels: container.value.labels, value: Buffer.from(data, 'base64').toString('utf8') } };
    },

    async writeAdministratorSecret(gcpProjectId, secretId, value) {
      let added: Response;
      try {
        added = await addSecretVersion(token, gcpProjectId, secretId, value);
      } catch {
        return { success: false, status: 'pending', message: 'Saving the shared database server\'s administrator password has an unknown outcome. Run the same command again; a new one is set if it was not saved.' };
      }
      return added.ok ? undefined : { success: false, message: `Saving the shared database server's administrator password failed (HTTP ${added.status}).`, error: `HTTP ${added.status}` };
    },

    async observeConnectionSecret(gcpProjectId, secretId) {
      const seen = await observeSecret(token, gcpProjectId, secretId);
      if (seen.state !== 'present') return seen;
      const { labels, hasEnabledVersion, latestVersion } = seen.value;
      return { state: 'present', value: { labels, hasEnabledVersion, ...(latestVersion ? { latestVersion } : {}) } };
    },

    publishConnectionSecret: (gcpProjectId, secretId, labels, value) => writeSecretVersion(token, gcpProjectId, secretId, labels, value),
    relabelConnectionSecret: recordSecretVersionMetadata,

    withSession: (target, work) => withCloudSqlSession(access.credentials(), target.connectionName, target.user, target.password, target.database,
      (client) => work({ query: (text, values) => client.query(text, values) })),
  };
}
