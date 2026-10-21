/**
 * Alert channels for the monitoring rules: one formatter and one sender
 * per channel (Slack incoming webhook, Telegram Bot API, generic JSON
 * webhook, SMTP email). Senders take their base URL as an argument so tests can point
 * them at a local server, and follow the best-effort contract of
 * `webhook.ts`: they never throw, a failure comes back as `ok: false`.
 *
 * Secrets (Slack webhook URL, bot token, SMTP URL and password) are never put into `detail`:
 * URLs are shown through `redactUrlSecrets` and the secret strings are
 * scrubbed from any server reply or error text.
 */
import nodemailer from 'nodemailer';
import { redactUrlSecrets } from '../http-client.js';
import { postWebhookJson } from '../webhook.js';
import type { AlertRuleResult } from './rules.js';

export type { AlertRuleResult };

export interface SendResult {
  ok: boolean;
  /** Human-readable outcome; never contains a secret. */
  detail: string;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface TelegramConfig {
  /** Bot API base, e.g. `https://api.telegram.org`. */
  apiBase: string;
  token: string;
  chatId: string;
}

/** The public Bot API; `TelegramConfig.apiBase` unless a test points elsewhere. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram's `sendMessage` text limit. */
const TELEGRAM_MAX_CHARS = 4096;

function fmtNum(n: number | null): string {
  return n === null ? 'n/a' : String(Math.round(n * 100) / 100);
}

function fmtChange(r: AlertRuleResult): string {
  if (r.change === null) return 'n/a';
  const sign = r.change > 0 ? '+' : '';
  return `${sign}${fmtNum(r.change)}${r.changeUnit === 'percent' ? '%' : ''}`;
}

function ruleLine(r: AlertRuleResult): string {
  const lvl = r.level === 'warn' ? ' [warn]' : '';
  return (
    `- ${r.name}${lvl}: ${r.metric} ${fmtNum(r.previous)} → ${fmtNum(r.current)} ` +
    `(change ${fmtChange(r)}, threshold ${r.threshold.op} ${fmtNum(r.threshold.value)})`
  );
}

/**
 * Plain-text alert listing each fired rule. Cut to `maxChars` with a
 * trailing "and N more" when the list is too long.
 */
export function formatAlert(
  results: AlertRuleResult[],
  opts: { maxChars?: number; title?: string } = {},
): string {
  const maxChars = opts.maxChars ?? TELEGRAM_MAX_CHARS;
  const firedRules = results.filter((r) => r.status === 'fired');
  const header = `${opts.title ?? 'FreeCrawl alert'}: ${firedRules.length} rule(s) fired`;
  // Reserve room for the widest trailer so a cut line never overflows it.
  const reserve = `\nand ${firedRules.length} more`.length;
  let text = header;
  for (const [i, rule] of firedRules.entries()) {
    const next = `${text}\n${ruleLine(rule)}`;
    const isLast = i === firedRules.length - 1;
    if (next.length + (isLast ? 0 : reserve) > maxChars) {
      return `${text}\nand ${firedRules.length - i} more`;
    }
    text = next;
  }
  return text;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join('***');
  }
  return out;
}

async function post(
  url: string,
  shownUrl: string,
  payload: Record<string, unknown>,
  secrets: string[],
  opts: SendOptions,
): Promise<SendResult> {
  try {
    const res = await postWebhookJson(url, payload, opts.timeoutMs);
    const detail = scrub(res.detail, [...secrets, url]);
    return res.ok
      ? { ok: true, detail: `HTTP ${res.status} from ${shownUrl}` }
      : { ok: false, detail: `${res.status ? `HTTP ${res.status} ` : ''}${shownUrl}: ${detail}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${shownUrl}: ${scrub(msg, [...secrets, url])}` };
  }
}

/** Slack incoming webhook: body must be `{text}`. */
export function sendSlack(
  webhookUrl: string,
  results: AlertRuleResult[],
  opts: SendOptions & { title?: string } = {},
): Promise<SendResult> {
  return post(
    webhookUrl,
    redactUrlSecrets(webhookUrl),
    { text: formatAlert(results, { title: opts.title }) },
    [webhookUrl],
    opts,
  );
}

/** Telegram Bot API `sendMessage` to one chat. The token sits in the URL path. */
export function sendTelegram(
  cfg: TelegramConfig,
  results: AlertRuleResult[],
  opts: SendOptions & { title?: string } = {},
): Promise<SendResult> {
  const url = `${cfg.apiBase.replace(/\/+$/, '')}/bot${cfg.token}/sendMessage`;
  return post(
    url,
    redactUrlSecrets(cfg.apiBase),
    { chat_id: cfg.chatId, text: formatAlert(results, { title: opts.title }) },
    [cfg.token, url],
    opts,
  );
}

/** Generic webhook: the JSON results as they are, with the alert title. */
export function sendWebhook(
  url: string,
  results: AlertRuleResult[],
  opts: SendOptions & { title?: string } = {},
): Promise<SendResult> {
  return post(url, redactUrlSecrets(url), { title: opts.title ?? 'FreeCrawl alert', results }, [url], opts);
}

/**
 * Email over SMTP (`smtps://user:pass@host:port`), same body as Slack. The
 * sender address is the SMTP user when it is an address, else
 * `freecrawl@<host>`.
 */
export async function sendEmail(
  smtpUrl: string,
  to: string,
  results: AlertRuleResult[],
  opts: SendOptions & { title?: string } = {},
): Promise<SendResult> {
  let shown = '[unparseable url]';
  const secrets = [smtpUrl];
  try {
    const u = new URL(smtpUrl);
    shown = `${u.protocol}//${u.host}`;
    // WHATWG keeps userinfo percent-encoded; scrub both forms and the raw login.
    secrets.push(u.password, decodeURIComponent(u.password));
    const user = decodeURIComponent(u.username);
    const timeout = opts.timeoutMs ?? 10_000;
    const transport = nodemailer.createTransport({
      url: smtpUrl,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
    const fired = results.filter((r) => r.status === 'fired').length;
    try {
      await transport.sendMail({
        from: user.includes('@') ? user : `freecrawl@${u.hostname}`,
        to,
        subject: `${opts.title ?? 'FreeCrawl alert'}: ${fired} rule(s) fired`,
        text: formatAlert(results, { title: opts.title }),
      });
    } finally {
      transport.close();
    }
    return { ok: true, detail: `mail sent via ${shown}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${shown}: ${scrub(msg, secrets)}` };
  }
}
