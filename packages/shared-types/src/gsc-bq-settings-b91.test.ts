import { describe, expect, it } from 'vitest';
import { GSC_BQ_ACCOUNT, defaultGscSettings, mergeGscSettings } from './google.js';

describe('B91 settings', () => {
  it('an old settings blob without the new keys reads as source api and the defaults', () => {
    const s = mergeGscSettings({ property: 'sc-domain:a.com', dateRange: '90d', matchCase: true });
    expect(s.source).toBe('api');
    expect(s.bqDataProject).toBe('');
    expect(s.bqDataset).toBe('searchconsole');
    expect(s.bqMaxGiB).toBe(10);
    expect(s.property).toBe('sc-domain:a.com');
    expect(s.matchCase).toBe(true);
    expect(mergeGscSettings(null)).toEqual(defaultGscSettings());
  });

  it('enforces the cap bounds 0.1 to 1000 and falls back on junk', () => {
    expect(mergeGscSettings({ bqMaxGiB: 0 }).bqMaxGiB).toBe(0.1);
    expect(mergeGscSettings({ bqMaxGiB: 5000 }).bqMaxGiB).toBe(1000);
    expect(mergeGscSettings({ bqMaxGiB: 2.5 }).bqMaxGiB).toBe(2.5);
    expect(mergeGscSettings({ bqMaxGiB: 'x' }).bqMaxGiB).toBe(10);
    expect(mergeGscSettings({ source: 'nope' }).source).toBe('api');
    expect(mergeGscSettings({ source: 'bigquery', bqDataset: '  ' }).bqDataset).toBe('searchconsole');
  });

  it('the bq account id is bq', () => {
    expect(GSC_BQ_ACCOUNT).toBe('bq');
  });
});
