import { describe, expect, it } from 'vitest';
import { getUserId, listHosts, webmasterQuotaText, type WebmasterDeps } from './webmaster.js';

// B168: the 4-requests-a-second pace holds across the phases of one pull (same deps object).
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const stub = ((url: string) =>
  Promise.resolve(String(url).endsWith('/user') ? json({ user_id: 7 }) : json({ hosts: [] }))) as unknown as NonNullable<WebmasterDeps['fetch']>;

function deps(sleeps: number[]): WebmasterDeps {
  return { fetch: stub, baseUrl: 'http://127.0.0.1:1', sleep: async (ms) => void sleeps.push(ms), now: () => 1000 };
}

describe('Yandex Webmaster request pace', () => {
  it('the second call with the same deps waits the interval left; the first call waits for nothing', async () => {
    const sleeps: number[] = [];
    const d = deps(sleeps);
    await getUserId('t', d);
    expect(sleeps).toEqual([]);
    await listHosts('t', 7, d);
    expect(sleeps).toEqual([250]);
  });

  it('separate pulls (separate deps objects) do not wait for each other', async () => {
    const sleeps: number[] = [];
    await getUserId('t', deps(sleeps));
    await getUserId('t', deps(sleeps));
    expect(sleeps).toEqual([]);
  });
});

describe('quota text (B168)', () => {
  it('one wording for the error and the stored-run refusal', () => {
    expect(webmasterQuotaText('2026-10-26T00:00:00.000Z')).toBe(
      'Yandex Webmaster daily request quota is used up; it opens again at 2026-10-26T00:00:00.000Z.',
    );
    expect(webmasterQuotaText(null)).toBe('Yandex Webmaster daily request quota is used up.');
  });
});
