import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';
import { rulesForType } from './schema-rules.js';

const PAGE = 'https://example.com/page';
const ld = (json: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
const findings = (...blocks: unknown[]) =>
  parseHtml(`<html><head>${blocks.map(ld).join('')}</head><body><p>x</p></body></html>`, PAGE)
    .schemaFindings;
const kinds = (...blocks: unknown[]) => findings(...blocks).map((f) => `${f.type}:${f.kind}`);

describe('structured data: one finding per gap (B146)', () => {
  it('does not also report a node missing a required entry as missing recommended ones', () => {
    expect(kinds({ '@type': 'LocalBusiness', name: 'B' })).toEqual([
      'LocalBusiness:missing-required',
    ]);
  });

  it('checks a node typed Organization and LocalBusiness as the local business only', () => {
    // A LocalBusiness is an Organization; like a lone Pharmacy, it follows the more specific rule.
    expect(kinds({ '@type': ['Organization', 'LocalBusiness'], name: 'B' })).toEqual([
      'LocalBusiness:missing-required',
    ]);
    const full = { '@type': ['Organization', 'LocalBusiness'], name: 'B', address: 'Main St 1' };
    expect(findings(full).map((f) => f.type)).toEqual(['LocalBusiness']);
    expect(kinds({ ...full, '@type': ['LocalBusiness', 'Organization'] })).toEqual([
      'LocalBusiness:missing-recommended',
    ]);
  });

  it('still checks both rules of a node with two unrelated types', () => {
    expect(kinds({ '@type': ['Organization', 'WebSite'], name: 'B' })).toEqual([
      'Organization:missing-recommended',
      'WebSite:missing-required',
    ]);
  });

  it('does not accept a bare @id reference as the name of a breadcrumb', () => {
    const list = (item: unknown) => ({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item },
        { '@type': 'ListItem', position: 2, name: 'Page' },
      ],
    });
    expect(findings(list({ '@id': 'https://example.com/#home' }))).toEqual([
      { block: 0, type: 'ListItem', kind: 'missing-required', props: ['name | item.name'] },
    ]);
    // Named elsewhere on the page: the reference is a real name.
    expect(
      findings(list({ '@id': 'https://example.com/#home' }), {
        '@type': 'WebPage',
        '@id': 'https://example.com/#home',
        name: 'Home',
      }),
    ).toEqual([]);
    expect(findings(list({ '@id': 'https://example.com/', name: 'Home' }))).toEqual([]);
  });

  it('reports a nameless reviewed product once, on the review', () => {
    const review = {
      '@type': 'Review',
      author: { name: 'A' },
      reviewRating: { ratingValue: 4 },
      itemReviewed: { '@type': 'Product', image: 'https://example.com/p.jpg' },
    };
    expect(findings(review)).toEqual([
      { block: 0, type: 'Review', kind: 'missing-required', props: ['itemReviewed.name'] },
    ]);
  });

  it('reports a Drug, DietarySupplement and Vehicle through the Product rule (as is)', () => {
    for (const t of ['Drug', 'DietarySupplement', 'Vehicle']) {
      expect(rulesForType(t).map((r) => r.types.join('/'))).toEqual(['Product']);
    }
  });
});

describe('recipe nutrition given as a reference (B158)', () => {
  const recipe = { '@type': 'Recipe', name: 'Soup', image: 'https://example.com/s.jpg' };
  const required = (...blocks: unknown[]) =>
    findings(...blocks).filter((f) => f.kind === 'missing-required');

  it('does not ask for recipeYield when nutrition is only a reference', () => {
    expect(required({ ...recipe, nutrition: { '@id': 'https://example.com/#n' } })).toEqual([]);
    expect(
      required({ ...recipe, nutrition: { '@id': 'https://example.com/#n', '@type': 'NutritionInformation' } }),
    ).toEqual([]);
  });

  it('still asks for recipeYield when the calories are written out', () => {
    expect(required({ ...recipe, nutrition: { calories: '200 kcal' } })).toEqual([
      { block: 0, type: 'Recipe', kind: 'missing-required', props: ['recipeYield'] },
    ]);
  });
});
