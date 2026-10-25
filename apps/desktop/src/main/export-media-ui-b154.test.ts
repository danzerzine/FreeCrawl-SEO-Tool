import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMenuLabels } from './menu-i18n.js';

// B154: the File menu item and dialog of the PDF files and screenshots export,
// the set editor's labels for them, and the lastmod choice of "Generate XML Sitemap".
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const app = read('App.tsx');
const menu = readFileSync(resolve(__dirname, 'menu.ts'), 'utf8');
const mainIndex = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
const media = read('components/MediaExportDialog.tsx');
const sitemap = read('components/SitemapOptionsDialog.tsx');
const sets = read('components/ExportSetsDialog.tsx');
const locale = (l: string): Record<string, Record<string, unknown>> =>
  JSON.parse(read(`i18n/locales/${l}.json`)) as Record<string, Record<string, unknown>>;

describe('B154 UI', () => {
  it('File → Export PDF Files and Screenshots opens the dialog, which runs through export-media IPC', () => {
    expect(menu).toContain("label: L.exportMedia,\n          click: () => send('export-media'),");
    expect(app).toContain("case 'export-media':\n          setMediaExportOpen(true);");
    expect(media).toContain('window.freecrawl.exportMediaInfo()');
    expect(media).toContain('.exportMediaRun({ what, maxBytes })');
    expect(mainIndex).toContain('registerHandle(IPC.exportMediaRun,');
    expect(mainIndex).toContain('setPdfExportMaxBytes(sess.getDb(), input.maxBytes);');
  });

  it('the set editor, the schedule and the menu run all fetch PDFs with the app config and the project cap', () => {
    expect(mainIndex.match(/\.\.\.desktopPdfOptions\(sess\.lastCrawlConfig, (sess\.getDb\(\)|db)\)/g)).toHaveLength(3);
    expect(sets).toContain("case 'pdfs':");
    expect(sets).toContain("case 'screenshots':");
  });

  it('every Generate XML Sitemap entry asks for the lastmod source, then passes it on', () => {
    for (const v of ['standard', 'image', 'hreflang', 'news', 'video']) {
      expect(app).toContain(`setSitemapVariant('${v}');`);
    }
    expect(app).not.toMatch(/sitemapGenerate\(\{ filePath: '' \}\)/);
    expect(app).toContain("window.freecrawl.sitemapGenerate({ filePath: '', variant, lastmod })");
    expect(sitemap).toContain("const LASTMODS: SitemapLastmod[] = ['chain', 'last-modified', 'sitemap', 'crawl', 'none'];");
  });

  it('English and Russian carry every new string; Russian is translated', () => {
    const en = locale('en');
    const ru = locale('ru');
    const keys = (o: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'string' ? [`${prefix}${k}`] : keys(v as Record<string, unknown>, `${prefix}${k}.`),
      );
    for (const block of ['mediaExport', 'sitemapGenerate'] as const) {
      expect(keys(ru[block]!).sort(), block).toEqual(keys(en[block]!).sort());
    }
    for (const k of keys(en['mediaExport']!)) {
      const tsx = /^(\w+)$/.exec(k)![1]!;
      expect(media, k).toContain(`'mediaExport.${tsx}'`);
    }
    expect(ru['mediaExport']!['title']).not.toBe(en['mediaExport']!['title']);
    expect((ru['sitemapGenerate']!['lastmod'] as Record<string, string>)['chain']).toMatch(/[а-я]/);
    expect(ru['exportSets']!['tokenPdfs']).toMatch(/[а-я]/);
  });

  it('the menu label and both folder dialog titles exist in every menu language', () => {
    for (const lang of ['en', 'tr', 'az', 'zh-CN', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'es'] as const) {
      const labels = getMenuLabels(lang);
      for (const k of ['exportMedia', 'dlgMediaExportFolderTitle', 'dlgMediaExportCompleteTitle'] as const) {
        expect(labels[k], `${lang}.${k}`).toBeTruthy();
      }
    }
    expect(getMenuLabels('ru').exportMedia).not.toBe(getMenuLabels('en').exportMedia);
  });
});
