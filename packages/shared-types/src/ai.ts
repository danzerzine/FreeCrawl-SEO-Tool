/**
 * Faz 7 — AI integrations (OpenAI / Anthropic / Ollama, plus Gemini and
 * any OpenAI-compatible service, B86).
 *
 * The LLM providers all share the same "run a custom prompt
 * against each crawled page" UX, so the renderer drives them through
 * a single `AiTab` and a single set of IPC channels — the only thing
 * that changes per provider is the API client wiring in the main
 * process. Credentials live in the existing encrypted credential
 * store (one integration id per provider id).
 */

/** Every provider id. The type below is derived from this list, so a new
 *  id appears here once and the `Record<AiProvider, …>` tables in the
 *  app fail to compile until they list it. */
export const AI_PROVIDERS = [
  'openai',
  'anthropic',
  'ollama',
  'gemini',
  'openai-compatible',
] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

/** Per-URL AI result stored in `ai_results`. */
export interface AiResult {
  provider: AiProvider;
  /** Model the response was generated with — for traceability. */
  model: string;
  /** The LLM's response text (or error message when `status === 'error'`). */
  response: string;
  tokensIn: number | null;
  tokensOut: number | null;
  status: 'ok' | 'error';
  error: string | null;
  fetchedAt: string;
}

/** One AI tab row — a crawled page joined with its latest AI result. */
export interface AiRow {
  /** `urls.id` — what the Detail panel opens when the row is clicked. */
  id: number;
  url: string;
  statusCode: number | null;
  /** Null when this page has no result for the queried provider. */
  ai: AiResult | null;
}
