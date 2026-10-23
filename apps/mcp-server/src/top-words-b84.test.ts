import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DesktopBridge from './desktop-bridge.js';

vi.mock('./desktop-bridge.js', async (orig) => ({
  ...(await orig<typeof DesktopBridge>()),
  bridgeRequest: vi.fn(async () => ({ ok: true })),
}));
import { bridgeRequest } from './desktop-bridge.js';
import { buildTools } from './tools.js';

const tool = () => buildTools().find((t) => t.name === 'report_top_words')!;
const sent = vi.mocked(bridgeRequest);
beforeEach(() => sent.mockClear());

describe('B84 MCP report_top_words', () => {
  it('without the new arguments it calls the old action (default = old behaviour)', async () => {
    await tool().handler({ limit: 10, locale: 'en' }, undefined as never);
    expect(sent).toHaveBeenCalledWith('POST', '/v1/action/report-top-words', { limit: 10, locale: 'en' });
  });

  it.each([{ n: 2 }, { bySection: true }, { section: 'news' }, { url: 'https://ex.test/a' }])(
    '%j calls the blocks action',
    async (args) => {
      await tool().handler(args, undefined as never);
      expect(sent).toHaveBeenCalledWith('POST', '/v1/action/report-top-words-blocks', args);
    },
  );

  it('the schema offers ru and the new arguments', () => {
    const props = (tool().inputSchema as { properties: Record<string, { enum?: unknown[] }> }).properties;
    expect(props.locale!.enum).toContain('ru');
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['n', 'bySection', 'section', 'sectionDepth', 'url', 'includeBody']));
  });
});
