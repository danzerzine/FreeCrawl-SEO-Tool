import { expect, it } from 'vitest';
import { mergeCrawlConfig } from './crawl-config.js';

const start = { url: 'https://example.com/' };
const js = { renderingMode: 'js' };

it('keeps jsRender.pageScript from a --config file, without an unknown-key note (B34)', () => {
  const m = mergeCrawlConfig({ ...js, jsRender: { pageScript: 'window.scrollTo(0, 1e6)' } }, {}, start);
  expect(m.kind).toBe('ok');
  if (m.kind !== 'ok') return;
  expect(m.config.jsRender.pageScript).toBe('window.scrollTo(0, 1e6)');
  expect(m.config.jsRender.pageScriptTimeoutMs).toBe(5000);
  expect(m.notes).toEqual([]);
});

it('--page-script (a flag layer) overrides the file', () => {
  const m = mergeCrawlConfig(
    { ...js, jsRender: { pageScript: 'from file', headless: false } },
    { jsRender: { pageScript: 'from flag' } } as never,
    start,
  );
  expect(m.kind).toBe('ok');
  if (m.kind !== 'ok') return;
  expect(m.config.jsRender.pageScript).toBe('from flag');
  expect(m.config.jsRender.headless).toBe(false);
});

it('a script longer than 20 000 characters is refused', () => {
  const m = mergeCrawlConfig({ ...js, jsRender: { pageScript: 'x'.repeat(20_001) } }, {}, start);
  expect(m.kind).toBe('error');
  if (m.kind === 'error') expect(m.message).toMatch(/20 000/);
  const ok = mergeCrawlConfig({ ...js, jsRender: { pageScript: 'x'.repeat(20_000) } }, {}, start);
  expect(ok.kind).toBe('ok');
});

it('a script without JavaScript rendering is refused with one line', () => {
  const m = mergeCrawlConfig({ jsRender: { pageScript: 'x()' } }, {}, start);
  expect(m.kind).toBe('error');
  if (m.kind === 'error') {
    expect(m.message).toMatch(/--render/);
    expect(m.message).not.toContain('\n');
  }
});
