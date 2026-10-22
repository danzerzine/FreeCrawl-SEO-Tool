/** Why a user-typed URL pattern is refused before it runs on every URL. */
export type UnsafePatternReason = 'too-long' | 'nested-quantifier';

const SPECIAL = '\\^$.|?*+()[]{}';

/**
 * Refuses patterns that can make a regex check hang on a long URL: over
 * `maxLength` characters, or a repeated group that itself holds a repeat
 * (`(a+)+`, `(.*)*`, `(x{2,})+`), the classic catastrophic-backtracking shape.
 *
 * A repeated group whose content opens with a plain character, not repeated
 * itself, that none of the group's repeats can match is a separator group and
 * passes: `(/page/\d+)+`, `(?:/[a-z]+)*`. Each round has to start at that
 * character, so the rounds cannot split the input in many ways. `(/[^x]+)+`
 * stays refused, as `[^x]` matches the `/`.
 *
 * A heuristic: overlapping alternatives such as `(a|aa)+` hang too and pass.
 */
export function unsafePatternReason(
  pattern: string,
  maxLength: number,
): UnsafePatternReason | null {
  if (pattern.length > maxLength) return 'too-long';
  return hasUnsafeRepeatedGroup(pattern) ? 'nested-quantifier' : null;
}

interface Group {
  /** Index just after `(` and any `?:`-style prefix. */
  contentStart: number;
  /** Plain first character, or null when the content opens otherwise. */
  lead: string | null;
  /** Repeated atoms inside, as source text; a repeated nested group as null. */
  repeats: (string | null)[];
  alternation: boolean;
}

function hasUnsafeRepeatedGroup(src: string): boolean {
  const stack: Group[] = [];
  let atomStart = -1;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const top = stack[stack.length - 1];
    if (ch === '\\') {
      atomStart = i;
      i += 2;
    } else if (ch === '[') {
      atomStart = i;
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === '(') {
      let start = i + 1;
      if (src[start] === '?') {
        const named = /^\?<(?![=!])[^>]*>/.exec(src.slice(start));
        start += named ? named[0].length : 2;
      }
      stack.push({ contentStart: start, lead: null, repeats: [], alternation: false });
      atomStart = -1;
      i = start;
      continue;
    } else if (ch === ')') {
      const group = stack.pop();
      i++;
      const q = quantifierAt(src, i);
      if (
        group &&
        q &&
        isUnbounded(src.slice(i, i + q)) &&
        group.repeats.length > 0 &&
        !isSeparatorGroup(group)
      ) {
        return true;
      }
      const parent = stack[stack.length - 1];
      if (group && q && parent) parent.repeats.push(null);
      // A nested group's own repeats are repeats of the parent too.
      if (group && parent) parent.repeats.push(...group.repeats);
      atomStart = -1;
      i += q;
      continue;
    } else if (ch === '|') {
      if (top) top.alternation = true;
      atomStart = -1;
      i++;
      continue;
    } else {
      atomStart = i;
      i++;
    }
    const q = quantifierAt(src, i);
    if (top && atomStart === top.contentStart && !q) top.lead = plainChar(src.slice(atomStart, i));
    if (q && top && isUnbounded(src.slice(i, i + q)) && atomStart >= 0)
      top.repeats.push(src.slice(atomStart, i));
    i += q;
  }
  return false;
}

/** Length of the quantifier at `i` (with a lazy `?`), 0 when none. */
function quantifierAt(src: string, i: number): number {
  const m = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(src.slice(i));
  return m ? m[0].length : 0;
}

/** `*`, `+` and `{n,}` / `{n,m}` repeat; `?` and `{n}` do not multiply the ways. */
function isUnbounded(q: string): boolean {
  return /^[*+]|^\{\d+,/.test(q);
}

function plainChar(atom: string): string | null {
  if (atom.length === 1) return SPECIAL.includes(atom) ? null : atom;
  if (atom.length === 2 && atom[0] === '\\' && /[^A-Za-z0-9]/.test(atom[1]!)) return atom[1]!;
  return null;
}

function isSeparatorGroup(group: Group): boolean {
  const lead = group.lead;
  if (lead === null || group.alternation) return false;
  return group.repeats.every((atom) => {
    if (atom === null) return false;
    try {
      return !new RegExp(`^(?:${atom})$`).test(lead);
    } catch {
      return false;
    }
  });
}
