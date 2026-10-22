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
  /**
   * Rows that depend on another property of the node: when `if` is present
   * (holding one of `ifIs`, if given) `then` is asked for, as a required or a
   * recommended entry by `level`. Both are entries like those in `required`.
   */
  conditions?: readonly SchemaCondition[];
  /**
   * Lists the node must hold enough named entries in, counted over all `lists`
   * together: a gap is a required finding worded `label`.
   */
  counts?: readonly SchemaCount[];
  /**
   * Tested once `rulesForType` has picked the rule: false means the rule does
   * not apply to this node (no finding, no label).
   */
  appliesWhen?: (node: Record<string, unknown>, pageUrl: string) => boolean;
  /** A node this rule matched carries the label, so `CONTEXT_RULES` can look for children by it. */
  label?: string;
}

export interface SchemaCount {
  /** Dotted paths ending at the property that holds the entries, e.g. `positiveNotes.itemListElement`. */
  lists: readonly string[];
  min: number;
  /** An entry counts when it is an object with this property present. */
  item: string;
  label: string;
}

export interface SchemaCondition {
  if: string;
  ifIs?: readonly string[];
  then: string;
  thenIs?: readonly string[];
  level: 'required' | 'recommended';
}

export const SCHEMA_RULES_CHECKED = '2026-10-22';

const GOOGLE = 'https://developers.google.com/search/docs/appearance/structured-data/';

const REVIEW_EXCLUDE = ['ClaimReview', 'Recommendation', 'ReviewNewsArticle'];

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
    conditions: [
      {
        if: 'previousStartDate',
        then: 'eventStatus',
        thenIs: ['EventRescheduled'],
        level: 'required',
      },
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
    conditions: [
      {
        if: 'jobLocation',
        then: 'jobLocation.address.addressCountry',
        level: 'required',
      },
    ],
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
    conditions: [{ if: 'nutrition.calories', then: 'recipeYield', level: 'required' }],
  },
  {
    source: `${GOOGLE}review-snippet`,
    types: ['Review'],
    exclude: REVIEW_EXCLUDE,
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
    label: 'qa-page',
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
    label: 'forum',
    required: ['author', 'author.name', 'datePublished', 'text | image | video | url'],
    // A post that stands for a thread on another page needs no content of its own.
    only: { url: (node, pageUrl) => pointsElsewhere(node['url'], pageUrl) },
  },
  {
    source: `${GOOGLE}discussion-forum`,
    types: ['SocialMediaPosting'],
    // BlogPosting (and LiveBlogPosting) are articles: they keep the Article rule.
    exclude: ['BlogPosting'],
    label: 'forum',
    required: ['author', 'author.name', 'datePublished', 'text | image | video | url'],
    // A post that stands for a thread on another page needs no content of its own.
    only: { url: (node, pageUrl) => pointsElsewhere(node['url'], pageUrl) },
  },
  {
    source: `${GOOGLE}return-policy`,
    types: ['MerchantReturnPolicy'],
    required: [
      'applicableCountry | merchantReturnLink',
      'returnPolicyCategory | merchantReturnLink',
    ],
    conditions: [
      {
        if: 'returnPolicyCategory',
        ifIs: ['MerchantReturnFiniteReturnWindow'],
        then: 'merchantReturnDays',
        level: 'required',
      },
      {
        if: 'returnFees',
        ifIs: ['ReturnShippingFees'],
        then: 'returnShippingFeesAmount',
        level: 'required',
      },
    ],
  },
  {
    // Pros and cons: Google wants at least two notes over both lists.
    source: `${GOOGLE}product-snippet`,
    types: ['Review'],
    exclude: REVIEW_EXCLUDE,
    appliesWhen: (node) => isPresent(node['positiveNotes']) || isPresent(node['negativeNotes']),
    counts: [
      {
        lists: ['positiveNotes.itemListElement', 'negativeNotes.itemListElement'],
        min: 2,
        item: 'name',
        label: 'positiveNotes + negativeNotes: 2 or more notes',
      },
    ],
  },
  {
    source: `${GOOGLE}carousel`,
    types: ['ItemList'],
    required: ['itemListElement'],
    appliesWhen: isCarousel,
    label: 'carousel',
  },
  {
    source: 'https://developers.google.com/search/updates',
    types: ['FAQPage', 'HowTo', 'ClaimReview'],
    retired: 'Google no longer shows these results',
  },
];

/**
 * A rule for a node by where it sits: reached from a node carrying the label
 * `from`, through a property in `via`. It matches a node whose `@type` is one
 * of `types` (or a subtype), or, when `implied` is set, a node with no
 * `@type`, which is then checked as `implied`. A match gives the node `label`,
 * so the rules for its own children can look for it. `rule` is left out when
 * the entry only passes a label on.
 */
export interface ContextRule {
  rule?: SchemaRule;
  from: string;
  via: readonly string[];
  types: readonly string[];
  implied?: string;
  label?: string;
}

export const CONTEXT_RULES: readonly ContextRule[] = [
  {
    rule: {
      source: `${GOOGLE}discussion-forum`,
      types: ['Comment'],
      required: ['author', 'datePublished', 'text | image | video'],
    },
    from: 'forum',
    via: ['comment'],
    types: ['Comment'],
    implied: 'Comment',
    label: 'forum',
  },
  {
    rule: {
      source: `${GOOGLE}discussion-forum`,
      types: ['InteractionCounter'],
      required: ['userInteractionCount', 'interactionType'],
    },
    from: 'forum',
    via: ['interactionStatistic'],
    types: ['InteractionCounter'],
    implied: 'InteractionCounter',
  },
  {
    rule: {
      source: `${GOOGLE}carousel`,
      types: ['ListItem'],
      required: ['position', 'url | item.url'],
    },
    from: 'carousel',
    via: ['itemListElement'],
    types: ['ListItem'],
    implied: 'ListItem',
    label: 'carousel-item',
  },
  {
    rule: {
      source: `${GOOGLE}movie`,
      types: ['Movie'],
      required: ['image', 'name'],
      recommended: ['dateCreated', 'director', 'aggregateRating', 'review'],
    },
    from: 'carousel-item',
    via: ['item'],
    types: ['Movie'],
  },
  {
    rule: { source: `${GOOGLE}local-business`, types: ['Restaurant'], required: ['image'] },
    from: 'carousel-item',
    via: ['item'],
    types: ['Restaurant'],
  },
  // The question itself is checked by the QAPage paths; this only passes the label on.
  { from: 'qa-page', via: ['mainEntity'], types: ['Question'], label: 'qa' },
  {
    rule: { source: `${GOOGLE}qapage`, types: ['Answer'], required: ['text'] },
    from: 'qa',
    via: ['acceptedAnswer', 'suggestedAnswer'],
    types: ['Answer'],
    implied: 'Answer',
    label: 'qa',
  },
  {
    rule: { source: `${GOOGLE}qapage`, types: ['Comment'], required: ['text'] },
    from: 'qa',
    via: ['comment'],
    types: ['Comment'],
    implied: 'Comment',
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

function isPresent(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return v !== undefined && v !== null;
}

const CAROUSEL_ITEMS = ['Course', 'Movie', 'Recipe', 'Restaurant'];

/**
 * An ItemList is a carousel when one of its entries holds a typed item that
 * Google shows in carousels. A typed reference counts; a bare url or an
 * untyped object does not.
 */
function isCarousel(node: Record<string, unknown>): boolean {
  return [node['itemListElement']].flat().some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return [(entry as Record<string, unknown>)['item']].flat().some((item) => {
      if (!item || typeof item !== 'object') return false;
      return [(item as Record<string, unknown>)['@type']]
        .flat()
        .some(
          (t) =>
            typeof t === 'string' &&
            CAROUSEL_ITEMS.some((root) => isSchemaTypeOf(normalizeSchemaType(t), root)),
        );
    });
  });
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
