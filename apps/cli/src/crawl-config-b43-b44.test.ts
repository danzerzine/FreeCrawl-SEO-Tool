import { describe, expect, it } from 'vitest';
import { mergeCrawlConfig } from './crawl-config.js';

const start = { url: 'https://example.com/' };

describe.each([
  ['cookieList', '--cookie-list'],
  ['coverage', '--coverage'],
] as const)('%s without rendering (B43/B44)', (key, flag) => {
  it('the typed flag is an error', () => {
    const m = mergeCrawlConfig({}, { jsRender: { [key]: true } } as never, start);
    expect(m).toEqual({ kind: 'error', message: `${flag} needs --render` });
  });

  it('a --config file with the option on and text rendering: a note, the option off, no error', () => {
    const m = mergeCrawlConfig({ renderingMode: 'text', jsRender: { [key]: true } }, {}, start);
    expect(m.kind).toBe('ok');
    if (m.kind !== 'ok') return;
    expect(m.config.jsRender[key]).toBe(false);
    expect(m.notes.join('\n')).toContain(flag);
  });

  it('with rendering the option stays on', () => {
    const m = mergeCrawlConfig({ renderingMode: 'js', jsRender: { [key]: true } }, {}, start);
    expect(m.kind === 'ok' && m.config.jsRender[key]).toBe(true);
  });
});
