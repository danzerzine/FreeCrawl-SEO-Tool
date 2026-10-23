import { describe, expect, it } from 'vitest';
import { CLOUD_MAX_PX, CLOUD_MIN_PX, cloudSizes } from '../renderer/src/utils/topWordsCloud';

describe('B84 word cloud sizes', () => {
  it('font size follows the log of the count between the smallest and the largest', () => {
    const sizes = cloudSizes([{ count: 1000 }, { count: 100 }, { count: 10 }]);
    expect(sizes).toEqual([CLOUD_MAX_PX, Math.round((CLOUD_MIN_PX + CLOUD_MAX_PX) / 2), CLOUD_MIN_PX]);
  });

  it('equal counts get one middle size; an empty list gives none', () => {
    const mid = Math.round((CLOUD_MIN_PX + CLOUD_MAX_PX) / 2);
    expect(cloudSizes([{ count: 5 }, { count: 5 }])).toEqual([mid, mid]);
    expect(cloudSizes([])).toEqual([]);
  });

  it('a count of 1 does not break the log scale', () => {
    expect(cloudSizes([{ count: 1 }, { count: 1 }, { count: 8 }])).toEqual([CLOUD_MIN_PX, CLOUD_MIN_PX, CLOUD_MAX_PX]);
  });
});
