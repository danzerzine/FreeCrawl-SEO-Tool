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

function abortError(): Error {
  const e = new Error('Link suggestions cancelled');
  e.name = 'AbortError';
  return e;
}
