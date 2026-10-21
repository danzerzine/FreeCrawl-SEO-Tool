import { afterEach, describe, expect, it } from 'vitest';
import net, { type AddressInfo } from 'node:net';
import { formatAlert, sendEmail, sendSlack, type AlertRuleResult } from './notify.js';

const rule: AlertRuleResult = {
  name: 'Rule 1', metric: 'status.404', level: 'fail', status: 'fired',
  previous: 10, current: 70, change: 60, threshold: { op: '>', value: 50 },
};

interface Mail { from: string; to: string[]; data: string }
let server: net.Server;
let mails: Mail[];
let socks: net.Socket[] = [];

/** Minimal SMTP server: AUTH PLAIN, then MAIL/RCPT/DATA. `authReply` is the AUTH answer. */
async function smtp(authReply = '235 2.7.0 Accepted'): Promise<number> {
  mails = [];
  server = net.createServer((sock) => {
    socks.push(sock);
    let mail: Mail = { from: '', to: [], data: '' };
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
          mail = { from: '', to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write(`${authReply}\r\n`);
        else if (/^MAIL FROM/i.test(line)) { mail.from = line; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { mail.to.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}
afterEach(() => new Promise<void>((r) => {
  server?.close(() => r());
  socks.forEach((s) => s.destroy());
  socks = [];
}));

/** Body of a message with its transfer encoding undone. */
function bodyText(data: string): string {
  const [head = '', ...rest] = data.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  if (/content-transfer-encoding:\s*base64/i.test(head)) return Buffer.from(body, 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    const bytes = body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

describe('sendEmail', () => {
  it('delivers one mail to the recipient with the Slack text', async () => {
    const port = await smtp();
    const res = await sendEmail(`smtp://bot:s3cret@127.0.0.1:${port}`, 'ops@example.com', [rule]);
    expect(res.ok).toBe(true);
    expect(res.detail).not.toContain('s3cret');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to.join()).toContain('<ops@example.com>');
    expect(bodyText(mails[0]!.data).replaceAll('\r\n', '\n')).toContain(formatAlert([rule]));
    expect(mails[0]!.data).toMatch(/^Subject: .*FreeCrawl alert/im);
    // Same text a Slack message would carry.
    expect(formatAlert([rule])).toContain('10 → 70');
    void sendSlack;
  });

  it('answers ok:false with the server reply on bad credentials, no password', async () => {
    const port = await smtp('535 5.7.8 Authentication credentials invalid');
    const res = await sendEmail(`smtp://bot:s3cret@127.0.0.1:${port}`, 'ops@example.com', [rule]);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('535');
    expect(res.detail).not.toContain('s3cret');
    expect(mails).toHaveLength(0);
  });

  it('does not throw on an unreachable host and hides the URL secrets', async () => {
    const res = await sendEmail('smtp://bot:s3cret@127.0.0.1:1', 'ops@example.com', [rule], { timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain('s3cret');
  });

  it('times out on a server that never answers', async () => {
    server = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const res = await sendEmail(`smtp://bot:s3cret@127.0.0.1:${port}`, 'ops@example.com', [rule], { timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain('s3cret');
  });

  it('does not throw on a malformed URL', async () => {
    const res = await sendEmail('not a url s3cret', 'ops@example.com', [rule]);
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain('s3cret');
  });
});
