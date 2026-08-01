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
});
