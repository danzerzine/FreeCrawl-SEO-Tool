import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DesktopBridge from './desktop-bridge.js';

vi.mock('./desktop-bridge.js', async (orig) => ({
  ...(await orig<typeof DesktopBridge>()),
  bridgeRequest: vi.fn(async () => ({ rows: [], targets: 0 })),
}));
import { bridgeRequest } from './desktop-bridge.js';
import { buildTools } from './tools.js';

const tool = () => buildTools().find((t) => t.name === 'report_link_suggestions')!;
const sent = vi.mocked(bridgeRequest);
beforeEach(() => sent.mockClear());

describe('B93 MCP report_link_suggestions', () => {
  it('is listed, needs no local project file and takes the report thresholds', () => {
    const names = buildTools().map((t) => t.name);
    expect(names).toContain('report_link_suggestions');
    expect(names.indexOf('report_link_suggestions')).toBeLessThan(names.indexOf('report_redirect_inlinks'));
    expect(tool().requiresDb).toBe(false);
    const props = (tool().inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual([
      'maxInlinks',
      'maxSourceOutlinks',
      'maxTargets',
      'minCloseness',
      'perSource',
      'perTarget',
    ]);
  });

  it('forwards the input to the bridge action and returns its rows', async () => {
    sent.mockResolvedValueOnce({ rows: [{ rank: 1 }], targets: 1, withoutSuggestion: 0, truncated: false });
    const out = await tool().handler({ perTarget: 2 }, undefined as never);
    expect(sent).toHaveBeenCalledWith('POST', '/v1/action/report-link-suggestions', { perTarget: 2 });
    expect(out).toMatchObject({ rows: [{ rank: 1 }] });
  });

  it('passes notComputed through unchanged', async () => {
    sent.mockResolvedValueOnce({ notComputed: true });
    expect(await tool().handler({}, undefined as never)).toEqual({ notComputed: true });
  });
});
