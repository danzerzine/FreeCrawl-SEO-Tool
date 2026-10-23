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
  /** One page only (title, description, H1 and its stored body); one block with scope `page`, `section` holding the URL. */
  url?: string;
  /** Only the pages of this folder (as `sectionOf` names it); one block with scope `section`. */
  section?: string;
  /** Folder depth for `bySection` and `section`, 1 (default) or 2. */
  sectionDepth?: number;
  /** Also count the stored page bodies (main-content prose) next to title, description and H1. */
  withBodies?: boolean;
  /** CSS selector of the content area, for the body prose. */
  contentAreaSelector?: string;
}

export interface TopWordsBlock {
  scope: 'site' | 'section' | 'page';
  /** The folder (`news`, `news/a`, `/` for the root, `(other)`); empty for the site block. */
  section: string;
  n: 1 | 2 | 3;
  rows: TopWordsRow[];
  /** Rare phrases were dropped to stay inside the memory limit: counts are approximate. */
  capped: boolean;
}

/** What `topWordsBlocks` does with the texts: feed the corpus, then each stored body, then read the blocks. */
interface BlocksRun {
  /** Counts the title, description and H1 of every page in scope. */
  addCorpus(): void;
  /** Counts the prose of a stored body, when the page is in scope. */
  addBody(url: string, text: string): void;
  result(): TopWordsBlock[];
}

function openBlocksRun(db: ProjectDb, opts: TopWordsBlocksOptions): BlocksRun {
  const n = opts.n === 2 || opts.n === 3 ? opts.n : 1;
  const depth = opts.sectionDepth ?? 1;
  if (opts.section !== undefined) {
    const section = opts.section;
    const agg = createTopWordsAggregator(opts);
    return {
      addCorpus() {
        for (const { text } of db.seoTextCorpus({ section, depth })) agg.add(text);
      },
      addBody(url, text) {
        if (sectionOf(url, depth) === section) agg.add(text);
      },
      result: () => [{ scope: 'section', section, n, rows: agg.result(), capped: agg.capped() }],
    };
  }
  if (!opts.bySection) {
    const agg = createTopWordsAggregator(opts);
    return {
      addCorpus() {
        for (const text of db.seoTextCorpus()) agg.add(text);
      },
      addBody: (_url, text) => agg.add(text),
      result: () => [{ scope: 'site', section: '', n, rows: agg.result(), capped: agg.capped() }],
    };
  }
  const sectionPages = new Map<string, number>();
  for (const { url } of db.seoTextCorpus({})) {
    const section = sectionOf(url, depth);
    if (section !== null) sectionPages.set(section, (sectionPages.get(section) ?? 0) + 1);
  }
  const sections = createSectionedTopWords({ ...opts, sectionDepth: depth, sectionPages });
  return {
    addCorpus() {
      for (const { url, text } of db.seoTextCorpus({})) sections.add(url, text);
    },
    addBody: (url, text) => sections.add(url, text),
    result: () =>
      sections.result().map((b) => ({
        scope: 'section' as const,
        section: b.section,
        n,
        rows: b.rows,
        capped: b.capped,
      })),
  };
}

function pageBlock(db: ProjectDb, url: string, opts: TopWordsBlocksOptions): TopWordsBlock {
  const n = opts.n === 2 || opts.n === 3 ? opts.n : 1;
  return { scope: 'page', section: url, n, rows: topWordsForUrl(db, url, opts), capped: false };
}

/**
 * Top words or phrases of a stored project: the whole site, one folder, or one block per folder.
 * Reads title, description and H1 of the indexable pages; stored bodies only with `withBodies`.
 */
export function topWordsBlocks(db: ProjectDb, opts: TopWordsBlocksOptions = {}): TopWordsBlock[] {
  if (opts.url !== undefined) return [pageBlock(db, opts.url, opts)];
  const run = openBlocksRun(db, opts);
  run.addCorpus();
  if (opts.withBodies) {
    for (const { url, body } of db.iterateStoredBodies()) {
      const text = extractProseText(body, opts.contentAreaSelector);
      if (text) run.addBody(url, text);
    }
  }
  return run.result();
}

/**
 * The same, for a caller that reduces the bodies to prose elsewhere (the desktop app does it on
 * its parser workers, four at a time, so a 60k-page corpus never stalls the window).
 */
export async function topWordsBlocksAsync(
  db: ProjectDb,
  opts: TopWordsBlocksOptions & { prose: (body: string) => Promise<string> },
): Promise<TopWordsBlock[]> {
  if (opts.url !== undefined) return [pageBlock(db, opts.url, opts)];
  const run = openBlocksRun(db, opts);
  run.addCorpus();
  if (opts.withBodies) {
    const BATCH = 4;
    let batch: { url: string; text: Promise<string> }[] = [];
    const drain = async (): Promise<void> => {
      const done = await Promise.all(batch.map((b) => b.text));
      batch.forEach((b, i) => {
        if (done[i]) run.addBody(b.url, done[i]!);
      });
      batch = [];
    };
    for (const { url, body } of db.iterateStoredBodies()) {
      batch.push({
        url,
        text: opts.prose(body).catch(() => extractProseText(body, opts.contentAreaSelector)),
      });
      if (batch.length >= BATCH) await drain();
    }
    if (batch.length > 0) await drain();
  }
  return run.result();
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
