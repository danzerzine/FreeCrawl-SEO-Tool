// Loops in place of `/\/+$/`, `/^\.+|\.+$/g` and `/\/\*[\s\S]*?\*\//g`: each of those
// regexes retries from every start position, so a long run of slashes, dots or
// unclosed comments takes quadratic time (64 000 slashes: seconds) (B199).

/** `s` without its trailing `/` characters. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(0, end);
}

/** `s` without its leading and trailing `.` characters. */
export function trimDots(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 0x2e) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x2e) end--;
  return s.slice(start, end);
}

/** `s` with every `/* … *\/` comment replaced by one space, as the lazy regex does; an unclosed one stays. */
export function stripBlockComments(s: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = s.indexOf('/*', from);
    if (open < 0) break;
    const close = s.indexOf('*/', open + 2);
    if (close < 0) break;
    out += s.slice(from, open) + ' ';
    from = close + 2;
  }
  return from === 0 ? s : out + s.slice(from);
}
