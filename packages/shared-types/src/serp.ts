import type { SeoThresholds } from './seo-thresholds.js';

/** SERP-lite (B85): the shapes the check, the CLI and the Reports dialog share. */

export interface SerpInputRow {
  url?: string;
  title: string;
  description: string;
}

/** One status per row for reading; chars are judged before pixels. */
export type SerpStatus =
  | 'ok'
  | 'missing'
  | 'too-short'
  | 'too-long'
  | 'pixel-too-short'
  | 'pixel-too-long';

export interface SerpFlags {
  titleTooShort: boolean;
  titleTooLong: boolean;
  titlePxShort: boolean;
  titlePxLong: boolean;
  descTooShort: boolean;
  descTooLong: boolean;
  descPxShort: boolean;
  descPxLong: boolean;
}

export interface SerpRowResult {
  url: string;
  title: string;
  titleChars: number;
  titlePx: number;
  titleStatus: SerpStatus;
  /** The title up to the last character that fits `titleMaxPx` (the whole title when it fits). */
  titleTruncated: string;
  description: string;
  descChars: number;
  descPx: number;
  descStatus: SerpStatus;
  /** The four independent checks per text, as the crawl keeps them. */
  flags: SerpFlags;
  /** Size of the group of rows with the same text (trimmed, case-folded); 0 when the text is unique or empty. */
  duplicateTitle: number;
  duplicateDescription: number;
}

/** IPC `reports:serp-check`: pasted text or ready rows, optional limits. Nothing is stored. */
export interface SerpCheckInput {
  text?: string;
  rows?: SerpInputRow[];
  thresholds?: Partial<SeoThresholds>;
}
