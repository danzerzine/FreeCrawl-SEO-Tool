import { describe, expect, it } from 'vitest';
import { googleRequest, type GoogleDeps } from './google-retry.js';

// M10 review round 2 (std Low 2): a token refresh that fails for a network
// reason is retried like any network error; only Google's answer is an auth error.
function deps(refresh: (n: number) => string, authFix?: string) {
  const sleeps: number[] = [];
  let calls = 0;
  let refreshes = 0;
  const d: GoogleDeps = {
    fetch: (async () => {
      calls++;
      return new Response('{}', { status: calls <= 2 ? 401 : 200 });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async (r) => {
      if (!r) return 'old';
      const kind = refresh(++refreshes);
      if (kind === 'network') throw new TypeError('fetch failed');
      if (kind === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (kind === 'grant') throw new Error('invalid_grant: Token has been revoked');
      return 'fresh';
    },
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
    random: () => 0,
    log: () => {},
    authFix,
  };
  return { d, sleeps, calls: () => calls };
}
const req = { op: 'test op', method: 'GET', url: 'https://x.test/a' };

describe('token refresh failures', () => {
  it('a refresh that hits a network failure is retried, not reported as reconnect', async () => {
    const t = deps((n) => (n === 1 ? 'network' : 'ok'));
    const res = await googleRequest(t.d, req);
    expect(res.status).toBe(200);
    expect(t.sleeps.length).toBe(1);
  });

  it('a refresh timeout is a network failure too', async () => {
    const t = deps((n) => (n === 1 ? 'timeout' : 'ok'));
    expect((await googleRequest(t.d, req)).status).toBe(200);
  });

  it('a refresh that Google rejects stays the auth error, without a retry', async () => {
    const t = deps(() => 'grant');
    const err = (await googleRequest(t.d, req).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/reconnect the Google account/i);
    expect(t.sleeps).toEqual([]);
  });

  it('the service-account message tells to check the key', async () => {
    const t = deps(() => 'grant', 'Check the service-account key.');
    const err = (await googleRequest(t.d, req).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/service-account key/);
    expect(err.message).not.toMatch(/reconnect/i);
  });
});
