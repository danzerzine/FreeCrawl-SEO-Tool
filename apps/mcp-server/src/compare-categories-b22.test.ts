import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPARE_CATEGORIES } from '@freecrawl/shared-types';
import { buildTools } from './tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIALOG = path.resolve(here, '../../desktop/src/renderer/src/components/CompareDialog.tsx');
const LOCALES = path.resolve(here, '../../desktop/src/renderer/src/i18n/locales');
const CLI = path.resolve(here, '../../cli/dist/index.js');

describe('one list of compare categories (B22)', () => {
  it('the MCP compare_load description names every category', () => {
    const tool = buildTools().find((t) => t.name === 'compare_load')!;
    for (const cat of COMPARE_CATEGORIES) expect(tool.description, cat).toContain(cat);
  });

  it('the CLI help names every category', () => {
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
    for (const cat of COMPARE_CATEGORIES) expect(help, cat).toContain(cat);
  });

  it('the dialog has a button for every category, and every locale has its labels', () => {
    const src = fs.readFileSync(DIALOG, 'utf8');
    for (const cat of COMPARE_CATEGORIES) expect(src, cat).toMatch(new RegExp(`\\b${cat}:`));
    const keys = [...src.matchAll(/'compare\.(\w+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(COMPARE_CATEGORIES.length);
    for (const file of fs.readdirSync(LOCALES)) {
      const compare = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8')).compare as Record<string, string>;
      for (const key of keys) expect(compare[key], `${file} compare.${key}`).toBeTruthy();
    }
  });
});
