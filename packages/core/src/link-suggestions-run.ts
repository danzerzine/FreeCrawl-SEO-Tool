import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { LinkSuggestionInput, LinkSuggestionResult } from '@freecrawl/shared-types';
import type { LinkSuggestionInternals } from './link-suggestions.js';

/** The worker file next to this module in a tsc build (`dist/link-suggestions-worker.js`). */
export const LINK_SUGGESTIONS_WORKER_PATH = fileURLToPath(
  new URL('./link-suggestions-worker.js', import.meta.url),
);

export interface RunLinkSuggestionsOptions {
  /** Aborting stops the worker; the promise rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Worker file when it is bundled elsewhere (the desktop app). */
  workerPath?: string;
  internals?: LinkSuggestionInternals;
}

/**
 * Runs the report on its own read-only connection in a dedicated worker thread (not the shared
 * reader pool: that one times out at 30 s and a heavy slot would block the overview).
 * Resolves `null` when the crawl did not compute inlinks.
 */
export function runLinkSuggestionsInWorker(
  file: string,
  input: LinkSuggestionInput = {},
  opts: RunLinkSuggestionsOptions = {},
): Promise<LinkSuggestionResult | null> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(opts.workerPath ?? LINK_SUGGESTIONS_WORKER_PATH, {
      workerData: { file, input, internals: opts.internals },
      resourceLimits: { maxYoungGenerationSizeMb: 24, maxOldGenerationSizeMb: oldLimitMb(file) },
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once(
      'message',
      (msg: { ok: boolean; result?: LinkSuggestionResult | null; error?: string }) =>
        finish(() =>
          msg.ok ? resolve(msg.result ?? null) : reject(new Error(msg.error ?? 'worker failed')),
        ),
    );
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`link-suggestions worker exited with code ${code}`))),
    );
  });
}

/**
 * Heap caps of the worker. Row blocks, token arrays and key strings die young; with V8's default
 * limits they pile up as RSS (1.49 GB at 1M URLs, 0.83 GB with the caps). The old-generation cap
 * grows with the project file (about 8 KB per URL, live heap about 300 bytes per URL) so a bigger
 * crawl is not killed by it.
 */
function oldLimitMb(file: string): number {
  let mb = 0;
  try {
    mb = fs.statSync(file).size / 1048576;
  } catch {
    /* the worker reports the missing file */
  }
  return Math.min(4096, Math.max(600, Math.round(mb / 12)));
}

function abortError(): Error {
  const e = new Error('Link suggestions cancelled');
  e.name = 'AbortError';
  return e;
}
