import { describe, expect, it, vi } from 'vitest';
import { GcpSecretWriterClient, type WriterPolicyKind } from '../../src/adapters/providers/gcp/gcp-secret-writer.client.js';
import { DestinationBudget } from '../../src/adapters/providers/secret-destination-http.js';
import { gcpAccountPolicyGetContractResponse } from '../../src/test/gcp-iam-policy-contract.js';

const policy = { etag: 'synthetic-etag', version: 3, bindings: [{ role: 'roles/viewer', members: ['user:synthetic@example.invalid'],
  condition: { title: 'preserve', expression: 'true' } }] };
describe('serialized Google IAM policy reads', () => {
  it.each([
    ['account', 'iam.googleapis.com/v1', 'projects/synthetic-project/serviceAccounts/123456789012345678901', 'POST', undefined, '?options.requestedPolicyVersion=3'],
    ['project', 'cloudresourcemanager.googleapis.com/v3', 'projects/synthetic-project', 'POST', { options: { requestedPolicyVersion: 3 } }, ''],
    ['secret', 'secretmanager.googleapis.com/v1', 'projects/synthetic-project/secrets/synthetic', 'GET', undefined, '?options.requestedPolicyVersion=3'],
    ['service', 'run.googleapis.com/v2', 'projects/synthetic-project/locations/us-central1/services/synthetic', 'GET', undefined, '?options.requestedPolicyVersion=3'],
    ['registry', 'artifactregistry.googleapis.com/v1', 'projects/synthetic-project/locations/us-central1/repositories/synthetic', 'GET', undefined, '?options.requestedPolicyVersion=3'],
  ] as const)('preserves the distinct %s policy contract and conditional bindings', async (kind, root, resource, method, body, query) => {
    const beforeWrite = vi.fn(), budget = new DestinationBudget({ deadlineMs: 1000 });
    const requests: unknown[] = [];
    const client = new GcpSecretWriterClient({ token: 'synthetic-token', budget, beforeWrite, sleep: async () => {}, request: async (input, init = {}) => {
      const url = new URL(String(input)), actualMethod = init.method ?? 'GET';
      requests.push({ url: url.toString(), method: actualMethod, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return gcpAccountPolicyGetContractResponse(url, actualMethod, init.body) ?? Response.json(policy);
    } });
    try {
      expect(await client.policy(kind as WriterPolicyKind, resource)).toEqual(policy);
      expect(requests).toEqual([{ url: `https://${root}/${resource}:getIamPolicy${query}`, method, body }]);
      expect(beforeWrite).not.toHaveBeenCalled();
    } finally { budget.close(); }
  });

  it('keeps a bootstrap policy read read-only after query serialization', async () => {
    const beforeWrite = vi.fn(), budget = new DestinationBudget({ deadlineMs: 1000 });
    const client = new GcpSecretWriterClient({ token: 'synthetic-token', budget, beforeWrite, sleep: async () => {}, request: async (input, init = {}) => {
      return gcpAccountPolicyGetContractResponse(new URL(String(input)), init.method ?? 'GET', init.body) ?? Response.json(policy);
    } });
    try {
      expect(await client.bootstrap.getServiceAccountIamPolicy('synthetic-project', '123456789012345678901')).toEqual(policy);
      expect(beforeWrite).not.toHaveBeenCalled();
    } finally { budget.close(); }
  });
});
