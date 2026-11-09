import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configureClient, request, toApiError } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('toApiError', () => {
  it('reads the structured error body', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'not_found', message: 'Nope' } }), { status: 404 });
    const err = await toApiError(res);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'Nope' });
  });
  it('falls back for non-JSON bodies', async () => {
    const err = await toApiError(new Response('oops', { status: 502, statusText: 'Bad Gateway' }));
    expect(err).toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' });
  });
});

describe('request', () => {
  it('maps network failures and triggers unauthorized handling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ isNetwork: true });

    const onUnauthorized = vi.fn();
    configureClient({ getToken: () => 't', onUnauthorized });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), { status: 401 })));
    await expect(request('GET', '/api/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
