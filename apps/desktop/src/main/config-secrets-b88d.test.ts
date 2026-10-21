import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';

// Reversible stand-in for the OS keyring, so "encrypted" really hides the text.
vi.mock('electron', () => {
  const flip = (s: string) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a);
  return {
    app: { getPath: () => process.env.FC_TEST_USERDATA ?? '/tmp' },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(flip(s)),
      decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
    },
  };
});

const { splitConfigSecrets, serializeConfigWithEncryptedSecrets, parseConfigWithEncryptedSecrets } =
  await import('./config-secrets.js');

const HOOK = 'https://hooks.example.test/services/T0/B0/very-secret-path';

describe('crawl-config secrets (B88d)', () => {
  it('splitConfigSecrets moves webhookUrl into the secrets', () => {
    const { clean, secrets } = splitConfigSecrets({ ...DEFAULT_CRAWL_CONFIG, webhookUrl: HOOK } as CrawlConfig);
    expect(clean.webhookUrl).toBe('');
    expect(secrets['webhookUrl']).toBe(HOOK);
  });

  it('the stored config holds no webhook URL in plain text and reads back whole', () => {
    const raw = serializeConfigWithEncryptedSecrets({ ...DEFAULT_CRAWL_CONFIG, webhookUrl: HOOK } as CrawlConfig);
    expect(raw).not.toContain('very-secret-path');
    expect(parseConfigWithEncryptedSecrets(raw)?.webhookUrl).toBe(HOOK);
  });
});
