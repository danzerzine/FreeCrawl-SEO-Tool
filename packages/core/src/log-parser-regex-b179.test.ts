import { describe, expect, it } from 'vitest';
import { createLogParser, detectLogFormat, type ParsedLogLine } from './log-parser.js';

/*
 * B179: COMBINED_RE / COMMON_RE had `\s+[^"]*` inside the request line, two
 * overlapping quantifiers, so a request line with tens of thousands of
 * spaces backtracked quadratically (50 000 spaces: 8.9 s). The references
 * below are the old patterns; results must stay identical for every line.
 */
const OLD_COMBINED =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z!]+)\s+(\S+)(?:\s+[^"]*)?"\s+(\d{3})\s+(\S+)\s+"([^"]*)"\s+"([^"]*)"/;
const OLD_COMMON =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z!]+)\s+(\S+)(?:\s+[^"]*)?"\s+(\d{3})\s+(\S+)/;

type Fields = Omit<ParsedLogLine, 'ts'>;

function expectedFields(raw: string): Fields | null {
  const line = raw.trim();
  const dash = (v: string | undefined) => (v && v !== '-' ? v : null);
  const toInt = (v: string | undefined) =>
    v == null || v === '-' || v === '' ? null : Number.parseInt(v, 10);
  const path = (v: string | undefined) => {
    if (!v || v === '-') return null;
    const h = v.indexOf('#');
    return h >= 0 ? v.slice(0, h) : v;
  };
  const c = OLD_COMBINED.exec(line);
  if (c) {
    return {
      ip: c[1] === '-' ? null : c[1]!,
      method: c[3]!,
      path: path(c[4]),
      status: toInt(c[5]),
      bytes: toInt(c[6]),
      referer: dash(c[7]),
      userAgent: dash(c[8]),
    };
  }
  const m = OLD_COMMON.exec(line);
  if (m) {
    return {
      ip: m[1] === '-' ? null : m[1]!,
      method: m[3]!,
      path: path(m[4]),
      status: toInt(m[5]),
      bytes: toInt(m[6]),
      referer: null,
      userAgent: null,
    };
  }
  return null;
}

const TS = '10/Oct/2023:13:55:36 +0000';
const lines: Record<string, string> = {
  combined: `1.2.3.4 - - [${TS}] "GET /a/b?x=1 HTTP/1.1" 200 512 "https://r.example/" "Mozilla/5.0 (X11; Linux)"`,
  combinedDashes: `- - - [${TS}] "GET / HTTP/2.0" 304 - "-" "-"`,
  common: `1.2.3.4 - frank [${TS}] "POST /form HTTP/1.0" 302 17`,
  noProtocol: `1.2.3.4 - - [${TS}] "GET /old" 200 10 "-" "curl/8"`,
  oddMethod: `1.2.3.4 - - [${TS}] "!BAD /x HTTP/1.1" 400 0 "-" "-"`,
  spacesInRequest: `1.2.3.4 - - [${TS}] "GET /a   b   c HTTP/1.1" 200 5 "-" "ua with   spaces"`,
  tabInRequest: `1.2.3.4 - - [${TS}] "GET /a\tHTTP/1.1" 200 5 "-" "ua"`,
  trailingSpacesInRequest: `1.2.3.4 - - [${TS}] "GET /a    " 200 5 "-" "ua"`,
  fragmentPath: `1.2.3.4 - - [${TS}] "GET /a#frag HTTP/1.1" 200 5 "-" "ua"`,
  quotedUaWithEscapedQuote: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 200 5 "-" "Bot \\"x\\" y"`,
  refererWithSpaces: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 200 5 "http://x/a b" "ua"`,
  combinedExtraTail: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 200 5 "-" "ua" 0.123 extra`,
  commonWithOneQuoted: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 200 5 "-"`,
  leadingWhitespace: `   1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 200 5 "-" "ua"  `,
  ipv6: `2001:db8::1 - - [${TS}] "GET /a HTTP/1.1" 200 5 "-" "ua"`,
  lowercaseMethod: `1.2.3.4 - - [${TS}] "get /a HTTP/1.1" 200 5 "-" "ua"`,
  badStatus: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1" 20 5 "-" "ua"`,
  unterminatedRequest: `1.2.3.4 - - [${TS}] "GET /a HTTP/1.1 200 5 "-" "ua"`,
  missingTimestamp: `1.2.3.4 - - "GET /a HTTP/1.1" 200 5`,
  garbage: 'this is not a log line',
  empty: '',
  onlyQuotes: '"" ""',
};

describe('Apache log regexes (B179)', () => {
  for (const [name, line] of Object.entries(lines)) {
    it(`keeps the old result for ${name}`, () => {
      const got = createLogParser({ format: 'apache-combined' }).feed(line);
      const want = expectedFields(line);
      if (want === null) {
        expect(got).toBeNull();
      } else {
        expect(got).not.toBeNull();
        const { ts, ...rest } = got as ParsedLogLine;
        expect(rest).toEqual(want);
        expect(ts === null || typeof ts === 'number').toBe(true);
      }
    });
  }

  it('still detects combined vs common', () => {
    expect(detectLogFormat([lines.combined!])).toBe('apache-combined');
    expect(detectLogFormat([lines.common!])).toBe('apache-common');
  });

  const head = `1.2.3.4 - - [${TS}] "GET /`;
  const adversarial: Record<string, string> = {
    spaces: head + ' '.repeat(50_000),
    spacesThenJunk: head + ' '.repeat(50_000) + 'x',
    spacesThenQuote: head + ' '.repeat(50_000) + '"',
    tabs: head + '\t'.repeat(50_000),
    spacesAfterHeaderOnly: '1.2.3.4' + ' '.repeat(50_000),
    spacesInsideBrackets: `1.2.3.4 - - [${' '.repeat(50_000)}`,
    spacesAfterStatus: `${head} HTTP/1.1" 200` + ' '.repeat(50_000),
    spacesInReferer: `${head} HTTP/1.1" 200 5 "` + ' '.repeat(50_000),
  };
  for (const [name, line] of Object.entries(adversarial)) {
    it(`parses a 50 000 char adversarial line in <50 ms: ${name}`, { timeout: 60_000 }, () => {
      const parser = createLogParser({ format: 'apache-combined' });
      const t0 = performance.now();
      parser.feed(line);
      detectLogFormat([line]);
      expect(performance.now() - t0).toBeLessThan(50);
    });
  }
});
