import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B104: the Duplicates tab has a "Recalculate duplicates" action wired through IPC to the writer worker.
const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8');
const main = read('index.ts');
const view = read('../renderer/src/components/DuplicatesGroupedView.tsx');

describe('B104 wiring', () => {
  it('channel, preload bridge, main handler and the button agree', () => {
    expect(read('../../../../packages/shared-types/src/ipc.ts')).toContain("duplicatesRecompute: 'duplicates:recompute'");
    expect(read('../preload/index.ts')).toContain('ipcRenderer.invoke(IPC.duplicatesRecompute, input)');
    expect(main).toMatch(/registerHandle\(\s*IPC\.duplicatesRecompute/);
    expect(main).toContain("'recomputeDuplicateClusters', args");
    expect(view).toContain('window.freecrawl.duplicatesRecompute');
  });

  it('refuses while a crawl runs; the button is in the toolbar and in the empty state', () => {
    const handler = /IPC\.duplicatesRecompute[\s\S]*?\n {2}\);\n/.exec(main)![0];
    expect(handler).toContain('activeCrawler?.isRunning');
    expect(view.match(/\{recomputeButton\}/g)).toHaveLength(2);
  });

  it('en and ru have the texts', () => {
    for (const lang of ['en', 'ru']) {
      const d = JSON.parse(read(`../renderer/src/i18n/locales/${lang}.json`)).duplicates;
      for (const k of ['recompute', 'recomputing', 'recomputeTitle']) expect(d[k], `${lang}.${k}`).toBeTruthy();
    }
  });
});
