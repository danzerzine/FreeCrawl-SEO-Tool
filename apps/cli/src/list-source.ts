import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_LIST_BYTES = 10 * 1024 * 1024;

/**
 * A Google Sheets link → the CSV export of the sheet it names
 * (`?gid=` or `#gid=`, the first sheet without one); any other link → null.
 */
export function sheetCsvUrl(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.hostname !== 'docs.google.com') return null;
  const m = /^\/spreadsheets\/d\/([^/]+)/.exec(u.pathname);
  if (!m) return null;
  const gid = u.searchParams.get('gid') ?? /(?:^#|&)gid=(\d+)/.exec(u.hash)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

/**
 * URLs of a list: plain text one per line (empty and `#` lines skipped), or
 * the first column of a CSV with quoted fields, a first row that is not a
 * URL taken for a header.
 */
export function parseListText(text: string, csv: boolean): string[] {
  if (!csv) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  }
  const firsts = csvFirstColumn(text).map((s) => s.trim());
  if (firsts.length > 0 && !/^https?:\/\//i.test(firsts[0]!)) firsts.shift();
  return firsts.filter((s) => s.length > 0);
}

/** The first field of each CSV record (RFC 4180: `""` inside quotes, line breaks in quoted fields). */
function csvFirstColumn(text: string): string[] {
  const out: string[] = [];
  let field = '';
  let column = 0;
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        if (column === 0) field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else if (column === 0) {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      column++;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || column > 0 || field.length > 0) out.push(field);
      field = '';
      column = 0;
      started = false;
    } else if (column === 0) {
      field += c;
      started = true;
    }
  }
  if (started || column > 0 || field.length > 0) out.push(field);
  return out;
}

export interface ListSourceOptions {
  userAgent: string;
  fetch?: typeof fetch;
  readStdin?: () => Promise<string>;
}

/**
 * The URLs of `--list <source>`: a file path, `-` for standard input, or an
 * http(s) link fetched once. Throws an Error whose message is the reason.
 */
export async function readListSource(source: string, opts: ListSourceOptions): Promise<string[]> {
  if (source === '-') {
    return parseListText(await (opts.readStdin ?? readAllStdin)(), false);
  }
  if (!/^https?:\/\//i.test(source)) {
    return parseListText(await readFile(resolve(source), 'utf8'), /\.csv$/i.test(source));
  }
  const sheet = sheetCsvUrl(source);
  const res = await (opts.fetch ?? fetch)(sheet ?? source, {
    headers: { 'user-agent': opts.userAgent },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') ?? '';
  const text = await readCapped(res);
  if (sheet && (/html/i.test(type) || /^\s*</.test(text))) {
    throw new Error('the sheet is not public (share it as "anyone with the link")');
  }
  return parseListText(
    text,
    sheet !== null || /csv/i.test(type) || /\.csv$/i.test(new URL(source).pathname),
  );
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_LIST_BYTES) {
      throw new Error(`the list is larger than ${MAX_LIST_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
