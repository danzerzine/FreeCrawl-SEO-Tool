import type { AiProvider } from '@freecrawl/shared-types';

/** Provider names as the AI tab, the assistant and the export dialog show
 *  them. A `Record`, so a provider id added to `AI_PROVIDERS` without a
 *  label does not compile. Translated through `translateLabel`. */
export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama (local)',
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible service',
};
