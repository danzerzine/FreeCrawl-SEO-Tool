/**
 * B88d — monitoring alerts as the desktop runs them: the project's rules
 * (`project_meta` `monitorRules`, the rule-file JSON the CLI reads too)
 * and the channels turned on for it (`monitorChannels`), checked after
 * every finished crawl against the previous crawl of the same site.
 *
 * Kept out of `index.ts` and free of Electron: credentials come in through
 * `deps.credentials` (`resolveCredentials`), so this runs, and is tested,
 * on its own. Delivery is best effort: a failed send is logged and
 * returned, never thrown.
 */
import type { ProjectDb } from '@freecrawl/db';
import {
  evaluateRules,
  listMetrics,
  listProjectRules,
  saveProjectRules,
  sendSlack,
  sendTelegram,
  sendWebhook,
  type AlertRuleResult,
  type SendResult,
} from '@freecrawl/core';
import {
  ALERT_CHANNELS,
  type AlertChannelId,
  type AlertDelivery,
  type MonitorAlertsConfig,
  type MonitorAlertsState,
} from '@freecrawl/shared-types';

/** `project_meta` key: JSON array of the {@link AlertChannelId}s turned on. */
const CHANNELS_META_KEY = 'monitorChannels';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface AlertDeps {
  /** Plaintext fields of one integration; main process only. */
  credentials: (integrationId: string) => Record<string, string>;
  /** Settings → Webhook URL, the generic channel. */
  webhookUrl?: string;
  /** Bot API base; tests point it at a local server. */
  telegramApiBase?: string;
  timeoutMs?: number;
  log: (level: 'info' | 'warn', message: string) => void;
}

type Sender = (results: AlertRuleResult[], deps: AlertDeps, title: string) => Promise<SendResult> | null;

/**
 * Builds one channel's send from its credentials; null when they are not
 * filled in. Every secret stays inside the sender, whose `detail` is
 * already redacted.
 */
const SENDERS: Record<AlertChannelId, Sender> = {
  slack: (results, deps, title) => {
    const url = deps.credentials('slack')['webhookUrl']?.trim();
    return url ? sendSlack(url, results, { title, timeoutMs: deps.timeoutMs }) : null;
  },
  telegram: (results, deps, title) => {
    const c = deps.credentials('telegram');
    const token = c['botToken']?.trim();
    const chatId = c['chatId']?.trim();
    if (!token || !chatId) return null;
    const apiBase = deps.telegramApiBase ?? TELEGRAM_API_BASE;
    return sendTelegram({ apiBase, token, chatId }, results, { title, timeoutMs: deps.timeoutMs });
  },
  email: (results, deps, title) => {
    const c = deps.credentials('email');
    const smtpUrl = c['smtpUrl']?.trim();
    const to = c['to']?.trim();
    if (!smtpUrl || !to) return null;
    // MERGE-B88F: the one email call site. When `sendEmail` (B88f) is in
    // core, replace the next three lines with
    //   return sendEmail(smtpUrl, to, results, { title, timeoutMs: deps.timeoutMs });
    void results;
    void title;
    return Promise.resolve({ ok: false, detail: 'email sending is not available in this build yet' });
  },
  webhook: (results, deps) => {
    const url = deps.webhookUrl?.trim();
    return url ? sendWebhook(url, results, { timeoutMs: deps.timeoutMs }) : null;
  },
};

/** The project's saved rules and channels. */
export function readAlertsConfig(db: Pick<ProjectDb, 'getMeta'>): MonitorAlertsConfig {
  let channels: AlertChannelId[] = [];
  try {
    const raw: unknown = JSON.parse(db.getMeta(CHANNELS_META_KEY) || '[]');
    if (Array.isArray(raw)) channels = ALERT_CHANNELS.filter((c) => raw.includes(c));
  } catch {
    /* unreadable: no channel on */
  }
  return { rules: listProjectRules(db), channels };
}

/** Saves both; a bad rule throws (naming `rules[<index>]`) before anything is written. */
export function saveAlertsConfig(
  db: Pick<ProjectDb, 'getMeta' | 'setMeta'>,
  config: MonitorAlertsConfig,
): MonitorAlertsConfig {
  saveProjectRules(db, { version: 1, rules: config.rules });
  const channels = ALERT_CHANNELS.filter((c) => config.channels.includes(c));
  db.setMeta(CHANNELS_META_KEY, JSON.stringify(channels));
  return readAlertsConfig(db);
}

/** What the Alerts panel loads. */
export function alertsState(db: Pick<ProjectDb, 'getMeta'>, deps: AlertDeps): MonitorAlertsState {
  const configured = ALERT_CHANNELS.filter((ch) => {
    if (ch === 'webhook') return Boolean(deps.webhookUrl?.trim());
    const c = deps.credentials(ch);
    if (ch === 'slack') return Boolean(c['webhookUrl']);
    if (ch === 'telegram') return Boolean(c['botToken'] && c['chatId']);
    return Boolean(c['smtpUrl'] && c['to']);
  });
  return { ...readAlertsConfig(db), metrics: listMetrics(), configured };
}

async function deliver(
  channels: readonly AlertChannelId[],
  results: AlertRuleResult[],
  deps: AlertDeps,
  title: string,
): Promise<AlertDelivery[]> {
  return Promise.all(
    channels.map(async (channel): Promise<AlertDelivery> => {
      try {
        const sent = SENDERS[channel](results, deps, title);
        const r = sent ? await sent : { ok: false, detail: 'not configured' };
        deps.log(r.ok ? 'info' : 'warn', `Alert to ${channel} ${r.ok ? 'sent' : 'failed'}: ${r.detail}`);
        return { channel, ok: r.ok, detail: r.detail };
      } catch (err) {
        // Senders never throw; a credential-store failure still must not.
        const detail = err instanceof Error ? err.message : String(err);
        deps.log('warn', `Alert to ${channel} failed: ${detail}`);
        return { channel, ok: false, detail };
      }
    }),
  );
}

/**
 * After a finished crawl: evaluates the project's rules on its newest
 * history row against the row before it of the same start URL, and sends
 * one message per channel that is on when at least one rule fired. The
 * start URL is the crawler's resolved one from the newest row, not the
 * typed `lastStartUrl`, which can differ (redirect, missing slash).
 */
export async function alertAfterCrawl(
  db: Pick<ProjectDb, 'getMeta' | 'latestCrawlRunStartUrl' | 'listCrawlRuns'>,
  deps: AlertDeps,
): Promise<AlertDelivery[]> {
  try {
    const { channels } = readAlertsConfig(db);
    const rules = listProjectRules(db);
    if (rules.length === 0 || channels.length === 0) return [];
    const startUrl = db.latestCrawlRunStartUrl();
    if (startUrl === null) return [];
    const runs = db.listCrawlRuns(startUrl, 2);
    const current = runs[runs.length - 1]!;
    const previous = runs.length > 1 ? runs[0]!.snapshot : null;
    const results = evaluateRules(rules, current.snapshot, previous);
    const fired = results.filter((r) => r.status === 'fired').length;
    if (fired === 0) return [];
    deps.log('info', `Alerts: ${fired} rule(s) fired for ${startUrl}`);
    return await deliver(channels, results, deps, 'FreeCrawl alert');
  } catch (err) {
    deps.log('warn', `Alerts skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** One sample fired rule, for the panel's «send test». */
const TEST_RESULT: AlertRuleResult = {
  name: 'Test alert from Settings → Alerts',
  metric: 'urls.total',
  level: 'warn',
  status: 'fired',
  previous: 100,
  current: 90,
  change: -10,
  changeUnit: 'count',
  threshold: { op: '<', value: 0 },
};

/** Sends the sample alert to each chosen channel; one without credentials reports «not configured». */
export function sendTestAlert(channels: readonly AlertChannelId[], deps: AlertDeps): Promise<AlertDelivery[]> {
  const chosen = ALERT_CHANNELS.filter((c) => channels.includes(c));
  return deliver(chosen, [TEST_RESULT], deps, 'FreeCrawl test alert');
}
