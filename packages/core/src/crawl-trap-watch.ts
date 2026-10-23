export interface TrapFinding {
  rule: 'R2' | 'R3';
  key: string;
  count: number;
  expected: number | null;
  share: number;
  samples: string[];
  atCount: number;
  host: string;
  names?: string;
}
export interface CheckResult {
  findings: TrapFinding[];
  sitemapShort: { found: number; listed: number } | null;
}
export function trapSectionKey(_url: string): string {
  throw new Error('not implemented');
}
export class CrawlTrapWatch {
  constructor(_opts: unknown = {}) {}
  observe(_url: string): boolean {
    throw new Error('not implemented');
  }
  setBaseline(_host: string, _urls: Iterable<string>): void {
    throw new Error('not implemented');
  }
  markSettled(): void {}
  check(): CheckResult {
    throw new Error('not implemented');
  }
}
