import { describe, expect, it } from 'vitest';
import { resolveTrackerConfig } from './tracker-config.js';
import { TRACKER_TEST_ENV } from './tracker-constants.js';

const GH = { token: 'ghp_x', owner: 'o', repo: 'r' };
const BC = { accessToken: 'bc_x', accountId: '1', todolistId: '2' };

describe('resolveTrackerConfig', () => {
  it('uses the stored apiBase', () => {
    const r = resolveTrackerConfig('github', { ...GH, apiBase: 'http://127.0.0.1:9' }, {});
    expect(r).toMatchObject({ ok: true, cfg: { apiBase: 'http://127.0.0.1:9', owner: 'o', repo: 'r', token: 'ghp_x' } });
  });

  it('fills the default host when apiBase is empty, outside test mode', () => {
    const r = resolveTrackerConfig('basecamp', BC, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cfg.apiBase).toMatch(/^https:\/\//);
  });

  it('names the missing field when the integration is not set up', () => {
    const r = resolveTrackerConfig('github', { token: 'x' }, {});
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/owner/);
  });

  it('test mode: loopback is allowed', () => {
    const env = { [TRACKER_TEST_ENV]: '1' };
    expect(resolveTrackerConfig('github', { ...GH, apiBase: 'http://127.0.0.1:5' }, env).ok).toBe(true);
    expect(resolveTrackerConfig('basecamp', { ...BC, apiBase: 'http://localhost:5' }, env).ok).toBe(true);
  });

  it('test mode: an empty apiBase is refused, because the default is a real host', () => {
    const env = { [TRACKER_TEST_ENV]: '1' };
    const r = resolveTrackerConfig('github', { ...GH, apiBase: '' }, env);
    expect(r).toMatchObject({ ok: false });
    const r2 = resolveTrackerConfig('basecamp', BC, env);
    expect(r2).toMatchObject({ ok: false });
  });

  it('test mode: any non-loopback address is refused', () => {
    const env = { [TRACKER_TEST_ENV]: '1' };
    const r = resolveTrackerConfig('github', { ...GH, apiBase: 'https://example.com' }, env);
    expect(r).toMatchObject({ ok: false });
  });

  it('declares the switch as FREECRAWL_E2E', () => {
    expect(TRACKER_TEST_ENV).toBe('FREECRAWL_E2E');
  });
});
