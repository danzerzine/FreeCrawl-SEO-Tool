import type { BasecampTaskConfig, GithubTaskConfig } from '@freecrawl/core';
import {
  BASECAMP_API_BASE,
  GITHUB_API_BASE,
  TRACKER_TEST_ENV,
  TRACKER_USER_AGENT,
} from './tracker-constants.js';

export type TrackerTarget = 'github' | 'basecamp';

export type TrackerConfigResult<T> = { ok: true; cfg: T } | { ok: false; message: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** In test mode the address that will actually be called must be loopback. */
function testModeRefusal(apiBase: string, env: Record<string, string | undefined>): string | null {
  if (env[TRACKER_TEST_ENV] !== '1') return null;
  try {
    const u = new URL(apiBase);
    if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return null;
  } catch {
    /* fall through to the refusal */
  }
  return `Test mode (${TRACKER_TEST_ENV}=1): the tracker API address must be a local http address; set apiBase in the integration.`;
}

function missing(fields: Record<string, string | undefined>, id: string): string | null {
  const gone = Object.entries(fields)
    .filter(([, v]) => !v?.trim())
    .map(([k]) => k);
  return gone.length
    ? `${id} is not set up: fill ${gone.join(', ')} in Settings → Integrations.`
    : null;
}

/** Stored credentials of an integration → the config a core sender takes, defaults applied, test mode checked. */
export function resolveTrackerConfig(
  target: 'github',
  creds: Record<string, string>,
  env: Record<string, string | undefined>,
): TrackerConfigResult<GithubTaskConfig>;
export function resolveTrackerConfig(
  target: 'basecamp',
  creds: Record<string, string>,
  env: Record<string, string | undefined>,
): TrackerConfigResult<BasecampTaskConfig>;
export function resolveTrackerConfig(
  target: TrackerTarget,
  creds: Record<string, string>,
  env: Record<string, string | undefined>,
): TrackerConfigResult<GithubTaskConfig | BasecampTaskConfig> {
  const get = (k: string) => creds[k]?.trim() ?? '';
  const apiBase = get('apiBase') || (target === 'github' ? GITHUB_API_BASE : BASECAMP_API_BASE);
  const gone =
    target === 'github'
      ? missing({ token: get('token'), owner: get('owner'), repo: get('repo') }, 'GitHub')
      : missing(
          {
            accessToken: get('accessToken'),
            accountId: get('accountId'),
            todolistId: get('todolistId'),
          },
          'Basecamp',
        );
  if (gone) return { ok: false, message: gone };
  const refusal = testModeRefusal(apiBase, env);
  if (refusal) return { ok: false, message: refusal };
  return target === 'github'
    ? {
        ok: true,
        cfg: {
          apiBase,
          token: get('token'),
          owner: get('owner'),
          repo: get('repo'),
          userAgent: TRACKER_USER_AGENT,
        },
      }
    : {
        ok: true,
        cfg: {
          apiBase,
          accessToken: get('accessToken'),
          accountId: get('accountId'),
          todolistId: get('todolistId'),
          userAgent: TRACKER_USER_AGENT,
        },
      };
}
