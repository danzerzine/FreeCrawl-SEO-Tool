import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The renderer project is not compiled by this test project: wiring is checked on the source text.
const root = path.resolve(__dirname, '../../../..');
const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const dialog = (): string => src('../renderer/src/components/IssueTaskDialog.tsx');
const locale = (l: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../renderer/src/i18n/locales/${l}.json`), 'utf8'));

function usedKeys(): string[] {
  return [...new Set([...dialog().matchAll(/t\(\s*'issueTask\.(\w+)'/g)].map((m) => m[1]!))];
}

describe('M21 IPC wiring', () => {
  it('three channels exist in ipc.ts, preload and main', () => {
    const ipc = src('../../../../packages/shared-types/src/ipc.ts');
    const preload = src('../preload/index.ts');
    const main = src('./index.ts');
    for (const [name, ch] of [
      ['issueTaskPreview', 'issue-task:preview'],
      ['issueTaskSend', 'issue-task:send'],
      ['issueTaskSave', 'issue-task:save'],
    ]) {
      expect(ipc).toContain(`${name}: '${ch}'`);
      expect(preload).toMatch(new RegExp(`${name}: \\(input`));
      expect(main).toMatch(new RegExp(`registerHandle\\(IPC\\.${name}`));
    }
  });

  it('main reads tracker credentials in the main process only, with the api fetch and the env', () => {
    const main = src('./index.ts');
    expect(main).toMatch(/createIssueTaskService\(\{[\s\S]*?credentials: resolveCredentials[\s\S]*?env: process\.env/);
  });

  it('the MCP server imports nothing from the tracker senders', () => {
    const dir = path.join(root, 'apps/mcp-server/src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && /issue-task|sendGithubIssue|sendBasecampTodo/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(dir);
    expect(hits).toEqual([]);
  });
});

describe('M21 dialog', () => {
  it('only the send handler calls issueTaskSend, and the buttons are off while it runs', () => {
    const d = dialog();
    expect(d.match(/issueTaskSend\(/g)).toHaveLength(1);
    expect(d).toMatch(/const send = async/);
    expect(d).toMatch(/if \(sending\) return/);
    expect(d).toMatch(/disabled=\{[^}]*sending[^}]*\}/);
  });

  it('Copy and Save need no integration; the send buttons need a configured target', () => {
    const d = dialog();
    expect(d).toMatch(/navigator\.clipboard\.writeText\(/);
    expect(d).toMatch(/issueTaskSave\(/);
    expect(d).toMatch(/ready\?\.targets\[target\]/);
    expect(d).toMatch(/disabled=\{!ready \|\| !configured \|\| sending\}/);
    expect(d).toMatch(/targetRow\('github'\)[\s\S]*targetRow\('basecamp'\)/);
  });

  it('shows the exact Markdown and the exact Basecamp HTML, the already-sent warning and the may-have-been-created note', () => {
    const d = dialog();
    expect(d).toMatch(/ready\.markdown/);
    expect(d).toMatch(/ready\.basecampHtml/);
    expect(d).toMatch(/alreadySent/);
    expect(d).toMatch(/mayHaveBeenCreated/);
  });

  it('the button sits in the URLs tab and shows for an Issues check only', () => {
    const tab = src('../renderer/src/tabs/UrlsTab.tsx');
    expect(tab).toMatch(/<IssueTaskDialog/);
    expect(tab).toMatch(/activeCategory\.startsWith\('issues:'\)/);
    expect(tab).toMatch(/t\('issueTask\.button'/);
  });
});

describe('M21 locale keys', () => {
  it('the dialog asks for keys', () => {
    expect(usedKeys().length).toBeGreaterThan(15);
  });

  it('en has every key as a string', () => {
    const en = locale('en');
    expect(usedKeys().filter((k) => typeof en['issueTask']?.[k] !== 'string')).toEqual([]);
  });

  it('ru has every key and none is the English text', () => {
    const en = locale('en');
    const ru = locale('ru');
    expect(usedKeys().filter((k) => typeof ru['issueTask']?.[k] !== 'string')).toEqual([]);
    // Product names and file formats, the same word in both languages.
    const SAME = new Set(['viewMarkdown', 'viewBasecamp']);
    expect(usedKeys().filter((k) => !SAME.has(k) && ru['issueTask']?.[k] === en['issueTask']?.[k])).toEqual([]);
  });

  it('ru keeps the same placeholders as en', () => {
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const en = locale('en');
    const ru = locale('ru');
    for (const k of usedKeys()) expect(ph(ru['issueTask']![k]!), k).toEqual(ph(en['issueTask']![k]!));
  });

  it('the Settings hints of both trackers have a Russian text', () => {
    const labels = fs.readFileSync(path.join(__dirname, '../renderer/src/i18n/labels/ru.ts'), 'utf8');
    expect(labels).toContain("Paste an OAuth access token. Basecamp tokens expire every 2 weeks");
    expect(labels).toContain("Create a fine-grained personal access token for the one repository");
  });
});
