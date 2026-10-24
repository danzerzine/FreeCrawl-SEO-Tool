import { parentPort, workerData } from 'node:worker_threads';
import { ProjectDb } from '@freecrawl/db';
import type { LinkSuggestionInput } from '@freecrawl/shared-types';
import { linkSuggestions, type LinkSuggestionInternals } from './link-suggestions.js';

/**
 * Worker thread of the link-suggestions report (B93), run by {@link runLinkSuggestionsInWorker}.
 * It opens its own read-only connection and reads with the memory map off, so a report that
 * takes minutes neither blocks the main process nor inflates its memory.
 *
 *   workerData: `{ file, input, internals? }`
 *   worker -> main: `{ ok: true, result }` or `{ ok: false, error }`
 */
if (!parentPort) {
  throw new Error('link-suggestions-worker: must be loaded via worker_threads');
}

const { file, input, internals } = workerData as {
  file: string;
  input: LinkSuggestionInput;
  internals?: LinkSuggestionInternals;
};

// No top-level await: the desktop bundle loads this file with require(), which refuses an
// ES module that awaits at the top level (ERR_REQUIRE_ASYNC_MODULE).
const port = parentPort;
void (async () => {
  const db = new ProjectDb(file, { readOnly: true });
  try {
    const result = await db.withoutMmap(async () => linkSuggestions(db, input, internals));
    port.postMessage({ ok: true, result });
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    db.close();
  }
})();
