import type { LinkSuggestionResult } from '@freecrawl/shared-types';

/**
 * B93: one running link-suggestions report per project window. A new request, a project switch
 * or the dialog closing aborts the one before it, so the old worker stops and its answer is
 * never shown or exported against a different project. No Electron here: tested on its own.
 */
export class LinkSuggestionsGate {
  private ctl: AbortController | null = null;

  /** Abort the running report (if any) and return the signal of a new one. */
  begin(): AbortSignal {
    this.ctl?.abort();
    this.ctl = new AbortController();
    return this.ctl.signal;
  }

  /** Abort the running report; the next `begin` starts clean. */
  cancel(): void {
    this.ctl?.abort();
    this.ctl = null;
  }
}

export function linkSuggestionsAbortError(): Error {
  const e = new Error('Link suggestions cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Runs `work` as the gate's current report. It rejects with an `AbortError` when a newer request
 * or a cancel came in meanwhile, or when `identity()` (the open project's database) changed.
 */
export async function guardedLinkSuggestions<T>(
  gate: LinkSuggestionsGate,
  identity: () => unknown,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = gate.begin();
  const at = identity();
  const result = await work(signal);
  if (signal.aborted || identity() !== at) throw linkSuggestionsAbortError();
  return result;
}

/** What the bridge (HTTP, MCP) sends: `{ notComputed: true }`, never JSON null. */
export function linkSuggestionsBridgeResult(
  result: LinkSuggestionResult | null,
): LinkSuggestionResult | { notComputed: true } {
  return result ?? { notComputed: true };
}
