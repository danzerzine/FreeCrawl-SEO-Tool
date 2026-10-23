import net, { type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { alertAfterCrawl, saveAlertsConfig } from './monitor-alerts.js';

/**
 * B115 — a scheduled crawl's change summary must not depend on a rule firing.
 * Mail goes only to a local fake SMTP server; nothing real is sent.
 */
interface Mail { to: string[]; data: string }
let server: net.Server;
let mails: Mail[] = [];
let socks: net.Socket[] = [];
let port = 0;

beforeAll(async () => {
  server = net.createServer((sock) => {
    socks.push(sock);
    let mail: Mail = { to: [], data: '' };
    let inData = false;
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (let i; (i = buf.indexOf(inData ? '\r\n.\r\n' : '\r\n')) >= 0; ) {
        if (inData) {
          mail.data = buf.slice(0, i);
          buf = buf.slice(i + 5);
          inData = false;
          mails.push(mail);
          mail = { to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('235 2.7.0 Accepted\r\n');
        else if (/^RCPT TO/i.test(line)) { mail.to.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => {
  mails = [];
  socks.forEach((s) => s.destroy());
  socks = [];
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const dir = mkdtempSync(join(tmpdir(), 'b115-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FOOTER = 'Changes: added 2.';
const MORE_404 = { name: 'More 404s', metric: 'status.404', vs: 'previous' as const, op: '>' as const, value: 0 };
const START = 'https://example.test/';
let n = 0;

/** A project with two finished crawls of the same (empty) site: no rule can fire on equal counts. */
function project(config: { rules: (typeof MORE_404)[]; channels: ('email' | 'slack')[] }): ProjectDb {
  const db = new ProjectDb(join(dir, `p${n++}.seoproject`));
  saveAlertsConfig(db, config);
  for (const finishedAt of ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']) {
    db.recordCrawlRun({ finishedAt, startUrl: START, mode: 'spider', durationMs: 1, toolVersion: 't' });
  }
  return db;
}

const logs: string[] = [];
const deps = (creds: Record<string, string> | null = { smtpUrl: `smtp://bot:pw@127.0.0.1:${0}`, to: 'ops@example.test' }) => ({
  credentials: (id: string) =>
    id === 'email' && creds ? { ...creds, smtpUrl: creds['smtpUrl']!.replace(':0', `:${port}`) } : {},
  log: (_l: 'info' | 'warn', m: string) => void logs.push(m),
});

describe('change summary without a fired rule (B115)', () => {
  it('rules on, none fired, email on: the summary mail still goes to the alert recipient', async () => {
    const db = project({ rules: [MORE_404], channels: ['email'] });
    const out = await alertAfterCrawl(db, deps(), { footer: FOOTER });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to.join()).toContain('<ops@example.test>');
    expect(mails[0]!.data).toContain(FOOTER);
    expect(mails[0]!.data).not.toMatch(/0 rule\(s\) fired/);
    expect(out.map((d) => [d.channel, d.ok])).toEqual([['email', true]]);
  });

  it('no summary (no comparison): a quiet crawl sends nothing, as before', async () => {
    const db = project({ rules: [MORE_404], channels: ['email'] });
    expect(await alertAfterCrawl(db, deps())).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('an empty comparison (no changes) sends nothing when no rule fired', async () => {
    const db = project({ rules: [MORE_404], channels: ['email'] });
    expect(await alertAfterCrawl(db, deps(), { footer: 'Changes: none.', footerChanged: false })).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('alert rules switched off (no rules) or no channel on: nothing is sent', async () => {
    const noRules = project({ rules: [], channels: ['email'] });
    expect(await alertAfterCrawl(noRules, deps(), { footer: FOOTER })).toEqual([]);
    const noChannel = project({ rules: [MORE_404], channels: [] });
    expect(await alertAfterCrawl(noChannel, deps(), { footer: FOOTER })).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('email is not among the channels (summary is mail-only): nothing is sent', async () => {
    const db = project({ rules: [MORE_404], channels: ['slack'] });
    expect(await alertAfterCrawl(db, deps(), { footer: FOOTER })).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('email on but no recipient or SMTP address: nothing is sent, no failure thrown', async () => {
    const db = project({ rules: [MORE_404], channels: ['email'] });
    expect(await alertAfterCrawl(db, deps(null), { footer: FOOTER })).toEqual([]);
    expect(await alertAfterCrawl(db, deps({ smtpUrl: `smtp://127.0.0.1:0`, to: '' }), { footer: FOOTER })).toEqual([]);
    expect(mails).toHaveLength(0);
  });
});
