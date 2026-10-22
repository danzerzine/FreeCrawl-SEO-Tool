import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'fc-oauth-'));
});
const reply = vi.hoisted(() => ({ next: null as (() => Promise<Response>) | null }));

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
}));
vi.mock('./api-fetch.js', () => ({ apiFetch: () => reply.next!() }));
vi.mock('./credentials.js', () => ({
  resolveCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }),
}));

const { getAccessToken } = await import('./google-oauth.js');
const { GoogleTokenError } = await import('./google-retry.js');

const record = { refreshToken: 'r', email: 'a@b.test', connectedAt: '2026-01-01T00:00:00Z', accountId: 'acc1' };
const json = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('getAccessToken typed errors (R2-2)', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(dir, 'google-tokens.enc.json'),
      JSON.stringify({
        'gsc#acc1': 'pt:' + Buffer.from(JSON.stringify(record)).toString('base64'),
      }),
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an unconnected integration is not_connected', async () => {
    const err = await getAccessToken('ga4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleTokenError);
    expect((err as InstanceType<typeof GoogleTokenError>).kind).toBe('not_connected');
  });

  it('invalid_grant is a dead grant that carries its own advice', async () => {
    reply.next = () => json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const err = (await getAccessToken('gsc', 'acc1', true).catch((e: unknown) => e)) as InstanceType<
      typeof GoogleTokenError
    >;
    expect(err).toBeInstanceOf(GoogleTokenError);
    expect(err.kind).toBe('dead_grant');
    expect(err.hasAdvice).toBe(true);
  });

  it('a 503 or 429 from the token endpoint is an endpoint failure', async () => {
    for (const status of [503, 429]) {
      reply.next = () => json(status, {});
      const err = (await getAccessToken('gsc', 'acc1', true).catch((e: unknown) => e)) as InstanceType<
        typeof GoogleTokenError
      >;
      expect(err).toBeInstanceOf(GoogleTokenError);
      expect(err.kind).toBe('endpoint');
    }
  });

  it('a 200 with an unreadable body is an endpoint failure', async () => {
    reply.next = () => Promise.resolve(new Response('not json', { status: 200 }));
    const err = (await getAccessToken('gsc', 'acc1', true).catch((e: unknown) => e)) as InstanceType<
      typeof GoogleTokenError
    >;
    expect(err.kind).toBe('endpoint');
  });

  it('a 400 invalid_client is a dead sign-in, not a retryable failure', async () => {
    reply.next = () => json(401, { error: 'invalid_client' });
    const err = (await getAccessToken('gsc', 'acc1', true).catch((e: unknown) => e)) as InstanceType<
      typeof GoogleTokenError
    >;
    expect(err.kind).toBe('dead_grant');
  });
});
