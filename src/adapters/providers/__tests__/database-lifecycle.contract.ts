import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IDatabaseAdapter } from '../../../domain/ports/database.port.js';

type FetchMock = ReturnType<typeof vi.fn>;

export interface MockDatabaseLifecycleContract {
  displayName: string;
  externalIds: [string, string];
  resourceName: string;
  createAdapter(): Promise<IDatabaseAdapter>;
  makeEnvironment(): Environment;
  makeComponent(externalId: string): Component;
  isListRequest(url: URL, init?: RequestInit): boolean;
  isItemRequest(url: URL, externalId: string, init?: RequestInit): boolean;
  listResponse(projects: Array<{ id: string; name: string }>): unknown;
}

export type DatabaseLifecycleParityScenario =
  | 'observation_unknown'
  | 'identity_conflict'
  | 'already_absent'
  | 'delete_observation_unknown'
  | 'delete_retry';

export interface DatabaseLifecycleParityFixture {
  adapter: IDatabaseAdapter;
  mutations(): unknown[];
  observations(): number;
}

export interface DatabaseLifecycleParityContract {
  displayName: string;
  externalIds: [string, string];
  resourceName: string;
  makeEnvironment(): Environment;
  makeComponent(externalId: string): Component;
  setup(scenario: DatabaseLifecycleParityScenario): Promise<DatabaseLifecycleParityFixture>;
}

function mutationCalls(fetchMock: FetchMock): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return !['GET', 'HEAD'].includes(init?.method ?? 'GET');
  });
}

/**
 * Shared safety floor for every database lifecycle adapter.
 *
 * Provider suites supply only their API shapes and routing. Keeping these
 * assertions provider-neutral makes it difficult for a new adapter to weaken
 * observation or deletion semantics while still claiming lifecycle support.
 */
export function runMockDatabaseLifecycleContract(
  contract: MockDatabaseLifecycleContract
): void {
  describe(`${contract.displayName} database lifecycle contract`, () => {
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

      const result = await adapter.provision('postgres', contract.makeEnvironment(), {
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

      const result = await adapter.provision('postgres', contract.makeEnvironment(), {
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
          return new Response(JSON.stringify({ message: 'not found' }), {
            status: 404,
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

/**
 * Protocol-neutral lifecycle contract for the database providers supported by
 * plan/apply. Fixtures may use HTTP, GraphQL, SDK commands, or a composed
 * hosting adapter; the safety assertions are intentionally identical.
 */
export function runDatabaseProviderParityContract(
  contract: DatabaseLifecycleParityContract
): void {
  describe(`${contract.displayName} database provider parity`, () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('fails closed when pre-create observation is unknown', async () => {
      const fixture = await contract.setup('observation_unknown');

      const result = await fixture.adapter.provision('postgres', contract.makeEnvironment(), {
        resourceName: contract.resourceName,
      });

      expect(result.receipt.success).toBe(false);
      expect(fixture.observations()).toBeGreaterThanOrEqual(1);
      expect(fixture.mutations()).toEqual([]);
    });

    it('blocks an observed provider identity instead of adopting or replacing it', async () => {
      const fixture = await contract.setup('identity_conflict');

      const result = await fixture.adapter.provision('postgres', contract.makeEnvironment(), {
        resourceName: contract.resourceName,
      });

      expect(result.receipt.success).toBe(false);
      expect(`${result.receipt.message} ${result.receipt.error ?? ''}`)
        .toContain(contract.externalIds[0]);
      expect(fixture.observations()).toBeGreaterThanOrEqual(1);
      expect(fixture.mutations()).toEqual([]);
    });

    it('treats provider-confirmed absence as idempotent deletion success', async () => {
      const fixture = await contract.setup('already_absent');

      const receipt = await fixture.adapter.destroy(
        contract.makeComponent(contract.externalIds[0])
      );

      expect(receipt.success).toBe(true);
      expect(receipt.message).toContain('already absent');
      expect(fixture.observations()).toBeGreaterThanOrEqual(1);
      expect(fixture.mutations()).toEqual([]);
    });

    it('does not mutate when deletion preflight is unknown', async () => {
      const fixture = await contract.setup('delete_observation_unknown');

      const receipt = await fixture.adapter.destroy(
        contract.makeComponent(contract.externalIds[0])
      );

      expect(receipt.success).toBe(false);
      expect(fixture.observations()).toBeGreaterThanOrEqual(1);
      expect(fixture.mutations()).toEqual([]);
    });

    it('waits for terminal absence and remains retry-safe', async () => {
      const fixture = await contract.setup('delete_retry');

      const receipt = await fixture.adapter.destroy(
        contract.makeComponent(contract.externalIds[0])
      );

      expect(receipt.success).toBe(true);
      expect(fixture.mutations()).toHaveLength(1);
      expect(fixture.observations()).toBeGreaterThanOrEqual(3);
    });
  });
}
