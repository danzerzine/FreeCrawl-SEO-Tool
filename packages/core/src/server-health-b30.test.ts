import { describe, expect, it } from 'vitest';
import { LoopDelayProbe, ServerHealth, inNightWindow, nightAwareMaxRps } from './server-health.js';

describe('ServerHealth trouble share (B30)', () => {
  it('three trouble URLs at 20 % or more of the last 50 call for a cut', () => {
    const h = new ServerHealth();
    let t = 0;
    const cuts: number[] = [];
    for (let i = 0; i < 9; i++) if (h.noteOutcome(i % 3 === 0, (t += 100))) cuts.push(i);
    expect(cuts).toEqual([6]);
  });

  it('a single trouble URL, or 5 % of them, never does', () => {
    const one = new ServerHealth();
    const five = new ServerHealth();
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 100;
      expect(one.noteOutcome(i === 7, t)).toBe(false);
      expect(five.noteOutcome(i % 20 === 0, t)).toBe(false);
    }
  });

  it('after a cut the window is cleared and the next waits 60 s', () => {
    const h = new ServerHealth();
    let t = 0;
    const cutsAt: number[] = [];
    for (let i = 0; i < 3000; i++) if (h.noteOutcome(true, (t += 100))) cutsAt.push(t);
    expect(cutsAt[0]).toBe(300);
    for (let k = 1; k < cutsAt.length; k++) expect(cutsAt[k]! - cutsAt[k - 1]!).toBeGreaterThanOrEqual(60_000);
    expect(cutsAt.length).toBeGreaterThan(1);
  });
});

describe('ServerHealth slow answers (B30)', () => {
  it('the first 20 kept samples set the base; a slow median calls for a cut once per 30 s', () => {
    const h = new ServerHealth();
    let t = 0;
    for (let i = 0; i < 20; i++) expect(h.noteLatency(50, 0, (t += 100))).toBe(false);
    expect(h.isSlow()).toBe(false);
    const cuts: number[] = [];
    for (let i = 0; i < 10; i++) if (h.noteLatency(600, 0, (t += 100))) cuts.push(i);
    // The (upper) median of the last 20 is slow once 10 of them are.
    expect(cuts).toEqual([9]);
    expect(h.isSlow()).toBe(true);
    // Fast again in the 20 answers after the cut: the base stays.
    for (let i = 0; i < 20; i++) h.noteLatency(50, 0, (t += 100));
    expect(h.isSlow()).toBe(false);
    for (let i = 0; i < 10; i++) h.noteLatency(150, 0, (t += 100));
    expect(h.isSlow()).toBe(true);
  });

  it('answers that stay slow after a cut become the base: the rate may rise, only a worse slowdown cuts again', () => {
    const h = new ServerHealth();
    let t = 0;
    for (let i = 0; i < 20; i++) h.noteLatency(50, 0, (t += 1000));
    const cuts: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (h.noteLatency(600, 0, (t += 1000))) cuts.push(i);
      // Held during the 20 answers after the cut, then accepted.
      if (i === 9 + 19) expect(h.isSlow()).toBe(true);
    }
    expect(cuts).toEqual([9]);
    expect(h.isSlow()).toBe(false);
    for (let i = 0; i < 40; i++) if (h.noteLatency(1500, 0, (t += 1000))) cuts.push(100 + i);
    expect(cuts).toEqual([9, 109]);
  });

  it('a site whose sections answer fast and articles slow is cut once, not to the floor', () => {
    // Times to headers seen on a live news site: cached section pages first, articles after.
    const first = [729, 204, 262, 761, 1276, 245, 160, 241, 132, 159, 181, 163, 129, 201, 311, 131, 122, 130, 229, 139];
    const next = [135, 451, 120, 252, 308, 497, 997, 312, 449, 301, 186, 250, 507, 396, 359, 396, 735, 697, 748, 667, 717, 1758, 654, 951, 882, 1604, 793, 928, 1612, 874, 468, 448, 480, 379, 456, 479, 488, 404, 397, 379];
    const h = new ServerHealth();
    let t = 0;
    let cuts = 0;
    for (const ms of first) h.noteLatency(ms, 0, (t += 1000));
    for (const ms of next) if (h.noteLatency(ms, 0, (t += 1000))) cuts++;
    for (let i = 0; i < 600; i++) if (h.noteLatency([310, 450, 380, 900, 340][i % 5]!, 0, (t += 1000))) cuts++;
    expect(cuts).toBe(1);
    expect(h.isSlow()).toBe(false);
  });

  it('a small slowdown under base + 300 ms is not slow', () => {
    const h = new ServerHealth();
    let t = 0;
    for (let i = 0; i < 20; i++) h.noteLatency(50, 0, (t += 100));
    for (let i = 0; i < 40; i++) expect(h.noteLatency(300, 0, (t += 100))).toBe(false);
  });

  it('a sample taken while the process was busy over 100 ms is dropped', () => {
    const h = new ServerHealth();
    let t = 0;
    for (let i = 0; i < 20; i++) h.noteLatency(50, 0, (t += 100));
    for (let i = 0; i < 40; i++) expect(h.noteLatency(900, 200, (t += 100))).toBe(false);
    expect(h.isSlow()).toBe(false);
  });
});

describe('LoopDelayProbe (B30)', () => {
  it('sees a 200 ms block of the event loop, then resets', async () => {
    const probe = new LoopDelayProbe();
    await new Promise((r) => setTimeout(r, 50));
    const until = Date.now() + 200;
    while (Date.now() < until) {
      /* block */
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(probe.maxSinceLastMs()).toBeGreaterThan(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(probe.maxSinceLastMs()).toBeLessThan(100);
    probe.stop();
  });
});

describe('night rate (B30)', () => {
  it('from inclusive, to exclusive; wraps midnight; from == to is no window', () => {
    expect([0, 6, 7, 23].map((h) => inNightWindow(h, 0, 7))).toEqual([true, true, false, false]);
    expect([21, 22, 23, 0, 5, 6].map((h) => inNightWindow(h, 22, 6))).toEqual([false, true, true, true, true, false]);
    expect([0, 5, 12].map((h) => inNightWindow(h, 5, 5))).toEqual([false, false, false]);
  });

  it('nightMaxRps replaces maxRps inside the window only, and only when set', () => {
    const c = { maxRps: 5, nightMaxRps: 2, nightFromHour: 22, nightToHour: 6 };
    expect(nightAwareMaxRps(c, new Date(2026, 9, 22, 23, 30))).toBe(2);
    expect(nightAwareMaxRps(c, new Date(2026, 9, 22, 12, 0))).toBe(5);
    expect(nightAwareMaxRps({ ...c, nightMaxRps: 0 }, new Date(2026, 9, 22, 23, 30))).toBe(5);
  });
});
