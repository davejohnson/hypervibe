import { describe, expect, it, vi } from 'vitest';
import { GcpSecretWriterClient } from '../../src/adapters/providers/gcp/gcp-secret-writer.client.js';
import { DestinationBudget } from '../../src/adapters/providers/secret-destination-http.js';
import { gcpRoleGetContractResponse } from '../../src/test/gcp-iam-role-contract.js';

describe('IAM projects.roles.get serialized request contract', () => {
  it.each([200, 404, 400, 403, 429, 500])('reads the exact role without list-only options; native status %s', async status => {
    const name = 'projects/synthetic-project/roles/synthetic_writer';
    const role = { name, description: 'synthetic-owner', includedPermissions: ['secretmanager.versions.add'], stage: 'GA' };
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const beforeWrite = vi.fn(), budget = new DestinationBudget({ deadlineMs: 1000 });
    const client = new GcpSecretWriterClient({ token: 'synthetic-token', budget, beforeWrite, sleep: async () => {}, request: async (input, init = {}) => {
      const url = new URL(String(input)), method = init.method ?? 'GET';
      requests.push({ url: url.toString(), method, body: init.body });
      return gcpRoleGetContractResponse(url, method, init.body) ?? Response.json(status === 200 ? role : {}, { status });
    } });
    try {
      if (status === 200) expect(await client.role(name)).toEqual(role);
      else if (status === 404) expect(await client.role(name)).toBeNull();
      else await expect(client.role(name)).rejects.toMatchObject({ status });
      expect(requests).toEqual([{ url: `https://iam.googleapis.com/v1/${name}`, method: 'GET', body: undefined }]);
      expect(beforeWrite).not.toHaveBeenCalled();
    } finally { budget.close(); }
  });
});
