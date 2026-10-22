// Checks that run before anything loads `node:sqlite`. Kept free of other
// imports: on a Node without that module, a static import anywhere in the
// graph fails before a single line of ours runs.

/**
 * Why this Node cannot run the CLI, or null when it can. `node:sqlite`
 * works without a flag from 22.13 on the 22 line and from 23.4 on.
 */
export function nodeVersionProblem(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const ok = major === 22 ? minor >= 13 : major === 23 ? minor >= 4 : major > 23;
  return ok ? null : `FreeCrawl needs Node 22.13+ (not 23.0–23.3); this is ${version}.`;
}

/**
 * Drops the one warning Node prints on every run while `node:sqlite` is
 * experimental; PowerShell turns any captured stderr line into an error.
 * Every other warning still prints.
 */
export function muteSqliteWarning(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type =
      typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === 'string' ? type : warning.name;
    if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}
