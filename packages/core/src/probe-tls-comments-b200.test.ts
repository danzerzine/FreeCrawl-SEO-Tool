import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// B200: the two one-off TLS probes disable certificate checks on purpose; the reason stays beside the option.
const read = (f: string): string => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

describe('certificate checks switched off only in the one-off probes', () => {
  it.each(['alpn-probe.ts', 'tls-probe.ts'])('%s explains rejectUnauthorized: false next to it', (file) => {
    const lines = read(file).split('\n');
    const i = lines.findIndex((l) => l.includes('rejectUnauthorized: false,'));
    expect(i).toBeGreaterThan(0);
    const above = lines.slice(Math.max(0, i - 3), i).filter((l) => /^\s*\/\/ /.test(l));
    expect(above.length).toBeGreaterThan(0);
    expect(above.join(' ')).toMatch(/Intended/);
  });

  it('the crawler, robots, sitemap and render code never turn verification off (http-client.ts has its own documented lenient retry)', () => {
    const offenders = ['crawler.ts', 'robots.ts', 'render-fetcher.ts', 'sitemap.ts'].filter((f) =>
      /rejectUnauthorized:\s*false/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});
