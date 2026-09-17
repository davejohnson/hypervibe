import { ECSClient } from '@aws-sdk/client-ecs';

/** RegisterTaskDefinition has no idempotency token: ambiguous writes must not retry.
 * Keep the existing transport, credentials and read-client retry policy unchanged.
 * Do not destroy this short-lived wrapper: its request handler belongs to the owner.
 */
export function ecsTaskDefinitionWriter(client: ECSClient): ECSClient {
  // This resolved-only field is not a constructor input; the endpoint itself is
  // retained and the SDK re-resolves its service-config lookup for the wrapper.
  const { serviceConfiguredEndpoint: _resolvedEndpoint, ...config } = client.config;
  return new ECSClient({ ...config, retryStrategy: undefined, maxAttempts: 1 });
}
