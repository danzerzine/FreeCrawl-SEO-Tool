/**
 * Service-account auth for BigQuery, shared by the crawl export (bigquery-export.ts) and the
 * Search Console bulk-export reader (gsc-bigquery.ts). Pure move out of bigquery-export.ts.
 *
 * The JWT is signed with the key's RS256 private key and exchanged at Google's token endpoint;
 * the access token is cached per process until a minute before it expires.
 */
import { createSign } from 'node:crypto';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';
import { GoogleTokenError, type GoogleDeps } from './google-retry.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/bigquery';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

function base64url(buf: Buffer | string): string {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64url');
}

/** Parse and validate the stored service-account JSON. */
export function parseServiceAccount(raw: string): ServiceAccount {
  if (!raw.trim()) {
    throw new Error(
      'No BigQuery service account — paste the JSON key in Settings → Integrations.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Service account JSON failed to parse: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Service account JSON is not an object.');
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (typeof sa.client_email !== 'string' || !sa.client_email) {
    throw new Error('Service account JSON missing `client_email`.');
  }
  if (typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY')) {
    throw new Error('Service account JSON missing `private_key`.');
  }
  return sa as ServiceAccount;
}

/** Mint a Google access token via the JWT-bearer grant. */
export async function mintAccessToken(sa: ServiceAccount, forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return tokenCache.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    exp: now + 3600,
    iat: now,
  };
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claim));
  const signingInput = `${header}.${body}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(sa.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const res = await apiFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!res.ok || !json || typeof json.access_token !== 'string') {
    const msg =
      (json?.error_description as string | undefined) ??
      (json?.error as string | undefined) ??
      `token exchange failed (HTTP ${res.status})`;
    // The key is rejected (4xx) or the token endpoint failed (5xx, 429, unreadable answer).
    const kind = res.ok || res.status >= 500 || res.status === 429 || !json ? 'endpoint' : 'dead_grant';
    throw new GoogleTokenError(`BigQuery auth: ${msg}`, kind);
  }
  const expiresIn =
    typeof json.expires_in === 'number' ? (json.expires_in as number) : 3600;
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.token;
}

export const defaultDeps = (getCreds: () => Record<string, string>): GoogleDeps => ({
  fetch: apiFetch as unknown as typeof fetch,
  getToken: (refresh) => mintAccessToken(parseServiceAccount(getCreds()['serviceAccountJson'] ?? ''), refresh),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: Math.random,
  log: (level, message) => logger.log(level, 'bigquery', message),
  authFix: 'Check the service-account key in Settings → Integrations (BigQuery): it may be deleted, disabled or pasted wrong.',
});

