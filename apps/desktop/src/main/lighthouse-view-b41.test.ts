import { describe, expect, it } from 'vitest';
import { formatKb, formatSavingsMs, orderForView, resourceLine, type PagespeedAuditRow } from '@freecrawl/shared-types';

const row = (id: string, over: Partial<PagespeedAuditRow> = {}): PagespeedAuditRow => ({
  url: 'https://ex.test/a', strategy: 'mobile', auditId: id, kind: 'insight', title: id, score: 0, displayValue: null,
  savingsMs: null, savingsBytes: null, items: [], itemsTruncated: false, lighthouseVersion: '13.5.0', fetchedAt: 't', ...over,
});

describe('B41 R8: Lighthouse view model', () => {
  it('keeps the chosen device only and lists opportunities first, then insights, then diagnostics, biggest saving first within a kind', () => {
    const rows = [
      row('diag-big', { kind: 'diagnostic', savingsMs: 5000 }),
      row('ins-small', { savingsMs: 10 }),
      row('opp', { kind: 'opportunity', savingsMs: 1 }),
      row('ins-big', { savingsMs: 900 }),
      row('ins-null'),
      row('other-device', { strategy: 'desktop', savingsMs: 99999 }),
    ];
    expect(orderForView(rows, 'mobile').map((r) => r.auditId)).toEqual(['opp', 'ins-big', 'ins-small', 'ins-null', 'diag-big']);
    expect(orderForView(rows, 'desktop').map((r) => r.auditId)).toEqual(['other-device']);
  });

  it('formats savings: unknown is a dash, never 0', () => {
    expect(formatSavingsMs(null)).toBe('—');
    expect(formatSavingsMs(420)).toBe('420 ms');
    expect(formatSavingsMs(1250)).toBe('1.3 s');
    expect(formatKb(null)).toBe('—');
    expect(formatKb(2048)).toBe('2 KB');
    expect(formatKb(94194)).toBe('92 KB');
    expect(formatKb(300)).toBe('0.3 KB');
  });

  it('one line per stored resource: label or url, selector, wasted bytes', () => {
    expect(resourceLine({ url: 'https://ex.test/i.gif', wastedBytes: 2048 })).toBe('https://ex.test/i.gif · 2 KB');
    expect(resourceLine({ label: 'Avoids redirects', value: true })).toBe('Avoids redirects · yes');
    expect(resourceLine({ label: 'No compression applied', value: false })).toBe('No compression applied · no');
    expect(resourceLine({ selector: 'body > img', snippet: '<img src="x">' })).toBe('body > img · <img src="x">');
    expect(resourceLine({ wastedMs: 120, url: 'https://ex.test/s.js' })).toBe('https://ex.test/s.js · 120 ms');
  });
});
