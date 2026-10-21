import type { CrawlConfig } from '@freecrawl/shared-types';
import { decryptString, encryptString } from './credentials.js';

// Crawl-config secret handling, moved out of `index.ts` so it is tested on
// its own.
//
// `CrawlConfig` carries credentials — HTTP-auth password/token, the browser
// form-login password, a proxy URL that can embed `user:pass@`, and the
// crawl-finished webhook URL. These must not sit in plaintext in
// preferences.json or the .seoproject, nor be handed to a colleague in a
// shared settings-export. `configSecretFields` enumerates them; the helpers
// below either blank them (export) or split them out for at-rest encryption
// (prefs / project meta).

/** Return the secret values from a config as a flat record, and a deep-ish
 *  copy of the config with those values blanked. */
export function splitConfigSecrets(config: CrawlConfig): {
  clean: CrawlConfig;
  secrets: Record<string, string>;
} {
  const clean: CrawlConfig = JSON.parse(JSON.stringify(config)) as CrawlConfig;
  const secrets: Record<string, string> = {};
  if (clean.auth) {
    if (clean.auth.password) {
      secrets['auth.password'] = clean.auth.password;
      clean.auth.password = '';
    }
    if (clean.auth.token) {
      secrets['auth.token'] = clean.auth.token;
      clean.auth.token = '';
    }
  }
  const pv = clean.formLogin?.browser?.passwordValue;
  if (pv) {
    secrets['formLogin.browser.passwordValue'] = pv;
    clean.formLogin!.browser!.passwordValue = '';
  }
  if (clean.proxyUrl) {
    secrets['proxyUrl'] = clean.proxyUrl;
    clean.proxyUrl = '';
  }
  // Bearer-equivalent (crawler.ts) and reused by the alerts.
  if (clean.webhookUrl) {
    secrets['webhookUrl'] = clean.webhookUrl;
    clean.webhookUrl = '';
  }
  return { clean, secrets };
}

/** Re-apply previously split secrets onto a (cleaned) config, in place. */
export function applyConfigSecrets(
  config: CrawlConfig,
  secrets: Record<string, string>,
): CrawlConfig {
  if (secrets['auth.password'] !== undefined && config.auth) {
    config.auth.password = secrets['auth.password'];
  }
  if (secrets['auth.token'] !== undefined && config.auth) {
    config.auth.token = secrets['auth.token'];
  }
  if (
    secrets['formLogin.browser.passwordValue'] !== undefined &&
    config.formLogin?.browser
  ) {
    config.formLogin.browser.passwordValue = secrets['formLogin.browser.passwordValue'];
  }
  if (secrets['proxyUrl'] !== undefined) {
    config.proxyUrl = secrets['proxyUrl'];
  }
  if (secrets['webhookUrl'] !== undefined) {
    config.webhookUrl = secrets['webhookUrl'];
  }
  return config;
}

/** A copy of the config with every secret blanked — for the shareable
 *  settings-export, which must never carry credentials. Accepts a loose
 *  record because the export IPC types its payload as `Record<string,
 *  unknown>`; the JSON round-trip inside `splitConfigSecrets` tolerates
 *  partial/extra fields. */
export function redactConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  return splitConfigSecrets(config as unknown as CrawlConfig).clean as unknown as Record<
    string,
    unknown
  >;
}

/** Serialize a config for at-rest storage: secrets are pulled out and the
 *  whole secret bundle is encrypted into one field, the rest stays plain
 *  (and human-diffable). Returns the JSON string to persist. */
export function serializeConfigWithEncryptedSecrets(config: CrawlConfig): string {
  const { clean, secrets } = splitConfigSecrets(config);
  const payload: { config: CrawlConfig; secretsEnc?: string } = { config: clean };
  if (Object.keys(secrets).length > 0) {
    payload.secretsEnc = encryptString(JSON.stringify(secrets));
  }
  return JSON.stringify(payload);
}

/** Reverse of {@link serializeConfigWithEncryptedSecrets}. Accepts both the
 *  new `{config, secretsEnc}` envelope and a legacy bare-config JSON string
 *  (pre-encryption projects) so old files still load. Returns null on parse
 *  failure. */
export function parseConfigWithEncryptedSecrets(raw: string): Partial<CrawlConfig> | null {
  try {
    const parsed = JSON.parse(raw) as
      | { config?: Partial<CrawlConfig>; secretsEnc?: string }
      | Partial<CrawlConfig>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'config' in parsed &&
      (parsed as { config?: unknown }).config
    ) {
      const env = parsed as { config: Partial<CrawlConfig>; secretsEnc?: string };
      const cfg = env.config;
      if (env.secretsEnc) {
        try {
          const secrets = JSON.parse(decryptString(env.secretsEnc)) as Record<string, string>;
          applyConfigSecrets(cfg as CrawlConfig, secrets);
        } catch {
          /* corrupt/undecryptable secrets — load the rest without them */
        }
      }
      return cfg;
    }
    // Legacy: the whole thing is a bare config object.
    return parsed as Partial<CrawlConfig>;
  } catch {
    return null;
  }
}
