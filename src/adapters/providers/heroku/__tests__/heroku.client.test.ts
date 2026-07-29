import { afterEach, describe, expect, it, vi } from 'vitest';
import { HerokuApiError, HerokuClient } from '../heroku.client.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(status === 204 ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
  });
}

describe('HerokuClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows every Next-Range page without turning truncation into absence', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const range = new Headers(init?.headers).get('Range');
      if (range === 'id ..; max=200;') {
        return jsonResponse(
          [{ id: APP_ID, name: 'hv-first' }],
          206,
          { 'Next-Range': 'id next-id..; max=200;' }
        );
      }
      if (range === 'id next-id..; max=200;') {
        return jsonResponse([{
          id: '22222222-2222-4222-8222-222222222222',
          name: 'hv-second',
        }]);
      }
      throw new Error(`unexpected Range header: ${range}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HerokuClient('token').listApps()).resolves.toEqual([
      { id: APP_ID, name: 'hv-first' },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'hv-second',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks a truncated page with no Next-Range header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([], 206))
    );

    await expect(new HerokuClient('token').listApps()).rejects.toThrow(
      /missing or repeated Next-Range/
    );
  });

  it('treats only provider-confirmed 404 as absence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HerokuClient('token');

    await expect(client.getApp(APP_ID)).resolves.toBeNull();
    await expect(client.getApp(APP_ID)).rejects.toEqual(
      expect.objectContaining<Partial<HerokuApiError>>({
        name: 'HerokuApiError',
        status: 403,
      })
    );
  });

  it('never includes provider response bodies in API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({
        message: 'secret-bearing-provider-message',
      }, 500))
    );

    await expect(new HerokuClient('token').getAccount()).rejects.toThrow(
      'Heroku Platform API error: 500'
    );
    await expect(new HerokuClient('token').getAccount()).rejects.not.toThrow(
      /secret-bearing-provider-message/
    );
  });
});
