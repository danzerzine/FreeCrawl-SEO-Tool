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
  dir = mkdtempSync(path.join(tmpdir(), 'fc-b31-mcp-'));
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

const copies = (d: string) => readdirSync(d).filter((n) => n.startsWith('freecrawl-cli-'));

class Server {
  private readonly p: ChildProcessWithoutNullStreams;
  private buf = '';
  private id = 0;
  private readonly waiting = new Map<number, (v: unknown) => void>();
  readonly exited: Promise<number | null>;

  /** `workDir`: FREECRAWL_WORK_DIR. */
  constructor(workDir: string) {
    this.p = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        TMPDIR: tmp,
        FREECRAWL_PROJECT: path.join(dir, 'none.seoproject'),
        FREECRAWL_WORK_DIR: workDir,
      },
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

}

describe('MCP server with FREECRAWL_WORK_DIR (B31)', () => {
  it('opens a saved project in <folder>/FreeCrawl-work, not the temp folder', async () => {
    const work = path.join(dir, 'big-disk');
    mkdirSync(work);
    const s = new Server(work);
    await s.call('set_project', { path: await saved('a', 3) });
    expect((await s.call('get_summary'))['total']).toBe(3);
    expect(copies(path.join(work, 'FreeCrawl-work'))).toHaveLength(1);
    expect(copies(tmp)).toEqual([]);
    s.closeStdin();
    await s.exited;
    expect(copies(path.join(work, 'FreeCrawl-work'))).toEqual([]);
  }, 30_000);

  it('a folder it cannot use fails the call and says why', async () => {
    const missing = path.join(dir, 'unplugged');
    const s = new Server(missing);
    await expect(s.call('set_project', { path: await saved('a', 1) })).rejects.toThrow(
      `FREECRAWL_WORK_DIR ${missing}: the folder does not exist`,
    );
    s.closeStdin();
    await s.exited;
  }, 30_000);
});
