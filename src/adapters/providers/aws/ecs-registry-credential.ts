import { isDeepStrictEqual } from 'node:util';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { RegistryCredentialLifecycle, RegistryCredentialTarget } from '../../../domain/ports/registry-credential.port.js';
import type { AwsSecretsAdapter } from '../secretmanagers/aws-secrets.adapter.js';

export function createEcsRegistryCredentialLifecycle(
  resolve: (environment: Environment, service: string) => Promise<RegistryCredentialTarget>,
  client: () => AwsSecretsAdapter | Promise<AwsSecretsAdapter>,
): RegistryCredentialLifecycle {
  const port: RegistryCredentialLifecycle = {
    async inspect(environment, service) {
      try { return await resolve(environment, service); }
      catch { throw new Error('The exact ECS service, image and existing repository credential secret cannot be verified. Native ECR images use workload identity; external private images require an existing repositoryCredentials reference.'); }
    },
    async update(environment, service, expected, credential, context) {
      let attempted = false;
      try {
        const target = await port.inspect(environment, service);
        if (!isDeepStrictEqual(target, expected) || !target.credentialReference || !credential.username || !credential.token) throw new Error();
        const secrets = await client();
        const current = await secrets.readCredentialJson(target.credentialReference);
        if (typeof current.username !== 'string' || typeof current.password !== 'string') throw new Error();
        if (current.username !== credential.username || current.password !== credential.token) {
          if (!context?.operationId || !/^[a-zA-Z0-9-]{32,64}$/.test(context.operationId)) throw new Error();
          attempted = true;
          await secrets.updateCredentialJson(target.credentialReference, { ...current, username: credential.username, password: credential.token }, context.operationId);
        }
        const after = await secrets.readCredentialJson(target.credentialReference);
        if (after.username !== credential.username || after.password !== credential.token) throw new Error();
        return { success: true, message: 'Existing ECS registry credential readback verified. Managed rollout must still prove image pull and runtime activation.', data: { mutationAttempted: attempted, configurationUpdated: true, credentialValueEvidence: 'readback', credentialUpdateActivation: 'deferred', runtimeRolloutRequired: true } };
      } catch { return { success: false, message: attempted ? 'ECS registry credential write is uncertain. Resume this exact operation after inspecting its existing secret version.' : 'ECS registry target or secret value cannot be verified; no write attempted.', data: { mutationAttempted: attempted } }; }
    },
  };
  port.reconcile = (environment, service, expected, credential, context) => port.update(environment, service, expected, credential, { ...context, retryUncertain: true });
  return port;
}
