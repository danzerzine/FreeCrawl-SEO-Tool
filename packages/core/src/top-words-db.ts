import type { ProjectDb } from '@freecrawl/db';
import { extractProseText } from './html-parser.js';
import {
  createSectionedTopWords,
  createTopWordsAggregator,
  sectionOf,
  type TopWordsOptions,
  type TopWordsRow,
} from './top-words.js';

export interface TopWordsBlocksOptions extends TopWordsOptions {
  /** One block per folder of the site instead of one for the whole site. */
  bySection?: boolean;
  /** Folder depth for `bySection`, 1 (default) or 2. */
  sectionDepth?: number;
  /** Also count the stored page bodies (main-content prose) next to title, description and H1. */
  withBodies?: boolean;
  /** CSS selector of the content area, for the body prose. */
  contentAreaSelector?: string;
}

export interface TopWordsBlock {
  scope: 'site' | 'section';
  /** The folder (`news`, `news/a`, `/` for the root, `(other)`); empty for the site block. */
  section: string;
  n: 1 | 2 | 3;
  rows: TopWordsRow[];
  /** Rare phrases were dropped to stay inside the memory limit: counts are approximate. */
  capped: boolean;
}

/**
 * Top words or phrases of a stored project: the whole site, or one block per section. Reads title,
 * description and H1 of the indexable pages; stored bodies only with `withBodies`.
 */
export function topWordsBlocks(db: ProjectDb, opts: TopWordsBlocksOptions = {}): TopWordsBlock[] {
  const n = opts.n === 2 || opts.n === 3 ? opts.n : 1;
  const prose = (body: string): string => extractProseText(body, opts.contentAreaSelector);
  if (!opts.bySection) {
    const agg = createTopWordsAggregator(opts);
    for (const text of db.seoTextCorpus()) agg.add(text);
    if (opts.withBodies) {
      for (const { body } of db.iterateStoredBodies()) {
        const text = prose(body);
        if (text) agg.add(text);
      }
    }
    return [{ scope: 'site', section: '', n, rows: agg.result(), capped: agg.capped() }];
  }
  const depth = opts.sectionDepth ?? 1;
  const sectionPages = new Map<string, number>();
  for (const { url } of db.seoTextCorpus({})) {
    const section = sectionOf(url, depth);
    if (section !== null) sectionPages.set(section, (sectionPages.get(section) ?? 0) + 1);
  }
  const sections = createSectionedTopWords({ ...opts, sectionDepth: depth, sectionPages });
  for (const { url, text } of db.seoTextCorpus({})) sections.add(url, text);
  if (opts.withBodies) {
    for (const { url, body } of db.iterateStoredBodies()) {
      const text = prose(body);
      if (text) sections.add(url, text);
    }
  }
  return sections
    .result()
    .map((b) => ({
      scope: 'section' as const,
      section: b.section,
      n,
      rows: b.rows,
      capped: b.capped,
    }));
}

/**
 * Top words of one page: its title, description and H1 and, when the crawl stored the page body,
 * the main-content prose of it.
 */
export function topWordsForUrl(
  db: ProjectDb,
  url: string,
  opts: TopWordsOptions & { contentAreaSelector?: string } = {},
): TopWordsRow[] {
  const agg = createTopWordsAggregator(opts);
  const parts: string[] = [];
  for (const { text } of db.seoTextCorpus({ url })) parts.push(text);
  const id = db.getUrlIdByUrl(url);
  const source = id === null ? null : db.getUrlSource(id);
  if (source?.body) parts.push(extractProseText(source.body, opts.contentAreaSelector));
  // One text, so a word of the title and the body still counts as one page.
  agg.add(parts.join(' '));
  return agg.result();
}
