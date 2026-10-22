import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParserPool, poolParseHtml, type ParseHtmlFn, type ParsePoolLog } from '@freecrawl/core';
import * as logger from './logger.js';

export { ParserTimeoutError } from '@freecrawl/core';

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
