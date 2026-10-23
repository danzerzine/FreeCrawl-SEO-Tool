import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, shell: {} }));
const creds = vi.hoisted(() => ({ map: {} as Record<string, Record<string, string>> }));
vi.mock('./credentials.js', () => ({ resolveCredentials: (id: string) => creds.map[id] ?? {} }));
const guard = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname !== '127.0.0.1') return Promise.reject(new Error('guard: blocked host'));
    return realFetch(input as string, init);
  }) as typeof fetch;
});
vi.mock('./api-fetch.js', () => ({ apiFetch: guard }));
vi.stubGlobal('fetch', guard);

const { runAiBatch, storeAiResult } = await import('./ai-batch.js');

const URLS = ['https://ex.test/a', 'https://ex.test/b', 'https://ex.test/c'];
let server: http.Server;
let port = 0;
let dir: string;
let db: ProjectDb;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const prompt = (JSON.parse(Buffer.concat(chunks).toString()) as { messages: { content: string }[] })
        .messages[0]!.content;
      if (prompt.includes('/b')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"boom"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `ok ${prompt}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
beforeEach(() => {
  creds.map['openai-compatible'] = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b86s-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
    (1,'${URLS[0]}',0,'html',200),(2,'${URLS[1]}',0,'html',200),(3,'${URLS[2]}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B86 batch persistence for a new provider', () => {
  it('3 URLs, one 500: two ok rows and one error row, all provider openai-compatible; queryAi joins them', async () => {
    const result = await runAiBatch({
      provider: 'openai-compatible',
      model: 'm',
      concurrency: 2,
      items: URLS.map((url) => ({ url, prompt: url })),
      isCancelled: () => false,
      onResult: (o) => storeAiResult(db, 'openai-compatible', 'm', o, '2026-10-23T10:00:00Z'),
      onProgress: () => {},
    });
    expect(result).toEqual({ completed: 2, failed: 1, cancelled: false });
    const { rows, total } = db.queryAi({ limit: 10, offset: 0, provider: 'openai-compatible' });
    expect(total).toBe(3);
    const byUrl = Object.fromEntries(rows.map((r) => [r.url, r.ai]));
    expect(byUrl[URLS[0]!]).toMatchObject({ provider: 'openai-compatible', status: 'ok', response: `ok ${URLS[0]}`, tokensIn: 5, tokensOut: 1 });
    expect(byUrl[URLS[1]!]).toMatchObject({ provider: 'openai-compatible', status: 'error', response: '', error: 'boom' });
    expect(byUrl[URLS[2]!]).toMatchObject({ status: 'ok' });
    // another provider sees none of them
    expect(db.queryAi({ limit: 10, offset: 0, provider: 'gemini', filter: 'with-data' }).total).toBe(0);
  });

  it('an empty model reply is stored as an error row, not as ok', async () => {
    storeAiResult(db, 'gemini', 'g', { url: URLS[0]!, ok: false, output: null, error: 'The model returned an empty reply' }, 't');
    const row = db.queryAi({ limit: 5, offset: 0, provider: 'gemini' }).rows.find((r) => r.url === URLS[0])!;
    expect(row.ai).toMatchObject({ provider: 'gemini', status: 'error', model: 'g' });
  });

  it('a gemini row round-trips and project reset clears it', () => {
    storeAiResult(db, 'gemini', 'gemini-2.5-flash', { url: URLS[0]!, ok: true, output: { text: 'x', tokensIn: null, tokensOut: null, model: 'gemini-2.5-flash' }, error: null }, 't');
    expect(db.queryAi({ limit: 5, offset: 0, provider: 'gemini', filter: 'with-data' }).total).toBe(1);
    db.reset();
    expect(db.queryAi({ limit: 5, offset: 0, provider: 'gemini', filter: 'with-data' }).total).toBe(0);
  });
});
