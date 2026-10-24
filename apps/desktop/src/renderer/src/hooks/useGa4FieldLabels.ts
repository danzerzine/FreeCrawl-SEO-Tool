import { useEffect, useState } from 'react';
import { ga4FieldLabels } from '@freecrawl/shared-types';

/**
 * API name → the name GA4 shows, for the project's chosen property (B166). Uses the
 * session's copy of the property metadata; empty (callers show the API name) when there is no
 * property, no network or no sign-in.
 */
export function useGa4FieldLabels(active: boolean): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.freecrawl.integrationSettingsGet('ga4');
        const property = typeof s?.['property'] === 'string' ? s['property'] : '';
        if (!property) return;
        const accountId = typeof s?.['accountId'] === 'string' ? s['accountId'] : '';
        const res = await window.freecrawl.ga4ListFields({
          property,
          accountId: accountId || undefined,
        });
        if (!cancelled && res.ok) setLabels(ga4FieldLabels(res.fields));
      } catch {
        /* no labels: the API names show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);
  return labels;
}
