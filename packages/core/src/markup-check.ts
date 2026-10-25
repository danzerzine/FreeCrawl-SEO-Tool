import { Parser } from 'htmlparser2';
import { parse } from 'parse5';
import { checkStructure } from './markup-structure.js';

/**
 * B45: a small, fixed HTML markup check. Not a validator. Neither parse5 7.3.0 nor
 * htmlparser2 10.1.0 reports stray end tags or mis-nesting: those come from a pass of
 * our own over the tokens (B45b, `markup-structure.ts`).
 * Codes are API (they land in the DB and in JSON): never renamed, a new one is appended.
 */
export const MARKUP_CODES = [
  'missing-doctype',
  'duplicate-attribute',
  'malformed-tag',
  'unexpected-end',
  'bad-character-reference',
  'duplicate-id',
  'obsolete-element',
  'unclosed-element',
  'stray-end-tag',
  'misnested-tag',
  'block-in-inline',
  'wrong-parent',
  'attribute-not-allowed',
] as const;
export type MarkupCode = (typeof MARKUP_CODES)[number];

export interface MarkupCheck {
  total: number;
  codes: Record<string, number>;
}

/** Only this much of the page is read. */
export const MARKUP_INPUT_CAP = 2 * 1024 * 1024;
/** Each code counts up to this many. */
export const MARKUP_COUNT_CAP = 1000;

const PARSE5_CODE: Record<string, MarkupCode> = {
  'missing-doctype': 'missing-doctype',
  'duplicate-attribute': 'duplicate-attribute',
  'missing-whitespace-between-attributes': 'malformed-tag',
  'unexpected-character-in-attribute-name': 'malformed-tag',
  'unexpected-equals-sign-before-attribute-name': 'malformed-tag',
  'missing-attribute-value': 'malformed-tag',
  'unexpected-solidus-in-tag': 'malformed-tag',
  'invalid-first-character-of-tag-name': 'malformed-tag',
  'missing-end-tag-name': 'malformed-tag',
  'end-tag-with-attributes': 'malformed-tag',
  'unexpected-character-in-unquoted-attribute-value': 'malformed-tag',
  'eof-in-tag': 'unexpected-end',
  'eof-in-comment': 'unexpected-end',
  'eof-in-cdata': 'unexpected-end',
  'eof-in-script-html-comment-like-text': 'unexpected-end',
  'eof-before-tag-name': 'unexpected-end',
  'incorrectly-closed-comment': 'unexpected-end',
  'abrupt-closing-of-empty-comment': 'unexpected-end',
  // NOT missing-semicolon-after-character-reference: too noisy in real URLs.
  'unknown-named-character-reference': 'bad-character-reference',
  'absence-of-digits-in-numeric-character-reference': 'bad-character-reference',
  'null-character-reference': 'bad-character-reference',
  'surrogate-character-reference': 'bad-character-reference',
  'character-reference-outside-unicode-range': 'bad-character-reference',
};

const OBSOLETE = new Set([
  'font', 'center', 'marquee', 'blink', 'frame', 'frameset', 'big', 'strike', 'tt', 'acronym',
  'applet', 'basefont', 'dir',
]);

/** Implied close is valid HTML for these: void elements and optional end tags. */
const IMPLIED_OK = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
  'colgroup', 'caption', 'option', 'optgroup', 'rt', 'rp', 'rb', 'rtc',
]);

interface P5Node {
  nodeName: string;
  childNodes?: P5Node[];
  attrs?: { name: string; value: string }[];
}

/** Counts the markup errors of one page (first 2 MB). */
export function checkMarkup(html: string): MarkupCheck {
  const cut = html.length > MARKUP_INPUT_CAP;
  const src = cut ? html.slice(0, MARKUP_INPUT_CAP) : html;
  const counts: Record<string, number> = {};
  const add = (code: MarkupCode): void => {
    counts[code] = (counts[code] ?? 0) + 1;
  };

  const doc = parse(src, {
    onParseError: (err) => {
      const code = PARSE5_CODE[err.code];
      // The cut itself would end the text inside a tag or comment.
      if (code && !(cut && code === 'unexpected-end')) add(code);
    },
  }) as unknown as P5Node;

  // Walk the parse5 tree (iteratively: pages can nest deep).
  const seenIds = new Set<string>();
  const stack: P5Node[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (OBSOLETE.has(node.nodeName)) add('obsolete-element');
    const id = node.attrs?.find((a) => a.name === 'id')?.value;
    if (id) {
      if (seenIds.has(id)) add('duplicate-id');
      else seenIds.add(id);
    }
    const kids = node.childNodes;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }

  // B45b: stray end tags, mis-nesting, content models and attributes.
  const structure = checkStructure(src, add);

  if (!cut) {
    // Implied closes of elements that need an end tag. Self-closed svg/math children are
    // reported as implied by htmlparser2 too, so nothing inside them counts (r2 N2).
    let foreign = 0;
    const parser = new Parser({
      onopentag(name) {
        if (name === 'svg' || name === 'math') foreign++;
      },
      onclosetag(name, implied) {
        if (name === 'svg' || name === 'math') foreign--;
        if (implied && foreign <= 0 && !IMPLIED_OK.has(name)) add('unclosed-element');
      },
    });
    parser.write(src);
    parser.end();
    // An element whose end tag came after its parent's was mis-nested, not left open:
    // htmlparser2 saw it closed by the parent, the structure pass saw its end tag.
    const unclosed = (counts['unclosed-element'] ?? 0) - structure.misnested;
    if (unclosed > 0) counts['unclosed-element'] = unclosed;
    else delete counts['unclosed-element'];
  }

  let total = 0;
  const codes: Record<string, number> = {};
  for (const code of MARKUP_CODES) {
    const n = counts[code];
    if (!n) continue;
    codes[code] = Math.min(n, MARKUP_COUNT_CAP);
    total += codes[code];
  }
  return { total, codes };
}
