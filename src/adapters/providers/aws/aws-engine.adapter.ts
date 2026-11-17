import type { Project } from '../../../domain/entities/project.entity.js';
import type { IEngineDatabaseAccess } from '../../../domain/ports/engine-database-access.port.js';
import { AwsWorkloadDiagnostics } from './aws-diagnostics.client.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ProviderRuntimeLogsRequest } from '../../../domain/ports/provider-logs.port.js';
import { z } from 'zod';
import type { VerifyResult } from '../../../domain/ports/provider.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * Hypervibe's own AWS access, created by one-time setup: an access key for
 * the hypervibe-local user (which can only assume deploy roles) plus the
 * project's deploy role. OpenTofu deploys with the assumed role.
 */
export const AwsEngineCredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(16),
  secretAccessKey: z.string().min(32),
  // The account role (hypervibe-deploy) or a per-project one from earlier versions.
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/hypervibe\/hypervibe-deploy(?:-[a-z0-9-]+)?$/),
  accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
}).strict();
export type AwsEngineCredentials = z.infer<typeof AwsEngineCredentialsSchema>;

export type AwsDeployAccess = Pick<AwsEngineCredentials, 'accessKeyId' | 'secretAccessKey' | 'roleArn' | 'region'>;

/** Proves the stored key can assume the deploy role (IAM changes take a few seconds to apply). */
export async function verifyAwsDeployAccess(access: AwsDeployAccess): Promise<{ ok: true; arn: string } | { ok: false; message: string }> {
  let lastError = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const sts = new STSClient({ region: access.region, credentials: { accessKeyId: access.accessKeyId, secretAccessKey: access.secretAccessKey } });
      const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: access.roleArn, RoleSessionName: 'hypervibe-verify', DurationSeconds: 900 }));
      const credentials = assumed.Credentials!;
      const who = await new STSClient({ region: access.region, credentials: { accessKeyId: credentials.AccessKeyId!, secretAccessKey: credentials.SecretAccessKey!, sessionToken: credentials.SessionToken! } })
        .send(new GetCallerIdentityCommand({}));
      return { ok: true, arn: who.Arn ?? '' };
    } catch (error) {
      lastError = error instanceof Error ? error.name : String(error);
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
  return { ok: false, message: `The deploy role was not usable yet (${lastError}).` };
}

export class AwsEngineAdapter implements IEngineDatabaseAccess {
  readonly name = 'aws';
  readonly capabilities = { supportedBuilders: ['dockerfile'], supportedComponents: [], supportsAutoWiring: false, supportsHealthChecks: true };
  private credentials: AwsEngineCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AwsEngineCredentialsSchema.parse(credentials);
  }

  readProviderLogs(request: ProviderRuntimeLogsRequest) {
    if (!this.credentials) throw new Error('Not connected.');
    return new AwsWorkloadDiagnostics(this.credentials).readProviderLogs(request);
  }

  readDeployment(environment: Environment, serviceName: string) {
    if (!this.credentials) throw new Error('Not connected.');
    return new AwsWorkloadDiagnostics(this.credentials).readDeployment(environment, serviceName);
  }

  async acquireManagedDatabaseAccess(project: Project, environment: Environment) {
    if (!this.credentials) throw new Error('Not connected.');
    const { acquireNativeEngineDatabaseAccess } = await import('../database/engine-database-access.js');
    return acquireNativeEngineDatabaseAccess(project, environment, { provider: 'aws', credentials: this.credentials });
  }

  async observeManagedDatabase(project: Project, environment: Environment) {
    if (!this.credentials) throw new Error('Not connected.');
    const { observeNativeEngineDatabase } = await import('../database/engine-database-access.js');
    return observeNativeEngineDatabase(project, environment, { provider: 'aws', credentials: this.credentials });
  }

  async recoverManagedDatabaseBinding(project: Project, environment: Environment) {
    if (!this.credentials) throw new Error('Not connected.');
    const { recoverNativeEngineDatabaseBinding } = await import('../database/engine-database-state.js');
    return recoverNativeEngineDatabaseBinding(project, environment, 'aws', this.credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) return { success: false, error: 'Not connected.' };
    const verified = await verifyAwsDeployAccess(this.credentials);
    return verified.ok ? { success: true } : { success: false, error: verified.message };
  }
}

providerRegistry.register({
  metadata: {
    name: 'aws',
    displayName: 'Amazon Web Services',
    category: 'deployment',
    orchestration: { logs: { runtime: true } },
    credentialsSchema: AwsEngineCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/',
    maturity: {
      lifecycle: {
        hosting: { status: 'planned', reason: 'The OpenTofu engine manages AWS infrastructure; this connection provides Hypervibe\'s access only.' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new AwsEngineAdapter();
    await adapter.connect(credentials);
    return adapter as never;
  },
});
