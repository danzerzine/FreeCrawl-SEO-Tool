import { SCHEMA_ANCESTORS } from './schema-types.js';

/**
 * Google's rich-result requirements for structured data, one record per
 * result type. Every rule is copied from the Google Search Central page in
 * its `source`; `SCHEMA_RULES_CHECKED` is the day those pages were read.
 *
 * Entries in `required` and `recommended` are dotted paths (`location.address`);
 * an entry `a | b` is met by any one of its paths. A rule written for a
 * schema.org type also checks its subtypes (`LocalBusiness` → `Restaurant`)
 * unless the subtype is in `exclude`; when a type falls under two rules, the
 * one for the more specific type wins (`Pharmacy` is checked as a local
 * business, not as an organization).
 */
export interface SchemaRule {
  source: string;
  types: readonly string[];
  exclude?: readonly string[];
  required?: readonly string[];
  recommended?: readonly string[];
  /**
   * A path that counts only when the node passes the test, e.g. a remote
   * job's `applicantLocationRequirements`. A path that does not count is also
   * left out of the finding's text.
   */
  only?: Readonly<Record<string, (node: Record<string, unknown>, pageUrl: string) => boolean>>;
  /** Google no longer shows this result: the node gets no findings. */
  retired?: string;
}

export const SCHEMA_RULES_CHECKED = '2026-10-22';

const GOOGLE = 'https://developers.google.com/search/docs/appearance/structured-data/';

export const SCHEMA_RULES: readonly SchemaRule[] = [
  {
    source: `${GOOGLE}article`,
    types: ['Article'],
    recommended: ['headline', 'image', 'datePublished', 'dateModified', 'author', 'author.name'],
  },
  { source: `${GOOGLE}breadcrumb`, types: ['BreadcrumbList'], required: ['itemListElement'] },
  { source: `${GOOGLE}course`, types: ['Course'], required: ['name', 'description'] },
  {
    source: `${GOOGLE}event`,
    types: ['Event'],
    exclude: [
      'BroadcastEvent',
      'PublicationEvent',
      'CourseInstance',
      'EventSeries',
      'DeliveryEvent',
    ],
    required: ['name', 'startDate', 'location', 'location.address'],
    recommended: [
      'endDate',
      'image',
      'offers',
      'organizer',
      'performer',
      'eventStatus',
      'description',
    ],
  },
  {
    source: `${GOOGLE}job-posting`,
    types: ['JobPosting'],
    required: [
      'title',
      'description',
      'datePosted',
      'hiringOrganization',
      'jobLocation | applicantLocationRequirements',
    ],
    recommended: ['employmentType'],
    // A fully remote job names the countries it hires from instead of a place.
    only: {
      applicantLocationRequirements: (node) =>
        [node['jobLocationType']].flat().some((v) => String(v).toUpperCase() === 'TELECOMMUTE'),
    },
  },
  {
    source: `${GOOGLE}local-business`,
    types: ['LocalBusiness'],
    required: ['name', 'address'],
    recommended: ['telephone', 'url', 'geo', 'openingHoursSpecification', 'priceRange'],
  },
  {
    source: `${GOOGLE}organization`,
    types: ['Organization'],
    recommended: ['name', 'url', 'logo'],
  },
  {
    source: `${GOOGLE}product-snippet`,
    types: ['Product'],
    exclude: ['ProductGroup'],
    required: ['name', 'review | aggregateRating | offers'],
  },
  { source: `${GOOGLE}product-variants`, types: ['ProductGroup'], required: ['name'] },
  {
    source: `${GOOGLE}recipe`,
    types: ['Recipe'],
    required: ['name', 'image'],
    recommended: ['recipeIngredient', 'recipeInstructions', 'author'],
  },
  {
    source: `${GOOGLE}review-snippet`,
    types: ['Review'],
    exclude: ['ClaimReview', 'Recommendation', 'ReviewNewsArticle'],
    required: [
      'author',
      'reviewRating',
      'reviewRating.ratingValue',
      'itemReviewed',
      'itemReviewed.name',
    ],
    recommended: ['datePublished'],
  },
  {
    source: `${GOOGLE}review-snippet`,
    types: ['AggregateRating'],
    required: ['ratingValue', 'ratingCount | reviewCount', 'itemReviewed', 'itemReviewed.name'],
    recommended: ['bestRating'],
  },
  {
    source: `${GOOGLE}software-app`,
    types: ['SoftwareApplication'],
    // Google shows no app result for a node typed only VideoGame.
    exclude: ['OperatingSystem', 'RuntimePlatform', 'VideoGame'],
    required: ['name', 'offers.price', 'aggregateRating | review'],
    recommended: ['applicationCategory', 'operatingSystem'],
  },
  {
    source: `${GOOGLE}video`,
    types: ['VideoObject'],
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', 'duration', 'contentUrl | embedUrl'],
  },
  {
    source: 'https://developers.google.com/search/docs/appearance/site-names',
    types: ['WebSite'],
    required: ['name', 'url'],
  },
  {
    source: `${GOOGLE}profile-page`,
    types: ['ProfilePage'],
    required: ['mainEntity', 'mainEntity.name | mainEntity.alternateName'],
  },
  {
    source: `${GOOGLE}qapage`,
    types: ['QAPage'],
    required: [
      'mainEntity',
      'mainEntity.name',
      'mainEntity.answerCount',
      'mainEntity.acceptedAnswer | mainEntity.suggestedAnswer',
    ],
  },
  {
    source: `${GOOGLE}discussion-forum`,
    types: ['DiscussionForumPosting'],
    required: ['author', 'author.name', 'datePublished', 'text | image | video | url'],
    // A post that stands for a thread on another page needs no content of its own.
    only: { url: (node, pageUrl) => pointsElsewhere(node['url'], pageUrl) },
  },
  {
    source: 'https://developers.google.com/search/updates',
    types: ['FAQPage', 'HowTo', 'ClaimReview'],
    retired: 'Google no longer shows these results',
  },
];

/** An object in a Product's `offers`. */
export const OFFER_RULE: SchemaRule = {
  source: `${GOOGLE}product-snippet`,
  types: ['Offer'],
  required: ['price | priceSpecification.price'],
  recommended: ['priceCurrency | priceSpecification.priceCurrency', 'availability'],
};

/** An AggregateOffer in a Product's `offers`. */
export const AGGREGATE_OFFER_RULE: SchemaRule = {
  source: `${GOOGLE}product-snippet`,
  types: ['AggregateOffer'],
  required: ['lowPrice', 'priceCurrency'],
  recommended: ['highPrice', 'offerCount'],
};

/** An item of a BreadcrumbList; `item` is dropped for the last one. */
export const BREADCRUMB_ITEM_RULE: SchemaRule = {
  source: `${GOOGLE}breadcrumb`,
  types: ['ListItem'],
  required: ['position', 'item', 'name | item.name'],
};

const ancestorsOf = (type: string): string[] =>
  SCHEMA_ANCESTORS[type]?.split(' ').filter(Boolean) ?? [];

/** `type` is `root` or one of its subtypes. */
export function isSchemaTypeOf(type: string, root: string): boolean {
  return type === root || ancestorsOf(type).includes(root);
}

/** `https://schema.org/Product`, `http://schema.org/Product/`, `schema:Product` → `Product`. */
export function normalizeSchemaType(type: string): string {
  const m = /^(?:https?:\/\/schema\.org\/|schema:)([^/]+)\/?$/.exec(type.trim());
  return m ? m[1]! : type;
}

/**
 * The rules a node of `type` is checked by: every rule whose type it is or
 * descends from (minus exclusions), keeping only the most specific when one
 * rule's type descends from another's.
 */
export function rulesForType(type: string): SchemaRule[] {
  const hits: { rule: SchemaRule; root: string }[] = [];
  for (const rule of SCHEMA_RULES) {
    const root = rule.types.find((t) => isSchemaTypeOf(type, t));
    if (!root) continue;
    if (rule.exclude?.some((x) => isSchemaTypeOf(type, x))) continue;
    hits.push({ rule, root });
  }
  return hits
    .filter(
      (h) => !hits.some((o) => o !== h && o.root !== h.root && isSchemaTypeOf(o.root, h.root)),
    )
    .map((h) => h.rule);
}

function pointsElsewhere(url: unknown, pageUrl: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const a = new URL(url, pageUrl);
    const b = new URL(pageUrl);
    a.hash = '';
    b.hash = '';
    return a.href !== b.href;
  } catch {
    return false;
  }
}
