import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ParserPool,
  poolParseHtml,
  poolReadServedSignals,
  type ParseHtmlFn,
  type ReadServedSignalsFn,
  type ParsePoolLog,
} from '@freecrawl/core';
import * as logger from './logger.js';

// The worker is an electron-vite entry built next to this bundle.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log: ParsePoolLog = (level, message) => logger.log(level, 'main', message);

export const parserPool = new ParserPool(path.join(__dirname, 'parser-worker.js'), log);

/**
 * Dispatch HTML parsing to the worker pool when ready, otherwise fall back
 * to the inline parser on the main thread. Passed into every
 * `new Crawler(...)` call.
 */
export const parseHtmlViaPool: ParseHtmlFn = poolParseHtml(parserPool, log);

/** The raw-vs-rendered signals read (B33) as a worker request, inline when the pool is not ready. */
export const readServedSignalsViaPool: ReadServedSignalsFn = poolReadServedSignals(parserPool, log);
