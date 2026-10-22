import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packProject, ProjectDb } from '@freecrawl/db';

// Drives the built server over stdio (`npm run build:mcp` first).
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let tmp: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b3-mcp-'));
  tmp = path.join(dir, 'tmp');
  mkdirSync(tmp);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A project packed as the desktop app saves it, holding `urls` pages. */
async function saved(name: string, urls: number): Promise<string> {
  const bare = path.join(dir, `${name}.bare`);
  const db = new ProjectDb(bare);
  for (let i = 0; i < urls; i++) {
    (db as unknown as { db: { exec(s: string): void } }).db.exec(
      `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/${i}', 200, 0)`,
    );
  }
  db.walCheckpoint();
  db.close();
  const file = path.join(dir, `${name}.seoproject`);
  await packProject(bare, file);
  rmSync(bare);
  return file;
}

const copies = () => readdirSync(tmp).filter((n) => n.startsWith('freecrawl-cli-'));

class Server {
  private readonly p: ChildProcessWithoutNullStreams;
  private buf = '';
  private id = 0;
  private readonly waiting = new Map<number, (v: unknown) => void>();
  readonly exited: Promise<number | null>;

  /** `project`: the default project, opened by the first tool that needs one. */
  constructor(project = path.join(dir, 'none.seoproject')) {
    this.p = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TMPDIR: tmp, FREECRAWL_PROJECT: project },
    });
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)));
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(this.buf.slice(0, nl)) as { id: number; result?: unknown };
        this.buf = this.buf.slice(nl + 1);
        this.waiting.get(msg.id)?.(msg.result);
      }
    });
  }

  /** A tool call's JSON result; throws on a tool error. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    const result = (await new Promise<unknown>((r) => {
      this.waiting.set(id, r);
      this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  closeStdin(): void {
    this.p.stdin.end();
  }

  kill(signal: NodeJS.Signals): void {
    this.p.kill(signal);
  }
}

describe('MCP server on projects saved by the desktop app (B3)', () => {
  it('reads a saved project; switching removes the first working copy', async () => {
    const a = await saved('a', 3);
    const b = await saved('b', 5);
    const s = new Server();
    await s.call('set_project', { path: a });
    expect((await s.call('get_summary'))['total']).toBe(3);
    expect(copies()).toHaveLength(1);
    const first = copies()[0];
    await s.call('set_project', { path: b });
    expect((await s.call('get_summary'))['total']).toBe(5);
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).not.toBe(first);
    s.closeStdin();
    await s.exited;
    expect(copies()).toEqual([]);
  }, 30_000);

  it('set_project sent while the default project is still opening wins', async () => {
    const big = await saved('big', 40_000);
    const small = await saved('small', 2);
    const s = new Server(big);
    const first = s.call('get_summary');
    await s.call('set_project', { path: small });
    expect((await first)['total']).toBe(40_000);
    expect((await s.call('get_summary'))['total']).toBe(2);
    expect(copies()).toHaveLength(1);
    s.closeStdin();
    await s.exited;
    expect(copies()).toEqual([]);
  }, 60_000);

  it('set_project on the same path reads a newer save of it', async () => {
    const a = await saved('a', 2);
    const s = new Server();
    await s.call('set_project', { path: a });
    expect((await s.call('get_summary'))['total']).toBe(2);
    await saved('a', 7);
    expect((await s.call('get_summary'))['total']).toBe(2);
    await s.call('set_project', { path: a });
    expect((await s.call('get_summary'))['total']).toBe(7);
    s.closeStdin();
    await s.exited;
    expect(copies()).toEqual([]);
  }, 30_000);

  it.each(['SIGINT', 'SIGTERM'] as const)('%s removes the working copy', async (signal) => {
    const a = await saved('a', 1);
    const s = new Server();
    await s.call('set_project', { path: a });
    expect(copies()).toHaveLength(1);
    s.kill(signal);
    await s.exited;
    expect(copies()).toEqual([]);
  }, 30_000);

  it('the default project, opened on first use, is read from a working copy too', async () => {
    const s = new Server(await saved('a', 4));
    expect(copies()).toEqual([]);
    const [one, two] = await Promise.all([s.call('get_summary'), s.call('get_summary')]);
    expect(one['total']).toBe(4);
    expect(two['total']).toBe(4);
    // Two first calls at once share one copy.
    expect(copies()).toHaveLength(1);
    s.closeStdin();
    await s.exited;
    expect(copies()).toEqual([]);
  }, 30_000);

  it('a hard kill leaves a copy the next start removes', async () => {
    const a = await saved('a', 1);
    const s = new Server();
    await s.call('set_project', { path: a });
    s.kill('SIGKILL');
    await s.exited;
    expect(copies()).toHaveLength(1);
    const next = new Server();
    await next.call('set_project', { path: a });
    expect(copies()).toHaveLength(1);
    next.closeStdin();
    await next.exited;
    expect(copies()).toEqual([]);
  }, 30_000);
});
