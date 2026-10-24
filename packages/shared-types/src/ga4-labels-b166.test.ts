import { describe, expect, it } from 'vitest';
import {
  ga4FieldLabel,
  ga4FieldLabels,
  ga4NotPulledReason,
  ga4PickerFieldsWithSaved,
  type Ga4Field,
} from './index.js';

const f = (apiName: string, kind: Ga4Field['kind'], customDefinition: boolean, uiName = apiName): Ga4Field => ({
  apiName,
  uiName,
  description: '',
  customDefinition,
  category: '',
  kind,
});

describe('GA4 field labels (B166)', () => {
  const fields = [f('sessions', 'metric', false, 'Sessions'), f('customEvent:article_category', 'dimension', true, 'Article category')];

  it('maps an API name to the name GA4 shows', () => {
    const labels = ga4FieldLabels(fields);
    expect(ga4FieldLabel('customEvent:article_category', labels)).toBe('Article category');
  });

  it('falls back to the API name when the label is not known', () => {
    expect(ga4FieldLabel('customEvent:article_category', {})).toBe('customEvent:article_category');
  });
});

describe('GA4 picker without a network (B166)', () => {
  it('lists the saved fields when the field list is empty', () => {
    const shown = ga4PickerFieldsWithSaved([], ['customEvent:words'], ['customEvent:article_category'], '');
    expect(shown.map((x) => [x.apiName, x.kind])).toEqual([
      ['customEvent:article_category', 'dimension'],
      ['customEvent:words', 'metric'],
    ]);
  });

  it('does not list a saved field twice', () => {
    const fields = [f('customEvent:words', 'metric', true, 'Words')];
    const shown = ga4PickerFieldsWithSaved(fields, ['customEvent:words'], [], '');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.uiName).toBe('Words');
  });
});

describe('GA4 not-pulled reason (B166)', () => {
  it('recognises the quota stop and any other stop', () => {
    expect(ga4NotPulledReason("not pulled: Google's quota for this property is used up")).toEqual({ kind: 'quota' });
    expect(ga4NotPulledReason('not pulled: a request failed')).toEqual({ kind: 'other', detail: 'a request failed' });
  });

  it('leaves a message from Google alone', () => {
    expect(ga4NotPulledReason('Field customEvent:x is not a valid dimension')).toBeNull();
    expect(ga4NotPulledReason(undefined)).toBeNull();
  });
});
