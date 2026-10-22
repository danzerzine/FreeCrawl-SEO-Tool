import { describe, expect, it } from 'vitest';
import { INTEGRATIONS } from './integrations.js';
import { defaultWebmasterSettings } from './webmaster.js';

describe('B39 Webmaster credentials', () => {
  it('is its own integration with one secret token field, next to Metrica', () => {
    const w = INTEGRATIONS.find((i) => i.id === 'webmaster')!;
    expect(w.fields).toHaveLength(1);
    expect(w.fields[0]).toMatchObject({ key: 'token', secret: true });
    expect(w.setupHint).toContain('webmaster:hostinfo');
    expect(w.setupHint).toContain('webmaster:verify');
    expect(w.helpUrl).toMatch(/^https:\/\/yandex\.com\/dev\/webmaster/);
    expect(INTEGRATIONS.some((i) => i.id === 'metrica')).toBe(true);
  });
  it('default settings hold no host', () => {
    expect(defaultWebmasterSettings()).toEqual({ hostId: '', hostName: '' });
  });
});
