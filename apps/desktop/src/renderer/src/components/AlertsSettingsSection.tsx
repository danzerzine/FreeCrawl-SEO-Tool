import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  ALERT_CHANNELS,
  ISSUE_GROUPS,
  type AlertChannelId,
  type AlertDelivery,
  type MonitorAlertsState,
  type MonitorRuleSpec,
} from '@freecrawl/shared-types';
import { translateLabel } from '../i18n/labels.js';

/**
 * B88d — Settings → Alerts: the project's monitoring rules and the
 * channels an alert goes to after a finished crawl. Rules are stored in
 * the project (`monitorRules`, the CLI's rule-file shape), so every change
 * here is saved at once rather than with the dialog's crawl settings.
 * Channel credentials live in Settings → Integrations / Webhook; this
 * panel only learns which channels are set up.
 */

/** `listMetrics()` names the per-code family like this; the picker asks for the code. */
const STATUS_CODE_PATTERN = 'status.<code>';
const STATUS_CODE_METRIC = /^status\.(\d{3})$/;

/** `issues:<key>` → [group label, check label], English, translated at render. */
const ISSUE_LABELS = new Map(
  ISSUE_GROUPS.flatMap((g) => g.items.map((i) => [i.category as string, [g.label, i.label] as const])),
);

/** Fixed metric → its `settingsPanels.alerts.metric.*` key. */
const FIXED_METRIC_KEYS: Record<string, string> = {
  'urls.total': 'urlsTotal',
  'urls.internal': 'urlsInternal',
  'urls.external': 'urlsExternal',
  indexable: 'indexable',
  'non-indexable': 'nonIndexable',
  noindex: 'noindex',
  canonicalised: 'canonicalised',
  'blocked-robots': 'blockedRobots',
  'status.2xx': 'status2xx',
  'status.3xx': 'status3xx',
  'status.4xx': 'status4xx',
  'status.5xx': 'status5xx',
  'status.no-response': 'statusNoResponse',
  'status.bot-blocked': 'statusBotBlocked',
  'response-time.avg-ms': 'responseTimeAvg',
  [STATUS_CODE_PATTERN]: 'statusCode',
};

const OPS: MonitorRuleSpec['op'][] = ['>', '>=', '<', '<=', '==', '!='];

/** Where a channel's credentials are filled in. */
const CHANNEL_SECTION: Record<AlertChannelId, string> = {
  slack: 'integration:slack',
  telegram: 'integration:telegram',
  email: 'integration:email',
  webhook: 'webhook',
};

interface Draft {
  name: string;
  /** A metric name, or `status.<code>` with the code in `statusCode`. */
  metric: string;
  statusCode: string;
  vs: 'absolute' | 'previous';
  change: 'count' | 'percent';
  op: MonitorRuleSpec['op'];
  value: string;
  level: 'fail' | 'warn';
}

const EMPTY_DRAFT: Draft = {
  name: '',
  metric: 'status.4xx',
  statusCode: '404',
  vs: 'absolute',
  change: 'count',
  op: '>',
  value: '0',
  level: 'fail',
};

function toDraft(r: MonitorRuleSpec): Draft {
  const code = STATUS_CODE_METRIC.exec(r.metric);
  return {
    name: r.name,
    metric: code ? STATUS_CODE_PATTERN : r.metric,
    statusCode: code ? code[1]! : EMPTY_DRAFT.statusCode,
    vs: r.vs ?? 'absolute',
    change: r.change ?? 'count',
    op: r.op,
    value: String(r.value),
    level: r.level ?? 'fail',
  };
}

function fromDraft(d: Draft): MonitorRuleSpec {
  const previous = d.vs === 'previous';
  return {
    name: d.name.trim(),
    metric: d.metric === STATUS_CODE_PATTERN ? `status.${d.statusCode.trim()}` : d.metric,
    vs: d.vs,
    change: previous ? d.change : 'count',
    op: d.op,
    value: Number(d.value),
    level: d.level,
  };
}

const inputClass =
  'rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[12px] text-surface-100 focus:border-blue-500 focus:outline-none';
const smallButton =
  'inline-flex items-center gap-1 rounded border border-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300 hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50';

export function AlertsSettingsSection({ onOpenSection }: { onOpenSection?: (key: string) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [state, setState] = useState<MonitorAlertsState | null>(null);
  /** Index being edited; -1 = a new rule; null = editor closed. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  useEffect(() => {
    window.freecrawl
      .monitorAlertsGet()
      .then(setState)
      .catch((e: unknown) =>
        setNotice({
          ok: false,
          text: t('settingsPanels.alerts.loadFailed', {
            defaultValue: 'Could not read the alert setup: {{detail}}',
            detail: errorText(e),
          }),
        }),
      );
  }, [t]);

  const save = useCallback(
    async (rules: MonitorRuleSpec[], channels: AlertChannelId[]): Promise<boolean> => {
      setBusy(true);
      try {
        setState(await window.freecrawl.monitorAlertsSave({ rules, channels }));
        setNotice({ ok: true, text: t('integrations.saved', { defaultValue: 'Saved.' }) });
        return true;
      } catch (e) {
        setNotice({
          ok: false,
          text: t('integrations.saveFailed', { defaultValue: 'Could not save: {{detail}}', detail: errorText(e) }),
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const metricLabel = useCallback(
    (metric: string): string => {
      const fixed = FIXED_METRIC_KEYS[metric];
      if (fixed) return t(`settingsPanels.alerts.metric.${fixed}`);
      const code = STATUS_CODE_METRIC.exec(metric);
      if (code) return `${t('settingsPanels.alerts.metric.statusCode')} ${code[1]}`;
      const issue = ISSUE_LABELS.get(metric);
      return issue ? issue.map((l) => translateLabel(l, lang)).join(' — ') : metric;
    },
    [t, lang],
  );

  /** The picker: counts first, then one group per issue sidebar group, as `listMetrics()` orders them. */
  const metricGroups = useMemo(() => {
    const metrics = state?.metrics ?? [];
    const counts = metrics.filter((m) => !ISSUE_LABELS.has(m));
    const issues = ISSUE_GROUPS.map((g) => ({
      label: translateLabel(g.label, lang),
      items: g.items.map((i) => i.category as string).filter((c) => metrics.includes(c)),
    })).filter((g) => g.items.length > 0);
    return [{ label: t('settingsPanels.alerts.groupCounts'), items: counts }, ...issues];
  }, [state?.metrics, lang, t]);

  if (!state) {
    return notice ? (
      <div className="text-[11px] text-red-300">{notice.text}</div>
    ) : (
      <div className="text-[11px] text-surface-500">{t('common.loading', { defaultValue: 'Loading…' })}</div>
    );
  }

  const openEditor = (index: number | null) => {
    setNotice(null);
    setEditing(index === null ? -1 : index);
    setDraft(index === null ? EMPTY_DRAFT : toDraft(state.rules[index]!));
  };

  const applyDraft = async () => {
    if (editing === null) return;
    const rule = fromDraft(draft);
    const rules = editing === -1 ? [...state.rules, rule] : state.rules.map((r, i) => (i === editing ? rule : r));
    if (await save(rules, state.channels)) setEditing(null);
  };

  const removeRule = (index: number) => {
    const name = state.rules[index]!.name;
    if (!window.confirm(t('settingsPanels.alerts.deleteConfirm', { name }))) return;
    void save(
      state.rules.filter((_, i) => i !== index),
      state.channels,
    );
  };

  const toggleChannel = (ch: AlertChannelId) => {
    const on = state.channels.includes(ch);
    void save(state.rules, on ? state.channels.filter((c) => c !== ch) : [...state.channels, ch]);
  };

  const sendTest = async () => {
    setBusy(true);
    setDeliveries([]);
    setNotice(null);
    try {
      setDeliveries(await window.freecrawl.monitorAlertsTest(state.channels));
    } catch (e) {
      setNotice({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const channelName = (ch: AlertChannelId): string =>
    ch === 'webhook'
      ? translateLabel('Webhook', lang)
      : ch === 'email'
        ? translateLabel('Email', lang)
        : ch === 'slack'
          ? 'Slack'
          : 'Telegram';

  const ruleSummary = (r: MonitorRuleSpec): string => {
    const measured =
      (r.vs ?? 'absolute') === 'previous'
        ? t('settingsPanels.alerts.summaryChange', { metric: metricLabel(r.metric) })
        : metricLabel(r.metric);
    return `${measured} ${r.op} ${r.value}${r.change === 'percent' ? '%' : ''}`;
  };

  const draftValid =
    draft.name.trim() !== '' &&
    draft.value.trim() !== '' &&
    Number.isFinite(Number(draft.value)) &&
    (draft.metric !== STATUS_CODE_PATTERN || /^\d{3}$/.test(draft.statusCode.trim()));

  return (
    <div data-testid="alerts-panel">
      <p className="mb-3 text-[11px] text-surface-400">{t('settingsPanels.alerts.intro')}</p>

      <div className="mb-4 rounded border border-surface-800 bg-surface-950/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[11px] font-semibold text-surface-200">{t('settingsPanels.alerts.rulesTitle')}</div>
          <button
            type="button"
            data-testid="alerts-rule-add"
            className={clsx(smallButton, 'ml-auto')}
            disabled={busy}
            onClick={() => openEditor(null)}
          >
            <Plus className="h-3 w-3" />
            {t('settingsPanels.alerts.addRule')}
          </button>
        </div>

        {state.rules.length === 0 && editing === null ? (
          <div className="px-2 py-3 text-center text-[11px] text-surface-500">{t('settingsPanels.alerts.empty')}</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {state.rules.map((r, i) => (
              <div
                key={`${i}-${r.name}`}
                data-testid={`alerts-rule-row-${i}`}
                className={clsx(
                  'flex items-center gap-2 rounded px-1.5 py-1 text-[12px]',
                  editing === i ? 'bg-accent-500/10 text-surface-100' : 'text-surface-300 hover:bg-surface-800/60',
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{r.name}</span>
                  <span className="truncate text-[10px] text-surface-500" title={r.metric}>
                    {ruleSummary(r)}
                  </span>
                </div>
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                    (r.level ?? 'fail') === 'fail' ? 'bg-red-900/40 text-red-300' : 'bg-amber-900/40 text-amber-300',
                  )}
                >
                  {(r.level ?? 'fail') === 'fail'
                    ? t('settingsPanels.alerts.levelFail')
                    : t('settingsPanels.alerts.levelWarn')}
                </span>
                <button
                  type="button"
                  data-testid={`alerts-rule-edit-${i}`}
                  className={smallButton}
                  disabled={busy}
                  onClick={() => openEditor(i)}
                  title={t('settingsPanels.alerts.edit')}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid={`alerts-rule-delete-${i}`}
                  className={smallButton}
                  disabled={busy}
                  onClick={() => removeRule(i)}
                  title={t('common.delete', { defaultValue: 'Delete' })}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {editing !== null && (
          <div data-testid="alerts-rule-editor" className="mt-2 rounded border border-surface-700 bg-surface-900/60 p-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 flex flex-col gap-0.5">
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.name')}</span>
                <input
                  type="text"
                  data-testid="alerts-rule-name"
                  className={inputClass}
                  value={draft.name}
                  placeholder={t('settingsPanels.alerts.namePlaceholder')}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className={clsx('flex flex-col gap-0.5', draft.metric === STATUS_CODE_PATTERN ? '' : 'col-span-2')}>
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.metricLabel')}</span>
                <select
                  data-testid="alerts-rule-metric"
                  className={inputClass}
                  value={draft.metric}
                  onChange={(e) => setDraft({ ...draft, metric: e.target.value })}
                >
                  {metricGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((m) => (
                        <option key={m} value={m}>
                          {metricLabel(m)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {draft.metric === STATUS_CODE_PATTERN && (
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.statusCodeLabel')}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    data-testid="alerts-rule-status-code"
                    className={inputClass}
                    value={draft.statusCode}
                    placeholder="404"
                    onChange={(e) => setDraft({ ...draft, statusCode: e.target.value })}
                  />
                </label>
              )}
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.compare')}</span>
                <select
                  data-testid="alerts-rule-vs"
                  className={inputClass}
                  value={draft.vs}
                  onChange={(e) => setDraft({ ...draft, vs: e.target.value as Draft['vs'] })}
                >
                  <option value="absolute">{t('settingsPanels.alerts.vsAbsolute')}</option>
                  <option value="previous">{t('settingsPanels.alerts.vsPrevious')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.unit')}</span>
                <select
                  data-testid="alerts-rule-change"
                  className={inputClass}
                  value={draft.vs === 'previous' ? draft.change : 'count'}
                  disabled={draft.vs !== 'previous'}
                  onChange={(e) => setDraft({ ...draft, change: e.target.value as Draft['change'] })}
                >
                  <option value="count">{t('settingsPanels.alerts.unitCount')}</option>
                  <option value="percent">{t('settingsPanels.alerts.unitPercent')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.condition')}</span>
                <div className="flex gap-1">
                  <select
                    data-testid="alerts-rule-op"
                    className={clsx(inputClass, 'font-mono')}
                    value={draft.op}
                    onChange={(e) => setDraft({ ...draft, op: e.target.value as Draft['op'] })}
                  >
                    {OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    data-testid="alerts-rule-value"
                    className={clsx(inputClass, 'min-w-0 flex-1')}
                    value={draft.value}
                    onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                  />
                </div>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-surface-400">{t('settingsPanels.alerts.level')}</span>
                <select
                  data-testid="alerts-rule-level"
                  className={inputClass}
                  value={draft.level}
                  onChange={(e) => setDraft({ ...draft, level: e.target.value as Draft['level'] })}
                >
                  <option value="fail">{t('settingsPanels.alerts.levelFail')}</option>
                  <option value="warn">{t('settingsPanels.alerts.levelWarn')}</option>
                </select>
              </label>
            </div>
            <p className="mt-1.5 text-[10px] text-surface-500">{t('settingsPanels.alerts.editorHint')}</p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded border border-surface-700 px-2.5 py-1 text-[11px] text-surface-300 hover:bg-surface-800"
                onClick={() => setEditing(null)}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                data-testid="alerts-rule-apply"
                disabled={busy || !draftValid}
                onClick={() => void applyDraft()}
                className={clsx(
                  'inline-flex items-center gap-1 rounded border border-blue-600 bg-blue-600/20 px-2.5 py-1 text-[11px] text-blue-100 hover:bg-blue-600/30',
                  (busy || !draftValid) && 'cursor-not-allowed opacity-50 hover:bg-blue-600/20',
                )}
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('common.save', { defaultValue: 'Save' })}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mb-4 rounded border border-surface-800 bg-surface-950/40 p-3">
        <div className="mb-1 text-[11px] font-semibold text-surface-200">{t('settingsPanels.alerts.channelsTitle')}</div>
        <p className="mb-2 text-[10px] text-surface-500">{t('settingsPanels.alerts.channelsHint')}</p>
        <div className="flex flex-col gap-1">
          {ALERT_CHANNELS.map((ch) => {
            const configured = state.configured.includes(ch);
            const result = deliveries.find((d) => d.channel === ch);
            return (
              <div key={ch} className="flex items-center gap-2 text-[12px] text-surface-200">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid={`alerts-channel-${ch}`}
                    className="h-3.5 w-3.5"
                    checked={state.channels.includes(ch)}
                    disabled={busy}
                    onChange={() => toggleChannel(ch)}
                  />
                  <span>{channelName(ch)}</span>
                </label>
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                    configured ? 'bg-emerald-900/40 text-emerald-300' : 'bg-surface-800 text-surface-500',
                  )}
                >
                  {configured
                    ? t('integrations.connected', { defaultValue: 'Configured' })
                    : t('integrations.notConfigured', { defaultValue: 'Not set' })}
                </span>
                {onOpenSection && (
                  <button
                    type="button"
                    className="text-[10px] text-blue-400 hover:text-blue-300"
                    onClick={() => onOpenSection(CHANNEL_SECTION[ch])}
                  >
                    {t('settingsPanels.alerts.setUp')}
                  </button>
                )}
                {result && (
                  <span
                    data-testid={`alerts-test-result-${ch}`}
                    className={clsx('ml-auto truncate text-[10px]', result.ok ? 'text-emerald-400' : 'text-red-300')}
                    title={result.detail}
                  >
                    {result.ok
                      ? t('settingsPanels.alerts.testSent')
                      : t('settingsPanels.alerts.testFailed', { detail: result.detail })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="alerts-send-test"
            className="inline-flex items-center gap-1 rounded border border-surface-700 px-2.5 py-1 text-[11px] text-surface-200 hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || state.channels.length === 0}
            title={state.channels.length === 0 ? t('settingsPanels.alerts.testNoChannel') : undefined}
            onClick={() => void sendTest()}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {t('settingsPanels.alerts.sendTest')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={clsx('text-[10px]', notice.ok ? 'text-emerald-400' : 'text-red-300')}>{notice.text}</div>
      )}
    </div>
  );
}
