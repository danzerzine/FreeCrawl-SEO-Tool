import { expect, it } from 'vitest';
import { mergeCrawlConfig } from './crawl-config.js';

it('--config accepts jsRender.consoleErrors without an unknown-key note (B35)', () => {
  const m = mergeCrawlConfig(
    { renderingMode: 'js', jsRender: { consoleErrors: true } },
    {},
    { url: 'https://example.com/' },
  );
  expect(m.kind).toBe('ok');
  if (m.kind !== 'ok') return;
  expect(m.config.jsRender.consoleErrors).toBe(true);
  expect(m.notes).toEqual([]);
});
