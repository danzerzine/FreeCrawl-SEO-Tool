/**
 * Yandex Webmaster pull (B39). Electron-free: the desktop IPC handler only wires the token, the
 * open project, the URL normaliser and the cancel signal into it, which is also what the tests do.
 *
 * Two phases, each saved page by page as it arrives: the removal events, then the broken
 * internal links. A progress record in project_meta `webmasterRun:<host>` lets a stopped pull
 * continue where it stopped:
 *
 *   - valid until `max(startedAt, exceededUntil) + 24 h` (a daily quota stop sets `exceededUntil`,
 *     the time Yandex opens the quota again, so the pull resumes after the quota window opens);
 *   - only while the API's `count` for the list is unchanged; a changed count means the list
 *     shifted under the saved offset, so the whole pull restarts at 0 with a new `startedAt`
 *     (both phases, so the stale delete below cannot remove rows the new run never re-read);
 *   - a finished phase is only verified (one request at offset = count), not read again.
 *
 * When both phases finish, the host's rows not reported again (`fetched_at` before `startedAt`)
 * are deleted, the record is cleared and the fetch meta is written.
 */
import {
  WebmasterError,
  fetchWebmasterBrokenLinks,
  fetchWebmasterEvents,
  getWebmasterUserId,
  type WebmasterDeps,
} from '@freecrawl/core';
import type { ProjectDb } from '@freecrawl/db';
import type {
  WebmasterFetchMeta,
  WebmasterFetchResult,
  WebmasterProgress,
  WebmasterRunProgress,
} from '@freecrawl/shared-types';

const WINDOW_MS = 24 * 3_600_000;

export interface WebmasterPullInput {
  token: string;
  hostId: string;
  hostName: string;
  /** Maps a URL as Yandex's robot saw it onto `urls.url`; null when it cannot be mapped. */
  normalize: (url: string) => string | null;
  /** Skips the `GET /user` request when the caller has it. */
  userId?: number;
  signal?: AbortSignal;
  onProgress?: (p: WebmasterProgress) => void;
}

export interface WebmasterPullDeps {
  db: Pick<
    ProjectDb,
    | 'getMeta'
    | 'setMeta'
    | 'upsertWebmasterEvents'
    | 'upsertWebmasterBrokenLinks'
    | 'deleteStaleWebmasterRows'
    | 'countWebmasterRows'
  >;
  /** HTTP, base URL, pause and clock of the client; tests point `baseUrl` at a local server. */
  api?: WebmasterDeps;
  now: () => Date;
}

/** The list moved under the saved offset in the links phase: restart both phases. */
class RestartPull extends Error {}

export const webmasterRunKey = (hostId: string): string => `webmasterRun:${hostId}`;
export const webmasterMetaKey = (hostId: string): string => `webmasterFetchMeta:${hostId}`;

function fresh(startedAt: string): WebmasterRunProgress {
  return {
    startedAt,
    eventsOffset: 0,
    eventsDone: false,
    linksOffset: 0,
    linksDone: false,
    eventsCount: null,
    linksCount: null,
    exceededUntil: null,
    skippedRows: 0,
    truncatedAtCap: false,
  };
}

/** The saved record when it still counts: within 24 h of the later of `startedAt` and `exceededUntil`. */
function readRecord(raw: string | null, nowMs: number): WebmasterRunProgress | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as WebmasterRunProgress;
    const started = Date.parse(r.startedAt);
    if (Number.isNaN(started)) return null;
    const until = r.exceededUntil ? Date.parse(r.exceededUntil) : NaN;
    const from = Math.max(started, Number.isNaN(until) ? 0 : until);
    if (nowMs > from + WINDOW_MS) return null;
    return { ...fresh(r.startedAt), ...r };
  } catch {
    return null;
  }
}

const failure = (
  error: string,
  errorCode: WebmasterFetchResult['errorCode'],
  exceededUntil: string | null = null,
  cancelled = false,
): WebmasterFetchResult => ({ ok: false, meta: null, error, errorCode, exceededUntil, cancelled });

const quotaText = (until: string | null): string =>
  `Yandex Webmaster daily request quota is used up${until ? `; it opens again at ${until}` : ''}.`;

export async function pullWebmaster(
  input: WebmasterPullInput,
  deps: WebmasterPullDeps,
): Promise<WebmasterFetchResult> {
  const { db } = deps;
  const api = deps.api ?? {};
  const runKey = webmasterRunKey(input.hostId);
  const nowIso = (): string => deps.now().toISOString();

  let record = readRecord(db.getMeta(runKey), deps.now().getTime()) ?? fresh(nowIso());
  const save = (): void => db.setMeta(runKey, JSON.stringify(record));

  // Yandex said when the quota opens again: do not spend requests before that.
  const until = record.exceededUntil ? Date.parse(record.exceededUntil) : NaN;
  if (!Number.isNaN(until) && deps.now().getTime() < until) {
    return failure(
      quotaText(record.exceededUntil ?? null),
      'quota-exceeded',
      record.exceededUntil ?? null,
    );
  }
  record.exceededUntil = null;

  let restarts = 0;
  const phaseOpts = { signal: input.signal };
  const progress = (phase: WebmasterProgress['phase'], done: number, total: number): void =>
    input.onProgress?.({ running: true, phase, done, total });

  try {
    const userId = input.userId ?? (await getWebmasterUserId(input.token, api, input.signal));

    for (;;) {
      try {
        // Phase 1: removal events.
        const evStart = record.eventsDone ? (record.eventsCount ?? 0) : record.eventsOffset;
        const events = await fetchWebmasterEvents(
          input.token,
          userId,
          input.hostId,
          {
            ...phaseOpts,
            startOffset: evStart,
            expectedCount: record.eventsCount ?? undefined,
            onRestart: () => {
              record = fresh(nowIso());
            },
            onPage: (rows, next, count) => {
              const mapped = [];
              for (const r of rows) {
                const url = input.normalize(r.url);
                if (url) mapped.push({ ...r, url });
                else record.skippedRows = (record.skippedRows ?? 0) + 1;
              }
              db.upsertWebmasterEvents(input.hostId, mapped, nowIso());
              record.eventsOffset = next;
              record.eventsCount = count;
              save();
              progress('events', next, count);
            },
          },
          api,
        );
        record.eventsDone = true;
        record.eventsCount = events.count;
        record.eventsOffset = events.count;
        record.truncatedAtCap = record.truncatedAtCap || events.truncatedAtCap;
        save();

        // Phase 2: broken internal links.
        const lnStart = record.linksDone ? (record.linksCount ?? 0) : record.linksOffset;
        const links = await fetchWebmasterBrokenLinks(
          input.token,
          userId,
          input.hostId,
          {
            ...phaseOpts,
            startOffset: lnStart,
            expectedCount: record.linksCount ?? undefined,
            onRestart: () => {
              if (restarts < 1) throw new RestartPull();
              record = fresh(nowIso());
            },
            onPage: (rows, next, count) => {
              const mapped = [];
              for (const r of rows) {
                const sourceUrl = input.normalize(r.sourceUrl);
                const destinationUrl = input.normalize(r.destinationUrl);
                if (sourceUrl && destinationUrl) mapped.push({ ...r, sourceUrl, destinationUrl });
                else record.skippedRows = (record.skippedRows ?? 0) + 1;
              }
              db.upsertWebmasterBrokenLinks(input.hostId, mapped, nowIso());
              record.linksOffset = next;
              record.linksCount = count;
              save();
              progress('links', next, count);
            },
          },
          api,
        );
        record.linksDone = true;
        record.linksCount = links.count;
        record.linksOffset = links.count;
        record.truncatedAtCap = record.truncatedAtCap || links.truncatedAtCap;
        break;
      } catch (err) {
        if (err instanceof RestartPull) {
          restarts++;
          record = fresh(nowIso());
          save();
          continue;
        }
        throw err;
      }
    }

    db.deleteStaleWebmasterRows(input.hostId, record.startedAt);
    const counts = db.countWebmasterRows(input.hostId);
    const meta: WebmasterFetchMeta = {
      hostName: input.hostName,
      fetchedAt: nowIso(),
      eventRows: counts.events,
      brokenLinkRows: counts.links,
      skippedRows: record.skippedRows ?? 0,
      truncatedAtCap: record.truncatedAtCap === true,
    };
    db.setMeta(webmasterMetaKey(input.hostId), JSON.stringify(meta));
    db.setMeta(runKey, '');
    return { ok: true, meta, error: null, errorCode: null, exceededUntil: null, cancelled: false };
  } catch (err) {
    if (err instanceof WebmasterError) {
      if (err.code === 'quota-exceeded') {
        record.exceededUntil = err.exceededUntil;
        save();
      }
      return failure(err.message, err.code, err.exceededUntil, err.code === 'cancelled');
    }
    return failure('Yandex Webmaster pull failed unexpectedly.', 'api');
  }
}
