/**
 * The folder of a page URL: its first `depth` path segments joined with `/`
 * (`/news/a/b` at depth 2 is `news/a`), `/` for the root, null for a string
 * that is not a URL. The one grouping Top Words sections and the average word
 * count per directory share. No decoding: segments stay as stored.
 */
export function sectionOf(url: string, depth = 1): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const taken = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .slice(0, Math.max(1, depth));
  return taken.length > 0 ? taken.join('/') : '/';
}
