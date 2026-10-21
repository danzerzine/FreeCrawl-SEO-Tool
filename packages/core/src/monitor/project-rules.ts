/**
 * The project's saved monitoring rules: `project_meta` key `monitorRules`,
 * holding the same JSON as a rule file (`{ "version": 1, "rules": [...] }`),
 * so the desktop alerts and `freecrawl check` read one list. Pattern of the
 * saved export sets (`export-items.ts`).
 */
import type { ProjectDb } from '@freecrawl/db';
import { parseRules, type Rule } from './rules.js';

/** `project_meta` key: a rule file's JSON. */
export const MONITOR_RULES_META_KEY = 'monitorRules';

/** The project's saved rules; none when nothing is saved or the stored JSON no longer parses. */
export function listProjectRules(db: Pick<ProjectDb, 'getMeta'>): Rule[] {
  const raw = db.getMeta(MONITOR_RULES_META_KEY);
  if (!raw) return [];
  try {
    return parseRules(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Replace the project's rules with a rule file's contents. Checked by
 * `parseRules` first, so a bad rule throws (naming `rules[<index>]`) and
 * nothing is saved; stored with every default filled in.
 */
export function saveProjectRules(db: Pick<ProjectDb, 'setMeta'>, file: unknown): Rule[] {
  const rules = parseRules(file);
  db.setMeta(MONITOR_RULES_META_KEY, JSON.stringify({ version: 1, rules }));
  return rules;
}
