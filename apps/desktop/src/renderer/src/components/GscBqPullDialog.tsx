import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { GscBqPlanView, GscBqProgress, GscBqRunResult } from '@freecrawl/shared-types';

const GIB = 1024 ** 3;

function gib(bytes: number): string {
  return (bytes / GIB).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * B91 — the dialog of «Pull from BigQuery»: shows what a pull would read and cost (dry run),
 * and runs it only from that shown plan. Cancel is allowed while it runs; the run ledger
 * lets the next pull continue where this one stopped.
 */
export function GscBqPullDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** Called after a run ended (also a partial one), so the table reloads. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<GscBqPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reset, setReset] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GscBqProgress | null>(null);
  const [result, setResult] = useState<GscBqRunResult | null>(null);

  const load = useCallback(async (withReset: boolean) => {
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const res = await window.freecrawl.gscBqPlan({ reset: withReset || undefined });
      setPlan(res.plan);
      setError(res.ok ? null : (res.error ?? 'Failed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => window.freecrawl.onGscBqProgress((p) => setProgress(p)), []);

  const run = useCallback(
    async (recordEmpty: boolean) => {
      if (!plan || running) return;
      setRunning(true);
      setResult(null);
      setProgress(null);
      try {
        let planId = plan.planId;
        if (plan.needsReset) {
          // The saved data is dropped only now, on the explicit Pull after the box was ticked.
          const fresh = await window.freecrawl.gscBqPlan({ reset: true });
          if (!fresh.ok || !fresh.plan) {
            setError(fresh.error ?? 'Failed');
            return;
          }
          setPlan(fresh.plan);
          planId = fresh.plan.planId;
        }
        const res = await window.freecrawl.gscBqRun({ planId, recordEmpty });
        setResult(res);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
      }
    },
    [plan, running, onDone],
  );

  const title = t('gscBq.title', { defaultValue: 'Pull from BigQuery' });
  const btn =
    'h-6 rounded border border-surface-700 bg-surface-800 px-2.5 text-[11px] hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50';
  const primary =
    'h-6 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-surface-700 disabled:text-surface-500';

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-label={title}
        className="w-[460px] max-h-[80%] overflow-y-auto rounded border border-surface-700 bg-surface-900 p-4 text-[12px] text-surface-200 shadow-xl"
      >
        <div className="mb-2 text-[13px] font-semibold">{title}</div>

        {loading && (
          <div className="mb-3 flex items-center gap-2 text-surface-400">
            <Loader2 size={12} className="animate-spin" />
            {t('gscBq.planning', { defaultValue: 'Checking the export (dry run, no cost)…' })}
          </div>
        )}

        {error && <div className="mb-3 break-words text-red-400">{error}</div>}

        {plan && !result && (
          <div className="mb-3 space-y-1.5 text-surface-300">
            <div className="break-all text-surface-400">
              {plan.siteUrl} · {plan.searchType} · {plan.location}
            </div>
            {plan.range ? (
              <div>
                {t('gscBq.range', {
                  defaultValue: 'Range: {{start}} to {{end}}',
                  start: plan.range.start,
                  end: plan.range.end,
                })}
              </div>
            ) : null}
            <div>
              {t('gscBq.coverage', {
                defaultValue:
                  '{{covered}} days already pulled, {{missing}} days to pull in {{parts}} parts.',
                covered: plan.coveredDays,
                missing: plan.missingDays,
                parts: plan.parts.length,
              })}
            </div>
            {plan.revisedDays.length > 0 && (
              <div className="text-amber-300">
                {t('gscBq.revised', {
                  defaultValue:
                    '{{n}} pulled days were revised by Google since. Rebuild to include them.',
                  n: plan.revisedDays.length,
                })}
              </div>
            )}
            <div>
              {t('gscBq.estimate', {
                defaultValue:
                  'Estimated read: {{gib}} GiB ({{share}}% of the free 1 TB a month). Cap: {{cap}} GiB; billed so far: {{billed}} GiB.',
                gib: gib(plan.totalEstimate),
                share: (plan.freeTierShare * 100).toFixed(1),
                cap: gib(plan.capBytes),
                billed: gib(plan.billedSoFar),
              })}
            </div>
            {plan.overCap && (
              <div className="text-amber-300">
                {t('gscBq.overCap', {
                  defaultValue:
                    'The estimate is above the cap; the pull will stop at the cap and can be continued after raising it in Settings.',
                })}
              </div>
            )}
            {plan.needsReset && (
              <label className="flex items-center gap-2 text-amber-300">
                <input
                  type="checkbox"
                  checked={reset}
                  onChange={(e) => setReset(e.target.checked)}
                />
                {t('gscBq.needsReset', {
                  defaultValue:
                    'The settings changed since the saved data was pulled. Drop the saved BigQuery data and pull again.',
                })}
              </label>
            )}
            {plan.missingDays === 0 && !plan.needsReset && (
              <div>{t('gscBq.upToDate', { defaultValue: 'Nothing new to pull.' })}</div>
            )}
          </div>
        )}

        {running && (
          <div className="mb-3 flex items-center gap-2 text-surface-300">
            <Loader2 size={12} className="animate-spin text-blue-400" />
            {t('gscBq.running', {
              defaultValue: 'Pulling part {{done}} of {{total}}…',
              done: progress?.done ?? 0,
              total: progress?.total ?? plan?.parts.length ?? 0,
            })}
          </div>
        )}

        {result && (
          <div className="mb-3 space-y-1.5 text-surface-300">
            <div>
              {t('gscBq.result', {
                defaultValue:
                  '{{done}} parts pulled, {{skipped}} already there. Billed: {{billed}} GiB.',
                done: result.partsDone,
                skipped: result.partsSkipped,
                billed: gib(result.totalBilled),
              })}
            </div>
            {result.stopped && (
              <div className="break-words text-amber-300">{result.stopped.message}</div>
            )}
            {result.error && <div className="break-words text-red-400">{result.error}</div>}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {running ? (
            <button
              type="button"
              className={btn}
              onClick={() => void window.freecrawl.gscBqCancel()}
            >
              {t('gscBq.stop', { defaultValue: 'Stop' })}
            </button>
          ) : (
            <>
              {result?.stopped?.reason === 'empty' && (
                <button type="button" className={btn} onClick={() => void run(true)}>
                  {t('gscBq.recordEmpty', { defaultValue: 'Record empty months and continue' })}
                </button>
              )}
              <button type="button" className={btn} onClick={onClose}>
                {result
                  ? t('common.close', { defaultValue: 'Close' })
                  : t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              {!result && (
                <button
                  type="button"
                  className={primary}
                  disabled={
                    !plan || !plan.canRun || (plan.needsReset && !reset) || plan.missingDays === 0
                  }
                  onClick={() => void run(false)}
                >
                  {t('gscBq.pull', { defaultValue: 'Pull' })}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
