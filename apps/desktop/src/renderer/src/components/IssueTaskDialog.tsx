import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { IssueTaskPreviewResult, IssueTaskTarget, UrlCategory } from '@freecrawl/shared-types';

/**
 * M21 (fork only) — one issue as a developer-ready task. Shows the exact text
 * that would go out; nothing is sent until a Send button is pressed.
 */
interface IssueTaskDialogProps {
  open: boolean;
  category: UrlCategory;
  onClose: () => void;
}

type Status =
  | { kind: 'none' }
  | { kind: 'info'; text: string }
  | { kind: 'sent'; url: string }
  | { kind: 'error'; text: string; mayHaveBeenCreated: boolean };

export function IssueTaskDialog({ open, category, onClose }: IssueTaskDialogProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<IssueTaskPreviewResult | null>(null);
  /** null = the generated title is kept. */
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [view, setView] = useState<'markdown' | 'html'>('markdown');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'none' });
  const [reloadKey, setReloadKey] = useState(0);
  /** The edits the shown preview was built from. */
  const [previewedKey, setPreviewedKey] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitleEdit(null);
    setNote('');
    setStatus({ kind: 'none' });
    setPreview(null);
    setPreviewedKey('');
  }, [open, category]);

  // The preview is rebuilt in main from the same inputs the send uses, so the text shown is the text sent.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      void window.freecrawl
        .issueTaskPreview({ category, ...(titleEdit !== null ? { title: titleEdit } : {}), note })
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setPreviewedKey(JSON.stringify([category, titleEdit, note]));
        })
        .catch((e: unknown) => {
          if (live) setPreview({ ok: false, message: e instanceof Error ? e.message : String(e) });
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, category, titleEdit, note, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const ready = preview?.ok ? preview : null;
  /** The shown text is the text of the current edits (the debounced preview has caught up). */
  const inSync = ready !== null && previewedKey === JSON.stringify([category, titleEdit, note]);

  const copy = async () => {
    if (!ready) return;
    await navigator.clipboard.writeText(ready.markdown);
    setStatus({ kind: 'info', text: t('issueTask.copied', { defaultValue: 'Markdown copied.' }) });
  };

  const save = async () => {
    if (!ready || !inSync) return;
    try {
      const r = await window.freecrawl.issueTaskSave({ category, previewId: ready.previewId });
      if (r.ok) {
        setStatus({
          kind: 'info',
          text: t('issueTask.saved', { defaultValue: 'Saved to {{path}}', path: r.filePath }),
        });
      } else if (!r.cancelled) {
        setStatus({ kind: 'error', text: r.message, mayHaveBeenCreated: false });
      }
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e), mayHaveBeenCreated: false });
    }
  };

  const send = async (target: IssueTaskTarget) => {
    if (sending || !ready || !inSync) return;
    setSending(true);
    setStatus({ kind: 'none' });
    try {
      const r = await window.freecrawl.issueTaskSend({ category, target, previewId: ready.previewId });
      setStatus(
        r.ok
          ? { kind: 'sent', url: r.url }
          : { kind: 'error', text: r.message, mayHaveBeenCreated: r.mayHaveBeenCreated === true },
      );
      setReloadKey((k) => k + 1);
    } catch (e) {
      setStatus({
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
        mayHaveBeenCreated: false,
      });
    } finally {
      setSending(false);
    }
  };

  const targetRow = (target: IssueTaskTarget) => {
    const st = ready?.targets[target];
    const configured = st?.configured === true;
    const name =
      target === 'github'
        ? t('issueTask.sendGithub', { defaultValue: 'Send to GitHub' })
        : t('issueTask.sendBasecamp', { defaultValue: 'Send to Basecamp' });
    return (
      <div key={target} className="flex flex-col gap-0.5">
        <button
          type="button"
          data-testid={`issue-task-send-${target}`}
          onClick={() => void send(target)}
          disabled={!inSync || !configured || sending}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] transition',
            !inSync || !configured || sending
              ? 'cursor-not-allowed border-surface-800 text-surface-600'
              : 'border-accent-500/60 text-accent-300 hover:bg-accent-500/10',
          )}
        >
          {sending && <Loader2 className="h-3 w-3 animate-spin" />}
          {name}
        </button>
        <span className="text-[10px] text-surface-500">
          {configured
            ? t('issueTask.goesTo', { defaultValue: 'Goes to {{where}}', where: st?.where })
            : t('issueTask.notConfigured', { defaultValue: 'Not set up: Settings → Integrations' })}
        </span>
        {st?.alreadySent && (
          <span className="text-[10px] text-amber-400">
            {t('issueTask.alreadySent', {
              defaultValue: 'Already sent in this session; sending again makes a second task.',
            })}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        data-testid="issue-task-dialog"
        className="flex max-h-[90vh] w-[860px] max-w-[95vw] flex-col rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-2.5">
          <div className="text-sm font-semibold text-surface-100">
            {t('issueTask.title', { defaultValue: 'Create task from issue' })}
          </div>
          <button
            className="rounded p-1 text-surface-400 hover:bg-surface-800 hover:text-surface-100"
            onClick={onClose}
            title={t('common.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
          {preview && !preview.ok && (
            <div className="text-[11px] text-red-400">{preview.message}</div>
          )}
          {!preview && (
            <div className="flex items-center gap-2 text-[11px] text-surface-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('issueTask.loading', { defaultValue: 'Building the task…' })}
            </div>
          )}
          {ready && (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-surface-400">
                {t('issueTask.titleLabel', { defaultValue: 'Task title' })}
                <input
                  data-testid="issue-task-title"
                  className="rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-surface-100"
                  value={titleEdit ?? ready.title}
                  onChange={(e) => setTitleEdit(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-surface-400">
                {t('issueTask.noteLabel', { defaultValue: 'Your note (optional)' })}
                <textarea
                  data-testid="issue-task-note"
                  rows={2}
                  className="rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-surface-100"
                  placeholder={t('issueTask.notePlaceholder', {
                    defaultValue: 'Context for whoever picks this up',
                  })}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <div className="flex items-center gap-2 text-[11px] text-surface-400">
                <span>
                  {t('issueTask.previewLabel', { defaultValue: 'Exact text that will be sent' })}
                </span>
                {(['markdown', 'html'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={clsx(
                      'rounded border px-2 py-0.5 text-[10px]',
                      view === v
                        ? 'border-accent-500/60 text-accent-300'
                        : 'border-surface-700 text-surface-400 hover:bg-surface-800',
                    )}
                  >
                    {v === 'markdown'
                      ? t('issueTask.viewMarkdown', { defaultValue: 'GitHub / .md (Markdown)' })
                      : t('issueTask.viewBasecamp', { defaultValue: 'Basecamp (HTML)' })}
                  </button>
                ))}
              </div>
              <pre
                data-testid="issue-task-preview"
                className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded border border-surface-800 bg-surface-950/50 p-2 font-mono text-[11px] text-surface-200"
              >
                {view === 'markdown' ? ready.markdown : ready.basecampHtml}
              </pre>
            </>
          )}

          {status.kind === 'sent' && (
            <div className="text-[11px] text-emerald-400" data-testid="issue-task-sent">
              {t('issueTask.created', { defaultValue: 'Task created:' })}{' '}
              <a className="underline" href={status.url} target="_blank" rel="noreferrer">
                {status.url}
              </a>
            </div>
          )}
          {status.kind === 'info' && (
            <div className="text-[11px] text-surface-300">{status.text}</div>
          )}
          {status.kind === 'error' && (
            <div className="text-[11px] text-red-400" data-testid="issue-task-error">
              {status.text}
              {status.mayHaveBeenCreated && (
                <div className="mt-0.5 text-amber-400">
                  {t('issueTask.mayHaveBeenCreated', {
                    defaultValue:
                      'The task may have been created anyway. Check the tracker before sending again.',
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-3 border-t border-surface-800 px-4 py-2.5">
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!ready}
            className="rounded border border-surface-700 px-2.5 py-1 text-[11px] text-surface-300 hover:bg-surface-800 disabled:cursor-not-allowed disabled:text-surface-600"
          >
            {t('issueTask.copyMarkdown', { defaultValue: 'Copy Markdown' })}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!ready || !inSync}
            className="rounded border border-surface-700 px-2.5 py-1 text-[11px] text-surface-300 hover:bg-surface-800 disabled:cursor-not-allowed disabled:text-surface-600"
          >
            {t('issueTask.saveMd', { defaultValue: 'Save .md' })}
          </button>
          <div className="ml-auto flex gap-4">
            {targetRow('github')}
            {targetRow('basecamp')}
          </div>
        </div>
      </div>
    </div>
  );
}
