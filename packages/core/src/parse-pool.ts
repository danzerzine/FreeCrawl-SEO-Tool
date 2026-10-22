import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parseHtml } from './html-parser.js';

/**
 * Round-robin pool of parser worker threads, shared by the desktop app and
 * the CLI. Each build hands it the path of its own worker file: the CLI
 * and other tsc builds use {@link PARSE_WORKER_PATH}, the desktop its
 * bundled entry.
 *
 * Why a pool, not a single worker:
 *   - Cheerio is single-threaded inside the worker. One worker can
 *     parse one document at a time.
 *   - The crawler runs at concurrency 20 by default, so up to 20
 *     pages return their HTML body simultaneously. With one worker
 *     they would serialise behind it, defeating the point.
 *
 * Dispatch is least-busy with a round-robin tie-break. Blind round-robin
 * was not sufficient in practice: it hands out work without looking at
 * what a worker is already carrying, so with concurrency 20 against as
 * few as 2 workers (a 4-core machine) several slow pages stack on the
 * same thread and push each other past the parse timeout — and a worker
 * that has already blown the timeout kept receiving more work.
 *
 * A timed-out worker is recycled rather than reused: the parse is a
 * synchronous cheerio call inside the worker that cannot be cancelled,
 * so the only way to stop it burning a core is to terminate the thread
 * and spawn a replacement.
 *
 * The pool counts as ready only once a worker has said so: a worker file
 * that fails to load would otherwise look like a running pool while every
 * parse quietly fell back to the main thread.
 */

/** The worker file next to this module in a tsc build (`dist/parse-worker.js`). */
export const PARSE_WORKER_PATH = fileURLToPath(new URL('./parse-worker.js', import.meta.url));

const REQUEST_TIMEOUT_MS = 60_000;

export type ParsePoolLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Thrown when a parse exceeds REQUEST_TIMEOUT_MS. Distinguished from a
 *  crash/not-ready failure because the caller must NOT retry it inline on
 *  the main thread — a document heavy enough to wedge a worker will freeze
 *  the whole process there. */
export class ParserTimeoutError extends Error {
  constructor(ms: number) {
    super(`parser-pool: timeout > ${ms}ms`);
    this.name = 'ParserTimeoutError';
  }
}

type ParseHtmlArgs = Parameters<typeof parseHtml>;
type ParseOpts = ParseHtmlArgs[2];
type ParseResult = ReturnType<typeof parseHtml>;

/** The Crawler's `parseHtml` option: a parse that may run off the main thread. */
export type ParseHtmlFn = (html: string, pageUrl: string, opts: ParseOpts) => Promise<ParseResult>;

interface PendingRequest {
  /** Which worker is carrying this request — needed to release its load
   *  counter and to fail everything queued on a wedged thread. */
  worker: Worker;
  resolve: (v: ParseResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResponseMessage {
  requestId?: number;
  ready?: boolean;
  ok?: boolean;
  result?: ParseResult;
  error?: string;
}

export class ParserPool {
  private workers: Worker[] = [];
  /** Workers that have sent their start-up `ready`. */
  private started = new Set<Worker>();
  private pending = new Map<number, PendingRequest>();
  /** In-flight parse count per worker, for least-busy dispatch. */
  private inFlight = new Map<Worker, number>();
  private nextRequestId = 1;
  private nextWorkerIdx = 0;
  private terminated = false;
  private readyWaiters: ((ready: boolean) => void)[] = [];
  /** Documents parsed on a worker so far. */
  parsed = 0;

  constructor(
    private readonly workerPath: string,
    private readonly log: ParsePoolLog = () => undefined,
  ) {}

  /**
   * Spawn the worker pool. Idempotent — calling init() twice is a
   * no-op once workers are already running.
   *
   *   `size` — number of worker threads. Defaults to a sensible
   *   value based on CPU count (cores - 2, clamped to [2, 8]).
   *   Leave room for the main thread + db-reader + db-writer +
   *   freeze-watchdog so the crawler isn't competing with its own
   *   plumbing for cores.
   */
  init(size?: number): void {
    if (this.terminated) {
      throw new Error('ParserPool: cannot init after terminate()');
    }
    if (this.workers.length > 0) return;
    const cpuCount = os.cpus().length;
    const target = size ?? Math.max(2, Math.min(8, cpuCount - 2));
    for (let i = 0; i < target; i++) {
      try {
        this.workers.push(this.spawnWorker());
      } catch (err) {
        this.log(
          'warn',
          `parser-pool: worker ${i} spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.workers.length === 0) {
      this.log('warn', 'parser-pool: no workers spawned — falling back to inline parseHtml.');
      this.settleReadyWaiters();
    } else {
      this.log('info', `parser-pool: spawned ${this.workers.length} parser worker(s)`);
    }
  }

  /** True when at least one worker has started and accepts requests. */
  isReady(): boolean {
    return this.started.size > 0 && !this.terminated;
  }

  /** Resolves true once a worker has started, false if none can. */
  whenReady(): Promise<boolean> {
    if (this.isReady()) return Promise.resolve(true);
    if (this.terminated || this.workers.length === 0) return Promise.resolve(false);
    return new Promise((r) => this.readyWaiters.push(r));
  }

  /**
   * Main-content prose of an HTML document (boilerplate stripped), run on a
   * worker so corpus-wide text jobs never block the main thread.
   */
  prose(html: string, contentAreaSelector?: string): Promise<string> {
    return this.dispatch(
      html,
      '',
      { contentAreaSelector },
      'prose',
    ) as Promise<unknown> as Promise<string>;
  }

  /**
   * Dispatch a parse request to the least-busy started worker. Rejects on
   * timeout or worker crash; the caller falls back to inline `parseHtml`
   * when the pool isn't ready (see {@link poolParseHtml}).
   */
  parse(html: string, pageUrl: string, opts: ParseOpts = {}): Promise<ParseResult> {
    return this.dispatch(html, pageUrl, opts, 'parse');
  }

  private dispatch(
    html: string,
    pageUrl: string,
    opts: ParseOpts,
    mode: 'parse' | 'prose',
  ): Promise<ParseResult> {
    if (!this.isReady()) {
      return Promise.reject(new Error('parser-pool: not ready'));
    }
    const requestId = this.nextRequestId++;
    const worker = this.pickWorker();
    this.inFlight.set(worker, (this.inFlight.get(worker) ?? 0) + 1);
    return new Promise<ParseResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.releaseWorker(worker);
        reject(new ParserTimeoutError(REQUEST_TIMEOUT_MS));
        // Recycle AFTER rejecting this caller: the worker is stuck inside a
        // synchronous parse that can't be interrupted, so leaving it in the
        // pool means it keeps a core pinned and keeps being handed work.
        this.recycleWedged(worker);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { worker, resolve, reject, timer });
      worker.postMessage({ requestId, html, pageUrl, opts, mode });
    });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('parser-pool: terminated'));
    }
    this.pending.clear();
    this.inFlight.clear();
    this.started.clear();
    this.settleReadyWaiters();
    const workers = this.workers;
    this.workers = [];
    await Promise.allSettled(workers.map((w) => w.terminate()));
  }

  // ── private ──────────────────────────────────────────────────────

  /** Least in-flight requests among started workers wins; ties rotate so
   *  equally-idle workers don't all receive the next batch on one thread. */
  private pickWorker(): Worker {
    const ready = this.workers.filter((w) => this.started.has(w));
    const n = ready.length;
    let best = ready[this.nextWorkerIdx % n]!;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const w = ready[(this.nextWorkerIdx + i) % n]!;
      const load = this.inFlight.get(w) ?? 0;
      if (load < bestLoad) {
        best = w;
        bestLoad = load;
      }
    }
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % n;
    return best;
  }

  private releaseWorker(w: Worker): void {
    const cur = this.inFlight.get(w) ?? 0;
    if (cur <= 1) this.inFlight.delete(w);
    else this.inFlight.set(w, cur - 1);
  }

  private settleReadyWaiters(): void {
    const ready = this.isReady();
    if (!ready && !this.terminated && this.workers.length > 0) return;
    for (const r of this.readyWaiters.splice(0)) r(ready);
  }

  /** Drop a worker that blew the parse timeout and put a fresh one in its
   *  place. Anything else queued behind it is failed rather than left to
   *  hang, since the thread is about to be terminated mid-parse. */
  private recycleWedged(w: Worker): void {
    const slot = this.workers.indexOf(w);
    if (slot < 0) return; // already recycled or removed
    // Remove it first so its own 'exit' handler treats it as replaced and
    // doesn't respawn a second time.
    this.workers.splice(slot, 1);
    this.started.delete(w);
    this.inFlight.delete(w);
    for (const [id, p] of this.pending) {
      if (p.worker !== w) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new ParserTimeoutError(REQUEST_TIMEOUT_MS));
    }
    this.log(
      'warn',
      `parser-worker exceeded ${REQUEST_TIMEOUT_MS}ms on a single document — terminating and respawning it.`,
    );
    void w.terminate().catch(() => undefined);
    const fresh = this.tryRespawn();
    if (fresh) this.workers.push(fresh);
  }

  private spawnWorker(): Worker {
    const w = new Worker(this.workerPath);
    w.on('message', (msg: ResponseMessage) => {
      if (msg?.ready) {
        this.started.add(w);
        this.settleReadyWaiters();
        return;
      }
      this.handleResponse(msg);
    });
    w.on('error', (err) => {
      this.log('error', `parser-worker error: ${err.message}`);
    });
    w.on('exit', (code) => {
      if (this.terminated) return;
      // Resolve this worker's CURRENT slot by identity — never trust a
      // captured index. An init-time spawn failure leaves the array
      // shorter than the logical worker count, so a captured index
      // would point at the wrong slot (or past the end).
      const slot = this.workers.indexOf(w);
      if (slot < 0) return; // already replaced / removed
      const hadStarted = this.started.delete(w);
      this.inFlight.delete(w);
      // Fail this worker's in-flight parses now instead of letting each one
      // sit out the full 60 s timeout for an answer that can never arrive.
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`parser-worker exited (code=${code})`));
      }
      // A clean exit, or a worker that never started (its file did not
      // load, so a replacement would fail the same way): drop the slot.
      if (code === 0 || !hadStarted) {
        this.workers.splice(slot, 1);
        if (!hadStarted) {
          this.log('error', `parser-worker failed to start (code=${code}): ${this.workerPath}`);
        }
        this.settleReadyWaiters();
        return;
      }
      this.log('warn', `parser-worker exited (code=${code}) — respawning`);
      const respawn = this.tryRespawn();
      if (respawn) {
        this.workers[slot] = respawn;
      } else {
        // Respawn failed — remove the dead worker so it is never picked.
        this.workers.splice(slot, 1);
      }
    });
    return w;
  }

  private tryRespawn(): Worker | null {
    if (this.terminated) return null;
    try {
      return this.spawnWorker();
    } catch (err) {
      this.log(
        'error',
        `parser-worker respawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private handleResponse(msg: ResponseMessage): void {
    if (typeof msg?.requestId !== 'number') return;
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);
    this.releaseWorker(pending.worker);
    if (msg.ok && msg.result !== undefined) {
      this.parsed++;
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error ?? 'parser-pool: unknown error'));
    }
  }
}

/**
 * A `parseHtml` for the Crawler's options that dispatches to `pool` when it
 * is ready and parses inline otherwise.
 */
export function poolParseHtml(pool: ParserPool, log: ParsePoolLog = () => undefined): ParseHtmlFn {
  return async (html, pageUrl, opts) => {
    if (!pool.isReady()) return parseHtml(html, pageUrl, opts);
    try {
      return await pool.parse(html, pageUrl, opts);
    } catch (err) {
      if (err instanceof ParserTimeoutError) {
        // Do NOT re-parse inline. This document already pinned a worker
        // thread for a full minute; running the same synchronous cheerio
        // pass on the main thread would freeze the whole process — crawler
        // scheduling included — for at least as long. Reject instead: the
        // crawler records the URL as failed with this reason, the rest of
        // the crawl proceeds, and the pool has already recycled the worker.
        log(
          'warn',
          `parser-pool timed out on ${pageUrl} — recording it as failed rather than blocking the main thread.`,
        );
        throw err;
      }
      // The worker crashed — the document itself is not implicated, so
      // parsing it inline is safe and keeps the crawl whole.
      log(
        'warn',
        `parser-pool dispatch failed (${
          err instanceof Error ? err.message : String(err)
        }) — using inline parseHtml as fallback.`,
      );
      return parseHtml(html, pageUrl, opts);
    }
  };
}
