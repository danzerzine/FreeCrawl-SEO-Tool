import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_OFFER_RULE,
  BREADCRUMB_ITEM_RULE,
  OFFER_RULE,
  SCHEMA_RULES,
  normalizeSchemaType,
  rulesForType,
} from './schema-rules.js';
import { SCHEMA_ANCESTORS } from './schema-types.js';

const rootOf = (type: string) => rulesForType(type).map((r) => r.types.join('/'));

describe('structured-data rules', () => {
  it('resolves common subtypes to the most specific rule', () => {
    expect(rootOf('Restaurant')).toEqual(['LocalBusiness']);
    expect(rootOf('Pharmacy')).toEqual(['LocalBusiness']);
    expect(rootOf('Hospital')).toEqual(['LocalBusiness']);
    expect(rootOf('Corporation')).toEqual(['Organization']);
    expect(rootOf('MusicEvent')).toEqual(['Event']);
    expect(rootOf('NewsArticle')).toEqual(['Article']);
    expect(rootOf('DiscussionForumPosting')).toEqual(['DiscussionForumPosting']);
    expect(rootOf('MobileApplication')).toEqual(['SoftwareApplication']);
    expect(rootOf('ProductGroup')).toEqual(['ProductGroup']);
    expect(rootOf('Car')).toEqual(['Product']);
  });

  it('gives excluded subtypes no rule from the excluding root', () => {
    expect(rootOf('BroadcastEvent')).toEqual([]);
    expect(rootOf('CourseInstance')).toEqual([]);
    expect(rootOf('VideoGame')).toEqual([]);
    expect(rootOf('ClaimReview')).toEqual(['FAQPage/HowTo/ClaimReview']);
    expect(rootOf('Person')).toEqual([]);
  });

  it('knows every type a rule names, so the generated map is current', () => {
    for (const rule of [...SCHEMA_RULES, OFFER_RULE, AGGREGATE_OFFER_RULE]) {
      for (const t of [...rule.types, ...(rule.exclude ?? [])]) {
        expect(SCHEMA_ANCESTORS, t).toHaveProperty(t);
      }
    }
    expect(BREADCRUMB_ITEM_RULE.types).toEqual(['ListItem']);
  });

  it('cites a Google Search Central page for every rule', () => {
    for (const rule of [...SCHEMA_RULES, OFFER_RULE, AGGREGATE_OFFER_RULE, BREADCRUMB_ITEM_RULE]) {
      expect(rule.source).toMatch(/^https:\/\/developers\.google\.com\/search\//);
    }
  });

  it('reads schema.org IRIs and prefixes as bare names, and leaves other values alone', () => {
    expect(normalizeSchemaType('https://schema.org/Product')).toBe('Product');
    expect(normalizeSchemaType('http://schema.org/Product/')).toBe('Product');
    expect(normalizeSchemaType('schema:Product')).toBe('Product');
    expect(normalizeSchemaType('https://example.com/Product')).toBe('https://example.com/Product');
    expect(normalizeSchemaType('Product')).toBe('Product');
  });
});
