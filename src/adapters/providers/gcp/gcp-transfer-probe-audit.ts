import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TransferEvidenceError } from './gcp-transfer-slot-evidence.js';

const timestamp = z.iso.datetime({ offset: true });
const auditEntry = z.strictObject({ insertId: z.string().min(1).max(256), timestamp, logName: z.string() });
const continuation = z.string().max(4096).optional();
const auditPage = z.strictObject({ entries: z.array(auditEntry).max(2).optional(), nextPageToken: continuation });
const candidate = z.strictObject({ name: z.string(), createTime: timestamp });
const versionsPage = z.strictObject({ versions: z.array(candidate).max(8).optional(), nextPageToken: continuation });

function unverified(): never { throw new TransferEvidenceError('Google could not uniquely link the pending test version to its original creation audit record.'); }

export function probeVersionReason(probeId: string, marker: string) {
  // Letters, digits and spaces are recorded verbatim. Punctuation in a request reason is base64-encoded by Google.
  return 'Hypervibe probe ' + createHash('sha256').update(JSON.stringify(['AddSecretVersion', probeId, marker])).digest('hex');
}

type Read = (url: URL, init: RequestInit) => Promise<unknown>;

/** Recover only from Admin Activity evidence: the secret inventory supplies candidates, never ownership. */
export async function findAuditedProbeVersion(projectId: string, secretName: string, reason: string, since: string, read: Read) {
  if (!timestamp.safeParse(since).success) unverified();
  const project = 'projects/' + projectId;
  const logName = project + '/logs/cloudaudit.googleapis.com%2Factivity';
  const aliasParent = project + '/secrets/' + secretName.split('/').at(-1);
  const parents = [secretName, aliasParent];
  const equal = (field: string, values: string[]) => '(' + values.map(value => field + '=' + JSON.stringify(value)).join(' OR ') + ')';
  const parentFilter = parents.map(name => 'protoPayload.resourceName=~' + JSON.stringify('^' + name + '(/versions/[1-9][0-9]*)?$'));
  const filter = [
    'logName=' + JSON.stringify(logName), 'timestamp>=' + JSON.stringify(since),
    'protoPayload.serviceName="secretmanager.googleapis.com"',
    'protoPayload.methodName="google.cloud.secretmanager.v1.SecretManagerService.AddSecretVersion"',
    'protoPayload.requestMetadata.requestAttributes.reason=' + JSON.stringify(reason),
    '(NOT protoPayload.status.code:* OR protoPayload.status.code=0)', '(' + parentFilter.join(' OR ') + ')',
  ].join(' AND ');
  const url = new URL('https://logging.googleapis.com/v2/entries:list');
  // A partial-response selector cannot traverse a protobuf Any. Keep the audit payload on Google's side.
  url.searchParams.set('fields', 'entries(insertId,timestamp,logName),nextPageToken');
  const signal = AbortSignal.timeout(45_000);
  async function uniqueEntry(extra = '') {
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    let match: z.infer<typeof auditEntry> | undefined;
    for (let page = 0; page < 3; page++) {
      const raw = await read(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Goog-User-Project': projectId },
        body: JSON.stringify({ resourceNames: [project], filter: filter + extra, orderBy: 'timestamp desc', pageSize: 2, pageToken }) });
      const parsed = auditPage.safeParse(raw);
      if (!parsed.success) unverified();
      for (const entry of parsed.data.entries ?? []) {
        if (match || entry.logName !== logName || Date.parse(entry.timestamp) < Date.parse(since)) unverified();
        match = entry;
      }
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return match;
      if (tokens.has(pageToken)) unverified();
      tokens.add(pageToken);
    }
    return unverified();
  }

  const event = await uniqueEntry();
  if (!event) unverified();
  const list = new URL('https://secretmanager.googleapis.com/v1/' + secretName + '/versions');
  list.search = new URLSearchParams({
    fields: 'versions(name,createTime),nextPageToken', filter: 'create_time>=' + since, pageSize: '8',
  }).toString();
  const inventory = versionsPage.safeParse(await read(list, { signal }));
  if (!inventory.success || inventory.data.nextPageToken) unverified();
  let matched: z.infer<typeof candidate> | undefined;
  for (const version of inventory.data.versions ?? []) {
    const prefix = secretName + '/versions/';
    const id = version.name.slice(prefix.length);
    if (!version.name.startsWith(prefix) || !/^[1-9][0-9]{0,19}$/.test(id) || Date.parse(version.createTime) < Date.parse(since)) unverified();
    const names = parents.map(parent => parent + '/versions/' + id);
    const resultName = equal('protoPayload.response.name', names);
    const resourceName = equal('protoPayload.resourceName', names);
    const result = await uniqueEntry(' AND ' + [
      'insertId=' + JSON.stringify(event.insertId), 'timestamp=' + JSON.stringify(event.timestamp),
      '(' + resourceName + ' OR ' + resultName + ')',
      '(' + resourceName + ' OR ' + equal('protoPayload.resourceName', parents) + ')',
      '(NOT protoPayload.response.name:* OR ' + resultName + ')',
      '(NOT protoPayload.response.createTime:* OR protoPayload.response.createTime=' + JSON.stringify(version.createTime) + ')',
    ].join(' AND '));
    if (result) {
      if (matched || result.insertId !== event.insertId || result.timestamp !== event.timestamp) unverified();
      matched = version;
    }
  }
  return matched ?? unverified();
}
