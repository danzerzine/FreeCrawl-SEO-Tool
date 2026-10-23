import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  EXPORT_DATASET_COLUMNS,
  INTEGRATIONS,
  isAiProvider,
} from '@freecrawl/shared-types';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, shell: {} }));
vi.mock('./credentials.js', () => ({ resolveCredentials: () => ({}) }));

const { resolveModel, defaultConcurrency } = await import('./ai-providers.js');

// The renderer is outside this project's tsconfig, so its files are read as text.
const renderer = path.resolve(__dirname, '../renderer/src');
const read = (rel: string) => fs.readFileSync(path.join(renderer, rel), 'utf8');
const exportDialog = read('components/ExportDialog.tsx');
const labels = read('components/ai-provider-label.ts');
const quoted = (id: string) => `'?${id}'?`;

describe('B86 type seam: every AiProvider id appears in every place that lists providers', () => {
  it('lists the five providers, appended to the original three', () => {
    expect([...AI_PROVIDERS]).toEqual(['openai', 'anthropic', 'ollama', 'gemini', 'openai-compatible']);
    expect(isAiProvider('gemini')).toBe(true);
    expect(isAiProvider('cohere')).toBe(false);
  });

  it.each([...AI_PROVIDERS])('%s has a label, a catalog entry, defaults, an export dataset and a guide', (id) => {
    expect(labels).toMatch(new RegExp(`^  ${quoted(id)}: '[^']+',$`, 'm'));
    expect(read('tabs/AiTab.tsx')).toContain('export { AI_PROVIDER_LABEL }');
    expect(read('tabs/AssistantTab.tsx')).toContain('export { AI_PROVIDER_LABEL }');
    const entry = INTEGRATIONS.find((i) => i.id === id);
    expect(entry?.category).toBe('ai');
    expect(typeof resolveModel(id)).toBe('string');
    expect(defaultConcurrency(id)).toBeGreaterThanOrEqual(1);
    expect(EXPORT_DATASET_COLUMNS[`ai:${id}`].length).toBeGreaterThan(0);
    expect(exportDialog).toContain(`dataset: 'ai:${id}'`);
    for (const lang of ['en', 'ru']) {
      expect(read(`components/integration-guides/${lang}.ts`)).toMatch(new RegExp(`^  ${quoted(id)}: \\{$`, 'm'));
    }
  });

  it('catalog fields of the new entries', () => {
    const fields = (id: string) =>
      Object.fromEntries((INTEGRATIONS.find((i) => i.id === id)?.fields ?? []).map((f) => [f.key, f]));
    expect(Object.keys(fields('gemini'))).toEqual(['apiKey', 'model']);
    expect(fields('gemini')['apiKey']?.secret).toBe(true);
    expect(Object.keys(fields('openai-compatible'))).toEqual(['baseUrl', 'apiKey', 'model']);
    expect(fields('openai-compatible')['baseUrl']?.secret).toBe(false);
    expect(fields('openai-compatible')['apiKey']?.optional).toBe(true);
    expect(fields('openai')['baseUrl']?.optional).toBe(true);
    expect(resolveModel('gemini')).toBe('gemini-2.5-flash');
    expect(resolveModel('openai-compatible')).toBe('');
  });
});
