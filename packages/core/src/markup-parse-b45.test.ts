import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const URL_ = 'http://127.0.0.1/p';

describe('parseHtml markup check (B45)', () => {
  const html = '<html><head><title>t</title></head><body><p id="a">x</p><p id="a">y</p></body></html>';

  it('option on: markupErrors and markupCodes come back (codes as compact sorted JSON)', () => {
    const page = parseHtml(html, URL_, { markupValidation: true });
    expect(page.markupErrors).toBe(2);
    expect(page.markupCodes).toBe('{"duplicate-id":1,"missing-doctype":1}');
  });

  it('option on, clean page: 0 errors and NULL codes', () => {
    const page = parseHtml(`<!DOCTYPE html>${html.replace('id="a">y', 'id="b">y')}`, URL_, { markupValidation: true });
    expect(page.markupErrors).toBe(0);
    expect(page.markupCodes).toBeNull();
  });

  it('option off or missing: both null (not checked)', () => {
    for (const opts of [{}, { markupValidation: false }]) {
      const page = parseHtml(html, URL_, opts);
      expect(page.markupErrors).toBeNull();
      expect(page.markupCodes).toBeNull();
    }
  });
});
