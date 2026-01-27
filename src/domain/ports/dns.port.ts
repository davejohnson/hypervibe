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
