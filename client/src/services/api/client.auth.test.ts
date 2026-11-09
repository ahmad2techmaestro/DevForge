import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureClient, request } from './client';
import { useAuth } from '../../store/auth';

afterEach(() => vi.unstubAllGlobals());

describe('first request after a reload', () => {
  it('sends the saved token as soon as the client is configured with the store getter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useAuth.setState({ token: 'saved-token' });
    configureClient({ getToken: () => useAuth.getState().token, onUnauthorized: () => undefined });
    await request('GET', '/api/me');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer saved-token' });
  });
});
