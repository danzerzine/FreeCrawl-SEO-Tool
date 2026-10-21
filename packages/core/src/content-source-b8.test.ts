import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://example.com/page';
const WORDS = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
const doc = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
const CHROME = '<nav>Home News Sport</nav><header>Site header</header><footer>Footer links</footer>';

describe('parseHtml reports where the main text came from (B8)', () => {
  const cases: Array<[string, string, string | undefined, string]> = [
    ['selector', `${CHROME}<div class="body">${WORDS}</div>`, '.body', 'selector'],
    ['main', `${CHROME}<main>${WORDS}</main>`, undefined, 'main'],
    ['article', `${CHROME}<article>${WORDS}</article>`, undefined, 'article'],
    ['body without chrome', `${CHROME}<div>${WORDS}</div>`, undefined, 'body-without-chrome'],
    ['whole body', `<nav>${WORDS}</nav>`, undefined, 'body'],
    ['selector set, not on the page', `${CHROME}<main>${WORDS}</main>`, '.body', 'selector-missed'],
    ['selector matches an empty element', `${CHROME}<div class="body"> </div><main>${WORDS}</main>`, '.body', 'selector-missed'],
    ['invalid selector', `${CHROME}<main>${WORDS}</main>`, 'div[', 'selector-missed'],
  ];
  for (const [name, body, selector, source] of cases) {
    it(name, () => {
      const p = parseHtml(doc(body), PAGE, { contentAreaSelector: selector });
      expect(p.contentSource).toBe(source);
    });
  }

  it('a selector hit fingerprints the selector text only', () => {
    const a = parseHtml(doc(`<nav>${'menu '.repeat(40)}</nav><div class="body">${WORDS}</div>`), PAGE, {
      contentAreaSelector: '.body',
    });
    const b = parseHtml(doc(`<div class="body">${WORDS}</div>`), PAGE, { contentAreaSelector: '.body' });
    expect(a.contentHash).not.toBeNull();
    expect(a.contentHash).toBe(b.contentHash);
  });
});
