/**
 * Names for the Compare dialog: the checks and kinds the compare result
 * carries as internal keys (`issues:ttfb-slow`, `content`) become the
 * sidebar names in the UI language, with page counts. Pure, so it is tested
 * without rendering.
 */
import {
  ISSUE_GROUPS,
  type CompareIssueChange,
  type CompareNotComparable,
} from '@freecrawl/shared-types';
import { translateLabel } from '../i18n/labels.js';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** `issues:<key>` → [group label, check label], English, translated at render. */
const ISSUE_LABELS = new Map(
  ISSUE_GROUPS.flatMap((g) =>
    g.items.map((i) => [i.category as string, [g.label, i.label] as const]),
  ),
);

/** "Group — check" in the UI language; an unknown key is returned as it is. */
export function issueCheckName(key: string, lang: string): string {
  const labels = ISSUE_LABELS.get(key);
  return labels ? labels.map((l) => translateLabel(l, lang)).join(' — ') : key;
}

/** A sample cell of the Issues tab: space-joined check keys → their names. */
export function issueKeysText(cell: string, lang: string): string {
  return cell
    .split(' ')
    .filter((k) => k !== '')
    .map((k) => issueCheckName(k, lang))
    .join(', ');
}

/** Per-check rows for the Issues tab, the most changed check first. */
export function issueChangeRows(
  changes: Record<string, CompareIssueChange>,
  lang: string,
): { key: string; name: string; appeared: number; resolved: number }[] {
  return Object.entries(changes)
    .map(([key, c]) => ({
      key,
      name: issueCheckName(key, lang),
      appeared: c.appeared,
      resolved: c.resolved,
    }))
    .sort(
      (a, b) => b.appeared + b.resolved - (a.appeared + a.resolved) || a.name.localeCompare(b.name),
    );
}

/** The name of a kind the pair could not be compared on: a check or a compare kind (`content`). */
function kindName(kind: string, t: T, lang: string): string {
  if (ISSUE_LABELS.has(kind)) return issueCheckName(kind, lang);
  return t(`compare.kind.${kind}`, { defaultValue: kind });
}

/** "Content (12 pages), Depth (1 page)" for the not-compared notice. */
export function notComparableSummary(
  notComparable: Record<string, CompareNotComparable>,
  t: T,
  lang: string,
): string {
  return Object.entries(notComparable)
    .map(([kind, n]) => `${kindName(kind, t, lang)} (${t('compare.pages', { count: n.urls })})`)
    .join(', ');
}
