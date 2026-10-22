import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { CrawlConfig } from '@freecrawl/shared-types';

/** Finished internal URLs the trouble share is taken over. */
const OUTCOME_WINDOW = 50;
const TROUBLE_MIN = 3;
const TROUBLE_SHARE = 0.2;
const TROUBLE_CUT_EVERY_MS = 60_000;
/** Page answers that set the base, and the rolling window compared with it. */
const LATENCY_WINDOW = 20;
const SLOW_FACTOR = 1.8;
const SLOW_MARGIN_MS = 300;
/** Above this share of the base clean answers do not raise the rate. */
const RECOVER_FACTOR = 1.3;
const SLOW_CUT_EVERY_MS = 30_000;
/** A sample is dropped when the process itself stalled this long. */
const BUSY_LOOP_MS = 100;

/**
 * What adaptive speed learns from answers other than 429/503: a server
 * that fails a share of its URLs (5xx, timeouts, network errors), and one
 * whose answers grow slow. Pure bookkeeping on an injected clock; the
 * crawler turns a `true` into a pause and a rate cut.
 */
export class ServerHealth {
  private outcomes: boolean[] = [];
  private lastTroubleCut = Number.NEGATIVE_INFINITY;
  private base: number | null = null;
  private samples: number[] = [];
  private lastSlowCut = Number.NEGATIVE_INFINITY;
  /** Set by a cut until 20 fresh answers show whether slowing down helped. */
  private afterCut = false;
  /** A cut did not help: answers counted since, to accept the slow level after 20. */
  private unhelped: number | null = null;

  /**
   * One finished internal URL, counted once after its retries; `trouble`
   * when it ended in a 5xx other than 503, a timeout, a network error or
   * an answer over 5 s. True when a cut is due: at least 3 trouble URLs
   * that are at least 20 % of the last 50, at most once a minute.
   */
  noteOutcome(trouble: boolean, now: number): boolean {
    this.outcomes.push(trouble);
    if (this.outcomes.length > OUTCOME_WINDOW) this.outcomes.shift();
    const count = this.outcomes.filter(Boolean).length;
    if (count < TROUBLE_MIN || count < TROUBLE_SHARE * this.outcomes.length) return false;
    if (now - this.lastTroubleCut < TROUBLE_CUT_EVERY_MS) return false;
    this.lastTroubleCut = now;
    this.outcomes = [];
    return true;
  }

  /**
   * Time to the response headers of a 2xx internal page fetched in one
   * attempt. `busyMs` is the longest event-loop stall since the previous
   * sample: over 100 ms the number measures this process, not the server,
   * and is dropped. True when a cut is due: the median of the last 20 is
   * over 1.8 × the base and over base + 300 ms, at most once per 30 s.
   *
   * The 20 answers after a cut are a fresh window. Still slower than
   * 1.3 × the base, the rate is held for 20 more answers (a cut may come
   * in them); still slow after a second cut or those answers, the slowness
   * is not this crawl's load (a site whose first pages are cached sections
   * and later ones articles looks like this): the slow median becomes the
   * base, so the rate may rise again and only a further slowdown cuts
   * again. A median under base / 1.8 brings the base back down, so a later
   * slowdown of a server that recovered is cut again.
   */
  noteLatency(ms: number, busyMs: number, now: number): boolean {
    if (busyMs > BUSY_LOOP_MS) return false;
    this.samples.push(ms);
    if (this.samples.length > LATENCY_WINDOW) this.samples.shift();
    if (this.base === null || this.afterCut) {
      if (this.samples.length < LATENCY_WINDOW) return false;
      const fresh = median(this.samples);
      this.afterCut = false;
      if (this.base === null) this.base = fresh;
      else if (fresh <= RECOVER_FACTOR * this.base) this.unhelped = null;
      else if (this.unhelped !== null) this.accept(fresh);
      else this.unhelped = 0;
      return false;
    }
    const m = median(this.samples);
    if (this.samples.length === LATENCY_WINDOW && m < this.base / SLOW_FACTOR) this.base = m;
    if (this.unhelped !== null && ++this.unhelped >= LATENCY_WINDOW) {
      if (m > RECOVER_FACTOR * this.base) this.accept(m);
      else this.unhelped = null;
    }
    if (m <= SLOW_FACTOR * this.base || m <= this.base + SLOW_MARGIN_MS) return false;
    if (now - this.lastSlowCut < SLOW_CUT_EVERY_MS) return false;
    this.lastSlowCut = now;
    this.samples = [];
    this.afterCut = true;
    return true;
  }

  /** From a cut until answers are back under 1.3 × the base, or a slow level is accepted: hold the rate. */
  isSlow(): boolean {
    if (this.base === null) return false;
    if (this.afterCut) return true;
    return median(this.samples) > RECOVER_FACTOR * this.base;
  }

  private accept(slowMedian: number): void {
    this.base = slowMedian;
    this.unhelped = null;
  }
}

/** Upper median. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The longest event-loop stall between two reads. */
export class LoopDelayProbe {
  private readonly histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });

  constructor() {
    this.histogram.enable();
  }

  maxSinceLastMs(): number {
    const max = this.histogram.max / 1e6;
    this.histogram.reset();
    return max;
  }

  stop(): void {
    this.histogram.disable();
  }
}

/** Local hour `hour` is inside [from, to); the window may wrap midnight; from == to is none. */
export function inNightWindow(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** `maxRps`, or `nightMaxRps` inside the night window when that is set. */
export function nightAwareMaxRps(
  config: Pick<CrawlConfig, 'maxRps' | 'nightMaxRps' | 'nightFromHour' | 'nightToHour'>,
  now: Date,
): number {
  return config.nightMaxRps > 0 &&
    inNightWindow(now.getHours(), config.nightFromHour, config.nightToHour)
    ? config.nightMaxRps
    : config.maxRps;
}
