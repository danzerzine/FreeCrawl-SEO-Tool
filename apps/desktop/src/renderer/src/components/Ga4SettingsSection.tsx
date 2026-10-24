import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GA4_MAX_CUSTOM_DIMENSIONS,
  GA4_MAX_CUSTOM_METRICS,
  ga4PickerFieldsWithSaved,
  ga4ToggleCustom,
  mergeGa4Settings,
  type Ga4Field,
  type GoogleAccount,
  type Ga4IntegrationSettings,
} from '@freecrawl/shared-types';

/**
 * Per-integration behaviour settings for Google Analytics 4, rendered
 * inside the GA4 card in Settings → Integrations. Smaller than the GSC
 * equivalent — the Data API call takes no dimension filters — but it
 * carries the same per-project account + date-range choice, so a project
 * remembers which of several linked GA4 accounts it reports on.
 */
export function Ga4SettingsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Ga4IntegrationSettings | null>(null);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [stored, list] = await Promise.all([
          window.freecrawl.integrationSettingsGet('ga4'),
          window.freecrawl.googleAccountsList('ga4'),
        ]);
        if (cancelled) return;
        setAccounts(list);
        setSettings(mergeGa4Settings(stored));
      } catch (e) {
        if (cancelled) return;
        // See GscSettingsSection — an unguarded rejection removed this
        // section from Settings entirely. Report it instead, and do not
        // substitute defaults for settings we could not read.
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="text-[11px]">
        <div className="font-semibold text-rose-300">
          {t('common.loadFailedTitle', { defaultValue: "Couldn't load this view" })}
        </div>
        <div className="mt-0.5 break-words text-surface-500">{loadError}</div>
      </div>
    );
  }
  if (!settings) return null;

  const update = <K extends keyof Ga4IntegrationSettings>(
    key: K,
    value: Ga4IntegrationSettings[K],
  ) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    void window.freecrawl.integrationSettingsSet('ga4', {
      [key]: value,
    } as Record<string, unknown>);
  };

  const selectCls =
    'h-6 rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none';

  return (
    <div className="mt-3 rounded border border-surface-800 bg-surface-950/60 p-2.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-surface-400">
        {t('ga4Settings.title', { defaultValue: 'Analytics 4 Settings' })}
      </div>

      {accounts.length > 1 && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] font-medium text-surface-300">
            {t('ga4Settings.account', { defaultValue: 'Account' })}
          </div>
          <select
            className={`${selectCls} max-w-full`}
            value={settings.accountId || accounts[0]?.accountId || ''}
            onChange={(e) => update('accountId', e.target.value)}
            title={t('ga4Settings.accountHint', {
              defaultValue:
                'Which linked Google account this project pulls Analytics data with.',
            })}
          >
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.email ?? a.accountId}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <div className="mb-1 text-[10px] font-medium text-surface-300">
          {t('ga4Settings.dateRange', { defaultValue: 'Date Range' })}
        </div>
        <select
          className={selectCls}
          value={settings.days}
          onChange={(e) =>
            update('days', Number(e.target.value) as Ga4IntegrationSettings['days'])
          }
        >
          <option value={7}>
            {t('ga4Settings.range7', { defaultValue: 'Last 7 days' })}
          </option>
          <option value={28}>
            {t('ga4Settings.range28', { defaultValue: 'Last 28 days' })}
          </option>
          <option value={90}>
            {t('ga4Settings.range90', { defaultValue: 'Last 90 days' })}
          </option>
        </select>
      </div>

      <CustomFieldPicker
        settings={settings}
        onChange={(metrics, dimensions) => {
          setSettings((prev) => (prev ? { ...prev, customMetrics: metrics, customDimensions: dimensions } : prev));
          void window.freecrawl.integrationSettingsSet('ga4', {
            customMetrics: metrics,
            customDimensions: dimensions,
          });
        }}
      />

      <p className="mt-2 text-[10px] leading-relaxed text-surface-500">
        {t('ga4Settings.hint', {
          defaultValue:
            'The property is picked in the GA4 tab toolbar. Analytics data is near-realtime, so the range ends today.',
        })}
      </p>
    </div>
  );
}

/**
 * Choose extra GA4 metrics and dimensions to pull next to the five fixed ones. The list comes
 * from the property's metadata (custom fields first); at most ten metrics and five dimensions,
 * because each dimension costs one more report.
 */
function CustomFieldPicker({
  settings,
  onChange,
}: {
  settings: Ga4IntegrationSettings;
  onChange: (metrics: string[], dimensions: string[]) => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<Ga4Field[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<'metrics' | 'dimensions' | null>(null);

  const load = async (refresh: boolean): Promise<void> => {
    if (!settings.property) return;
    setLoading(true);
    setError(null);
    const res = await window.freecrawl.ga4ListFields({
      property: settings.property,
      accountId: settings.accountId || undefined,
      refresh,
    });
    setLoading(false);
    if (res.ok) setFields(res.fields);
    else setError(res.error);
  };

  useEffect(() => {
    // The field list is refreshed each time the picker opens (spec B37), so a stale pick shows.
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.property, settings.accountId]);

  const shown = ga4PickerFieldsWithSaved(fields, settings.customMetrics, settings.customDimensions, query);

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium text-surface-300">
        {t('ga4Settings.customTitle', { defaultValue: 'Custom metrics and dimensions' })}
        <span className="font-normal text-surface-500">
          {t('ga4Settings.customCount', {
            defaultValue: '{{m}}/{{mMax}} metrics · {{d}}/{{dMax}} dimensions',
            m: settings.customMetrics.length,
            mMax: GA4_MAX_CUSTOM_METRICS,
            d: settings.customDimensions.length,
            dMax: GA4_MAX_CUSTOM_DIMENSIONS,
          })}
        </span>
        {settings.property && (
          <button
            type="button"
            className="ml-auto text-surface-500 underline decoration-dotted hover:text-surface-300"
            onClick={() => void load(true)}
            disabled={loading}
          >
            {t('ga4Settings.customRefresh', { defaultValue: 'Refresh list' })}
          </button>
        )}
      </div>
      {!settings.property ? (
        <p className="text-[10px] text-surface-500">
          {t('ga4Settings.customNoProperty', {
            defaultValue: 'Pick a property in the GA4 tab first; its fields are listed here.',
          })}
        </p>
      ) : (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ga4Settings.customSearch', { defaultValue: 'Search fields…' })}
            className="mb-1 h-6 w-full rounded border border-surface-700 bg-surface-950 px-2 text-[11px] text-surface-100 placeholder-surface-500 focus:border-blue-500 focus:outline-none"
          />
          {error && <div className="mb-1 break-words text-[10px] text-red-400">{error}</div>}
          {blocked && (
            <div className="mb-1 text-[10px] text-amber-300">
              {blocked === 'metrics'
                ? t('ga4Settings.customFullMetrics', {
                    defaultValue: 'At most {{n}} metrics; untick one to add another.',
                    n: GA4_MAX_CUSTOM_METRICS,
                  })
                : t('ga4Settings.customFullDimensions', {
                    defaultValue:
                      'At most {{n}} dimensions (each one is a separate report); untick one to add another.',
                    n: GA4_MAX_CUSTOM_DIMENSIONS,
                  })}
            </div>
          )}
          <div className="max-h-44 overflow-y-auto rounded border border-surface-800">
            {loading && fields.length === 0 && (
              <div className="px-2 py-1 text-[10px] text-surface-500">
                {t('ga4Settings.customLoading', { defaultValue: 'Loading fields…' })}
              </div>
            )}
            {shown.map((f) => (
              <label
                key={`${f.kind}:${f.apiName}`}
                className="flex cursor-pointer items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-surface-800/50"
                title={f.description}
              >
                <input
                  type="checkbox"
                  checked={(f.kind === 'metric' ? settings.customMetrics : settings.customDimensions).includes(f.apiName)}
                  onChange={() => {
                    const r = ga4ToggleCustom(settings.customMetrics, settings.customDimensions, f);
                    setBlocked(r.blocked ?? null);
                    if (!r.blocked) onChange(r.metrics, r.dimensions);
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-surface-100">{f.uiName}</span>
                <span className="shrink-0 text-surface-500">{f.apiName}</span>
                <span className="shrink-0 rounded bg-surface-800 px-1 text-[9px] uppercase text-surface-400">
                  {f.kind === 'metric'
                    ? t('ga4Settings.kindMetric', { defaultValue: 'metric' })
                    : t('ga4Settings.kindDimension', { defaultValue: 'dimension' })}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
