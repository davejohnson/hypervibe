import { z } from 'zod';
import type { CommandRegistrar } from '../application/commands.js';
import type { CommandContext } from '../application/context.js';
import {
  createHypervibeCloudPairingClient,
  DEFAULT_HYPERVIBE_CLOUD_BASE_URL,
  HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
  normalizeHypervibeCloudBaseUrl,
  type HypervibeCloudConnection,
  type HypervibeCloudPairingClient,
  type PendingHypervibeCloudConnection,
  type VerifiedHypervibeCloudConnection,
} from '../application/cloud-pairing.js';
import { commandSuccess, HvError, wrapCommandHandler } from '../application/results.js';
import { detectGitRemoteUrl, parseGitHubRepoFromRemote } from '../lib/git-remote.js';

interface CloudToolOptions {
  detectRepository?: () => string | null;
  createClient?: (baseUrl: string) => HypervibeCloudPairingClient;
  now?: () => Date;
}

function currentRepository(): string | null {
  return parseGitHubRepoFromRemote(detectGitRemoteUrl() ?? undefined);
}

function publicConnectionSummary(connection: VerifiedHypervibeCloudConnection) {
  return {
    status: connection.status,
    repository: connection.repository,
    project: connection.project,
    environments: connection.environments.map(({ id, key, name }) => ({ id, key, name })),
    pairedAt: connection.pairedAt,
  };
}

function decryptConnection(
  ctx: CommandContext,
  credentialsEncrypted: string
): HypervibeCloudConnection | null {
  try {
    const value = ctx.secretStore.decryptObject<HypervibeCloudConnection>(credentialsEncrypted);
    if (value?.version !== 1 || !['pending', 'verified'].includes(value.status)) return null;
    return value;
  } catch {
    return null;
  }
}

export function registerHvCloudTools(
  commands: CommandRegistrar,
  ctx: CommandContext,
  options: CloudToolOptions = {}
): void {
  const detectRepository = options.detectRepository ?? currentRepository;
  const createClient = options.createClient ?? ((baseUrl) => (
    createHypervibeCloudPairingClient({ baseUrl })
  ));
  const now = options.now ?? (() => new Date());

  commands.register(
    'hv_cloud_pair',
    'Connect the current private GitHub repository to Hypervibe reporting through a short-lived browser approval. action="start" returns the approval link and human code; after approval, action="status" completes the one-time exchange and stores environment credentials encrypted on this machine. No GitHub token or environment name is requested or returned.',
    {
      action: z.enum(['start', 'status']).optional().describe('Pairing step (default: start)'),
      baseUrl: z.string().optional().describe('Hypervibe cloud origin (default: https://hypervibe.dev; HTTPS required except loopback development)'),
    },
    wrapCommandHandler(async ({ action = 'start', baseUrl: requestedBaseUrl }) => {
      const repository = detectRepository();
      if (!repository) {
        throw new HvError('VALIDATION', 'The current directory does not have a GitHub origin remote.', {
          hint: 'Run this command inside the GitHub repository you want Hypervibe to observe.',
          agentInstruction: {
            action: 'ask_user',
            message: 'Ask the user to run the command from the intended GitHub repository; do not request a repository id or GitHub token.',
          },
        });
      }

      const baseUrl = normalizeHypervibeCloudBaseUrl(
        requestedBaseUrl ?? DEFAULT_HYPERVIBE_CLOUD_BASE_URL
      );
      const stored = ctx.repos.connections.findByProviderAndScope(
        HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
        repository
      );
      const connection = stored
        ? decryptConnection(ctx, stored.credentialsEncrypted)
        : null;

      if (action === 'status') {
        if (!stored || !connection) {
          throw new HvError('NOT_FOUND', `No active Hypervibe cloud pairing was found for ${repository}.`, {
            hint: 'Start pairing first with hypervibe cloud pair.',
            next: ['hv_cloud_pair'],
          });
        }
        if (connection.baseUrl !== baseUrl) {
          throw new HvError('VALIDATION', 'The active pairing belongs to a different Hypervibe cloud URL.', {
            hint: `Retry status with baseUrl="${connection.baseUrl}".`,
          });
        }
        if (connection.status === 'verified') {
          return commandSuccess(publicConnectionSummary(connection), {
            hint: 'This repository is already paired. Hypervibe can report activity for its spec-declared environments.',
          });
        }
        if (new Date(connection.expiresAt).getTime() <= now().getTime()) {
          ctx.repos.connections.updateStatus(stored.id, 'failed');
          throw new HvError('VALIDATION', 'The browser pairing expired.', {
            hint: 'Start a new pairing with hypervibe cloud pair.',
            next: ['hv_cloud_pair'],
          });
        }

        const result = await createClient(baseUrl).exchange(connection.deviceCode);
        if (result.status === 'pending') {
          return commandSuccess({
            status: 'pending',
            repository,
            userCode: connection.userCode,
            verificationUrl: connection.verificationUrl,
            expiresAt: connection.expiresAt,
            retryAfterSeconds: result.retryAfterSeconds,
          }, {
            hint: 'Approve this repository in the browser, then run hypervibe cloud pair --action status again.',
            next: ['hv_cloud_pair'],
          });
        }

        const verified: VerifiedHypervibeCloudConnection = {
          version: 1,
          status: 'verified',
          baseUrl,
          repository,
          project: result.project,
          environments: result.credentials.map(({ environment, token }) => ({
            ...environment,
            token,
          })),
          pairedAt: now().toISOString(),
        };
        ctx.repos.connections.updateCredentials(
          stored.id,
          ctx.secretStore.encryptObject(verified)
        );
        ctx.repos.connections.updateStatus(stored.id, 'verified');
        return commandSuccess(publicConnectionSummary(verified), {
          hint: 'Pairing complete. Hypervibe can now report activity for these spec-declared environments.',
        });
      }

      if (connection?.status === 'verified') {
        return commandSuccess(publicConnectionSummary(connection), {
          hint: 'This repository is already paired. No new browser approval was created.',
        });
      }
      if (
        connection?.status === 'pending'
        && connection.baseUrl === baseUrl
        && new Date(connection.expiresAt).getTime() > now().getTime()
      ) {
        return commandSuccess({
          status: 'pending',
          repository,
          userCode: connection.userCode,
          verificationUrl: connection.verificationUrl,
          expiresAt: connection.expiresAt,
        }, {
          hint: 'Open the approval link, then run hypervibe cloud pair --action status.',
          next: ['hv_cloud_pair'],
        });
      }

      const result = await createClient(baseUrl).start(repository);
      const pending: PendingHypervibeCloudConnection = {
        version: 1,
        status: 'pending',
        baseUrl,
        repository,
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        expiresAt: result.expiresAt,
      };
      ctx.repos.connections.upsert({
        provider: HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
        scope: repository,
        credentialsEncrypted: ctx.secretStore.encryptObject(pending),
      });
      return commandSuccess({
        status: 'pending',
        repository,
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrl,
        expiresAt: pending.expiresAt,
      }, {
        hint: 'Open the approval link, then run hypervibe cloud pair --action status.',
        next: ['hv_cloud_pair'],
      });
    })
  );
}
