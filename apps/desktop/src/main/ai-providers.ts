/**
 * Faz 7 — AI integrations: OpenAI, Anthropic, Ollama, Gemini and any
 * OpenAI-compatible service (B86).
 *
 * One thin abstraction so the AI tab and batch runner don't have to
 * know which provider they're driving. Each provider exposes the same
 * `runPrompt` shape — give it a prompt, get back text + token counts
 * (when the API reports them). Credentials are resolved here from the
 * encrypted credential store; nothing leaks to the renderer.
 *
 *   OpenAI            — Bearer key, Chat Completions API (optional base URL).
 *   Gemini            — the same client at Google's OpenAI-compatible base.
 *   OpenAI-compatible — the same client at the user's own base URL.
 *   Anthropic         — `x-api-key`, Messages API.
 *   Ollama            — local HTTP endpoint, no auth.
 */
import type { AiProvider } from '@freecrawl/shared-types';
import { resolveCredentials } from './credentials.js';
import { apiFetch } from './api-fetch.js';

const REQUEST_TIMEOUT_MS = 120_000;

/** Output limit per provider. Gemini 2.5 spends the limit on hidden
 *  thinking tokens first, so it gets more room; a local server is slow
 *  and its models ramble, so it gets less. */
const MAX_TOKENS_BY_PROVIDER: Record<AiProvider, number> = {
  openai: 800,
  anthropic: 800,
  ollama: 800,
  gemini: 4000,
  'openai-compatible': 1500,
};

const DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  ollama: 'llama3.2',
  gemini: 'gemini-2.5-flash',
  // No default: the service decides which names exist.
  'openai-compatible': '',
};

/** Default concurrency per provider — Ollama is local + single-model,
 *  so 1 in flight; cloud providers tolerate a small parallel burst; a
 *  custom OpenAI-compatible server is usually local, so it stays low. */
const DEFAULT_CONCURRENCY: Record<AiProvider, number> = {
  openai: 3,
  anthropic: 3,
  ollama: 1,
  gemini: 4,
  'openai-compatible': 2,
};

export interface AiRunOutput {
  /** Response text returned by the provider. */
  text: string;
  /** Tokens billed for the prompt — null when the API doesn't report it. */
  tokensIn: number | null;
  /** Tokens billed for the completion — null when not reported. */
  tokensOut: number | null;
  /** The model that produced this response — useful when defaults change. */
  model: string;
}

export class AiRunError extends Error {
  constructor(
    message: string,
    public readonly model: string,
  ) {
    super(message);
    this.name = 'AiRunError';
  }
}

/** Resolve the effective model for a provider — explicit override → user
 *  pref (Ollama only) → built-in default. */
export function resolveModel(provider: AiProvider, override?: string): string {
  if (override && override.trim()) return override.trim();
  if (provider === 'ollama' || provider === 'gemini' || provider === 'openai-compatible') {
    const pref = (resolveCredentials(provider)['model'] ?? '').trim();
    if (pref) return pref;
  }
  return DEFAULT_MODELS[provider];
}

export function defaultConcurrency(provider: AiProvider): number {
  return DEFAULT_CONCURRENCY[provider];
}

/** Run one prompt through the selected provider. Throws `AiRunError`
 *  on any failure — the batch runner converts it into a stored error
 *  row so a single bad URL never aborts the whole batch. */
export async function runPrompt(
  provider: AiProvider,
  model: string,
  prompt: string,
): Promise<AiRunOutput> {
  switch (provider) {
    case 'openai':
    case 'gemini':
    case 'openai-compatible':
      return runOpenAiLike(provider, model, prompt);
    case 'anthropic':
      return runAnthropic(model, prompt);
    case 'ollama':
      return runOllama(model, prompt);
  }
}

// ── OpenAI-style services (OpenAI, Gemini, any compatible server) ────

export type OpenAiLikeProvider = 'openai' | 'gemini' | 'openai-compatible';

export interface OpenAiTarget {
  /** Human name used in error texts. */
  label: string;
  /** Base URL without a trailing slash; the request goes to `<baseUrl>/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  /** False only for a custom service, where a local server may need no key. */
  keyRequired: boolean;
}

/** A target problem the caller turns into its own error class. */
export class AiTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTargetError';
  }
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
let geminiBaseOverride: string | null = null;

/** Test-only: point Gemini at a local fake. There is deliberately no env
 *  var for this — it would redirect where the stored key is sent. */
export function __setGeminiBaseUrlForTests(url: string | null): void {
  geminiBaseOverride = url;
}

/** Loopback or private-range host: where plain `http` is allowed. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Validate a user-typed base URL and strip trailing slashes. */
function checkBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AiTargetError(`The base URL is not a valid address: ${raw.slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AiTargetError('The base URL must start with http:// or https://.');
  }
  if (u.username || u.password) {
    throw new AiTargetError('The base URL must not contain a user name or password; put the key in the API Key field.');
  }
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
    throw new AiTargetError(
      'http:// is only allowed for this computer or a private network address; use https:// for a public service.',
    );
  }
  return u.href.replace(/\/+$/, '');
}

/** Where a provider's chat requests go and with which key. Pure apart
 *  from reading the credential store. */
export function openAiTarget(provider: OpenAiLikeProvider): OpenAiTarget {
  const creds = resolveCredentials(provider);
  const apiKey = (creds['apiKey'] ?? '').trim();
  switch (provider) {
    case 'openai': {
      const custom = (creds['baseUrl'] ?? '').trim();
      return {
        label: 'OpenAI',
        baseUrl: custom ? checkBaseUrl(custom) : OPENAI_BASE_URL,
        apiKey,
        keyRequired: true,
      };
    }
    case 'gemini':
      return {
        label: 'Gemini',
        baseUrl: checkBaseUrl(geminiBaseOverride ?? GEMINI_BASE_URL),
        apiKey,
        keyRequired: true,
      };
    case 'openai-compatible': {
      const custom = (creds['baseUrl'] ?? '').trim();
      if (!custom) {
        throw new AiTargetError(
          'No base URL for the OpenAI-compatible service — enter it in Settings → Integrations.',
        );
      }
      return {
        label: 'The OpenAI-compatible service',
        baseUrl: checkBaseUrl(custom),
        apiKey,
        keyRequired: false,
      };
    }
  }
}

/** Remove the key from any text that may reach a stored row or the UI. */
function scrubKey(text: string, apiKey: string): string {
  return apiKey.length >= 4 ? text.split(apiKey).join('***') : text;
}

/** POST one chat-completions request. Returns the parsed JSON, or throws
 *  `AiTargetError` with a message that never contains the key. Redirects
 *  are not followed: the key must not travel to another origin. */
export async function postChatCompletions(
  target: OpenAiTarget,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (target.keyRequired && !target.apiKey) {
    throw new AiTargetError(`No ${target.label} API key — paste yours in Settings → Integrations.`);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.apiKey) headers['Authorization'] = `Bearer ${target.apiKey}`;
  let res: Awaited<ReturnType<typeof apiFetch>>;
  try {
    res = await apiFetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AiTargetError(scrubKey(`Couldn't reach ${target.label} at ${new URL(target.baseUrl).origin}: ${msg}`, target.apiKey));
  }
  if (res.status >= 300 && res.status < 400) {
    throw new AiTargetError(`${target.label}: the service redirected to another address; set the final address as the Base URL.`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const err = (json?.['error'] as { message?: string } | undefined)?.message;
    throw new AiTargetError(
      scrubKey(
        err ?? `${target.label} API error (HTTP ${res.status}${json ? '' : ', the reply was not JSON'})`,
        target.apiKey,
      ),
    );
  }
  return json;
}

/** Reject a model reply that carries no text, naming the likely cause. */
export function emptyReplyMessage(finishReason: unknown): string {
  return (
    'The model returned an empty reply' +
    (finishReason === 'length' ? ' (output limit reached before any text)' : '')
  );
}

async function runOpenAiLike(
  provider: OpenAiLikeProvider,
  model: string,
  prompt: string,
): Promise<AiRunOutput> {
  let json: Record<string, unknown>;
  try {
    const target = openAiTarget(provider);
    if (!model.trim()) {
      throw new AiTargetError(`No model name for ${target.label} — enter it in Settings → Integrations.`);
    }
    json = await postChatCompletions(
      target,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: MAX_TOKENS_BY_PROVIDER[provider],
      },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof AiTargetError) throw new AiRunError(err.message, model);
    throw err;
  }
  const choice = (
    json['choices'] as { message?: { content?: unknown }; finish_reason?: unknown }[] | undefined
  )?.[0];
  const content = choice?.message?.content;
  const text = (typeof content === 'string' ? content : '').trim();
  if (!text) throw new AiRunError(emptyReplyMessage(choice?.finish_reason), model);
  const usage = json['usage'] as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  return {
    text,
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
    model,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────

async function runAnthropic(model: string, prompt: string): Promise<AiRunOutput> {
  const apiKey = (resolveCredentials('anthropic')['apiKey'] ?? '').trim();
  if (!apiKey) {
    throw new AiRunError(
      'No Anthropic API key — paste yours in Settings → Integrations.',
      model,
    );
  }
  const res = await apiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS_BY_PROVIDER.anthropic,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const err = (json?.['error'] as { message?: string } | undefined)?.message;
    throw new AiRunError(
      err ?? `Anthropic API error (HTTP ${res.status})`,
      model,
    );
  }
  const content = json['content'] as { type?: unknown; text?: unknown }[] | undefined;
  const text =
    content
      ?.filter((c) => c?.type === 'text' && typeof c?.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim() ?? '';
  const usage = json['usage'] as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  return {
    text,
    tokensIn: usage?.input_tokens ?? null,
    tokensOut: usage?.output_tokens ?? null,
    model,
  };
}

// ── Ollama ───────────────────────────────────────────────────────────

async function runOllama(model: string, prompt: string): Promise<AiRunOutput> {
  const creds = resolveCredentials('ollama');
  const endpoint = (creds['endpoint'] ?? 'http://localhost:11434').trim() || 'http://localhost:11434';
  let res: Response;
  try {
    res = await apiFetch(`${endpoint.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    throw new AiRunError(
      `Couldn't reach Ollama at ${endpoint}: ${msg}`,
      model,
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const errMsg =
      (json?.['error'] as string | undefined) ??
      `Ollama returned HTTP ${res.status}`;
    throw new AiRunError(errMsg, model);
  }
  return {
    text: (json['response'] as string | undefined)?.trim() ?? '',
    tokensIn:
      typeof json['prompt_eval_count'] === 'number'
        ? (json['prompt_eval_count'] as number)
        : null,
    tokensOut:
      typeof json['eval_count'] === 'number'
        ? (json['eval_count'] as number)
        : null,
    model,
  };
}
