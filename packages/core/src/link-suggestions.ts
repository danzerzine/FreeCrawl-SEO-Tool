import type { ProjectDb } from '@freecrawl/db';
import type { LinkSuggestionInput, LinkSuggestionResult } from '@freecrawl/shared-types';

/** Test and tuning hooks of {@link linkSuggestions}; the product never sets them. */
export interface LinkSuggestionInternals {
  /** Posting lists longer than this are not walked (default 20000). */
  postingCap?: number;
  /** Time budget of the candidate step in ms (default 120000). */
  budgetMs?: number;
  /** Total postings the term index may hold (default 60M). */
  maxPostings?: number;
  /** Terms with a document frequency above this are dropped (default max(2% of pages, 50)). */
  dfCut?: number;
  /** Filled while running. */
  stats?: { maxListWalked: number; listsSkipped: number };
}

export function linkSuggestions(
  _db: ProjectDb,
  _input: LinkSuggestionInput = {},
  _internals: LinkSuggestionInternals = {},
): LinkSuggestionResult | null {
  throw new Error('not implemented');
}
