/** Smallest and largest font size (px) of the Top Words cloud. */
export const CLOUD_MIN_PX = 12;
export const CLOUD_MAX_PX = 32;

/**
 * Font size of each cloud entry: the log of its count, scaled between the smallest and the largest
 * count of the list, so a few very frequent words do not shrink the rest to dust.
 */
export function cloudSizes(entries: readonly { count: number }[]): number[] {
  if (entries.length === 0) return [];
  const logs = entries.map((e) => Math.log(Math.max(1, e.count)));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  const mid = Math.round((CLOUD_MIN_PX + CLOUD_MAX_PX) / 2);
  if (hi === lo) return logs.map(() => mid);
  return logs.map((l) =>
    Math.round(CLOUD_MIN_PX + ((l - lo) / (hi - lo)) * (CLOUD_MAX_PX - CLOUD_MIN_PX)),
  );
}
