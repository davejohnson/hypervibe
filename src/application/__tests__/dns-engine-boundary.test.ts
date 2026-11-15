import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloudflare from '../../domain/services/cloudflare-ops.service.js';
import { executeDomainAction, DOMAIN_DNS_OPERATION, DOMAIN_DNS_REMOVE_OPERATION } from '../infrastructure-engine-domain.js';

afterEach(() => vi.restoreAllMocks());

describe('DNS resource ownership boundary', () => {
  it.each([DOMAIN_DNS_OPERATION, DOMAIN_DNS_REMOVE_OPERATION])('refuses obsolete %s actions without an OpenTofu artifact', async operation => {
    // The owner requires resource changes to use a saved OpenTofu plan.
    // Matching native DNS contents are deliberately not resource ownership.
    let records: any[] = operation === DOMAIN_DNS_REMOVE_OPERATION
      ? [{ id: 'existing-record', name: 'app.example.com', type: 'CNAME', content: 'ghs.googlehosted.com', proxied: false }]
      : [];
    const createRecord = vi.fn(async () => { records = [{ id: 'new-record', name: 'app.example.com', type: 'CNAME', content: 'ghs.googlehosted.com', proxied: false }]; return records[0]; });
    const deleteRecord = vi.fn(async () => { records = []; });
    const adapter = { listRecords: vi.fn(async () => records), createRecord, deleteRecord };
    vi.spyOn(cloudflare, 'getCloudflareAdapterFromHints').mockReturnValue({ adapter } as never);
    vi.spyOn(cloudflare, 'findCloudflareZone').mockResolvedValue({ id: 'zone', name: 'example.com' } as never);
    const result = await executeDomainAction({ adapter: {} as never, gcpProjectId: 'fixture-project', region: 'us-central1' }, {
      id: 'dns:app.example.com', type: operation === DOMAIN_DNS_OPERATION ? 'create' : 'destroy',
      resource: { kind: 'domain', name: 'app.example.com', provider: 'cloudflare' },
      verified: true, reason: 'Old custom DNS action', metadata: { operation, domain: 'app.example.com' },
    });
    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(createRecord).not.toHaveBeenCalled();
    expect(deleteRecord).not.toHaveBeenCalled();
  });
});
