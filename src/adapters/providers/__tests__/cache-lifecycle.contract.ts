import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ICacheAdapter } from '../../../domain/ports/cache.port.js';

type FetchMock = ReturnType<typeof vi.fn>;

export interface MockCacheLifecycleContract {
  displayName: string;
  externalIds: [string, string];
  resourceName: string;
  createAdapter(): Promise<ICacheAdapter>;
  makeEnvironment(): Environment;
  makeComponent(externalId: string): Component;
  isListRequest(url: URL, init?: RequestInit): boolean;
  isItemRequest(url: URL, externalId: string, init?: RequestInit): boolean;
  listResponse(resources: Array<{ id: string; name: string }>): unknown;
  absentResponse?: unknown;
}

function mutationCalls(fetchMock: FetchMock): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return !['GET', 'HEAD'].includes(init?.method ?? 'GET');
  });
}

/** Shared observation and deletion safety floor for cache lifecycle adapters. */
export function runMockCacheLifecycleContract(
  contract: MockCacheLifecycleContract
): void {
  describe(`${contract.displayName} cache lifecycle contract`, () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('does not create when existing-resource observation is unknown', async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (contract.isListRequest(url, init)) {
          return new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = await contract.createAdapter();

      const result = await adapter.provision('redis', contract.makeEnvironment(), {
        resourceName: contract.resourceName,
      });

      expect(result.receipt.success).toBe(false);
      expect(result.receipt.error).toContain('503');
      expect(mutationCalls(fetchMock)).toEqual([]);
    });

    it('blocks ambiguous durable identity instead of choosing a name match', async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (contract.isListRequest(url, init)) {
          return new Response(JSON.stringify(contract.listResponse([
            { id: contract.externalIds[0], name: contract.resourceName },
            { id: contract.externalIds[1], name: contract.resourceName },
          ])), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = await contract.createAdapter();

      const result = await adapter.provision('redis', contract.makeEnvironment(), {
        resourceName: contract.resourceName,
      });

      expect(result.receipt.success).toBe(false);
      expect(result.receipt.error).toContain(contract.externalIds[0]);
      expect(result.receipt.error).toContain(contract.externalIds[1]);
      expect(mutationCalls(fetchMock)).toEqual([]);
    });

    it('treats provider-confirmed preflight absence as idempotent deletion success', async () => {
      const externalId = contract.externalIds[0];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (contract.isItemRequest(url, externalId, init)) {
          return new Response(JSON.stringify(
            contract.absentResponse ?? { message: 'not found' }
          ), {
            status: contract.absentResponse === undefined ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = await contract.createAdapter();

      const receipt = await adapter.destroy(contract.makeComponent(externalId));

      expect(receipt.success).toBe(true);
      expect(receipt.message).toContain('already absent');
      expect(mutationCalls(fetchMock)).toEqual([]);
    });

    it('does not mistake a failed deletion preflight for absence', async () => {
      const externalId = contract.externalIds[0];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (contract.isItemRequest(url, externalId, init)) {
          return new Response(JSON.stringify({ message: 'forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = await contract.createAdapter();

      const receipt = await adapter.destroy(contract.makeComponent(externalId));

      expect(receipt.success).toBe(false);
      expect(receipt.error).toContain('403');
      expect(mutationCalls(fetchMock)).toEqual([]);
    });
  });
}
