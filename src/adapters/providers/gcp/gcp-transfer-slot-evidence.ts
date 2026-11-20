import { z } from 'zod';
import { GcpBootstrapClient } from './gcp-bootstrap.client.js';

const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const projectSchema = z.object({ name: z.string().regex(/^projects\/[1-9][0-9]*$/), projectId: z.string(), state: z.literal('ACTIVE') });
const secretSchema = z.object({ name: z.string(), createTime: z.iso.datetime({ offset: true }),
  labels: z.record(z.string(), z.string()).default({}) });
const versionsPage = z.strictObject({
  versions: z.array(z.unknown()).optional(), totalSize: z.number().int().nonnegative().optional(), nextPageToken: z.string().max(4096).optional(),
});

export interface TransferSlotTarget { projectId: string; accountEmail: string; secretId: string }
export interface TransferSlotEvidence {
  projectNumber: string;
  account: { name: string; email: string; uniqueId: string; displayName?: string; description?: string } | null;
  secret: { name: string; createTime: string; labels: Record<string, string> } | null;
  directAccessor: boolean;
}

export class TransferEvidenceError extends Error {}
function reject(reason: string): never { throw new TransferEvidenceError(reason); }

async function verifyEmptyVersions(base: string, read: (url: URL) => Promise<Response>) {
  const url = new URL(base + '/versions');
  url.searchParams.set('fields', 'versions(name),nextPageToken,totalSize');
  url.searchParams.set('pageSize', '1');
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await read(url);
    if (!response.ok) reject('Google could not verify the transfer secret version inventory.');
    const result = versionsPage.safeParse(await response.json());
    if (!result.success) reject('Google returned an unreadable transfer secret version inventory.');
    if (result.data.versions?.length || result.data.totalSize) reject('The transfer credential secret already has a version. Only an empty container can be prepared.');
    const token = result.data.nextPageToken;
    if (!token) return;
    if (seen.has(token)) reject('Google repeated a page in the transfer secret version inventory.');
    seen.add(token);
    url.searchParams.set('pageToken', token);
  }
  reject('The transfer secret version inventory exceeded the page limit.');
}

function directAccessor(value: unknown, email: string): boolean {
  // A conditional binding, any other principal or role, and duplicate bindings
  // all require separate review. Omitted bindings are the ProtoJSON empty list.
  const exact = z.strictObject({
    role: z.literal('roles/secretmanager.secretAccessor'), members: z.tuple([z.literal('serviceAccount:' + email)]),
  });
  const result = z.strictObject({
    version: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(), bindings: z.array(exact).max(1).optional(),
    etag: z.string().min(1).optional(), auditConfigs: z.array(z.unknown()).optional(),
  }).safeParse(value);
  if (!result.success) reject('The transfer secret has an unverified or unrelated direct IAM policy.');
  return result.data.bindings?.length === 1;
}

/** Read exact Google identities and directly attached policy. Never read a secret payload. */
export async function readTransferSlotEvidence(token: string, target: TransferSlotTarget): Promise<TransferSlotEvidence> {
  const { projectId, accountEmail, secretId } = target;
  const accountId = accountEmail.split('@')[0]!;
  if (!token.trim() || !projectIdPattern.test(projectId) || !projectIdPattern.test(accountId)
      || accountEmail !== accountId + '@' + projectId + '.iam.gserviceaccount.com' || !/^[A-Za-z0-9_-]{1,255}$/.test(secretId)) {
    reject('The transfer credential target must specify one Google project, service account and global secret.');
  }
  const signal = AbortSignal.timeout(60_000);
  const read = (url: string | URL) => fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal, redirect: 'error' });
  try {
    const projectResponse = await read('https://cloudresourcemanager.googleapis.com/v3/projects/' + projectId + '?fields=name,projectId,state');
    if (!projectResponse.ok) reject('Google could not verify the transfer project.');
    const identity = projectSchema.safeParse(await projectResponse.json());
    if (!identity.success || identity.data.projectId !== projectId) reject('Google did not return the selected active transfer project.');
    const project = identity.data.name;
    const projectNumber = project.slice('projects/'.length);
    const client = new GcpBootstrapClient({ accessToken: token, fetch: (url, init) => fetch(url, { ...init, signal, redirect: 'error' }),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    const identityAccount = await client.getServiceAccount(projectId, accountId);
    if (identityAccount?.disabled) reject('The transfer service account is disabled.');
    const account = identityAccount && {
      name: identityAccount.name, email: identityAccount.email, uniqueId: identityAccount.uniqueId,
      ...(identityAccount.displayName ? { displayName: identityAccount.displayName } : {}),
      ...(identityAccount.description ? { description: identityAccount.description } : {}),
    };
    const name = project + '/secrets/' + secretId;
    const base = 'https://secretmanager.googleapis.com/v1/' + name;
    const secretResponse = await read(base + '?fields=name,createTime,labels');
    if (secretResponse.status === 404) return { projectNumber, account, secret: null, directAccessor: false };
    if (!secretResponse.ok) reject('Google could not verify the transfer credential secret.');
    const metadata = secretSchema.safeParse(await secretResponse.json());
    if (!metadata.success || ![name, 'projects/' + projectId + '/secrets/' + secretId].includes(metadata.data.name)) {
      reject('Google did not return the exact transfer credential secret and its creation time.');
    }
    await verifyEmptyVersions(base, read);
    const policy = await read(base + ':getIamPolicy?options.requestedPolicyVersion=3');
    if (!policy.ok) reject('Google could not verify the direct transfer secret IAM policy.');
    const granted = directAccessor(await policy.json(), accountEmail);
    if (!account && granted) reject('The transfer secret role references an account that Google could not find.');
    const labels = Object.fromEntries(Object.keys(metadata.data.labels).sort().map(key => [key, metadata.data.labels[key]!]));
    return { projectNumber, account, secret: { name, createTime: metadata.data.createTime, labels }, directAccessor: granted };
  } catch (error) {
    if (error instanceof TransferEvidenceError) throw error;
    throw new Error('Google could not verify the transfer service account or secret metadata.');
  }
}
