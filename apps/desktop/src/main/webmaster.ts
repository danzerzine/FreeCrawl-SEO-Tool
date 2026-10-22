/**
 * Yandex Webmaster API client, bound to the desktop app. The client itself lives in packages/core
 * `webmaster.ts`; this binding sends its requests through the integration dispatcher
 * (`api-fetch.ts`) and its diagnostics to the app log.
 */
import type { WebmasterHost } from '@freecrawl/shared-types';
import { getWebmasterUserId, listWebmasterHosts, type WebmasterDeps } from '@freecrawl/core';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';

export { WebmasterError } from '@freecrawl/core';

export const webmasterDeps: WebmasterDeps = {
  fetch: apiFetch,
  log: (level, message) => logger.log(level, 'webmaster', message),
};

/** The account behind the token and every host it can see. */
export async function listHosts(
  token: string,
): Promise<{ userId: number; hosts: WebmasterHost[] }> {
  const userId = await getWebmasterUserId(token, webmasterDeps);
  return { userId, hosts: await listWebmasterHosts(token, userId, webmasterDeps) };
}
