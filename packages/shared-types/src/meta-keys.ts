/**
 * Names of the `project_meta` rows the integrations write, defined once: the desktop app, the CLI and the
 * db package all read them (B168).
 */

/**
 * Key of one Google account's row for `base` (`ga4FetchMeta`, `gscFetchMeta`, `ga4CustomRun`). A project
 * from before accounts were linked kept the row under the bare `base`; an empty account id is that row.
 */
export function googleMetaKey(base: string, accountId: string): string {
  return accountId ? `${base}:${accountId}` : base;
}

/** Key of the last Yandex Webmaster pull's metadata for one host. */
export const webmasterMetaKey = (hostId: string): string => `webmasterFetchMeta:${hostId}`;

/**
 * Whether a pasted Yandex OAuth token has the shape of one: a single run of token characters, no spaces or
 * line breaks (which would reach the HTTP client and be quoted in its error).
 */
export const isYandexTokenShape = (token: string): boolean => /^[A-Za-z0-9._~+/=-]+$/.test(token);
