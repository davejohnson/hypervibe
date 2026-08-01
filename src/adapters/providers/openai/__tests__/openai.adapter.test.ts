import { afterEach, describe, expect, it, vi } from 'vitest';
import { HYPERVIBE_CODE_MODEL, OpenAIAdapter } from '../openai.adapter.js';

afterEach(() => vi.restoreAllMocks());

describe('OpenAIAdapter', () => {
  it('verifies model visibility without exposing the API key', async () => {
    const adapter = new OpenAIAdapter();
    adapter.connect({ apiKey: 'secret-key' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id: HYPERVIBE_CODE_MODEL }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    const result = await adapter.verify();
    expect(result).toMatchObject({ success: true, model: HYPERVIBE_CODE_MODEL });
    expect(JSON.stringify(result)).not.toContain('secret-key');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.openai.com/v1/models/${HYPERVIBE_CODE_MODEL}`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('uses strict non-persistent structured output for environment configuration advice', async () => {
    const adapter = new OpenAIAdapter();
    adapter.connect({ apiKey: 'secret-api-key' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      model: HYPERVIBE_CODE_MODEL,
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            summary: 'One unexplained gap.',
            decisions: [{
              candidateId: 'gap-0001',
              classification: 'shared_required',
              severity: 'warning',
              confidence: 'medium',
              valueSensitivity: 'public_identifier',
              rationale: 'Both release environments use the same application feature.',
              recommendedAction: 'set_environment_value',
            }],
          }),
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await adapter.analyzeEnvironmentConfiguration({
      comparisonEnvironments: ['staging', 'production'],
      environmentFeatures: {
        staging: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
        production: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
      },
      candidates: [{
        id: 'gap-0001',
        service: 'web',
        key: 'RECAPTCHA_SITE_KEY',
        presentIn: ['production'],
        missingFrom: ['staging'],
        declarations: { staging: 'unmanaged', production: 'unmanaged' },
      }],
    });

    expect(result.advice.decisions[0]?.candidateId).toBe('gap-0001');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: HYPERVIBE_CODE_MODEL,
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body.input).toContain('RECAPTCHA_SITE_KEY');
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
    expect(JSON.stringify(result)).not.toContain('secret-api-key');
  });

  it('rejects extra request fields before they can cross the model boundary', async () => {
    const adapter = new OpenAIAdapter();
    adapter.connect({ apiKey: 'secret-api-key' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const request = {
      comparisonEnvironments: ['staging', 'production'],
      environmentFeatures: {
        staging: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
        production: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
      },
      candidates: [{
        id: 'gap-0001', service: 'web', key: 'API_SECRET', presentIn: ['production'], missingFrom: ['staging'],
        declarations: { staging: 'unmanaged', production: 'unmanaged' },
        value: 'must-never-leave-process',
      }],
    };

    await expect(adapter.analyzeEnvironmentConfiguration(request as never)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on incomplete or invalid structured output', async () => {
    const adapter = new OpenAIAdapter();
    adapter.connect({ apiKey: 'secret-api-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(adapter.analyzeEnvironmentConfiguration({
      comparisonEnvironments: ['staging', 'production'],
      environmentFeatures: {
        staging: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
        production: { provider: 'railway', database: false, cache: false, storage: false, queues: false, payments: false, email: false },
      },
      candidates: [{
        id: 'gap-0001', service: 'web', key: 'API_SECRET', presentIn: ['production'], missingFrom: ['staging'],
        declarations: { staging: 'unmanaged', production: 'unmanaged' },
      }],
    })).rejects.toThrow('did not complete');
  });
});
