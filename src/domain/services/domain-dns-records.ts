export interface ProviderDnsRecord {
  name?: unknown;
  host?: unknown;
  fqdn?: unknown;
  type?: unknown;
  recordType?: unknown;
  value?: unknown;
  data?: unknown;
  requiredValue?: unknown;
  content?: unknown;
  currentValue?: unknown;
  purpose?: unknown;
  status?: unknown;
}

export interface NormalizedDnsRecord {
  name: string;
  type: string;
  value: string;
  currentValue?: string;
  purpose?: string;
  status?: string;
}

const DNS_TYPES = new Set([
  'A',
  'AAAA',
  'CAA',
  'CERT',
  'CNAME',
  'DNSKEY',
  'DS',
  'HTTPS',
  'LOC',
  'MX',
  'NAPTR',
  'NS',
  'SMIMEA',
  'SRV',
  'SSHFP',
  'SVCB',
  'TLSA',
  'TXT',
  'URI',
]);

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeDnsRecordType(value: unknown): string | null {
  const raw = stringField(value);
  if (!raw) return null;

  let type = raw.toUpperCase();
  for (const prefix of ['DNS_RECORD_TYPE_', 'DNS_RECORD_', 'RECORD_TYPE_', 'DNS_TYPE_']) {
    if (type.startsWith(prefix)) {
      type = type.slice(prefix.length);
      break;
    }
  }

  if (!DNS_TYPES.has(type) && type.includes('_')) {
    const last = type.split('_').at(-1);
    if (last && DNS_TYPES.has(last)) {
      type = last;
    }
  }

  return DNS_TYPES.has(type) ? type : null;
}

function normalizeName(name: string): string {
  return name.replace(/\.$/, '').toLowerCase();
}

function normalizeValue(type: string, value: string): string {
  const trimmed = value.trim();
  if (type === 'CNAME') {
    return trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/\.$/, '')
      .toLowerCase();
  }
  return trimmed;
}

export function normalizeProviderDnsRecord(record: ProviderDnsRecord): NormalizedDnsRecord | null {
  const name = stringField(record.name) ?? stringField(record.host) ?? stringField(record.fqdn);
  const type = normalizeDnsRecordType(record.type ?? record.recordType);
  const value = stringField(record.value ?? record.data ?? record.requiredValue ?? record.content);

  if (!name || !type || !value) {
    return null;
  }

  const currentValue = stringField(record.currentValue);
  const purpose = stringField(record.purpose);
  const status = stringField(record.status);
  return {
    name: normalizeName(name),
    type,
    value: normalizeValue(type, value),
    ...(currentValue ? { currentValue: normalizeValue(type, currentValue) } : {}),
    ...(purpose ? { purpose } : {}),
    ...(status ? { status } : {}),
  };
}

function statusImpliesConfigured(status?: string): boolean | undefined {
  if (!status) return undefined;
  const normalized = status.toUpperCase();
  if (/(INVALID|PENDING|WAITING|MISSING|FAILED|FAILURE|ERROR|UNVERIFIED)/.test(normalized)) {
    return false;
  }
  if (/(VALID|VERIFIED|ACTIVE|SUCCESS|SUCCEEDED|CONFIGURED)/.test(normalized)) {
    return true;
  }
  return undefined;
}

export function providerDnsRecordIsConfigured(record: ProviderDnsRecord): boolean {
  const normalized = normalizeProviderDnsRecord(record);
  if (!normalized) return false;

  const statusConfigured = statusImpliesConfigured(normalized.status);
  if (statusConfigured !== undefined) {
    return statusConfigured;
  }

  return Boolean(normalized.currentValue && normalized.currentValue === normalized.value);
}

export function providerDnsRecordsAreConfigured(records: ProviderDnsRecord[]): boolean | undefined {
  const normalized = records.map(normalizeProviderDnsRecord).filter((record): record is NormalizedDnsRecord => Boolean(record));
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.every(providerDnsRecordIsConfigured);
}
