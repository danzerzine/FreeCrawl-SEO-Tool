import { Tokenizer } from 'htmlparser2';

/**
 * B45b: the structure half of the markup check, on the raw token stream
 * (htmlparser2's tokenizer; neither parse5 nor htmlparser2's parser reports
 * these). A small model of the HTML tree builder keeps a stack of open
 * elements with the valid implied closes (paragraphs, list items, table
 * parts, options, ruby text), and counts:
 *  - `stray-end-tag`: an end tag with no open element of its name, or of a void element;
 *  - `misnested-tag`: an element an ancestor's end tag closed, whose own end tag comes later;
 *  - `block-in-inline`: a block element where only phrasing content may be (a link or
 *    other transparent element passes its parent's rule on);
 *  - `wrong-parent`: an element under a parent it may not have (`li` outside a list, a
 *    cell outside a row, …);
 *  - `attribute-not-allowed`: an HTML attribute on an HTML element that does not take it.
 *    Only attributes the table below knows count, so global, data-, aria-, event and
 *    framework attributes, and custom elements, are never reported.
 * Nothing inside svg or math is checked, and nothing inside a template.
 */
export type StructureCode =
  | 'stray-end-tag'
  | 'misnested-tag'
  | 'block-in-inline'
  | 'wrong-parent'
  | 'attribute-not-allowed';

const set = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));

const VOID = set('area base br col embed hr img input link meta param source track wbr keygen');
/** End tags that are never stray: the parser makes these elements up when they are missing. */
const IMPLICIT = set('html head body');
/** Elements whose end tag may be left out: closing their parent closes them without an error. */
const OPTIONAL_END = set(
  'p li dt dd tr td th thead tbody tfoot colgroup caption option optgroup rb rt rtc rp',
);
/** Start tags that close an open paragraph. */
const CLOSES_P = set(
  'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr li dd dt main menu nav ol p pre search section summary table ul',
);
/** Block elements reported inside phrasing content. */
const BLOCK = set(
  'address article aside blockquote details dialog div dl fieldset figure footer form h1 h2 h3 h4 h5 h6 ' +
    'header hgroup hr main menu nav ol p pre search section table ul',
);
/** Elements that may hold phrasing content only. */
const PHRASING_ONLY = set(
  'span b i em strong small s cite q dfn abbr data time code var samp kbd sub sup u mark bdi bdo label ' +
    'output button h1 h2 h3 h4 h5 h6 pre legend summary',
);
/** Elements whose content model is their parent's. */
const TRANSPARENT = set('a ins del map object video audio canvas noscript slot');
/** The scope boundaries of the tree builder. */
const SCOPE = set('applet caption html table td th marquee object template');
/** An element and the parents it may have (the parser's implied table body counts as `table`). */
const PARENTS: Record<string, ReadonlySet<string>> = {
  li: set('ul ol menu'),
  dt: set('dl div'),
  dd: set('dl div'),
  tr: set('table thead tbody tfoot'),
  td: set('tr'),
  th: set('tr'),
  thead: set('table'),
  tbody: set('table'),
  tfoot: set('table'),
  caption: set('table'),
  colgroup: set('table'),
  col: set('colgroup table'),
  option: set('select datalist optgroup'),
  optgroup: set('select'),
  figcaption: set('figure'),
  summary: set('details'),
  source: set('picture video audio'),
  track: set('video audio'),
  param: set('object'),
};

const P = set('p');
const BUTTON_SCOPE = new Set([...SCOPE, 'button']);
const LIST_SCOPE = new Set([...SCOPE, 'ol', 'ul', 'menu']);
const DL_SCOPE = new Set([...SCOPE, 'dl']);
const TABLE_STOP = set('table template html');
const ROW_STOP = set('tr table template html');
const SELECT_STOP = set('select template html');
const LI = set('li');
const DT_DD = set('dt dd');
const CELLS = set('td th');
const ROW = set('tr');
const ROW_CLOSERS = set('tr caption colgroup');
const TABLE_SECTIONS = set('thead tbody tfoot caption colgroup');
const OPTIONS = set('option optgroup');
const RUBY = set('ruby');
const RUBY_TEXT = set('rb rt rp');
const RUBY_PARTS = set('rb rt rtc rp');

/** HTML elements: only these have their attributes checked. */
const HTML_ELEMENTS = set(
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code ' +
    'col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer ' +
    'form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map ' +
    'mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ' +
    'ruby s samp script search section select slot small source span strong style sub summary sup table tbody ' +
    'td template textarea tfoot th thead time title tr track u ul var video wbr',
);

/**
 * Element-specific HTML attributes and the elements that take them. Obsolete
 * presentational ones (align, bgcolor, …) are left out on purpose, and a few
 * obsolete uses that are still everywhere (width on a table cell, type on a
 * list, name on a link) count as allowed: the check reports attributes on the
 * wrong element, not old markup.
 */
const ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  href: set('a area base link'),
  src: set('audio embed iframe img input script source track video'),
  srcset: set('img source'),
  sizes: set('img source link'),
  alt: set('area img input'),
  action: set('form'),
  method: set('form'),
  enctype: set('form'),
  novalidate: set('form'),
  'accept-charset': set('form'),
  target: set('a area base form'),
  rel: set('a area link form'),
  download: set('a area'),
  ping: set('a area'),
  hreflang: set('a link'),
  type: set('a link script style input button ol ul li source embed object menu'),
  name: set('a img button fieldset form iframe input map meta object output param select slot textarea details embed'),
  value: set('button data input li meter option output param progress'),
  for: set('label output'),
  content: set('meta'),
  'http-equiv': set('meta'),
  charset: set('meta script'),
  async: set('script'),
  defer: set('script'),
  nomodule: set('script'),
  integrity: set('link script'),
  crossorigin: set('audio img link script video'),
  media: set('link meta source style'),
  loading: set('img iframe'),
  decoding: set('img'),
  controls: set('audio video'),
  autoplay: set('audio video'),
  loop: set('audio video'),
  muted: set('audio video'),
  preload: set('audio video'),
  poster: set('video'),
  playsinline: set('video'),
  datetime: set('del ins time'),
  cite: set('blockquote del ins q'),
  colspan: set('td th'),
  rowspan: set('td th'),
  headers: set('td th'),
  scope: set('th'),
  placeholder: set('input textarea'),
  required: set('input select textarea'),
  checked: set('input'),
  selected: set('option'),
  multiple: set('input select'),
  readonly: set('input textarea'),
  maxlength: set('input textarea'),
  minlength: set('input textarea'),
  min: set('input meter'),
  max: set('input meter progress'),
  step: set('input'),
  pattern: set('input'),
  accept: set('input'),
  list: set('input'),
  cols: set('textarea'),
  rows: set('textarea'),
  wrap: set('textarea'),
  size: set('input select hr'),
  disabled: set('button fieldset input optgroup option select textarea link'),
  autocomplete: set('form input select textarea'),
  label: set('option optgroup track'),
  kind: set('track'),
  srclang: set('track'),
  default: set('track'),
  open: set('details dialog'),
  reversed: set('ol'),
  start: set('ol'),
  sandbox: set('iframe'),
  allow: set('iframe'),
  allowfullscreen: set('iframe'),
  srcdoc: set('iframe'),
  referrerpolicy: set('a area iframe img link script'),
  usemap: set('img object'),
  ismap: set('img'),
  shape: set('area'),
  coords: set('area'),
  span: set('col colgroup'),
  high: set('meter'),
  low: set('meter'),
  optimum: set('meter'),
  as: set('link'),
  blocking: set('link script style'),
  fetchpriority: set('img link script'),
  formaction: set('button input'),
  formmethod: set('button input'),
  formenctype: set('button input'),
  formtarget: set('button input'),
  formnovalidate: set('button input'),
  width: set('img canvas iframe embed object video input source table td th col colgroup hr pre'),
  height: set('img canvas iframe embed object video input source table td th tr'),
};

/** Runs the pass over `src` and reports each finding through `add`. */
export function checkStructure(src: string, add: (code: StructureCode) => void): { misnested: number } {
  const stack: string[] = [];
  /**
   * Elements an ancestor's end tag closed (they are unclosed as far as B45
   * knows): their own end tag later is mis-nesting, `silent` when the finding
   * was already reported another way.
   */
  const closedEarly = new Map<string, { loud: number; silent: number }>();
  let foreign = 0;
  let template = 0;
  let misnested = 0;
  let tagName = '';
  let attrs: string[] = [];

  const remember = (name: string, silent: boolean): void => {
    const e = closedEarly.get(name) ?? { loud: 0, silent: 0 };
    if (silent) e.silent++;
    else e.loud++;
    closedEarly.set(name, e);
  };
  /** Pops down to and including index `i`; what is above it was closed by that pop. */
  const popTo = (i: number, silent: boolean): void => {
    while (stack.length > i + 1) {
      const name = stack.pop()!;
      if (!OPTIONAL_END.has(name)) remember(name, silent);
    }
    stack.length = i;
  };
  /** Index of the open `names` element nearest the top, not crossing `stop`; -1 when none. */
  const findOpen = (names: ReadonlySet<string>, stop: ReadonlySet<string>): number => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const name = stack[i]!;
      if (names.has(name)) return i;
      if (stop.has(name)) return -1;
    }
    return -1;
  };
  /** The valid closes a start tag implies, before the element opens. */
  const impliedCloses = (name: string): void => {
    if (CLOSES_P.has(name)) {
      const p = findOpen(P, BUTTON_SCOPE);
      // Only what lies between is closed early, and the block-in-inline report already covers it.
      if (p >= 0) popTo(p, true);
    }
    let i = -1;
    if (name === 'li') i = findOpen(LI, LIST_SCOPE);
    else if (name === 'dt' || name === 'dd') i = findOpen(DT_DD, DL_SCOPE);
    else if (name === 'td' || name === 'th') i = findOpen(CELLS, ROW_STOP);
    else if (name === 'tr') i = findOpen(ROW_CLOSERS, TABLE_STOP);
    else if (TABLE_SECTIONS.has(name)) {
      // A section opened inside a section closes the outer one, rows and cells with it.
      i = findOpen(TABLE_SECTIONS, TABLE_STOP);
      if (i < 0) i = findOpen(ROW, TABLE_STOP);
    } else if (name === 'option') i = stack.at(-1) === 'option' ? stack.length - 1 : -1;
    else if (name === 'optgroup') i = findOpen(OPTIONS, SELECT_STOP);
    else if (name === 'rt' || name === 'rp') i = findOpen(RUBY_TEXT, RUBY);
    else if (name === 'rb' || name === 'rtc') i = findOpen(RUBY_PARTS, RUBY);
    else if (name === 'col' && stack.at(-1) === 'caption') i = stack.length - 1;
    if (i >= 0) popTo(i, true);
  };

  /** The element whose content model decides what `stack[top]` may hold. */
  const contentParent = (): { name: string | undefined; through: boolean } => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const name = stack[i]!;
      if (!TRANSPARENT.has(name)) return { name, through: i < stack.length - 1 };
    }
    return { name: undefined, through: false };
  };

  const open = (name: string, selfClosing: boolean): void => {
    if (foreign > 0) {
      if (!selfClosing && (name === 'svg' || name === 'math')) foreign++;
      return;
    }
    if (template === 0) {
      if (BLOCK.has(name)) {
        const parent = contentParent();
        if (parent.name && (PHRASING_ONLY.has(parent.name) || (parent.name === 'p' && parent.through))) {
          add('block-in-inline');
        }
      }
      if (HTML_ELEMENTS.has(name)) {
        for (const attr of new Set(attrs)) {
          const allowed = ATTRIBUTES[attr];
          if (allowed && !allowed.has(name)) add('attribute-not-allowed');
        }
      }
    }
    impliedCloses(name);
    if (template === 0) {
      const parents = PARENTS[name];
      const parent = stack.at(-1);
      if (parents && parent !== undefined && !parents.has(parent) && parent !== 'template') add('wrong-parent');
      else if (parents && parent === undefined) add('wrong-parent');
    }
    // A new element of the name forgets the old one closed early.
    closedEarly.delete(name);
    if (name === 'svg' || name === 'math') {
      if (!selfClosing) foreign = 1;
      return;
    }
    if (IMPLICIT.has(name) || VOID.has(name)) return;
    if (name === 'template') template++;
    stack.push(name);
  };

  const close = (name: string): void => {
    if (foreign > 0) {
      if (name === 'svg' || name === 'math') foreign--;
      return;
    }
    if (IMPLICIT.has(name)) return;
    if (VOID.has(name)) {
      add('stray-end-tag');
      return;
    }
    const i = stack.lastIndexOf(name);
    if (i < 0) {
      const early = closedEarly.get(name);
      if (early && early.loud > 0) {
        early.loud--;
        misnested++;
        add('misnested-tag');
      } else if (early && early.silent > 0) {
        early.silent--;
      } else {
        add('stray-end-tag');
      }
      return;
    }
    if (name === 'template') template--;
    popTo(i, false);
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onopentagname(start, end) {
        tagName = src.slice(start, end).toLowerCase();
        attrs = [];
      },
      onattribname(start, end) {
        attrs.push(src.slice(start, end).toLowerCase());
      },
      onopentagend() {
        open(tagName, false);
      },
      onselfclosingtag() {
        // `<br/>` is a br; `<div/>` is an open div in HTML (B45 counts it unclosed).
        open(tagName, true);
      },
      onclosetag(start, end) {
        close(src.slice(start, end).toLowerCase());
      },
      onattribdata() {},
      onattribentity() {},
      onattribend() {},
      oncdata() {},
      oncomment() {},
      ondeclaration() {},
      onend() {},
      onprocessinginstruction() {},
      ontext() {},
      ontextentity() {},
    },
  );
  tokenizer.write(src);
  tokenizer.end();
  return { misnested };
}
