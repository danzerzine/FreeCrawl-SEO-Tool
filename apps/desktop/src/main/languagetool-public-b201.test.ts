import { describe, expect, it } from 'vitest';
import { isPublicLanguageTool } from './languagetool.js';

describe('the public LanguageTool endpoint is told by its origin (B201)', () => {
  it.each([
    ['https://api.languagetool.org', true],
    ['https://api.languagetool.org/', true],
    ['https://api.languagetool.org/v2', true],
    ['https://api.languagetool.org:443/v2/', true],
    ['https://API.languagetool.org//', true],
    ['https://api.languagetool.org.example.com', false],
    ['https://api.languagetool.org@evil.test', false],
    ['http://api.languagetool.org', false],
    ['http://localhost:8081', false],
    ['not a url', false],
  ])('%s -> %s', (endpoint, expected) => {
    expect(isPublicLanguageTool(endpoint)).toBe(expected);
  });
});
