import { describe, expect, it } from 'vitest';
import {
  guardedLinkSuggestions,
  LinkSuggestionsGate,
  linkSuggestionsBridgeResult,
} from './link-suggestions-guard.js';

const never = (signal: AbortSignal): Promise<string> =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))),
  );

describe('B93 link-suggestions guard', () => {
  it('a second request aborts the first', async () => {
    const gate = new LinkSuggestionsGate();
    const first = guardedLinkSuggestions(gate, () => 1, never);
    const second = guardedLinkSuggestions(gate, () => 1, async () => 'two');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('two');
  });

  it('cancel (dialog closed, project switched) aborts the running request', async () => {
    const gate = new LinkSuggestionsGate();
    const p = guardedLinkSuggestions(gate, () => 1, never);
    gate.cancel();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('drops the answer of an old project even if its worker finished', async () => {
    const gate = new LinkSuggestionsGate();
    let db = 'a';
    const p = guardedLinkSuggestions(gate, () => db, async () => {
      db = 'b'; // another project opened while the worker ran
      return 'rows of a';
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the answer when nothing changed', async () => {
    const gate = new LinkSuggestionsGate();
    await expect(guardedLinkSuggestions(gate, () => 1, async () => 'ok')).resolves.toBe('ok');
  });

  it('the bridge sends notComputed, not null', () => {
    expect(linkSuggestionsBridgeResult(null)).toEqual({ notComputed: true });
    const r = { rows: [], targets: 0, withoutSuggestion: 0, truncated: false, degraded: false };
    expect(linkSuggestionsBridgeResult(r as never)).toBe(r);
    expect(JSON.stringify(linkSuggestionsBridgeResult(null))).not.toBe('null');
  });
});
