/**
 * The steps of a scheduled crawl that compares itself with the previous one (B81, B116), pulled out of the
 * main process so each can be tested with plain functions: the copy before the crawl starts, the change
 * report with its deferred alert, the `changes` field of the webhook and the save at the end.
 */
import { compareChangesText, compareHasChanges, type CompareSummary } from '@freecrawl/core';

type Log = (level: 'info' | 'warn', message: string) => void;

export interface ScheduledLaunchDeps {
  /** Copies the saved project aside; rejects when it cannot. */
  keepPreviousCrawl: (projectPath: string) => Promise<void>;
  /** A crawl is already running in this window (one started by hand while the copy ran). */
  crawlActive: () => boolean;
  /** Starts the scheduled crawl. */
  launch: () => void;
  /** Writes the outcome into the schedule's status. */
  recordSkipped: () => void;
  log: Log;
}

/**
 * Starts a scheduled crawl. With a change report asked for, the project is copied first, so the first
 * autosave of the crawl cannot change what the report compares with; a failed copy only costs the report.
 * A crawl started by hand while the copy ran wins: the scheduled one is skipped, and the skip is written
 * to the schedule's status and the log, not dropped silently.
 */
export async function launchScheduledCrawl(
  deps: ScheduledLaunchDeps,
  projectPath: string,
  withChangeReport: boolean,
): Promise<'launched' | 'skipped'> {
  if (withChangeReport) {
    try {
      await deps.keepPreviousCrawl(projectPath);
    } catch (err) {
      deps.log(
        'warn',
        `Copy of the previous crawl failed, the change report will be skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (deps.crawlActive()) {
    deps.recordSkipped();
    deps.log('warn', 'Scheduled crawl skipped: a crawl was started by hand while the previous crawl was being copied');
    return 'skipped';
  }
  deps.launch();
  return 'launched';
}

export interface ScheduledChangeDeps {
  /** Compares the new crawl with the copy; null when there is no copy. */
  runChangeReport: () => Promise<CompareSummary | null>;
  /** The deferred alert of the project's monitoring rules, with the change report as its footer. */
  alert: (opts: { footer?: string; footerChanged: boolean }) => unknown;
  log: Log;
}

/**
 * The change report of a scheduled crawl and the alert that follows it. The alert goes out whatever the
 * report did (it carries the monitoring rules, which do not depend on it); a failed report is returned as
 * an error line for the webhook and the log, never thrown.
 */
export async function scheduledChangeReport(
  deps: ScheduledChangeDeps,
): Promise<{ changes: CompareSummary | null; error: string | null }> {
  let changes: CompareSummary | null = null;
  let error: string | null = null;
  try {
    changes = await deps.runChangeReport();
    if (!changes) {
      deps.log('info', 'Change report skipped: no copy of the previous crawl (the copy at the crawl start failed)');
    } else {
      deps.log('info', compareChangesText(changes));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = `compare: ${msg}`;
    deps.log('warn', `Change report failed: ${msg}`);
  }
  void deps.alert({
    footer: changes ? compareChangesText(changes) : undefined,
    footerChanged: changes ? compareHasChanges(changes) : false,
  });
  return { changes, error };
}

/** The `changes` field of the scheduled webhook; null without a change report. */
export function webhookChanges(changes: CompareSummary | null): {
  totalBefore: number;
  totalAfter: number;
  counts: CompareSummary['counts'];
  checksChanged: number;
  notComparable: string[];
} | null {
  if (!changes) return null;
  return {
    totalBefore: changes.totalA,
    totalAfter: changes.totalB,
    counts: changes.counts,
    checksChanged: Object.keys(changes.issueChanges).length,
    notComparable: Object.keys(changes.notComparable),
  };
}

export interface ScheduledSaveDeps {
  /** True while another save of this window is running; set and cleared around ours. */
  saveInFlight: () => boolean;
  setSaveInFlight: (value: boolean) => void;
  save: () => Promise<void>;
  log: Log;
}

/** Saves the project after a compared crawl so the next run's copy holds this crawl. */
export async function saveAfterScheduledCrawl(deps: ScheduledSaveDeps): Promise<'saved' | 'skipped' | 'failed'> {
  if (deps.saveInFlight()) return 'skipped';
  deps.setSaveInFlight(true);
  try {
    await deps.save();
    deps.log('info', 'Saved the project for the next change report');
    return 'saved';
  } catch (err) {
    deps.log('warn', `Save after the scheduled crawl failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  } finally {
    deps.setSaveInFlight(false);
  }
}
