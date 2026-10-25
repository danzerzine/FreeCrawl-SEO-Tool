import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { ISSUE_GROUPS, type ExportSet, type ExportSetChoiceGroup } from '@freecrawl/shared-types';
import { translateLabel } from '../i18n/labels.js';
import { TAB_ORDER } from '../store.js';

/** `issues:<check>` → its sidebar group and check labels (English, translated at render). */
const ISSUE_LABELS = new Map(
  ISSUE_GROUPS.flatMap((g) => g.items.map((i) => [i.category as string, [g.label, i.label] as const])),
);
const TAB_LABELS = new Map(TAB_ORDER.map((tab) => [`tab:${tab.key}`, tab.label]));
/** Link report token → the Reports dialog's label key. */
const REPORT_KEYS: Record<string, string> = {
  'redirect-inlinks': 'redirectInlinks',
  'redirects-to-error': 'redirectsToError',
  'error-inlinks': 'errorInlinks',
  'non-indexable-inlinks': 'nonIndexableInlinks',
};

/**
 * B14 — saved export sets: the `freecrawl export --save-set` / `--set`
 * lists, made and run from the app. A set holds `--what` tokens; it is
 * stored in the project, so the CLI and a scheduled crawl run the same set.
 * Same shell, classes and spacing as Export As.
 */
interface ExportSetsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ExportSetsDialog({ open, onClose }: ExportSetsDialogProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [sets, setSets] = useState<ExportSet[]>([]);
  const [groups, setGroups] = useState<ExportSetChoiceGroup[]>([]);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rawHeaders, setRawHeaders] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    setSets(await window.freecrawl.exportSetsList());
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus('');
    void reload();
    void window.freecrawl.exportSetsChoices().then(setGroups);
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const groupTitle: Record<ExportSetChoiceGroup['group'], string> = {
    exports: t('exportSets.groupExports', { defaultValue: 'Whole exports' }),
    links: t('exportSets.groupLinks', { defaultValue: 'Link reports' }),
    tabs: t('exportSets.groupTabs', { defaultValue: 'Tabs' }),
    issues: t('exportSets.groupIssues', { defaultValue: 'Issue lists' }),
    datasets: t('exportSets.groupDatasets', { defaultValue: 'Datasets' }),
    issueInlinks: t('exportSets.groupIssueInlinks', { defaultValue: 'Inlinks to pages with an issue' }),
  };
  const tokenLabel = (token: string, label?: string): string | undefined => {
    switch (token) {
      case 'bulk':
        return t('scheduled.exportBulk', { defaultValue: 'Bulk export (CSV folder)' });
      case 'seo-audit':
        return t('scheduled.exportSeoAudit', { defaultValue: 'SEO Audit (Screaming Frog layout)' });
      case 'html':
        return t('scheduled.exportHtml', { defaultValue: 'HTML report' });
      case 'audit':
        return t('exportSets.tokenAudit', { defaultValue: 'Audit report (HTML)' });
      case 'issues':
        return t('exportSets.tokenIssues', { defaultValue: 'Issues summary' });
      case 'pdfs':
        return t('exportSets.tokenPdfs', { defaultValue: 'PDF files (downloaded with the crawl settings)' });
      case 'screenshots':
        return t('exportSets.tokenScreenshots', { defaultValue: 'Screenshots' });
    }
    // The labels the sidebar, tab bar and Reports dialog show, so a set
    // reads the same as the rest of the app in every language.
    const issue = ISSUE_LABELS.get(token.replace(/^issue-inlinks:/, 'issues:'));
    if (issue) return issue.map((l) => translateLabel(l, lang)).join(' — ');
    const tab = TAB_LABELS.get(token);
    if (tab) return translateLabel(tab, lang);
    const report = REPORT_KEYS[token];
    if (report) return t(`reports.report.${report}`, { defaultValue: label });
    return label ? translateLabel(label, lang) : undefined;
  };

  /** Picker order, so a saved set reads the way the list does. */
  const order = useMemo(() => groups.flatMap((g) => g.choices.map((c) => c.token)), [groups]);
  const q = filter.trim().toLowerCase();

  const toggle = (token: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  const load = (set: ExportSet) => {
    setName(set.name);
    setPicked(new Set(set.what));
    setRawHeaders(set.rawHeaders === true);
    setStatus('');
  };

  const fail = (prefix: string, err: unknown) =>
    setStatus(
      prefix +
        ': ' +
        (err instanceof Error ? err.message : String(err)),
    );

  const save = async () => {
    setBusy(true);
    try {
      const what = [
        ...order.filter((tok) => picked.has(tok)),
        ...[...picked].filter((tok) => !order.includes(tok)),
      ];
      const saved = await window.freecrawl.exportSetSave({ name, what, ...(rawHeaders ? { rawHeaders } : {}) });
      await reload();
      setStatus(t('exportSets.savedMsg', { name: saved.name, defaultValue: 'Saved the set "{{name}}".' }));
    } catch (err) {
      fail(t('exportSets.saveFailed', { defaultValue: 'Could not save the set' }), err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (setName: string) => {
    if (
      !window.confirm(
        t('exportSets.deleteConfirm', { name: setName, defaultValue: 'Delete the export set "{{name}}"?' }),
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await window.freecrawl.exportSetDelete(setName);
      await reload();
      setStatus(t('exportSets.deletedMsg', { name: setName, defaultValue: 'Deleted the set "{{name}}".' }));
    } catch (err) {
      fail(t('exportSets.deleteFailed', { defaultValue: 'Could not delete the set' }), err);
    } finally {
      setBusy(false);
    }
  };

  const run = async (setName: string) => {
    setBusy(true);
    setStatus('');
    try {
      await window.freecrawl.exportSetRun(setName);
    } catch (err) {
      fail(t('export.failedPrefix', { defaultValue: 'Export failed' }), err);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const canSave = !busy && name.trim() !== '' && picked.size > 0;
  const smallButton =
    'rounded border border-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300 hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        data-testid="export-sets-dialog"
        className="flex max-h-[90vh] w-[860px] max-w-[95vw] flex-col rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-2.5">
          <div className="text-sm font-semibold text-surface-100">
            {t('exportSets.title', { defaultValue: 'Saved Export Sets' })}
          </div>
          <button
            className="rounded p-1 text-surface-400 hover:bg-surface-800 hover:text-surface-100"
            onClick={onClose}
            title={t('common.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-4">
            <section className="flex min-h-0 flex-col">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-surface-400">
                {t('exportSets.savedSets', { defaultValue: 'Saved sets' })}
              </div>
              <div className="max-h-[420px] overflow-auto rounded border border-surface-800 bg-surface-950/50 p-2">
                {sets.length === 0 ? (
                  <div className="px-2 py-4 text-center text-[11px] text-surface-500">
                    {t('exportSets.empty', {
                      defaultValue: 'No saved sets yet. Tick exports on the right, name the set and save it.',
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {sets.map((s) => (
                      <div
                        key={s.name}
                        data-testid={`export-sets-row-${s.name}`}
                        className={clsx(
                          'flex items-center gap-2 rounded px-1.5 py-1 text-[12px]',
                          s.name === name.trim()
                            ? 'bg-accent-500/10 text-surface-100'
                            : 'text-surface-300 hover:bg-surface-800/60',
                        )}
                      >
                        <button
                          type="button"
                          data-testid={`export-sets-load-${s.name}`}
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                          title={t('exportSets.loadHint', { defaultValue: 'Load into the form to change it' })}
                          onClick={() => load(s)}
                        >
                          <span className="truncate">{s.name}</span>
                          <span className="w-full truncate font-mono text-[10px] text-surface-500">
                            {s.what.join(', ')}
                            {s.rawHeaders ? ' · --raw-headers' : ''}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid={`export-sets-run-${s.name}`}
                          className={smallButton}
                          disabled={busy}
                          onClick={() => void run(s.name)}
                        >
                          {t('exportSets.run', { defaultValue: 'Run…' })}
                        </button>
                        <button
                          type="button"
                          data-testid={`export-sets-delete-${s.name}`}
                          className={smallButton}
                          disabled={busy}
                          onClick={() => void remove(s.name)}
                        >
                          {t('common.delete', { defaultValue: 'Delete' })}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-col">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-surface-400">
                  {t('exportSets.contents', { defaultValue: 'Set contents' })}
                </div>
                <div className="text-[10px] text-surface-500">
                  {t('exportSets.picked', {
                    defaultValue_one: '{{count}} export picked',
                    defaultValue_other: '{{count}} exports picked',
                    count: picked.size,
                  })}
                </div>
              </div>
              <div className="mb-1.5 flex gap-2">
                <input
                  type="text"
                  data-testid="export-sets-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('exportSets.name', { defaultValue: 'Name' })}
                  className="min-w-0 flex-1 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                />
                <input
                  type="text"
                  data-testid="export-sets-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('common.search', { defaultValue: 'Search' })}
                  className="min-w-0 flex-1 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="max-h-[380px] overflow-auto rounded border border-surface-800 bg-surface-950/50 p-2">
                {groups.map((g) => {
                  const shown = g.choices.filter((c) => {
                    if (!q) return true;
                    const label = tokenLabel(c.token, c.label) ?? '';
                    return c.token.toLowerCase().includes(q) || label.toLowerCase().includes(q);
                  });
                  if (shown.length === 0) return null;
                  return (
                    <div key={g.group} className="mb-2 last:mb-0">
                      <div className="mb-0.5 px-1.5 text-[10px] uppercase tracking-wide text-surface-500">
                        {groupTitle[g.group]}
                      </div>
                      <div className="grid grid-cols-1 gap-1">
                        {shown.map((c) => {
                          const checked = picked.has(c.token);
                          const label = tokenLabel(c.token, c.label);
                          return (
                            <label
                              key={c.token}
                              title={c.token}
                              className={clsx(
                                'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px]',
                                checked
                                  ? 'bg-accent-500/10 text-surface-100'
                                  : 'text-surface-300 hover:bg-surface-800/60',
                              )}
                            >
                              <input
                                type="checkbox"
                                data-testid={`export-sets-token-${c.token}`}
                                className="h-3.5 w-3.5"
                                checked={checked}
                                onChange={() => toggle(c.token)}
                              />
                              {label && <span className="truncate">{label}</span>}
                              <span
                                className={clsx(
                                  'truncate font-mono text-[10px] text-surface-500',
                                  label ? 'ml-auto' : '',
                                )}
                              >
                                {c.token}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-surface-200">
                <input
                  type="checkbox"
                  data-testid="export-sets-raw-headers"
                  checked={rawHeaders}
                  onChange={(e) => setRawHeaders(e.target.checked)}
                />
                <span>
                  {t('exportSets.rawHeaders', { defaultValue: 'Column keys instead of grid labels in headers' })}
                </span>
              </label>
            </section>
          </div>

          {status && (
            <div className="mt-3 truncate rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[11px] text-surface-200">
              {status}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-800 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-surface-700 px-3 py-1 text-[12px] text-surface-300 hover:bg-surface-800"
          >
            {t('common.close', { defaultValue: 'Close' })}
          </button>
          <button
            type="button"
            data-testid="export-sets-save"
            onClick={() => void save()}
            disabled={!canSave}
            className={clsx(
              'inline-flex items-center gap-1 rounded border border-blue-600 bg-blue-600/20 px-3 py-1 text-[12px] text-blue-100 hover:bg-blue-600/30',
              !canSave && 'cursor-not-allowed opacity-50 hover:bg-blue-600/20',
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('common.save', { defaultValue: 'Save' })}
          </button>
        </div>
      </div>
    </div>
  );
}
