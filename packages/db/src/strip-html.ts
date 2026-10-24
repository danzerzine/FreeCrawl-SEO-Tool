/**
 * Removes every `<tag …>…</tag>` span (case-insensitive, ASCII) and puts a
 * space in its place. Same result as `s.replace(/<tag[\s\S]*?<\/tag>/gi, ' ')`
 * but linear: the regex is quadratic on a body with many openers and no
 * closing tag (each opener rescans to the end), which let one crafted page
 * stall the whole pass. Here an opener with no closer after it ends the scan:
 * every later opener has no closer either.
 */
function stripTagBlocks(s: string, tag: string): string {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let lower = s.toLowerCase();
  // A few characters (e.g. U+0130) change length when lowercased, which
  // would misalign indexes; fall back to ASCII-only lowercasing, the only
  // case folding the regex flag `i` applies here.
  if (lower.length !== s.length) lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  let from = lower.indexOf(open);
  if (from < 0) return s;
  let out = '';
  let pos = 0;
  while (from >= 0) {
    const end = lower.indexOf(close, from + open.length);
    if (end < 0) break;
    out += s.slice(pos, from) + ' ';
    pos = end + close.length;
    from = lower.indexOf(open, pos);
  }
  return out + s.slice(pos);
}

// Rough HTML-to-text — strips `<script>` / `<style>` blocks, then
// every remaining tag, then named entities, collapses whitespace,
// lowercases. We don't bother with a full cheerio parse because the
// boilerplate-detection signal is robust to noise (repeated
// navigation copy is repeated whether we get tags right or not),
// and the 2K-page pass needs to be fast.
export const stripHtml = (html: string): string =>
  stripTagBlocks(stripTagBlocks(stripTagBlocks(html, 'script'), 'style'), 'noscript')
    // Unterminated trailing block. Bodies arrive truncated (the
    // crawler's 1 MB snapshot cap, plus the SUBSTR cap below), so the
    // cut routinely lands inside a <script>. The paired patterns above
    // need a closing tag to match, so without this the whole minified
    // bundle survives tag-stripping and becomes "text" — on a real
    // crawl that turned 400 words of prose into 8,300 JS tokens, and
    // since those tokens are near-identical across pages every shingle
    // looked like boilerplate and coverage pinned at 100% site-wide.
    .replace(/<(?:script|style|noscript)\b[\s\S]*$/i, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
