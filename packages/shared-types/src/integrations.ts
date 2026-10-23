/**
 * Faz 7 — Integration catalog + credential model.
 *
 * FreeCrawl is a local-first open-source desktop app: there is no
 * FreeCrawl backend, so every integration is connected with the
 * end-user's OWN credentials. Three credential models:
 *
 *  - `api-key`         — paste a provider API key (OpenAI, Ahrefs, …).
 *  - `oauth-byoc`      — "bring your own client": the user creates their
 *                        own Google Cloud OAuth Desktop client and
 *                        pastes the client ID + secret. No FreeCrawl-
 *                        owned OAuth app, no Google verification needed.
 *  - `service-account` — paste a Google service-account JSON key.
 *  - `local`           — no secret; a local endpoint URL (Ollama).
 *  - `webhook`         — a secret incoming-webhook URL (Slack).
 *  - `smtp`            — a secret `smtps://user:pass@host:port` URL (email).
 *
 * Secrets never leave the main process in plaintext — they are
 * encrypted at rest with Electron `safeStorage` (OS-backed: DPAPI /
 * Keychain / libsecret) and only decrypted in-process when an API call
 * actually needs them.
 *
 * This file is the single source of truth for the catalog; the
 * Settings → Integrations panel renders straight from `INTEGRATIONS`.
 */

export type IntegrationAuthType =
  | 'api-key'
  | 'oauth-byoc'
  | 'service-account'
  | 'local'
  | 'webhook'
  | 'smtp';

/** `notify`: the channels the monitoring alerts send to (Settings → Alerts). */
export type IntegrationCategory = 'ai' | 'seo' | 'google' | 'performance' | 'notify';

/** One credential field a user fills in for an integration. */
export interface IntegrationField {
  /** Storage key — unique within the integration. */
  key: string;
  /** UI label. */
  label: string;
  /**
   * Secret fields are masked in the UI, never echoed back to the
   * renderer once saved, and stored encrypted. Non-secret fields
   * (endpoint URLs, OAuth client IDs) round-trip in plaintext so the
   * user can see and edit them.
   */
  secret: boolean;
  /** Placeholder / example text. */
  placeholder?: string;
  /** When true the field may be left blank. */
  optional?: boolean;
  /** Multi-line input (service-account JSON). */
  multiline?: boolean;
}

export interface IntegrationDef {
  /** Stable id — credential storage key + IPC reference. */
  id: string;
  /** Display name. */
  name: string;
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  /** One-line description of what the integration does. */
  description: string;
  /** Credential fields the user must provide. */
  fields: IntegrationField[];
  /** Where to obtain the credentials — opened in the browser. */
  helpUrl: string;
  /**
   * Short "how to get credentials" hint shown under the card. For
   * `oauth-byoc` this is the BYOC explanation.
   */
  setupHint: string;
}

const KEY_FIELD: IntegrationField = {
  key: 'apiKey',
  label: 'API Key',
  secret: true,
  placeholder: 'Paste your API key',
};

/** OAuth bring-your-own-client field pair (Google Desktop OAuth client). */
const OAUTH_BYOC_FIELDS: IntegrationField[] = [
  {
    key: 'clientId',
    label: 'OAuth Client ID',
    secret: false,
    placeholder: '....apps.googleusercontent.com',
  },
  {
    key: 'clientSecret',
    label: 'OAuth Client Secret',
    secret: true,
    placeholder: 'Paste the client secret',
  },
];

const BYOC_HINT =
  'Create your own OAuth client: Google Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth client ID → Application type "Desktop app". Enable the matching API for the project first, then paste the client ID + secret here.';

/**
 * The integration catalog. Order = display order. Google OAuth-BYOC
 * entries are listed but only become functional once the user pastes
 * their own client credentials.
 */
export const INTEGRATIONS: IntegrationDef[] = [
  // ---- AI ----
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'ai',
    authType: 'api-key',
    description: 'Run a custom prompt per URL — content analysis, title ideas, summaries.',
    fields: [
      KEY_FIELD,
      {
        key: 'baseUrl',
        label: 'Base URL',
        secret: false,
        placeholder: 'https://api.openai.com/v1',
        optional: true,
      },
    ],
    helpUrl: 'https://platform.openai.com/api-keys',
    setupHint: 'Create an API key at platform.openai.com → API keys. Usage is billed to your OpenAI account. Leave Base URL empty unless you use a proxy or gateway.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    category: 'ai',
    authType: 'api-key',
    description: 'Run a custom prompt per URL with Gemini models (through Google\'s OpenAI-compatible endpoint).',
    fields: [
      KEY_FIELD,
      {
        key: 'model',
        label: 'Model',
        secret: false,
        placeholder: 'gemini-2.5-flash',
        optional: true,
      },
    ],
    helpUrl: 'https://aistudio.google.com/apikey',
    setupHint: 'Create an API key at aistudio.google.com → Get API key. Usage is billed to your Google account.',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible service',
    category: 'ai',
    authType: 'api-key',
    description: 'Any service that speaks the OpenAI chat API at its own address: LM Studio, vLLM, OpenRouter, a gateway.',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        secret: false,
        placeholder: 'http://localhost:1234/v1',
      },
      { ...KEY_FIELD, optional: true },
      {
        key: 'model',
        label: 'Model',
        secret: false,
        placeholder: 'model name as the service lists it',
      },
    ],
    helpUrl: 'https://platform.openai.com/docs/api-reference/chat',
    setupHint: 'Enter the service address (it must end where /chat/completions starts, usually /v1). The key may stay empty for a local server. https is required unless the address is on this computer or a private network.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    category: 'ai',
    authType: 'api-key',
    description: 'Run a custom prompt per URL with Claude models.',
    fields: [KEY_FIELD],
    helpUrl: 'https://console.anthropic.com/settings/keys',
    setupHint: 'Create an API key at console.anthropic.com → Settings → API Keys. Usage is billed to your Anthropic account.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local LLM)',
    category: 'ai',
    authType: 'local',
    description: 'Run prompts against a locally-hosted model — no API key, no cost.',
    fields: [
      {
        key: 'endpoint',
        label: 'Ollama endpoint',
        secret: false,
        placeholder: 'http://localhost:11434',
      },
      {
        key: 'model',
        label: 'Model',
        secret: false,
        placeholder: 'llama3.2',
        optional: true,
      },
    ],
    helpUrl: 'https://ollama.com/download',
    setupHint: 'Install Ollama and run a model locally (e.g. `ollama run llama3.2`). The default endpoint is http://localhost:11434.',
  },

  // ---- Performance ----
  {
    id: 'pagespeed',
    name: 'Google PageSpeed Insights',
    category: 'performance',
    authType: 'api-key',
    description: 'Lighthouse audit scores per URL (mobile + desktop).',
    fields: [KEY_FIELD],
    helpUrl: 'https://developers.google.com/speed/docs/insights/v5/get-started',
    setupHint:
      "A free API key is required — Google's keyless shared quota is now 0/day, so anonymous audits no longer work. Create a key in Google Cloud Console (no billing required), enable the PageSpeed Insights API, then paste the key here. Free tier: 25 000 queries/day, 240/min.",
  },
  {
    id: 'crux',
    name: 'Chrome UX Report (CrUX)',
    category: 'performance',
    authType: 'api-key',
    description: 'Real-user field Core Web Vitals per URL (p75 LCP / INP / CLS / FCP / TTFB).',
    fields: [KEY_FIELD],
    helpUrl: 'https://developer.chrome.com/docs/crux/api',
    setupHint:
      'An API key is required (no keyless mode). Create a key in Google Cloud Console (no billing required), enable the "Chrome UX Report API", then paste the key here. A single Google API key can serve both this and PageSpeed Insights once both APIs are enabled. Pages with too little real-user traffic simply return no data.',
  },

  // ---- Content quality ----
  {
    id: 'languagetool',
    name: 'LanguageTool',
    category: 'seo',
    authType: 'local',
    description: 'Spelling, grammar and style checking per page.',
    fields: [
      {
        key: 'endpoint',
        label: 'API endpoint',
        secret: false,
        placeholder: 'https://api.languagetool.org',
        optional: true,
      },
      {
        key: 'username',
        label: 'Premium username',
        secret: false,
        optional: true,
        placeholder: 'Account email (Premium only)',
      },
      {
        key: 'apiKey',
        label: 'Premium API Key',
        secret: true,
        optional: true,
        placeholder: 'Premium API key (optional)',
      },
    ],
    helpUrl: 'https://languagetool.org/http-api/',
    setupHint:
      'Leave everything blank to use the free public API (rate-limited to ~20 requests/min). For unlimited checks, self-host LanguageTool and point the endpoint at it (e.g. http://localhost:8081), or paste a Premium username + API key.',
  },

  // ---- SEO data ----
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    category: 'seo',
    authType: 'api-key',
    description: 'Backlinks, domain rating, referring domains per URL.',
    fields: [KEY_FIELD],
    helpUrl: 'https://ahrefs.com/api',
    setupHint: 'Requires an Ahrefs subscription with API access. Generate a token in your Ahrefs account → API.',
  },
  {
    id: 'majestic',
    name: 'Majestic',
    category: 'seo',
    authType: 'api-key',
    description: 'Trust Flow, Citation Flow, backlink counts.',
    fields: [KEY_FIELD],
    helpUrl: 'https://developer-support.majestic.com/api/',
    setupHint: 'Requires a Majestic subscription. Get your API key from the Majestic developer dashboard.',
  },
  {
    id: 'moz',
    name: 'Moz',
    category: 'seo',
    authType: 'api-key',
    description: 'Domain Authority, Page Authority, Spam Score.',
    fields: [
      { key: 'accessId', label: 'Access ID', secret: false, placeholder: 'Moz Access ID' },
      { key: 'secretKey', label: 'Secret Key', secret: true, placeholder: 'Moz Secret Key' },
    ],
    helpUrl: 'https://moz.com/api',
    setupHint: 'Requires a Moz API subscription. The Access ID + Secret Key are in your Moz account → API.',
  },
  {
    id: 'semrush',
    name: 'Semrush',
    category: 'seo',
    authType: 'api-key',
    description: 'Organic keywords, traffic estimates, SERP features.',
    fields: [KEY_FIELD],
    helpUrl: 'https://www.semrush.com/api-documentation/',
    setupHint: 'Requires a Semrush subscription with API units. Get your API key from Semrush → Subscription info → API.',
  },

  {
    id: 'metrica',
    name: 'Yandex Metrica',
    category: 'seo',
    authType: 'api-key',
    description:
      'Unsampled pageviews (per page URL) and visits, users and search-engine visits (per landing page) for each crawled URL.',
    fields: [
      {
        key: 'token',
        label: 'OAuth token',
        secret: true,
        placeholder: 'Paste a token with the metrika:read scope',
      },
    ],
    helpUrl: 'https://yandex.com/dev/metrika/en/intro/authorization',
    setupHint:
      'Register an app of type "For API access or debugging" at oauth.yandex.com with the metrika:read permission, then open https://oauth.yandex.com/authorize?response_type=token&client_id=<your app ID> while signed in to an account that can view the counter, and paste the token shown. The token only reads data.',
  },

  {
    id: 'webmaster',
    name: 'Yandex Webmaster',
    category: 'seo',
    authType: 'api-key',
    description:
      'Pages Yandex removed from search (with its reason) and the broken internal links it reports, matched to the crawled URLs.',
    fields: [
      {
        key: 'token',
        label: 'OAuth token',
        secret: true,
        placeholder: 'Paste a token with the webmaster:hostinfo and webmaster:verify scopes',
      },
    ],
    helpUrl: 'https://yandex.com/dev/webmaster/doc/en/tasks/how-to-get-oauth',
    setupHint:
      'Register an app of type "For API access or debugging" at oauth.yandex.com with the webmaster:hostinfo and webmaster:verify permissions, then open https://oauth.yandex.com/authorize?response_type=token&client_id=<your app ID> while signed in to an account that owns the site in Yandex Webmaster, and paste the token shown. This is a separate token from Yandex Metrica. Yandex tokens last about 6 months. The token only reads data.',
  },

  // ---- Google (OAuth bring-your-own-client) ----
  {
    id: 'gsc',
    name: 'Google Search Console',
    category: 'google',
    authType: 'oauth-byoc',
    description: 'Clicks, impressions, CTR, position + URL Inspection per page.',
    fields: OAUTH_BYOC_FIELDS,
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
    setupHint: `${BYOC_HINT} Enable the "Google Search Console API".`,
  },
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    category: 'google',
    authType: 'oauth-byoc',
    description: 'Pageviews, users, engagement, bounce, conversions per URL.',
    fields: OAUTH_BYOC_FIELDS,
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
    setupHint: `${BYOC_HINT} Enable the "Google Analytics Data API".`,
  },
  {
    id: 'sheets',
    name: 'Google Sheets',
    category: 'google',
    authType: 'oauth-byoc',
    description: 'Export crawl results straight to a Google Sheet.',
    fields: OAUTH_BYOC_FIELDS,
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
    setupHint: `${BYOC_HINT} Enable the "Google Sheets API".`,
  },
  {
    id: 'bigquery',
    name: 'Google BigQuery',
    category: 'google',
    authType: 'service-account',
    description: 'Stream crawl results into a BigQuery dataset for warehousing.',
    fields: [
      {
        key: 'serviceAccountJson',
        label: 'Service Account JSON',
        secret: true,
        placeholder: 'Paste the full service-account key JSON',
        multiline: true,
      },
      {
        key: 'projectId',
        label: 'GCP Project ID',
        secret: false,
        placeholder: 'my-gcp-project',
      },
    ],
    helpUrl: 'https://cloud.google.com/iam/docs/service-accounts-create',
    setupHint:
      'Create a service account in Google Cloud Console with BigQuery Data Editor role, generate a JSON key, and paste it here along with the project ID. To read your Search Console bulk export from BigQuery (Settings → Search Console → source BigQuery), also give that service account "BigQuery Data Viewer" on the Search Console dataset and "BigQuery Job User" on the billing project. FreeCrawl only reads that dataset.',
  },

  // ---- Alert channels (Settings → Alerts) ----
  {
    id: 'slack',
    name: 'Slack',
    category: 'notify',
    authType: 'webhook',
    description: 'Post an alert to a Slack channel when a monitoring rule fires after a crawl.',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Incoming webhook URL',
        secret: true,
        placeholder: 'https://hooks.slack.com/services/…',
      },
    ],
    helpUrl: 'https://api.slack.com/messaging/webhooks',
    setupHint:
      'Create a Slack app with "Incoming Webhooks" turned on, add a webhook to the channel that should get the alerts, and paste its URL here. Anyone with the URL can post to that channel, so it is stored encrypted.',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'notify',
    authType: 'api-key',
    description: 'Send an alert to a Telegram chat when a monitoring rule fires after a crawl.',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' },
      { key: 'chatId', label: 'Chat ID', secret: false, placeholder: '-1001234567890' },
    ],
    helpUrl: 'https://core.telegram.org/bots/tutorial',
    setupHint:
      'Create a bot with @BotFather and paste its token. Add the bot to the chat, send it a message, and read the chat ID from https://api.telegram.org/bot<token>/getUpdates.',
  },
  {
    id: 'email',
    name: 'Email',
    category: 'notify',
    authType: 'smtp',
    description: 'Email an alert when a monitoring rule fires after a crawl.',
    fields: [
      {
        key: 'smtpUrl',
        label: 'SMTP server URL',
        secret: true,
        placeholder: 'smtps://user:password@smtp.example.com:465',
      },
      { key: 'to', label: 'Send to', secret: false, placeholder: 'seo-team@example.com' },
    ],
    helpUrl: 'https://nodemailer.com/smtp/',
    setupHint:
      'The SMTP server URL carries the login: smtps://user:password@host:465 (or smtp://…:587 for STARTTLS). Percent-encode special characters in the password. The URL is stored encrypted.',
  },
  {
    id: 'github-tasks',
    name: 'GitHub Issues',
    category: 'notify',
    authType: 'api-key',
    description: 'Create a GitHub issue from an Issues-tab check, after you have read the text.',
    fields: [
      { key: 'token', label: 'Access token', secret: true, placeholder: 'github_pat_…' },
      { key: 'owner', label: 'Owner', secret: false, placeholder: 'my-org' },
      { key: 'repo', label: 'Repository', secret: false, placeholder: 'my-site' },
      {
        key: 'apiBase',
        label: 'API address (leave empty for GitHub)',
        secret: false,
        placeholder: 'https://<host>',
        optional: true,
      },
    ],
    helpUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    setupHint:
      'Create a fine-grained personal access token for the one repository with Repository permissions → Issues: Read and write. Nothing is sent until you press Send in the task preview.',
  },
  {
    id: 'basecamp-tasks',
    name: 'Basecamp to-do',
    category: 'notify',
    authType: 'api-key',
    description: 'Create a Basecamp to-do from an Issues-tab check, after you have read the text.',
    fields: [
      { key: 'accessToken', label: 'Access token', secret: true, placeholder: 'BAhb…' },
      { key: 'accountId', label: 'Account ID', secret: false, placeholder: '1234567' },
      { key: 'todolistId', label: 'To-do list ID', secret: false, placeholder: '9876543210' },
      {
        key: 'apiBase',
        label: 'API address (leave empty for Basecamp)',
        secret: false,
        placeholder: 'https://<host>',
        optional: true,
      },
    ],
    helpUrl: 'https://github.com/basecamp/bc3-api',
    setupHint:
      'Paste an OAuth access token. Basecamp tokens expire every 2 weeks: when a send says the token expired, paste a new one here. The account ID and the to-do list ID are the numbers in the to-do list URL. Nothing is sent until you press Send in the task preview.',
  },
];

/** Lookup an integration definition by id. */
export function getIntegration(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/**
 * Per-integration credential state sent to the renderer. Secret field
 * values are NEVER included — only a `set` flag — so a configured key
 * can't be read back out of the UI. Non-secret field values round-trip
 * so the user can see/edit them.
 */
export interface IntegrationCredentialState {
  /** True when every required (non-optional) field has a value. */
  configured: boolean;
  /** Per-field state. `value` is '' for secret fields even when set. */
  fields: Record<string, { set: boolean; value: string }>;
}

/** Map of integration id → credential state. */
export type IntegrationsState = Record<string, IntegrationCredentialState>;
