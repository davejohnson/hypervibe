import { projectAwsDatabaseQuerySecret } from '../aws/aws-database-query-secret.js';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { OpenTofuEngine } from '../../engine/opentofu/engine.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../../engine/opentofu/install.js';
import { AwsEngineCredentialsSchema } from '../aws/aws-engine.adapter.js';
import { awsEngineAuthentication, awsEngineBackend } from '../aws/tofu/aws-engine.backend.js';
import { AzureEngineCredentialsSchema } from '../azure/azure-engine.adapter.js';
import { azureEngineAuthentication, azureEngineBackend } from '../azure/tofu/azure-engine.backend.js';
import { AZURE_SCOPES, AzureTokens, azureRest } from '../azure/azure-ops.client.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { AwsDatabaseBinding, AzureDatabaseBinding } from '../../../domain/ports/engine-database-access.port.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function resources(state: unknown): Array<Record<string, unknown>> {
  const root = object(object(object(state).values).root_module);
  if (!Array.isArray(root.resources)) throw new Error('Engine resources are unavailable.');
  return root.resources.map(object);
}
function exact(state: unknown, address: string): Record<string, unknown> {
  const matches = resources(state).filter(resource => resource.address === address);
  if (matches.length !== 1 || matches[0]!.mode !== 'managed' || matches[0]!.tainted === true) throw new Error('Engine database ownership is incomplete or ambiguous.');
  return object(matches[0]!.values);
}
function single(values: string[]): string {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length !== 1) throw new Error('Engine database credential ownership is incomplete or ambiguous.');
  return unique[0]!;
}
/** The state references an environment-owned runtime credential; it supplies exact DB/login names privately. */
function credentialReference(state: unknown, provider: 'aws' | 'azure'): string {
  const refs: string[] = [];
  for (const resource of resources(state)) {
    if (resource.mode !== 'managed' || resource.tainted === true) continue;
    const values = object(resource.values);
    if (provider === 'aws' && resource.type === 'aws_ecs_express_gateway_service') {
      for (const container of Array.isArray(values.primary_container) ? values.primary_container : []) {
        for (const variable of Array.isArray(object(container).environment) ? object(container).environment as unknown[] : []) {
          if (object(variable).name === 'HYPERVIBE_PARAMETER_PATH') refs.push(text(object(variable).value));
        }
      }
    } else if (provider === 'aws' && resource.type === 'aws_ecs_task_definition') {
      const containers: unknown = JSON.parse(text(values.container_definitions) || '[]');
      for (const container of Array.isArray(containers) ? containers : []) {
        for (const variable of Array.isArray(object(container).environment) ? object(container).environment as unknown[] : []) {
          if (object(variable).name === 'HYPERVIBE_PARAMETER_PATH') refs.push(text(object(variable).value));
        }
      }
    } else if (provider === 'azure' && ['azurerm_container_app', 'azurerm_container_app_job'].includes(text(resource.type))) {
      for (const secret of Array.isArray(values.secret) ? values.secret : []) {
        if (object(secret).name === 'database-url') refs.push(text(object(secret).key_vault_secret_id));
      }
    }
  }
  return single(refs);
}
function postgres(value: unknown, host: string): URL {
  if (typeof value !== 'string') throw new Error('Database credential is unavailable.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== host || !url.username || !url.password || !url.pathname.slice(1)
    || url.port && url.port !== '5432') throw new Error('The stored database credential conflicts with the owned server.');
  return url;
}

/** Read-only recovery for older engine bindings. Nothing is guessed from mutable project/environment names. */
export async function recoverNativeEngineDatabaseBinding(project: Project, environment: Environment, provider: 'aws' | 'azure', rawCredentials: unknown): Promise<AwsDatabaseBinding | AzureDatabaseBinding> {
  const binary = await ensureEngineBinary();
  if (!binary.ok) throw new Error('The private engine is unavailable for database ownership recovery.');
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const state = (partition: 'environment' | 'project-shared') => ({ provider, projectId: project.id, environmentId: partition === 'environment' ? environment.id : 'shared-testing', partition });
  if (provider === 'aws') {
    const connection = AwsEngineCredentialsSchema.parse(rawCredentials);
    if (connection.roleArn.split(':')[4] !== connection.accountId) throw new Error('AWS role and account disagree.');
    const auth = await awsEngineAuthentication(connection);
    const shared = await engine.inspectState({ backend: awsEngineBackend, configuration: { files: {}, resources: {} }, auth, state: state('project-shared'),
      project: document => { const resource = exact(document, 'aws_rds_cluster.postgres'); return { arn: text(resource.arn), host: text(resource.endpoint) }; } });
    if (!shared.ok || !shared.present) throw new Error('The shared AWS database state could not be read.');
    const arn = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:([a-zA-Z0-9-]+)$/.exec(shared.value.arn);
    if (!arn || arn[2] !== connection.accountId) throw new Error('The retained database has an unknown AWS account or region.');
    const region = arn[1]!;
    if (environment.platformBindings?.provider === 'aws' && (environment.platformBindings.projectId !== connection.accountId
        || environment.platformBindings.environmentId !== region)) throw new Error('Shared database placement conflicts with the saved environment.');
    const own = await engine.inspectState({ backend: awsEngineBackend, configuration: { files: {}, resources: {} }, auth, state: state('environment'), project: document => ({ reference: credentialReference(document, provider), ...(resources(document).some(row => row.address === 'aws_secretsmanager_secret.database_query') ? { querySecretArn: projectAwsDatabaseQuerySecret(document, { ...connection, region, environmentId: environment.id }) } : {}) }) });
    if (!own.ok || !own.present
      || own.value.reference !== `/hypervibe/${environment.id.toLowerCase()}/`) throw new Error('The exact environment and shared database engine states could not be correlated.');
    const ssm = new SSMClient({ region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! }, maxAttempts: 1 });
    try {
      const name = `${own.value.reference}DATABASE_URL`;
      const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), { abortSignal: AbortSignal.timeout(30_000) });
      if (result.Parameter?.Name !== name) throw new Error('Parameter identity mismatch.');
      const url = postgres(result.Parameter.Value, shared.value.host);
      return { clusterArn: shared.value.arn, accountId: connection.accountId, region, name: decodeURIComponent(url.pathname.slice(1)), owner: decodeURIComponent(url.username), ...(own.value.querySecretArn ? { querySecretArn: own.value.querySecretArn } : {}) };
    } finally { ssm.destroy(); }
  }
  const connection = AzureEngineCredentialsSchema.parse(rawCredentials); const auth = azureEngineAuthentication(connection);
  const shared = await engine.inspectState({ backend: azureEngineBackend, configuration: { files: {}, resources: {} }, auth, state: state('project-shared'),
    project: document => { const resource = exact(document, 'azurerm_postgresql_flexible_server.postgres'); return { id: text(resource.id), host: text(resource.fqdn) }; } });
  const own = await engine.inspectState({ backend: azureEngineBackend, configuration: { files: {}, resources: {} }, auth, state: state('environment'), project: document => credentialReference(document, provider) });
  const prefix = `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/`;
  if (!shared.ok || !shared.present || !own.ok || !own.present || !shared.value.id.toLowerCase().startsWith(prefix.toLowerCase())
    || !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+$/.test(own.value)) throw new Error('The exact environment and shared database engine states could not be correlated.');
  const secret = await azureRest(new AzureTokens(connection), AZURE_SCOPES.vault, 'GET', `${own.value}?api-version=7.4`);
  if (secret.status !== 200 || !text(secret.body.id).startsWith(`${own.value}/`)) throw new Error('The exact environment database credential could not be read.');
  const url = postgres(secret.body.value, shared.value.host);
  return { serverId: shared.value.id, subscriptionId: connection.subscriptionId, resourceGroup: connection.resourceGroup, host: shared.value.host,
    name: decodeURIComponent(url.pathname.slice(1)), owner: decodeURIComponent(url.username), secretUrl: own.value };
}
