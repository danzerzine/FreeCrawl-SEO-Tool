import type { UrlCategory } from './crawl.js';

/**
 * Limits the length, pixel-width and thin-content checks compare against
 * (B77). One place holds the defaults; a project stores the values it is
 * counted with, so SQL, labels and compare all read the same numbers.
 *
 * Characters and the thin-content word count follow the limits SEO tools
 * commonly ship, so reports from different tools agree. Pixel widths are
 * measured with Google's result font (Arial 18 px for titles, 14 px for
 * descriptions); the upper limits are where Google cuts the snippet.
 */
export interface SeoThresholds {
  titleMinChars: number;
  titleMaxChars: number;
  titleMinPx: number;
  titleMaxPx: number;
  descriptionMinChars: number;
  descriptionMaxChars: number;
  descriptionMinPx: number;
  descriptionMaxPx: number;
  /** Pages with fewer words than this are thin content. */
  thinContentWords: number;
  /** Pages whose visible text is under this share of the HTML (percent) are flagged Low Text/Code Ratio. */
  textCodeRatioMinPercent: number;
  /** B44b: a rendered page leaving more than this share of its CSS unused (percent). */
  cssUnusedPct: number;
  /** B44b: a rendered page leaving more than this share of its JavaScript unused (percent). */
  jsUnusedPct: number;
}

export const DEFAULT_SEO_THRESHOLDS: Readonly<SeoThresholds> = Object.freeze({
  titleMinChars: 30,
  titleMaxChars: 60,
  titleMinPx: 200,
  titleMaxPx: 600,
  descriptionMinChars: 70,
  descriptionMaxChars: 155,
  descriptionMinPx: 400,
  descriptionMaxPx: 990,
  thinContentWords: 200,
  textCodeRatioMinPercent: 10,
  cssUnusedPct: 50,
  jsUnusedPct: 50,
});

/** The checks each threshold feeds; compare uses it to name what a changed threshold affects. */
export const SEO_THRESHOLD_CHECKS: Readonly<Record<keyof SeoThresholds, readonly UrlCategory[]>> = {
  titleMinChars: ['issues:title-too-short'],
  titleMaxChars: ['issues:title-too-long'],
  titleMinPx: ['issues:title-pixel-width-too-short'],
  titleMaxPx: ['issues:title-pixel-width-too-long'],
  descriptionMinChars: ['issues:meta-too-short'],
  descriptionMaxChars: ['issues:meta-too-long'],
  descriptionMinPx: ['issues:meta-pixel-width-too-short'],
  descriptionMaxPx: ['issues:meta-pixel-width-too-long'],
  thinContentWords: ['issues:content-thin'],
  textCodeRatioMinPercent: ['issues:text-code-ratio-low'],
  cssUnusedPct: ['issues:css-unused'],
  jsUnusedPct: ['issues:js-unused'],
};

/** Every key filled: a missing, negative or non-numeric value falls back to its default. */
export function resolveSeoThresholds(partial?: Partial<SeoThresholds> | null): SeoThresholds {
  const out = { ...DEFAULT_SEO_THRESHOLDS };
  if (!partial || typeof partial !== 'object') return out;
  for (const key of Object.keys(out) as (keyof SeoThresholds)[]) {
    const v = Number(partial[key]);
    if (partial[key] != null && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v);
  }
  return out;
}

/** Checks whose thresholds differ between two crawls. */
export function checksWithDifferentThresholds(a: SeoThresholds, b: SeoThresholds): UrlCategory[] {
  const out: UrlCategory[] = [];
  for (const key of Object.keys(SEO_THRESHOLD_CHECKS) as (keyof SeoThresholds)[]) {
    if (a[key] !== b[key]) out.push(...SEO_THRESHOLD_CHECKS[key]);
  }
  return out;
}

/** Fills `{{titleMaxChars}}`-style placeholders in a label with the thresholds. */
export function fillThresholdLabel(
  label: string,
  t: SeoThresholds = DEFAULT_SEO_THRESHOLDS,
): string {
  if (!label.includes('{{')) return label;
  return label.replace(/\{\{(\w+)\}\}/g, (m, key: string) =>
    key in t ? String(t[key as keyof SeoThresholds]) : m,
  );
}
