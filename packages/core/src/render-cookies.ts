import type { Page, Response } from 'playwright';
import {
  buildCookieList,
  mapScriptWrite,
  parseSetCookie,
  type CookieListResult,
  type CookieRecord,
  type ScriptCookieWrite,
} from './cookie-list.js';

/** One frame's `evaluate` may not take longer than this: a frame stuck in a busy loop must not stall the render. */
const FRAME_READ_TIMEOUT_MS = 1500;

export interface CookieCollector {
  /**
   * Detaches the listeners, then returns the list: the `Set-Cookie` lines of this render's responses
   * (plus the redirect chain of `main`) and the script writes of every frame. Never throws.
   */
  collect(main: Response | null | undefined): Promise<CookieListResult>;
  /** Detaches every listener. Safe to call twice and after `collect`. */
  finish(): void;
}

type Req = { redirectedFrom(): Req | null; response(): Promise<RespLike | null> };
type RespLike = {
  url(): string;
  request(): Req;
  headersArray(): Promise<{ name: string; value: string }[]>;
};

/** The records of one response's `Set-Cookie` lines; a response that cannot be read gives []. */
async function headerCookies(resp: RespLike): Promise<CookieRecord[]> {
  const out: CookieRecord[] = [];
  try {
    const url = resp.url();
    for (const h of await resp.headersArray()) {
      if (h.name.toLowerCase() !== 'set-cookie') continue;
      // One entry per line, but a joined value (newline) is split to be safe.
      for (const line of h.value.split('\n')) {
        const rec = parseSetCookie(line, url);
        if (rec) out.push(rec);
      }
    }
  } catch {
    /* the response is gone: it contributes nothing */
  }
  return out;
}

/**
 * Collects what one page render caused (B43), never the browser's cookie jar: the pool's pages share one
 * context and each render wipes the jar in its `finally`, so a jar read is not per page.
 * Header cookies: a `response` listener attached before `goto`, counting only requests that started after it
 * (a reused page may still answer the previous URL). Script cookies: the recorder's per-frame writes.
 */
export function attachCookieCollector(
  page: Pick<Page, 'on' | 'off' | 'frames'>,
  opts: { frameTimeoutMs?: number } = {},
): CookieCollector {
  const started = new WeakSet<object>();
  const reads: Promise<CookieRecord[]>[] = [];
  const onRequest = (r: object): void => {
    started.add(r);
  };
  const onResponse = (resp: RespLike): void => {
    try {
      if (!started.has(resp.request())) return;
      reads.push(headerCookies(resp));
    } catch {
      /* never break the page's events */
    }
  };
  page.on('request', onRequest as never);
  page.on('response', onResponse as never);

  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    page.off('request', onRequest as never);
    page.off('response', onResponse as never);
  };

  const readFrames = async (): Promise<CookieRecord[]> => {
    const out: CookieRecord[] = [];
    const limit = opts.frameTimeoutMs ?? FRAME_READ_TIMEOUT_MS;
    for (const frame of page.frames()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const writes = (await Promise.race([
          frame.evaluate('window.__fcCookieWrites || []'),
          new Promise<never>((_r, reject) => {
            timer = setTimeout(() => reject(new Error('frame read timeout')), limit);
          }),
        ])) as unknown;
        if (!Array.isArray(writes)) continue;
        for (const w of writes) {
          const rec = mapScriptWrite(w as ScriptCookieWrite);
          if (rec) out.push(rec);
        }
      } catch {
        /* a detached or stuck frame is not seen */
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  };

  return {
    finish,
    async collect(main) {
      finish();
      const chain: RespLike[] = [];
      try {
        // The main request's redirect hops, oldest first.
        const hops: Req[] = [];
        for (let r = (main as unknown as RespLike | null | undefined)?.request().redirectedFrom() ?? null; r; r = r.redirectedFrom()) {
          hops.unshift(r);
        }
        for (const hop of hops) {
          const resp = await hop.response();
          if (resp) chain.push(resp);
        }
      } catch {
        /* the chain is best effort */
      }
      const header: CookieRecord[] = [];
      for (const resp of chain) header.push(...(await headerCookies(resp)));
      for (const list of await Promise.all(reads)) header.push(...list);
      let script: CookieRecord[] = [];
      try {
        script = await readFrames();
      } catch {
        script = [];
      }
      return buildCookieList(header, script);
    },
  };
}
