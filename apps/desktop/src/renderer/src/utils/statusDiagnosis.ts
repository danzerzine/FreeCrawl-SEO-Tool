/**
 * Human-readable diagnosis for an HTTP status code, enriched with
 * signals read off the response headers. Drives the "what does this
 * mean / why did it happen" banner in the URL Details → HTTP Headers
 * sub-tab — the place users land when a crawl returns a status they
 * don't recognise (520-class Cloudflare codes are the canonical
 * example: "Server Error" tells you nothing about the cause).
 *
 * Pure / sync / renderer-only — everything it needs is already in the
 * `CrawlUrlRow` (statusCode, statusText) plus the captured response
 * headers, so there's no IPC.
 *
 * Every sentence lives in `DIAGNOSIS_EN` and is looked up under `diag.`
 * in the locale files; `tests/status-diagnosis-i18n.test.ts` keeps
 * `en.json` identical to it. The caller passes its `t` — without one the
 * English text is returned (with `{{placeholders}}` filled in).
 */

export interface StatusDiagnosis {
  /** "520 — Web Server Returned an Unknown Error (Cloudflare)" */
  title: string;
  severity: 'ok' | 'info' | 'warning' | 'error';
  /** One-paragraph plain-English explanation of what the code means. */
  explanation: string;
  /** Bullet list of the most likely causes in a crawl context. */
  causes: string[];
  /**
   * Signals derived from the response headers — e.g. "Behind Cloudflare
   * (cf-ray: 9faa…)", "Server asked to retry after 60 s". Empty when no
   * recognised hint headers were present.
   */
  signals: string[];
  /**
   * Actionable next steps tuned to a crawler workflow (lower the rate,
   * change the User-Agent, etc.). Empty for codes where there's nothing
   * the crawler can do.
   */
  whatToDo: string[];
}

/** i18next's `t`, or anything shaped like it. */
export type DiagnosisTranslate = (key: string, options: Record<string, unknown>) => string;

/**
 * Every string of the diagnosis banner, in English. Keys are relative to
 * the `diag.` namespace. Settings are named exactly as the Settings dialog
 * labels them, so the user can find what a step points at.
 */
export const DIAGNOSIS_EN = {
  // ── Cloudflare's 5xx extension codes (520-530). Not origin errors in the
  //    usual sense — they describe a failure between Cloudflare and the
  //    customer's origin server, OR (530) a Cloudflare-side block.
  //    `statusText` for these is usually the unhelpful generic "Server
  //    Error", which is exactly why this table exists.
  'cloudflareStyle': 'Cloudflare-style edge code',
  'code.520.name': 'Web Server Returned an Unknown Error',
  'code.520.explanation':
    "Cloudflare connected to the origin server but got back an empty, malformed, or unexpected response (e.g. the connection was reset mid-response, the origin returned headers that are too large, or the origin process crashed). It is a catch-all 'something went wrong at the origin' code.",
  'code.520.cause1': 'Origin server crashed, restarted, or ran out of workers/memory while serving the request',
  'code.520.cause2':
    'Origin closed the TCP connection before sending a complete response (often an app-level timeout or OOM kill)',
  'code.520.cause3':
    "The crawl's request rate overwhelmed the origin's process pool — 520s that appear in bursts under load almost always mean this",
  'code.520.cause4':
    'Origin returned response headers larger than Cloudflare allows (rare; usually a misconfigured app)',
  'code.520.todo1':
    'If 520s appear in bursts across many URLs, lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed) — the origin is being overloaded by the crawl',
  'code.520.todo2':
    'Re-crawl the affected URLs after the crawl finishes (transient 520s often clear on retry — raise Retry Attempts in Settings → Speed)',
  'code.520.todo3':
    'If only specific URLs 520 consistently, those pages have a server-side bug — flag them to the site owner',

  'code.521.name': 'Web Server Is Down',
  'code.521.explanation':
    'Cloudflare could not open a TCP connection to the origin server — the origin actively refused the connection or is not listening on the expected port.',
  'code.521.cause1': 'Origin web server (nginx/Apache/Node/etc.) is stopped or has crashed',
  'code.521.cause2':
    "Origin's firewall is blocking Cloudflare's IP ranges (a misconfiguration — the origin should allow Cloudflare)",
  'code.521.cause3': 'Origin server is overloaded to the point of not accepting new connections',
  'code.521.todo1':
    'This is an origin-availability problem, not something the crawler can work around — the site is effectively down for these URLs',
  'code.521.todo2': 'Re-crawl later; if it persists, the site is broken',

  'code.522.name': 'Connection Timed Out',
  'code.522.explanation':
    'Cloudflare started a TCP handshake with the origin but it never completed within the timeout — the origin accepted the SYN but never replied, or a network device between them dropped the packets.',
  'code.522.cause1': 'Origin is severely overloaded (TCP backlog full)',
  'code.522.cause2': "Origin's firewall is silently dropping (not rejecting) Cloudflare's packets",
  'code.522.cause3': 'Network/routing issue between Cloudflare and the origin',
  'code.522.cause4': "Under crawl load: the origin's connection table is exhausted by the crawl's parallel requests",
  'code.522.todo1':
    'Lower Max Concurrency (Settings → Speed) and re-crawl — connection-table exhaustion is the usual cause when this shows up mid-crawl',
  'code.522.todo2': 'Retry the affected URLs after the crawl',

  'code.523.name': 'Origin Is Unreachable',
  'code.523.explanation':
    "Cloudflare could not route to the origin server at all — typically a DNS problem in Cloudflare's origin record, or the origin's network is down.",
  'code.523.cause1': "The site's DNS record in Cloudflare points to a wrong / dead IP",
  'code.523.cause2': "Origin's hosting provider has a network outage",
  'code.523.cause3': 'BGP / routing failure between Cloudflare and the origin',
  'code.523.todo1': 'Nothing the crawler can do — this is an origin DNS/network misconfiguration',

  'code.524.name': 'A Timeout Occurred',
  'code.524.explanation':
    "Cloudflare made a TCP connection to the origin successfully, but the origin did not send a complete HTTP response within Cloudflare's timeout (100 s by default). The origin is alive but too slow on this request.",
  'code.524.cause1': 'A slow database query, external API call, or heavy computation on the page',
  'code.524.cause2': 'Origin is overloaded — requests are queuing behind a saturated worker pool',
  'code.524.cause3':
    "Under crawl load: the crawl filled the origin's request queue and this URL waited too long behind it",
  'code.524.todo1':
    "Lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed) so the origin isn't saturated",
  'code.524.todo2':
    'Increase Response Timeout (Settings → Crawler) if you want to give genuinely slow pages more time',
  'code.524.todo3': 'Retry affected URLs after the crawl',

  'code.525.name': 'SSL Handshake Failed',
  'code.525.explanation':
    'The TLS handshake between Cloudflare and the origin server failed. This is the Cloudflare↔origin leg, not the browser↔Cloudflare leg you see in the address bar — so the site can look fine to a normal visitor and still 525.',
  'code.525.cause1':
    "Origin's TLS certificate is expired, self-signed, or for the wrong hostname (with Cloudflare in 'Full (strict)' mode)",
  'code.525.cause2': 'Origin only supports old TLS versions / cipher suites that Cloudflare rejects',
  'code.525.cause3': 'Origin server is overloaded and dropping TLS handshakes',
  'code.525.todo1':
    "Origin TLS misconfiguration — not something the crawler can change. Check the host's certificate (the TLS Cert rows in URL Details, for HTTPS)",

  'code.526.name': 'Invalid SSL Certificate',
  'code.526.explanation':
    "Cloudflare (in 'Full (strict)' SSL mode) could not validate the origin server's TLS certificate.",
  'code.526.cause1': 'Origin certificate is expired, self-signed, or issued for a different hostname',
  'code.526.cause2': 'Certificate chain on the origin is incomplete (missing intermediates)',
  'code.526.todo1': 'Origin certificate problem — nothing the crawler can do',

  'code.527.name': 'Railgun Error (Cloudflare, deprecated)',
  'code.527.explanation':
    'A connection error in Cloudflare Railgun (a now-retired origin-acceleration product). Effectively obsolete; if you see it the site is on a very old Cloudflare setup.',
  'code.527.cause1': 'Legacy Cloudflare Railgun connection failure',
  'code.527.todo1': 'Nothing actionable from the crawler side',

  'code.530.name': 'Cloudflare Error (usually a firewall / WAF block — error 1020)',
  'code.530.explanation':
    'A 530 is Cloudflare\'s way of saying "an error happened, see the error 1xxx code in the body". In a crawl context it is almost always 1020 "Access Denied" — a Cloudflare Firewall / WAF / Bot-Fight rule blocked the request. Less commonly it pairs with 1016 (origin DNS error) or other 1xxx codes.',
  'code.530.cause1':
    'Cloudflare WAF / Firewall Rules / Bot Fight Mode flagged the crawler — by IP, by User-Agent, by request rate, or by missing browser fingerprints',
  'code.530.cause2': 'The site has a "managed challenge" the crawler can\'t solve',
  'code.530.cause3': '(Rarely) an origin DNS error (1016) rather than a block',
  'code.530.todo1': 'Set a browser-like User-Agent (Settings → Requests) — the default crawler UA is the #1 trigger',
  'code.530.todo2':
    'Lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed) — rapid requests from one IP trip rate-based rules',
  'code.530.todo3': 'Respect robots.txt and any declared Crawl-delay (Settings → Crawler)',
  'code.530.todo4':
    'If the site owner is you, allowlist the crawler in Cloudflare; otherwise this site is intentionally blocking automated access',

  // ── Other codes worth a richer explanation than `statusText`.
  'code.401.name': 'Unauthorized',
  'code.401.explanation': 'The resource requires authentication and none (or invalid) credentials were sent.',
  'code.401.cause1': 'Page is behind HTTP Basic/Bearer auth',
  'code.401.cause2': 'A session cookie is required and none was sent',
  'code.401.todo1': 'Configure credentials in Settings → Authentication if you have them',
  'code.401.todo2': 'Use Settings → Cookies → "Accept all" if the site gates content behind a session',

  'code.403.name': 'Forbidden',
  'code.403.explanation':
    'The server understood the request but refuses to serve it. In a crawl this is most often a bot block or a WAF rule rather than a genuine permission issue.',
  'code.403.cause1': 'WAF / bot-protection rule triggered by the crawler User-Agent, IP, or request rate',
  'code.403.cause2': 'Directory or file genuinely not accessible to anonymous users',
  'code.403.cause3': 'Hotlink / referer protection',
  'code.403.todo1': 'Try a browser-like User-Agent (Settings → Requests)',
  'code.403.todo2': 'Lower the crawl rate (Settings → Speed)',
  'code.403.todo3': "If it's site-wide, the site is actively blocking automated access",

  'code.404.name': 'Not Found',
  'code.404.explanation': 'The server has no resource at this URL.',
  'code.404.cause1': 'Broken internal/external link',
  'code.404.cause2': 'Page was removed without a redirect',
  'code.404.cause3': 'Typo in a link href',
  'code.404.todo1': 'Fix or remove the linking pages — see the Inlinks tab for who links here',

  'code.408.name': 'Request Timeout',
  'code.408.explanation': 'The server timed out waiting for the request to complete.',
  'code.408.cause1': 'Slow network between crawler and server',
  'code.408.cause2': 'Server-side connection timeout set very low',
  'code.408.todo1': 'Usually transient — raise Retry Attempts (Settings → Speed)',

  'code.410.name': 'Gone',
  'code.410.explanation': 'The resource was intentionally and permanently removed — stronger than a 404.',
  'code.410.cause1': 'Page deliberately retired; the server is telling crawlers to drop it',
  'code.410.todo1': 'Remove links to this URL — Google will de-index it faster than a 404',

  'code.429.name': 'Too Many Requests (rate limited)',
  'code.429.explanation':
    'The server is rate-limiting the crawler — too many requests in too short a window from this IP/User-Agent.',
  'code.429.cause1': "Crawl rate exceeds the server's per-client limit",
  'code.429.cause2': 'Shared hosting with aggressive throttling',
  'code.429.todo1': 'Lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed)',
  'code.429.todo2': 'Honour the Retry-After header — see "From the response headers" below if the server sent one',
  'code.429.todo3': 'Turn on "Respect robots.txt Crawl-delay" (Settings → Crawler)',

  'code.451.name': 'Unavailable for Legal Reasons',
  'code.451.explanation': 'The resource is blocked for legal reasons (court order, GDPR geoblock, DMCA, etc.).',
  'code.451.cause1': 'Geo-restricted content',
  'code.451.cause2': 'Legally-mandated takedown',
  'code.451.todo1': 'Nothing — the block is intentional',

  'code.500.name': 'Internal Server Error',
  'code.500.explanation': 'An unhandled error occurred in the server-side application while building the page.',
  'code.500.cause1': 'Bug in the page template / backend code',
  'code.500.cause2': 'Database unavailable',
  'code.500.cause3': 'Misconfiguration on the server',
  'code.500.todo1': 'Retry after the crawl (transient 500s clear; persistent ones are a real bug)',
  'code.500.todo2':
    'If 500s appear under load, the crawl may be overwhelming a database — slow the crawl (Settings → Speed)',

  'code.502.name': 'Bad Gateway',
  'code.502.explanation':
    'A reverse proxy / load balancer in front of the app got an invalid response from the upstream application server.',
  'code.502.cause1': 'Upstream app server crashed or returned garbage',
  'code.502.cause2': 'Upstream is overloaded — common under crawl load',
  'code.502.cause3': 'Proxy↔upstream timeout',
  'code.502.todo1': 'Lower the crawl rate (Settings → Speed) if 502s appear in bursts',
  'code.502.todo2': 'Retry affected URLs after the crawl',

  'code.503.name': 'Service Unavailable',
  'code.503.explanation':
    'The server is temporarily unable to handle the request — usually overload or maintenance. Often comes with a Retry-After header.',
  'code.503.cause1': 'Server overloaded — the crawl itself can cause this',
  'code.503.cause2': 'Scheduled maintenance window',
  'code.503.cause3': 'Auto-scaling lag (new instances spinning up)',
  'code.503.todo1': 'Lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed)',
  'code.503.todo2': 'Honour Retry-After (see "From the response headers" below)',
  'code.503.todo3': 'Retry affected URLs after the crawl',

  'code.504.name': 'Gateway Timeout',
  'code.504.explanation': "A reverse proxy / load balancer didn't get a response from the upstream app server in time.",
  'code.504.cause1': 'Slow database query / external API call on the page',
  'code.504.cause2': 'Upstream overloaded — requests queueing',
  'code.504.cause3': 'Under crawl load: the crawl saturated the upstream worker pool',
  'code.504.todo1': 'Lower the crawl rate (Settings → Speed)',
  'code.504.todo2': 'Increase Response Timeout (Settings → Crawler) for genuinely slow pages',
  'code.504.todo3': 'Retry affected URLs after the crawl',

  'code.508.name': 'Loop Detected',
  'code.508.explanation':
    'The server detected an infinite loop while processing the request (often WebDAV or a redirect loop server-side).',
  'code.508.cause1': 'Server-side redirect loop',
  'code.508.cause2': 'Recursive include / symlink loop',
  'code.508.todo1': 'Server bug — nothing the crawler can do',

  'code.509.name': 'Bandwidth Limit Exceeded',
  'code.509.explanation':
    'A non-standard code (cPanel/Apache) meaning the hosting account hit its monthly bandwidth cap.',
  'code.509.cause1': 'Shared hosting bandwidth quota exhausted',
  'code.509.todo1': 'Nothing the crawler can do — the host is throttling the whole account',

  // ── Signals read off the response headers.
  'signal.cloudflare':
    'Behind Cloudflare — cf-ray {{ray}}. The status code describes the Cloudflare↔origin link, not what a browser sees.',
  'signal.fronted': 'Fronted by {{front}}.',
  'signal.origin': 'Origin server: {{server}}.',
  'signal.retryAfterSeconds':
    'Server sent Retry-After: {{seconds}} s — it is explicitly asking clients to back off for that long. A polite crawl should not re-request this URL sooner.',
  'signal.retryAfter': 'Server sent Retry-After: {{value}}.',
  'signal.cfCache': 'Cloudflare cache status: {{status}}.',
  'signal.xRobots': 'X-Robots-Tag: {{value}} — affects indexability regardless of the status.',

  // ── Deliberately not requested (robots.txt).
  'robots.title': 'Not Requested — Disallowed by robots.txt',
  'robots.explanation':
    'The crawler never sent a request for this URL: a robots.txt rule for the configured user-agent disallows it. There is no status code because no response was ever asked for — this is not a connection failure.',
  'robots.cause1': 'A Disallow rule in the site robots.txt matches this path for the crawl user-agent',
  'robots.cause2': 'The URL is linked from crawled pages, so it is recorded and counted, but never fetched',
  'robots.todo1': 'Nothing, if the exclusion is intended — Google will not crawl it either',
  'robots.todo2':
    'Check whether the page should be indexable: a disallowed URL cannot pass on link equity and its content is never seen',
  'robots.todo3':
    'Use Help → Robots.txt Tester to see which rule matches, or turn off "Respect robots.txt" in Settings → Crawler to audit it anyway',

  // ── Network error (no response).
  'network.title': 'No HTTP Response — Network / Connection Error',
  'network.explanationDetail':
    'The request never received an HTTP response. The crawler recorded: "{{detail}}".',
  'network.explanation':
    'The request never received an HTTP response — DNS lookup, TCP connection, TLS handshake, or the response read failed before any status line arrived.',
  'network.cause1':
    'DNS could not resolve the hostname (typo, dead domain, or a name only resolvable from inside a private network)',
  'network.cause2': 'TCP connection refused or timed out (host down, firewall, wrong port)',
  'network.cause3': 'TLS handshake failed (expired/invalid certificate, protocol mismatch)',
  'network.cause4': 'Connection reset or read timed out mid-response',
  'network.cause5':
    'Request aborted by the crawler because it exceeded Response Timeout (Settings → Crawler) or Max response time (Settings → Advanced)',
  'network.todo1': 'Check the hostname resolves and the site is reachable from a normal browser on this machine',
  'network.todo2': 'If it is reachable but slow, raise Response Timeout (Settings → Crawler)',
  'network.todo3':
    'If it only fails under load, lower Max Concurrency / Max URL/s (Settings → Speed) — connection-table exhaustion on the origin looks like a network error to the client',
  'network.todo4': 'Retry the affected URLs after the crawl (transient resets clear on retry)',

  // ── 1xx / 2xx / 3xx — not errors.
  'informational.title': '{{code}} — Informational',
  'informational.fallback': 'Informational',
  'informational.explanation':
    'A 1xx response ({{text}}). These are interim responses; the crawler treats them as transient and waits for the final status.',
  'success.fallback': 'Success',
  'success.explanation':
    'The request succeeded. No diagnosis needed — this section only has extra detail for error and redirect codes.',
  'redirect.fallback': 'Redirect',
  'redirect.explanation301':
    'Permanent redirect. Search engines transfer ranking signals to the target and update their index to the new URL.',
  'redirect.explanation302':
    'Temporary redirect. Search engines keep the original URL indexed. A 302 used long-term is a common SEO mistake — it should usually be a 301.',
  'redirect.explanation308': 'Permanent redirect (like 301 but the request method is preserved).',
  'redirect.explanation304':
    'Not Modified — the cached copy is still fresh. The crawler normally requests without conditional headers, so this is unusual.',
  'redirect.explanationOther': 'A {{code}} redirect ({{text}}).',
  'redirect.location': 'Location header points to: {{location}}',
  'redirect.noLocation': 'No Location header was captured — unusual for a redirect.',
  'redirect.todoPermanent':
    'If this redirect is permanent, change it to a 301/308 so ranking signals consolidate',
  'redirect.todoChain': 'Check the Response Codes tab to see the full redirect chain and its final target',

  // ── 4xx / 5xx with no specific entry.
  'clientError.fallback': 'Client Error',
  'clientError.explanation':
    "A 4xx code means the server rejected the request as the client's fault (bad request, not allowed, not found, etc.). In a crawl, persistent 4xx on linked pages usually means broken links; sporadic 4xx can be bot-protection.",
  'clientError.cause1': 'Broken or malformed link',
  'clientError.cause2': 'Bot-protection / WAF rule',
  'clientError.cause3': 'Method or content the server refuses',
  'clientError.todo1': 'Check the Inlinks tab to see what links to this URL',
  'clientError.todo2':
    'If it looks like a block, try a browser-like User-Agent and a slower rate (Settings → Requests / Speed)',
  'serverError.fallback': 'Server Error',
  'serverError.explanation':
    'A 5xx code means the server failed to fulfil a request it accepted as valid. Under crawl load these are frequently the crawl overwhelming the origin rather than a genuine page bug.',
  'serverError.cause1': 'Server-side error or crash',
  'serverError.cause2': 'Origin overloaded — possibly by the crawl itself',
  'serverError.cause3': 'Upstream/proxy failure',
  'serverError.todo1':
    'Lower Max Concurrency / Max URL/s and add a Per-Worker Delay (Settings → Speed) if 5xx appear in bursts',
  'serverError.todo2': 'Raise Retry Attempts (Settings → Speed) and re-crawl affected URLs',
} as const;

export type DiagnosisKey = keyof typeof DIAGNOSIS_EN;

/** Severity and bullet counts per code; the text is under `code.<n>.*` in `DIAGNOSIS_EN`. */
interface CodeInfo {
  severity: StatusDiagnosis['severity'];
  causes: number;
  todos: number;
  /** A Cloudflare edge code — the title names it as such. */
  cloudflare?: true;
}

const CODES: Record<number, CodeInfo> = {
  520: { severity: 'error', causes: 4, todos: 3, cloudflare: true },
  521: { severity: 'error', causes: 3, todos: 2, cloudflare: true },
  522: { severity: 'error', causes: 4, todos: 2, cloudflare: true },
  523: { severity: 'error', causes: 3, todos: 1, cloudflare: true },
  524: { severity: 'error', causes: 3, todos: 3, cloudflare: true },
  525: { severity: 'error', causes: 3, todos: 1, cloudflare: true },
  526: { severity: 'error', causes: 2, todos: 1, cloudflare: true },
  527: { severity: 'error', causes: 1, todos: 1 },
  530: { severity: 'error', causes: 3, todos: 4 },
  401: { severity: 'warning', causes: 2, todos: 2 },
  403: { severity: 'warning', causes: 3, todos: 3 },
  404: { severity: 'warning', causes: 3, todos: 1 },
  408: { severity: 'warning', causes: 2, todos: 1 },
  410: { severity: 'info', causes: 1, todos: 1 },
  429: { severity: 'warning', causes: 2, todos: 3 },
  451: { severity: 'info', causes: 2, todos: 1 },
  500: { severity: 'error', causes: 3, todos: 2 },
  502: { severity: 'error', causes: 3, todos: 2 },
  503: { severity: 'error', causes: 3, todos: 3 },
  504: { severity: 'error', causes: 3, todos: 3 },
  508: { severity: 'error', causes: 2, todos: 1 },
  509: { severity: 'error', causes: 1, todos: 1 },
};

/** Every key the code tables reference — for the i18n test. */
export function diagnosisCodeKeys(): string[] {
  const keys: string[] = [];
  for (const [code, info] of Object.entries(CODES)) {
    keys.push(`code.${code}.name`, `code.${code}.explanation`);
    for (let i = 1; i <= info.causes; i++) keys.push(`code.${code}.cause${i}`);
    for (let i = 1; i <= info.todos; i++) keys.push(`code.${code}.todo${i}`);
  }
  return keys;
}

type HeaderList = ReadonlyArray<{ name: string; value: string }>;

function headerMap(headers: HeaderList): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) m.set(h.name.toLowerCase(), h.value);
  return m;
}

/** Detect the fronting CDN / proxy from response headers, if any. */
function detectFront(h: Map<string, string>): string | null {
  const server = (h.get('server') ?? '').toLowerCase();
  if (h.has('cf-ray') || server.includes('cloudflare')) return 'Cloudflare';
  if (h.has('x-amz-cf-id') || server.includes('cloudfront')) return 'Amazon CloudFront';
  if (h.has('x-served-by') && (h.get('x-served-by') ?? '').includes('cache')) return 'Fastly';
  if (server.includes('akamai') || h.has('x-akamai-transformed')) return 'Akamai';
  if (server.includes('vercel') || h.has('x-vercel-id')) return 'Vercel';
  if (server.includes('netlify')) return 'Netlify';
  if (h.has('x-sucuri-id') || h.has('x-sucuri-cache')) return 'Sucuri WAF';
  if (server.includes('varnish') || h.has('x-varnish')) return 'Varnish';
  if (server.includes('nginx')) return 'nginx';
  if (server.includes('apache')) return 'Apache';
  if (server.includes('litespeed')) return 'LiteSpeed';
  if (server.includes('microsoft-iis') || server.includes('iis')) return 'IIS';
  return null;
}

/**
 * Build the diagnosis for a (statusCode, statusText, headers) triple.
 * `statusCode` may be null/0 for pre-response network failures, in
 * which case the explanation focuses on connection-level causes —
 * unless `indexability` says the URL was never requested at all.
 */
export function diagnoseStatus(
  statusCode: number | null,
  statusText: string | null,
  headers: HeaderList,
  indexability?: string | null,
  t?: DiagnosisTranslate,
): StatusDiagnosis {
  const tr = (key: DiagnosisKey, vars: Record<string, string | number> = {}): string => {
    const en: string = DIAGNOSIS_EN[key];
    if (t) return t(`diag.${key}`, { defaultValue: en, ...vars });
    return en.replace(/\{\{(\w+)\}\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  };
  const list = (prefix: string, kind: 'cause' | 'todo', n: number): string[] =>
    Array.from({ length: n }, (_, i) => tr(`${prefix}.${kind}${i + 1}` as DiagnosisKey));

  // Bot protection answered instead of the page: the row keeps no status
  // (it isn't the page's answer), but the code the challenge came with is
  // in the status text — "Cloudflare challenge (HTTP 403)". Diagnose that
  // code rather than calling it a network failure.
  if ((statusCode === null || statusCode === 0) && indexability === 'unknown:bot-blocked') {
    const code = /\(HTTP (\d{3})\)/.exec(statusText ?? '')?.[1];
    if (code) return diagnoseStatus(Number(code), statusText, headers, null, t);
  }
  const h = headerMap(headers);
  const front = detectFront(h);

  // Header-derived signals — independent of the status code, but most
  // useful on the error codes.
  const signals: string[] = [];
  if (h.has('cf-ray')) {
    signals.push(tr('signal.cloudflare', { ray: h.get('cf-ray') ?? '' }));
  } else if (front && front !== 'nginx' && front !== 'Apache' && front !== 'IIS' && front !== 'LiteSpeed') {
    signals.push(tr('signal.fronted', { front }));
  } else if (front) {
    signals.push(tr('signal.origin', { server: `${front}${h.get('server') ? ` (${h.get('server')})` : ''}` }));
  }
  const retryAfter = h.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    signals.push(
      Number.isFinite(seconds)
        ? tr('signal.retryAfterSeconds', { seconds })
        : tr('signal.retryAfter', { value: retryAfter }),
    );
  }
  const cfCache = h.get('cf-cache-status');
  if (cfCache) signals.push(tr('signal.cfCache', { status: cfCache }));
  const xRobots = h.get('x-robots-tag');
  if (xRobots) signals.push(tr('signal.xRobots', { value: xRobots }));

  // ----- Deliberately not requested (robots.txt) -----
  // Shares the "no status code" shape with a network failure, so without
  // this branch a disallowed URL was diagnosed as a DNS/TLS/timeout
  // error and sent the user hunting a connection problem that isn't there.
  if (
    (statusCode === null || statusCode === 0) &&
    indexability === 'non-indexable:robots-blocked'
  ) {
    return {
      title: tr('robots.title'),
      severity: 'info',
      explanation: tr('robots.explanation'),
      causes: list('robots', 'cause', 2),
      whatToDo: list('robots', 'todo', 3),
      signals,
    };
  }

  // ----- Network error (no response) -----
  if (statusCode === null || statusCode === 0) {
    return {
      title: tr('network.title'),
      severity: 'error',
      explanation:
        statusText && statusText.trim()
          ? tr('network.explanationDetail', { detail: statusText })
          : tr('network.explanation'),
      causes: list('network', 'cause', 5),
      signals,
      whatToDo: list('network', 'todo', 4),
    };
  }

  // ----- 1xx / 2xx / 3xx — not errors -----
  if (statusCode >= 100 && statusCode < 200) {
    return {
      title: tr('informational.title', { code: statusCode }),
      severity: 'info',
      explanation: tr('informational.explanation', { text: statusText || tr('informational.fallback') }),
      causes: [],
      signals,
      whatToDo: [],
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return {
      // The reason phrase is the server's own words ("OK") and stays as sent.
      title: `${statusCode} — ${statusText || tr('success.fallback')}`,
      severity: 'ok',
      explanation: tr('success.explanation'),
      causes: [],
      signals,
      whatToDo: [],
    };
  }
  if (statusCode >= 300 && statusCode < 400) {
    const loc = h.get('location');
    const temporary = statusCode === 302 || statusCode === 307;
    return {
      title: `${statusCode} — ${statusText || tr('redirect.fallback')}`,
      severity: 'info',
      explanation:
        statusCode === 301
          ? tr('redirect.explanation301')
          : temporary
            ? tr('redirect.explanation302')
            : statusCode === 308
              ? tr('redirect.explanation308')
              : statusCode === 304
                ? tr('redirect.explanation304')
                : tr('redirect.explanationOther', { code: statusCode, text: statusText || '' }),
      causes: loc ? [tr('redirect.location', { location: loc })] : [tr('redirect.noLocation')],
      signals,
      whatToDo: temporary
        ? [tr('redirect.todoPermanent'), tr('redirect.todoChain')]
        : [tr('redirect.todoChain')],
    };
  }

  // ----- 4xx / 5xx — look up the knowledge base -----
  const info = CODES[statusCode];
  if (info) {
    // 52x are Cloudflare-only, but without cf-ray (or a Cloudflare server
    // header) we shouldn't claim the response came from Cloudflare.
    const suffix = info.cloudflare
      ? ` (${front === 'Cloudflare' || h.has('cf-ray') ? 'Cloudflare' : tr('cloudflareStyle')})`
      : '';
    const prefix = `code.${statusCode}`;
    return {
      title: `${statusCode} — ${tr(`${prefix}.name` as DiagnosisKey)}${suffix}`,
      severity: info.severity,
      explanation: tr(`${prefix}.explanation` as DiagnosisKey),
      causes: list(prefix, 'cause', info.causes),
      signals,
      whatToDo: list(prefix, 'todo', info.todos),
    };
  }

  // ----- 4xx / 5xx with no specific entry -----
  if (statusCode >= 400 && statusCode < 500) {
    return {
      title: `${statusCode} — ${statusText || tr('clientError.fallback')}`,
      severity: 'warning',
      explanation: tr('clientError.explanation'),
      causes: list('clientError', 'cause', 3),
      signals,
      whatToDo: list('clientError', 'todo', 2),
    };
  }
  return {
    title: `${statusCode} — ${statusText || tr('serverError.fallback')}`,
    severity: 'error',
    explanation: tr('serverError.explanation'),
    causes: list('serverError', 'cause', 3),
    signals,
    whatToDo: list('serverError', 'todo', 2),
  };
}
