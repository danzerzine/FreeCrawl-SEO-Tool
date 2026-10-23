import { describe, expect, it } from 'vitest';
import { shouldRunAxe } from './render-fetcher.js';

const ok = { detectAxe: true, status: 200, contentType: 'text/html; charset=utf-8', navigatedTo: null };

describe('shouldRunAxe (B40 R4)', () => {
  it('runs on a 2xx HTML page that did not navigate away', () => {
    expect(shouldRunAxe(ok)).toBe(true);
    expect(shouldRunAxe({ ...ok, status: 299 })).toBe(true);
    expect(shouldRunAxe({ ...ok, contentType: 'application/xhtml+xml' })).toBe(true);
  });
  it('does not run when the option is off', () => {
    expect(shouldRunAxe({ ...ok, detectAxe: false })).toBe(false);
    expect(shouldRunAxe({ ...ok, detectAxe: undefined })).toBe(false);
  });
  it('does not run on 3xx, 4xx, 5xx or no status', () => {
    for (const status of [0, 199, 301, 304, 404, 500]) expect(shouldRunAxe({ ...ok, status })).toBe(false);
  });
  it('does not run on non-HTML content', () => {
    expect(shouldRunAxe({ ...ok, contentType: 'application/pdf' })).toBe(false);
    expect(shouldRunAxe({ ...ok, contentType: 'application/json' })).toBe(false);
  });
  it('treats a missing content type as HTML (the browser rendered it)', () => {
    expect(shouldRunAxe({ ...ok, contentType: undefined })).toBe(true);
  });
  it('does not run when the document replaced itself', () => {
    expect(shouldRunAxe({ ...ok, navigatedTo: 'http://x.test/other' })).toBe(false);
  });
});
