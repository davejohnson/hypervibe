import {
  DescribeSecretCommand, ListSecretVersionIdsCommand, PutSecretValueCommand, SecretsManagerClient,
  type SecretsManagerClientConfig,
} from '@aws-sdk/client-secrets-manager';
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts';
import type { AwsSecretDestination, SecretDestination, SecretDestinationDriver, SecretDestinationObservation } from '../../../domain/ports/secret-destination.port.js';
import { authorizeDestinationWrite, bounded, delivered, deliveryFailure, DestinationBoundaryError, DestinationBudget,
  failureCode, parseAttempt, parseDestination } from '../secret-destination-http.js';

export interface AwsSecretDestinationAuthentication {
  accountId: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}
export interface AwsSecretDestinationOptions {
  requestHandler?: SecretsManagerClientConfig['requestHandler'];
  stsRequestHandler?: STSClientConfig['requestHandler'];
}

function providerError(error: unknown): DestinationBoundaryError {
  if (error instanceof DestinationBoundaryError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'ResourceNotFoundException') return new DestinationBoundaryError('destination_absent', 404);
  if (name === 'AccessDeniedException' || name === 'UnrecognizedClientException' || name === 'InvalidClientTokenId') {
    return new DestinationBoundaryError('access_denied', 403);
  }
  if (name === 'InvalidParameterException' || name === 'InvalidRequestException' || name === 'ResourceExistsException') {
    return new DestinationBoundaryError('provider_unavailable', 400);
  }
  return new DestinationBoundaryError('provider_unavailable');
}

/** Bound bytes before SDK deserialization, including ignored/error fields. */
export function boundAwsSdkResponses(client: { config: { requestHandler: STSClient['config']['requestHandler'] } }): void {
  const handler = client.config.requestHandler;
  const handle = handler.handle.bind(handler);
  client.config.requestHandler = Object.assign(Object.create(handler), {
    handle: async (...args: Parameters<typeof handle>) => {
      const callOptions = args[1] as { abortSignal?: AbortSignal } | undefined;
      const budget = new DestinationBudget({ signal: callOptions?.abortSignal, deadlineMs: 30_000 });
      let body: unknown;
      try {
        const result = await budget.wait(handle(...args));
        body = result.response.body;
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        const add = (part: unknown) => {
          if (typeof part !== 'string' && !(part instanceof Uint8Array)) throw new DestinationBoundaryError('invalid_response');
          const chunk = typeof part === 'string' ? Buffer.from(part) : part;
          bytes += chunk.byteLength;
          if (bytes > 1_048_576) throw new DestinationBoundaryError('invalid_response');
          chunks.push(chunk);
        };
        if (typeof body === 'string' || body instanceof Uint8Array) add(body);
        else if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
          const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          while (true) {
            const part = await budget.wait(iterator.next());
            if (part.done) break;
            add(part.value);
          }
        } else if (body !== undefined && body !== null) throw new DestinationBoundaryError('invalid_response');
        return { response: { ...result.response, body: Buffer.concat(chunks) } };
      } catch (error) {
        if (body && typeof body === 'object' && 'destroy' in body && typeof body.destroy === 'function') body.destroy();
        throw error;
      } finally { budget.close(); }
    },
  });
}

export function createAwsSecretDestinationDriver(authentication: AwsSecretDestinationAuthentication,
  options: AwsSecretDestinationOptions = {}): SecretDestinationDriver {
  // Explicit credentials only. Never let the SDK select a different account via
  // its ambient provider chain; never let it replay a mutation automatically.
  if (!authentication.credentials?.accessKeyId || !authentication.credentials.secretAccessKey) {
    throw new DestinationBoundaryError('invalid_input');
  }
  const client = new SecretsManagerClient({ region: authentication.region, credentials: authentication.credentials,
    maxAttempts: 1, ...(options.requestHandler ? { requestHandler: options.requestHandler } : {}) });
  const sts = new STSClient({ region: authentication.region, credentials: authentication.credentials,
    maxAttempts: 1, ...(options.stsRequestHandler ? { requestHandler: options.stsRequestHandler } : {}) });
  boundAwsSdkResponses(client); boundAwsSdkResponses(sts);
  const scope = (input: SecretDestination): AwsSecretDestination => {
    const destination = parseDestination(input);
    if (destination.provider !== 'aws-secrets' || destination.accountId !== authentication.accountId
      || destination.region !== authentication.region) throw new DestinationBoundaryError('scope_mismatch');
    return destination;
  };
  const verifyIdentity = async (destination: AwsSecretDestination, budget: DestinationBudget) => {
    const result = await budget.wait(sts.send(new GetCallerIdentityCommand({}), { abortSignal: budget.signal }));
    if (result.Account !== destination.accountId || typeof result.Arn !== 'string'
      || result.Arn.split(':')[4] !== destination.accountId) throw new DestinationBoundaryError('scope_mismatch');
  };
  const inspect = async (destination: AwsSecretDestination, budget: DestinationBudget) => {
    const result = await budget.wait(client.send(new DescribeSecretCommand({ SecretId: destination.secretArn }), { abortSignal: budget.signal }));
    if (result.ARN !== destination.secretArn || result.DeletedDate !== undefined) throw new DestinationBoundaryError('invalid_response');
  };
  const versions = async (destination: AwsSecretDestination, budget: DestinationBudget) => {
    const records: Array<{ version: string; stages: string[] }> = [];
    const seenTokens = new Set<string>();
    const seenVersions = new Set<string>();
    let next: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await budget.wait(client.send(new ListSecretVersionIdsCommand({ SecretId: destination.secretArn,
        IncludeDeprecated: true, MaxResults: 100, ...(next ? { NextToken: next } : {}) }), { abortSignal: budget.signal }));
      if (result.ARN !== destination.secretArn || !Array.isArray(result.Versions)) throw new DestinationBoundaryError('invalid_response');
      for (const version of result.Versions) {
        if (typeof version.VersionId !== 'string' || !/^[A-Za-z0-9-]{32,64}$/.test(version.VersionId)
          || seenVersions.has(version.VersionId) || (version.VersionStages !== undefined
            && (!Array.isArray(version.VersionStages) || version.VersionStages.some(stage => typeof stage !== 'string')))) {
          throw new DestinationBoundaryError('invalid_response');
        }
        seenVersions.add(version.VersionId);
        records.push({ version: version.VersionId, stages: version.VersionStages ?? [] });
      }
      if (result.NextToken === undefined || result.NextToken === '') return records;
      if (typeof result.NextToken !== 'string' || result.NextToken.length > 4096 || seenTokens.has(result.NextToken)) {
        throw new DestinationBoundaryError('invalid_response');
      }
      next = result.NextToken; seenTokens.add(next);
    }
    throw new DestinationBoundaryError('invalid_response');
  };
  return {
    async observe(input, callOptions) {
      return bounded<SecretDestinationObservation>(callOptions, async budget => {
        const destination = scope(input);
        await verifyIdentity(destination, budget);
        await inspect(destination, budget);
        return { status: 'present' as const, hasVersions: (await versions(destination, budget)).length > 0 };
      }, error => {
        const safe = providerError(error);
        return safe.status === 404 ? { status: 'absent' as const } : { status: 'unknown' as const, code: safe.code };
      });
    },
    async deliver(input, value, callOptions) {
      let writeStarted = false;
      return bounded(callOptions, async budget => {
        const attempt = parseAttempt(input, value);
        const destination = scope(attempt.destination);
        await verifyIdentity(destination, budget);
        await inspect(destination, budget);
        if ((await versions(destination, budget)).length) throw new DestinationBoundaryError('destination_initialized');
        const stage = `hv-${attempt.attemptId}`;
        await authorizeDestinationWrite(budget, callOptions);
        writeStarted = true;
        const result = await budget.wait(client.send(new PutSecretValueCommand({ SecretId: destination.secretArn,
          SecretString: value, ClientRequestToken: attempt.attemptId, VersionStages: [stage] }), { abortSignal: budget.signal }));
        if (result.ARN !== destination.secretArn || result.VersionId !== attempt.attemptId
          || !Array.isArray(result.VersionStages) || !result.VersionStages.includes(stage)) throw new DestinationBoundaryError('invalid_response');
        return delivered(destination, result.VersionId);
      }, error => deliveryFailure(providerError(error), writeStarted));
    },
    async reconcile(input, callOptions) {
      return bounded(callOptions, async budget => {
        const attempt = parseAttempt(input);
        const destination = scope(attempt.destination);
        await verifyIdentity(destination, budget);
        await inspect(destination, budget);
        const matches = (await versions(destination, budget)).filter(version => version.version === attempt.attemptId
          && version.stages.includes(`hv-${attempt.attemptId}`));
        if (matches.length !== 1) return { status: 'unknown' as const, code: matches.length ? 'attempt_ambiguous' as const : 'attempt_not_found' as const };
        return delivered(destination, matches[0].version);
      }, error => ({ status: 'unknown', code: failureCode(providerError(error)) }));
    },
  };
}
