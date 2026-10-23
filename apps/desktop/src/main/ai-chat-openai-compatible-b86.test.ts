import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@freecrawl/shared-types';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));
const creds = vi.hoisted(() => ({ map: {} as Record<string, Record<string, string>> }));
vi.mock('./credentials.js', () => ({
  resolveCredentials: (id: string) => creds.map[id] ?? {},
}));
// Per-file guard: only 127.0.0.1 may be reached.
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

const { runChatTurn, ChatError } = await import('./ai-chat.js');
const { __setGeminiBaseUrlForTests } = await import('./ai-providers.js');

let server: http.Server;
let port = 0;
let seen: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        auth: req.headers['authorization'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
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
  creds.map = {};
  reply = { status: 200, body: {} };
  __setGeminiBaseUrlForTests(null);
});

const MESSAGES: AssistantMessage[] = [{ role: 'user', content: 'how many 404s?' }];
const TOOLS = [
  { name: 'count_issues', description: 'Count issues', parameters: { type: 'object', properties: {} } },
];
const TOOL_REPLY = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'count_issues', arguments: '{"code":404}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 4 },
};

describe('B86 runChatTurn on OpenAI-style services', () => {
  it('openai-compatible: the tool_calls reply parses exactly like openai', async () => {
    creds.map['openai'] = { apiKey: 'ok', baseUrl: `http://127.0.0.1:${port}/v1` };
    reply = { status: 200, body: TOOL_REPLY };
    const viaOpenAi = await runChatTurn('openai', 'm', 'sys', MESSAGES, TOOLS, new AbortController().signal);

    creds.map['openai-compatible'] = { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1/`, model: 'm' };
    const viaCompat = await runChatTurn('openai-compatible', 'm', 'sys', MESSAGES, TOOLS, new AbortController().signal);

    expect(viaCompat).toEqual(viaOpenAi);
    expect(viaCompat).toEqual({
      text: '',
      toolCalls: [{ id: 'c1', name: 'count_issues', arguments: { code: 404 } }],
      tokensIn: 11,
      tokensOut: 4,
    });
    expect(seen[1]!.url).toBe('/v1/chat/completions');
    expect(seen[1]!.auth).toBe('Bearer k');
    expect(seen[1]!.body['tool_choice']).toBe('auto');
    expect((seen[1]!.body['tools'] as unknown[]).length).toBe(1);
  });

  it('gemini chat goes to the Gemini base with its key', async () => {
    creds.map['gemini'] = { apiKey: 'gk' };
    __setGeminiBaseUrlForTests(`http://127.0.0.1:${port}/v1beta/openai`);
    reply = { status: 200, body: { choices: [{ message: { content: 'ok then' } }] } };
    const out = await runChatTurn('gemini', 'gemini-2.5-flash', 'sys', MESSAGES, [], new AbortController().signal);
    expect(out.text).toBe('ok then');
    expect(seen[0]!.url).toBe('/v1beta/openai/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer gk');
    expect(seen[0]!.body['tools']).toBeUndefined();
  });

  it('an empty text with no tool calls is a ChatError (output limit named when cut)', async () => {
    creds.map['openai-compatible'] = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' };
    reply = { status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } };
    const err = await runChatTurn('openai-compatible', 'm', 's', MESSAGES, [], new AbortController().signal).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ChatError);
    expect((err as Error).message).toMatch(/empty reply \(output limit reached before any text\)/);
  });

  it('401 and bad base URL are ChatErrors without the key', async () => {
    creds.map['openai-compatible'] = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-secret-123456',
      model: 'm',
    };
    reply = { status: 401, body: { error: { message: 'wrong key sk-secret-123456' } } };
    const e1 = await runChatTurn('openai-compatible', 'm', 's', MESSAGES, [], new AbortController().signal).catch(
      (e: unknown) => e as Error,
    );
    expect(e1).toBeInstanceOf(ChatError);
    expect((e1 as Error).message).not.toContain('sk-secret-123456');
    creds.map['openai-compatible'] = { baseUrl: 'http://example.com/v1', apiKey: 'k', model: 'm' };
    const e2 = await runChatTurn('openai-compatible', 'm', 's', MESSAGES, [], new AbortController().signal).catch(
      (e: unknown) => e as Error,
    );
    expect(e2).toBeInstanceOf(ChatError);
    expect(seen).toHaveLength(1);
  });
});
