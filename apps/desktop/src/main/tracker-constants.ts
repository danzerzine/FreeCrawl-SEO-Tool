// The only file in the repo that may name the real tracker hosts. The host
// guard test (core/issue-task-host-guard-m21.test.ts) fails on them anywhere
// else, so tests and demos can never reach a real tracker by accident.

/** Default API roots, applied in the desktop layer only when the user left apiBase empty. */
export const GITHUB_API_BASE = 'https://api.github.com';
export const BASECAMP_API_BASE = 'https://3.basecampapi.com';

/** Sent with every tracker request; Basecamp answers 400 without a "name (contact)" User-Agent. */
export const TRACKER_USER_AGENT = 'FreeCrawl (https://github.com/danzerzine/FreeCrawl-SEO-Tool)';

/**
 * Env var that switches the main process into test mode (e2e builds and
 * rendered checks). In test mode the address finally used, after defaults
 * are applied, must be loopback; a real host is refused.
 */
export const TRACKER_TEST_ENV = 'FREECRAWL_E2E';
