import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { normalizeHypervibeCloudBaseUrl } from './cloud-pairing.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { ensureRepoEnvFilesIgnored } from '../domain/spec/repo-env-file.js';
import {
  detectGitRemoteUrl,
  normalizeGitRemoteIdentity,
  resolveGitHeadCommitSha,
} from '../lib/git-remote.js';
import { primaryWorkspaceDirectory } from '../lib/workspace-context.js';
import { parseEnvContent } from '../utils/env-parser.js';

const PROVIDER = 'hypervibe-secret-import';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const keySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    keys: z.array(keySchema).min(1).max(16),
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
const receivedSchema = metadataSchema
  .extend({
    values: z.record(keySchema, z.string().min(1).max(4096)),
    replanRequired: z.literal(true),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['pending', 'consuming', 'received', 'imported']),
    root: z.string(),
    requestId: z.string().uuid(),
    environment: z.string(),
    repository: z.string(),
    sourceRevision: z.string(),
    sourceDigest: z.string(),
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    expiresAt: z.string().datetime(),
    received: receivedSchema.optional(),
    keys: z.array(keySchema).optional(),
    fileDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((state) =>
    state.status === 'received'
      ? Boolean(state.received)
      : state.status === 'imported'
        ? Boolean(state.keys?.length && state.fileDigest)
        : Boolean(state.token)
  );
type State = z.infer<typeof stateSchema>;
export interface SecretImportInput {
  action?: 'start' | 'receive';
  requestId: string;
  env: string;
  baseUrl?: string;
  confirm?: boolean;
}

function checkout(directory: string, env: string) {
  const root = findRepoRoot(directory);
  if (!root)
    throw new HvError('VALIDATION', 'Run secret import inside the intended GitHub checkout.');
  const specPath = path.join(root, '.hypervibe/spec.json');
  if (!lstatSync(specPath).isFile())
    throw new HvError('VALIDATION', 'The committed spec must be a regular file.');
  const sourceRevision = resolveGitHeadCommitSha(root, specPath);
  const document = readRepoSpecFile(root);
  const remote = normalizeGitRemoteIdentity(detectGitRemoteUrl(root) ?? undefined);
  if (
    !sourceRevision ||
    !document ||
    !remote?.startsWith('github.com/') ||
    (document.spec.gitRemoteUrl &&
      normalizeGitRemoteIdentity(document.spec.gitRemoteUrl) !== remote) ||
    !document.spec.environments[env]
  ) {
    throw new HvError(
      'VALIDATION',
      'Use the matching GitHub checkout with a clean, committed spec declaring this environment.'
    );
  }
  return {
    root: realpathSync(root),
    repository: remote.slice('github.com/'.length),
    sourceRevision,
    sourceDigest: hash(readFileSync(specPath)),
    spec: document.spec,
  };
}

function readPrivateFile(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HvError(
      'VALIDATION',
      'The env destination must be a readable regular file, never a symlink.'
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new HvError(
        'VALIDATION',
        'The env destination must be a small regular file without hard links.'
      );
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o600) !== 0o600)
        throw new HvError('VALIDATION', 'The env destination needs owner read/write permission.');
      fchmodSync(fd, stat.mode & 0o600);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function preservedLines(content: string, keys: string[]): string[] {
  // Preserve unrelated lines byte-for-byte. Only unambiguously empty, single-line
  // assignments may be filled; populated or multiline/ambiguous input blocks.
  const lines = content.split(/\r?\n/);
  return lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return true;
    const raw = match[2].trim();
    if (
      (raw.startsWith('"') && (raw.length === 1 || !raw.endsWith('"'))) ||
      (raw.startsWith("'") && (raw.length === 1 || !raw.endsWith("'")))
    )
      throw new HvError(
        'VALIDATION',
        'Import requires single-line env assignments; preserve and resolve multiline entries first.'
      );
    if (!keys.includes(match[1])) return true;
    if (!['', '""', "''"].includes(raw))
      throw new HvError('VALIDATION', `Refusing to replace an existing value for ${match[1]}.`);
    return false;
  });
}

function encodeAssignment(key: string, value: string): string {
  const encoded = !/['\r\n]/.test(value) ? `'${value}'` : JSON.stringify(value);
  const line = `${key}=${encoded}`;
  if (parseEnvContent(line)[key] !== value || value.includes('\0'))
    throw new HvError(
      'VALIDATION',
      `The value for ${key} cannot round-trip through this project's env parser. The received values remain encrypted locally.`
    );
  return line;
}

function reserveDestination(root: string, env: string, keys: string[]) {
  const name = `.env.${env}`;
  const stagingName = `.env.${env}_hypervibe_import`;
  const file = path.join(root, name);
  const stagingFile = path.join(root, stagingName);
  ensureRepoEnvFilesIgnored(root, [name, stagingName]);
  const original = readPrivateFile(file);
  const lines = preservedLines(original ?? '', keys);
  let fd: number;
  try {
    fd = openSync(
      stagingFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new HvError(
      'VALIDATION',
      `Another import or interrupted write owns ${stagingName}. Inspect it before retrying; do not delete a possible recovery copy blindly.`
    );
  }
  let closed = false;
  let ownsStagingFile = true;
  return {
    file,
    content(values: Record<string, string>) {
      const eol = original?.includes('\r\n') ? '\r\n' : '\n';
      return [...lines, ...keys.map((key) => encodeAssignment(key, values[key])), ''].join(eol);
    },
    write(output: string) {
      // Recheck both git protection and file contents immediately before commit.
      ensureRepoEnvFilesIgnored(root, [name, stagingName]);
      if (readPrivateFile(file) !== original)
        throw new HvError(
          'VALIDATION',
          'The env file changed during retrieval. Received values remain encrypted locally; review the file before retrying.'
        );
      writeFileSync(fd, output, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      closed = true;
      renameSync(stagingFile, file);
      ownsStagingFile = false;
    },
    close() {
      if (!closed) {
        closeSync(fd);
        closed = true;
      }
      // Only this call's O_EXCL-created staging file is eligible for cleanup.
      if (ownsStagingFile) {
        try {
          unlinkSync(stagingFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        ownsStagingFile = false;
      }
    },
  };
}

export function createCloudSecretImport({
  context,
  directory = primaryWorkspaceDirectory,
  fetchImpl = fetch,
  now = () => new Date(),
}: {
  context: CommandContext;
  directory?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  async function request(baseUrl: string, state: State, method: 'GET' | 'POST'): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(
        new URL(`/api/v1/credential-retrievals/${state.requestId}`, baseUrl),
        {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${state.token}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        }
      );
      if (!response.ok) throw new Error('unaccepted response');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 32 * 1024) throw new Error('oversized response');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HvError(
        'PROVIDER_ERROR',
        method === 'GET'
          ? 'Could not read the approved request. Complete browser approval and check the request is ready and unexpired.'
          : 'Retrieval was not confirmed. The server may have consumed the request; do not retry it automatically. Ask the owner for a new request.'
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run(input: SecretImportInput): Promise<Record<string, unknown>> {
    if (
      !z.string().uuid().safeParse(input.requestId).success ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.env) ||
      input.env === 'example'
    )
      throw new HvError('VALIDATION', 'Supply the request ID and exact environment.');
    const baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
    const scope = checkout(directory(), input.env);
    const connectionScope = hash([baseUrl, scope.root, input.requestId, input.env].join('\n'));
    let stored = context.repos.connections.findByProviderAndScope(PROVIDER, connectionScope);
    let state: State | undefined;
    if (stored) {
      try {
        state = stateSchema.parse(context.secretStore.decryptObject(stored.credentialsEncrypted));
      } catch {
        throw new HvError(
          'VALIDATION',
          'Local import state is unreadable. Restore it or ask the owner for a new request.'
        );
      }
      if (
        state.requestId !== input.requestId ||
        state.root !== scope.root ||
        state.repository !== scope.repository ||
        state.environment !== input.env ||
        state.sourceRevision !== scope.sourceRevision ||
        state.sourceDigest !== scope.sourceDigest
      )
        throw new HvError(
          'VALIDATION',
          'This import belongs to a different checkout or source revision.'
        );
    }
    const save = (next: State) => {
      const encrypted = context.secretStore.encryptObject(next);
      if (stored) context.repos.connections.updateCredentials(stored.id, encrypted);
      else
        stored = context.repos.connections.upsert({
          provider: PROVIDER,
          scope: connectionScope,
          credentialsEncrypted: encrypted,
        });
      state = next;
    };
    const receipt = () => ({
      status: 'imported',
      environment: input.env,
      path: path.join(scope.root, `.env.${input.env}`),
      keys: state?.keys ?? [],
      secretRefs: (state?.keys ?? []).map((key) => ({
        key,
        ref: `dotenv:${path.join(scope.root, `.env.${input.env}`)}#${key}`,
      })),
      replanRequired: true,
    });
    if (state?.status === 'imported') {
      const content = readPrivateFile(path.join(scope.root, `.env.${input.env}`));
      if (content === null || hash(content) !== state.fileDigest)
        throw new HvError(
          'VALIDATION',
          'This import already completed, but its env file has since changed or disappeared. It cannot be retrieved again.'
        );
      return receipt();
    }
    if ((input.action ?? 'start') === 'start') {
      if (state && state.status !== 'pending')
        throw new HvError(
          'VALIDATION',
          'A retrieval was already attempted. Finish local recovery or request new credentials.'
        );
      if (!state || new Date(state.expiresAt) <= now()) {
        save({
          version: 1,
          status: 'pending',
          root: scope.root,
          requestId: input.requestId,
          environment: input.env,
          repository: scope.repository,
          sourceRevision: scope.sourceRevision,
          sourceDigest: scope.sourceDigest,
          token: randomBytes(32).toString('base64url'),
          expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
        });
      }
      const challenge = hash(state!.token!);
      return {
        status: 'approval_required',
        requestId: input.requestId,
        environment: input.env,
        repository: scope.repository,
        comparisonCode: challenge.slice(0, 12).toUpperCase(),
        verificationUrl: `${baseUrl}/app/credential-requests/${input.requestId}/retrieval-authorizations/new?challenge=${challenge}`,
      };
    }
    if (!input.confirm)
      throw new HvError(
        'CONFIRM_REQUIRED',
        'Confirm the one-time import into the private env file. The server copy will be erased.'
      );
    if (!state)
      throw new HvError('VALIDATION', 'Start import and approve this device in the browser first.');
    if (state.status === 'consuming')
      throw new HvError(
        'VALIDATION',
        'A previous retrieval has an unknown outcome. Ask the owner for a new request; this client will not retrieve it again.'
      );
    if (state.status === 'pending' && new Date(state.expiresAt) <= now())
      throw new HvError(
        'VALIDATION',
        'This local import expired. Start again and approve a fresh proof.'
      );
    let metadata: Metadata;
    try {
      metadata = metadataSchema.parse(
        state.received
          ? metadataSchema.parse(
              Object.fromEntries(
                Object.entries(state.received).filter(
                  ([key]) => !['values', 'replanRequired'].includes(key)
                )
              )
            )
          : await request(baseUrl, state, 'GET')
      );
    } catch (error) {
      if (error instanceof HvError) throw error;
      throw new HvError('VALIDATION', 'The server returned invalid request metadata.');
    }
    if (
      metadata.requestId !== input.requestId ||
      metadata.repository !== scope.repository ||
      metadata.environment !== input.env ||
      metadata.sourceRevision !== scope.sourceRevision ||
      metadata.sourceDigest !== scope.sourceDigest ||
      new Set(metadata.keys).size !== metadata.keys.length ||
      metadata.keys.some((key) => {
        const slot = scope.spec.secrets?.[key];
        return !slot || slot.ownership !== 'delegated' || !slot.environments.includes(input.env);
      })
    )
      throw new HvError(
        'VALIDATION',
        'The approved request does not match this committed repository, environment, and delegated key set.'
      );
    // A crash after rename but before the receipt must not cause another fetch
    // or mistake our completed write for an owner-supplied value to overwrite.
    if (state.status === 'received' && state.fileDigest) {
      ensureRepoEnvFilesIgnored(scope.root, [`.env.${input.env}`]);
      const content = readPrivateFile(path.join(scope.root, `.env.${input.env}`));
      if (content !== null && hash(content) === state.fileDigest) {
        save({
          ...state,
          status: 'imported',
          token: undefined,
          received: undefined,
          keys: metadata.keys,
        });
        return receipt();
      }
    }
    const destination = reserveDestination(scope.root, input.env, metadata.keys);
    try {
      if (state.status !== 'received') {
        save({ ...state, status: 'consuming' });
        const raw = await request(baseUrl, state!, 'POST');
        const parsed = receivedSchema.safeParse(raw);
        if (
          !parsed.success ||
          JSON.stringify(
            metadataSchema.parse(
              Object.fromEntries(
                Object.entries(parsed.data ?? {}).filter(
                  ([key]) => !['values', 'replanRequired'].includes(key)
                )
              )
            )
          ) !== JSON.stringify(metadata) ||
          Object.keys(parsed.data.values).sort().join(',') !==
            metadata.keys.slice().sort().join(',')
        )
          throw new HvError(
            'VALIDATION',
            'The consuming response was invalid. The request may be consumed; ask the owner for a new request.'
          );
        save({
          ...state!,
          status: 'received',
          token: undefined,
          received: parsed.data,
        });
      }
      // Revalidate local scope after network I/O; never write into a switched checkout.
      const current = checkout(directory(), input.env);
      if (
        current.root !== scope.root ||
        current.sourceDigest !== scope.sourceDigest ||
        current.sourceRevision !== scope.sourceRevision ||
        current.repository !== scope.repository
      )
        throw new HvError(
          'VALIDATION',
          'The checkout changed during retrieval. Received values remain encrypted locally.'
        );
      const output = destination.content(state!.received!.values);
      save({ ...state!, fileDigest: hash(output) });
      destination.write(output);
      save({
        ...state!,
        status: 'imported',
        token: undefined,
        received: undefined,
        keys: metadata.keys,
      });
      return receipt();
    } finally {
      destination.close();
    }
  }
  return { run };
}
