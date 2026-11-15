/** DNS ownership is independent of the application's hosting provider. */
export type DnsProvider = 'cloudflare' | 'gcp' | 'aws' | 'azure';
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'CAA' | 'MX';

/** Exact provider-native zone identity. Names alone never establish ownership. */
export interface DnsZoneIdentity {
  provider: DnsProvider;
  zoneId: string;
  zoneName: string;
  scope: {
    accountId?: string;
    projectId?: string;
    subscriptionId?: string;
    resourceGroup?: string;
  };
}

export interface DnsObservedRecord {
  /** Canonical, provider-importable identity including the zone scope. */
  nativeId: string;
  name: string;
  type: DnsRecordType;
  /** TXT is unquoted content; CAA is `flags tag "value"`; MX is `preference exchange.`. */
  values: string[];
  ttl: number;
  proxied?: boolean;
}

export type DnsObservation<T> =
  | { status: 'present'; value: T }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string };

export interface DnsZoneObservation {
  identity: DnsZoneIdentity;
  /** Provider coherence version, not proof of immutable resource lifetime. */
  etag?: string;
  /** Immutable provider identifier when distinct from the configuration address. */
  providerNativeId?: string;
  visibility: 'public' | 'private' | 'unknown';
  dnssec: 'enabled' | 'disabled' | 'unknown';
  nameservers: string[];
}

/**
 * Established by application planning from fresh scoped observations. An
 * authoritative RRset provider must never receive an unobserved create.
 */
export type DnsRecordAuthority =
  | { kind: 'absent' }
  | { kind: 'managed'; nativeId: string; preserveValues: string[] }
  | { kind: 'adopt'; nativeId: string; existingValues: string[]; preserveValues: string[] };

export interface DnsRecordIntent {
  /** Stable logical identifier, independent of value, order and environment. */
  key: string;
  /** Fully qualified owner name, optionally with the final dot. */
  name: string;
  type: DnsRecordType;
  /** TXT is unquoted content; CAA is `flags tag "value"`; MX is `preference exchange.`. */
  values: string[];
  ttl: number;
  proxied?: boolean;
  authority: DnsRecordAuthority;
}

export interface DnsEngineInput {
  zone: DnsZoneIdentity;
  records: DnsRecordIntent[];
  /** Exact managed records being retired; adopted sibling values remain declared. */
  retiredRecords?: DnsRecordIntent[];
}
/**
 * Common DNS types and interface for DNS providers (Cloudflare, Route53, etc.)
 */

export interface DnsZone {
  id: string;
  name: string;
  status: string;
}

export interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
}

export interface IDnsProvider {
  readonly name: string;

  /**
   * Connect with provider credentials
   */
  connect(credentials: unknown): void;

  /**
   * Verify the connection works
   */
  verify(): Promise<{ success: boolean; error?: string }>;

  /**
   * List all DNS zones in the account
   */
  listZones(): Promise<DnsZone[]>;

  /**
   * Find a zone by domain name
   */
  findZoneByName(domain: string): Promise<DnsZone | null>;

  /**
   * List DNS records in a zone, optionally filtered by type
   */
  listRecords(zoneId: string, type?: string): Promise<DnsRecord[]>;

  /**
   * Create a new DNS record
   */
  createRecord(zoneId: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord>;

  /**
   * Update an existing DNS record
   */
  updateRecord(zoneId: string, recordId: string, updates: Partial<DnsRecord>): Promise<DnsRecord>;

  /**
   * Delete a DNS record
   */
  deleteRecord(zoneId: string, recordId: string): Promise<void>;

  /**
   * Create or update a DNS record by name and type
   */
  upsertRecord(
    zoneId: string,
    name: string,
    type: string,
    content: string,
    options?: Partial<DnsRecord>
  ): Promise<{ record: DnsRecord; action: 'created' | 'updated' }>;
}
