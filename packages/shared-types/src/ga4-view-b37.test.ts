import { describe, expect, it } from 'vitest';
import { ga4CellText, ga4PickerFields, ga4ToggleCustom, type Ga4Field } from './index.js';

const f = (apiName: string, kind: Ga4Field['kind'], customDefinition: boolean, uiName = apiName): Ga4Field => ({
  apiName,
  uiName,
  description: '',
  customDefinition,
  category: '',
  kind,
});
const FIELDS = [
  f('sessions', 'metric', false, 'Sessions'),
  f('customEvent:word_count', 'metric', true, 'Word count'),
  f('country', 'dimension', false, 'Country'),
  f('customEvent:author', 'dimension', true, 'Author'),
  f('customUser:plan', 'dimension', true, 'Plan'),
];

describe('B37 picker helpers', () => {
  it('lists the custom fields first, then the standard ones, each group by its label', () => {
    expect(ga4PickerFields(FIELDS, '').map((x) => x.apiName)).toEqual([
      'customEvent:author',
      'customUser:plan',
      'customEvent:word_count',
      'country',
      'sessions',
    ]);
  });

  it('keeps kind groups apart: dimensions before metrics inside each block', () => {
    const names = ga4PickerFields(FIELDS, '').map((x) => x.kind);
    expect(names).toEqual(['dimension', 'dimension', 'metric', 'dimension', 'metric']);
  });

  it('search matches the API name or the label, ignoring case', () => {
    expect(ga4PickerFields(FIELDS, 'WORD').map((x) => x.apiName)).toEqual(['customEvent:word_count']);
    expect(ga4PickerFields(FIELDS, 'customuser').map((x) => x.apiName)).toEqual(['customUser:plan']);
    expect(ga4PickerFields(FIELDS, 'nothing')).toEqual([]);
  });

  it('adds up to ten metrics and five dimensions, then refuses with the reason; removing always works', () => {
    const tenMetrics = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(ga4ToggleCustom(tenMetrics, [], f('m10', 'metric', true))).toEqual({ metrics: tenMetrics, dimensions: [], blocked: 'metrics' });
    expect(ga4ToggleCustom(tenMetrics, [], f('m3', 'metric', true))).toEqual({ metrics: tenMetrics.filter((m) => m !== 'm3'), dimensions: [] });
    const fiveDims = ['d0', 'd1', 'd2', 'd3', 'd4'];
    expect(ga4ToggleCustom([], fiveDims, f('d5', 'dimension', true))).toEqual({ metrics: [], dimensions: fiveDims, blocked: 'dimensions' });
    expect(ga4ToggleCustom([], ['d0'], f('d1', 'dimension', true))).toEqual({ metrics: [], dimensions: ['d0', 'd1'] });
  });
});

describe('B37 cell text', () => {
  it('a metric shows its number', () => {
    expect(ga4CellText([{ value: '1234.5', sessions: null }])).toBe('1234.5');
  });
  it('a dimension shows the value with most sessions and «+N» for the rest', () => {
    expect(
      ga4CellText([
        { value: 'Ann', sessions: 3 },
        { value: 'Bob', sessions: 9 },
        { value: 'Cy', sessions: 1 },
      ]),
    ).toBe('Bob +2');
    expect(ga4CellText([{ value: 'Ann', sessions: 3 }])).toBe('Ann');
  });
  it('no values is an empty cell (blank = no data from GA4 for this range)', () => {
    expect(ga4CellText(undefined)).toBe('');
    expect(ga4CellText([])).toBe('');
  });
});
