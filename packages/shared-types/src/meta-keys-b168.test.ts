import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { googleMetaKey, isYandexTokenShape, webmasterMetaKey } from './meta-keys.js';

// B168 S3 / S8: one definition of the meta-key rule and of the token shape.
describe('integration meta keys', () => {
  it('google: per account, the bare base for a project from before accounts', () => {
    expect(googleMetaKey('ga4FetchMeta', 'acc-1')).toBe('ga4FetchMeta:acc-1');
    expect(googleMetaKey('gscFetchMeta', '')).toBe('gscFetchMeta');
  });
  it('webmaster: per host', () => {
    expect(webmasterMetaKey('https:ex.test:443')).toBe('webmasterFetchMeta:https:ex.test:443');
  });
  it('token shape: one run of token characters', () => {
    expect(isYandexTokenShape('y0_AgAAAA-abc.def~1+/=')).toBe(true);
    for (const bad of ['', 'a b', 'a\nb', 'tok"en']) expect(isYandexTokenShape(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('no second copy of the rules', () => {
  const root = join(__dirname, '../../..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !e.parentPath.includes('node_modules') && !e.parentPath.includes('dist'))
      .map((e) => join(e.parentPath, e.name));
  const files = [...sources(join(root, 'apps/desktop/src')), ...sources(join(root, 'apps/cli/src')), ...sources(join(root, 'packages/db/src')), ...sources(join(root, 'packages/core/src'))];
  it('the token regexp and the account key template are written once', () => {
    const texts = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
    expect(texts.filter(([, t]) => t.includes('A-Za-z0-9._~+/=-')).map(([f]) => f)).toEqual([]);
    expect(texts.filter(([, t]) => /accountId \? `\$\{base\}:\$\{accountId\}`/.test(t)).map(([f]) => f)).toEqual([]);
    expect(texts.filter(([, t]) => /webmasterFetchMeta:\$\{/.test(t)).map(([f]) => f)).toEqual([]);
  });
});
