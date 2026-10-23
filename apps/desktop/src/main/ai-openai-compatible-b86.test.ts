import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));

// Credentials come from a per-test map instead of the encrypted store.
const creds = vi.hoisted(() => ({ map: {} as Record<string, Record<string, string>> }));
vi.mock('./credentials.js', () => ({
  resolveCredentials: (id: string) => creds.map[id] ?? {},
}));

// Per-file guard: only 127.0.0.1 may be reached (B86 never calls a real AI service).
const guard = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
    return realFetch(input as string, init);
  }) as typeof fetch;
});
vi.mock('./api-fetch.js', () => ({ apiFetch: guard }));
vi.stubGlobal('fetch', guard);

const providers = await import('./ai-providers.js');
const { runPrompt, openAiTarget, __setGeminiBaseUrlForTests } = providers;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

let server: http.Server;
let port = 0;
let seen: Seen[] = [];
let reply: Reply = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers['authorization'],
        body,
      });
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  seen = [];
  reply = { status: 200, body: {} };
  creds.map = {};
  __setGeminiBaseUrlForTests(null);
});

const okReply = (content: string) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

describe('B86 runPrompt: OpenAI-compatible service at its own address', () => {
  it('posts to <baseUrl>/chat/completions with a Bearer key and reads text + usage', async () => {
    creds.map['openai-compatible'] = {
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      apiKey: 'k',
      model: 'local-model',
    };
    reply = { status: 200, body: okReply('hi') };
    const out = await runPrompt('openai-compatible', 'local-model', 'say hi');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer k');
    expect(seen[0]!.body['model']).toBe('local-model');
    expect(seen[0]!.body['messages']).toEqual([{ role: 'user', content: 'say hi' }]);
    expect(out).toEqual({ text: 'hi', tokensIn: 3, tokensOut: 2, model: 'local-model' });
  });

  it('gemini uses the fixed Google base (swapped only by the test setter) and its own key', async () => {
    creds.map['gemini'] = { apiKey: 'gk', model: 'gemini-2.5-flash' };
    __setGeminiBaseUrlForTests(`http://127.0.0.1:${port}/v1beta/openai/`);
    reply = { status: 200, body: okReply('from gemini') };
    const out = await runPrompt('gemini', 'gemini-2.5-flash', 'p');
    expect(seen[0]!.url).toBe('/v1beta/openai/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer gk');
    expect(out.text).toBe('from gemini');
    // the production target points at Google
    __setGeminiBaseUrlForTests(null);
    expect(openAiTarget('gemini').baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('openai with an empty baseUrl targets api.openai.com; with baseUrl set it targets that address', async () => {
    creds.map['openai'] = { apiKey: 'ok', baseUrl: '' };
    expect(openAiTarget('openai').baseUrl).toBe('https://api.openai.com/v1');
    creds.map['openai'] = { apiKey: 'ok', baseUrl: `http://127.0.0.1:${port}/v1` };
    expect(openAiTarget('openai').baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    reply = { status: 200, body: okReply('via proxy') };
    const out = await runPrompt('openai', 'gpt-4o-mini', 'p');
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(out.text).toBe('via proxy');
  });
});

describe('B86 errors and the key', () => {
  const useCompat = (extra: Record<string, string> = {}) => {
    creds.map['openai-compatible'] = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-secret-123456',
      model: 'm',
      ...extra,
    };
  };

  it('401 gives a readable message that does not contain the key, even when the service echoes it', async () => {
    useCompat();
    reply = { status: 401, body: { error: { message: 'Bad key sk-secret-123456 for this account' } } };
    const err = await runPrompt('openai-compatible', 'm', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(providers.AiRunError);
    expect((err as Error).message).toContain('Bad key');
    expect((err as Error).message).not.toContain('sk-secret-123456');
    // no message body at all: still readable, still without the key
    reply = { status: 401, body: {} };
    const err2 = await runPrompt('openai-compatible', 'm', 'p').catch((e: unknown) => e as Error);
    expect((err2 as Error).message).toMatch(/HTTP 401/);
    expect((err2 as Error).message).not.toContain('sk-secret-123456');
  });

  it('a redirect to another origin is refused and the key is not sent there', async () => {
    useCompat();
    reply = { status: 302, headers: { Location: 'http://127.0.0.2:9/steal' }, body: {} };
    const err = await runPrompt('openai-compatible', 'm', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(providers.AiRunError);
    expect((err as Error).message).toMatch(/redirected to another address/);
    expect((err as Error).message).not.toContain('sk-secret-123456');
    expect(seen).toHaveLength(1);
  });

  it('a body that is not JSON is an AiRunError', async () => {
    useCompat();
    reply = { status: 200, raw: '<html>gateway</html>' };
    const err = await runPrompt('openai-compatible', 'm', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(providers.AiRunError);
    expect((err as Error).message).toMatch(/not JSON/);
  });

  it('an empty model for openai-compatible fails before any request', async () => {
    useCompat({ model: '' });
    expect(providers.resolveModel('openai-compatible')).toBe('');
    const err = await runPrompt('openai-compatible', '', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(providers.AiRunError);
    expect((err as Error).message).toMatch(/No model name/);
    expect(seen).toHaveLength(0);
  });

  it('a missing key is an error for openai and gemini, but not for a custom service', async () => {
    creds.map['gemini'] = { apiKey: '' };
    const err = await runPrompt('gemini', 'gemini-2.5-flash', 'p').catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/No Gemini API key/);
    useCompat({ apiKey: '' });
    reply = { status: 200, body: okReply('keyless') };
    const out = await runPrompt('openai-compatible', 'm', 'p');
    expect(out.text).toBe('keyless');
    expect(seen[0]!.auth).toBeUndefined();
  });

  it('resolveModel reads the model field for gemini and openai-compatible; defaults and concurrency', () => {
    creds.map['gemini'] = { model: ' gemini-2.5-pro ' };
    expect(providers.resolveModel('gemini')).toBe('gemini-2.5-pro');
    creds.map['gemini'] = {};
    expect(providers.resolveModel('gemini')).toBe('gemini-2.5-flash');
    expect(providers.resolveModel('gemini', 'x')).toBe('x');
    expect(providers.defaultConcurrency('gemini')).toBe(4);
    expect(providers.defaultConcurrency('openai-compatible')).toBe(2);
  });
});

describe('B86 openAiTarget base URL rules', () => {
  const compat = (baseUrl: string) => {
    creds.map['openai-compatible'] = { baseUrl, apiKey: 'k', model: 'm' };
    return () => openAiTarget('openai-compatible');
  };

  it.each(['ftp://x/v1', 'https://user:pw@x/v1', 'http://example.com/v1', 'not a url', ''])(
    'rejects %s',
    (u) => {
      expect(compat(u)).toThrow(providers.AiTargetError);
    },
  );

  it.each([
    'http://127.0.0.1:1',
    'http://localhost:1234',
    'http://192.168.1.5/v1',
    'http://10.0.0.2/v1',
    'http://172.20.1.1/v1',
    'http://[::1]:8080/v1',
    'https://openrouter.ai/api/v1/',
  ])('accepts %s', (u) => {
    const t = compat(u)();
    expect(t.baseUrl.endsWith('/')).toBe(false);
    expect(t.keyRequired).toBe(false);
  });

  it('refuses a public http address for the openai proxy field too', () => {
    creds.map['openai'] = { apiKey: 'k', baseUrl: 'http://example.com/v1' };
    expect(() => openAiTarget('openai')).toThrow(providers.AiTargetError);
    creds.map['openai'] = { apiKey: 'k', baseUrl: 'http://172.32.0.1/v1' };
    expect(() => openAiTarget('openai')).toThrow(providers.AiTargetError);
  });
});

describe('B86 empty replies and output limits', () => {
  it('an empty reply with finish_reason length is an error that names the output limit', async () => {
    creds.map['gemini'] = { apiKey: 'gk' };
    __setGeminiBaseUrlForTests(`http://127.0.0.1:${port}/v1beta/openai`);
    reply = { status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } };
    const err = await runPrompt('gemini', 'gemini-2.5-flash', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(providers.AiRunError);
    expect((err as Error).message).toMatch(/empty reply \(output limit reached before any text\)/);
    expect(seen[0]!.body['max_tokens']).toBe(4000);
  });

  it('whitespace-only content is an error too, also for openai (which used to store an ok empty row)', async () => {
    creds.map['openai'] = { apiKey: 'ok', baseUrl: `http://127.0.0.1:${port}/v1` };
    reply = { status: 200, body: { choices: [{ message: { content: '  \n' }, finish_reason: 'stop' }] } };
    const err = await runPrompt('openai', 'gpt-4o-mini', 'p').catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('The model returned an empty reply');
    expect(seen[0]!.body['max_tokens']).toBe(800);
  });

  it('openai-compatible sends max_tokens 1500', async () => {
    creds.map['openai-compatible'] = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' };
    reply = { status: 200, body: okReply('x') };
    await runPrompt('openai-compatible', 'm', 'p');
    expect(seen[0]!.body['max_tokens']).toBe(1500);
  });
});
