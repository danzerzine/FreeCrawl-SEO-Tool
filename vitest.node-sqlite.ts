// Vitest 2's module runner strips the `node:` prefix and then looks for a
// package named `sqlite`, which does not exist. The config aliases that bare
// id here, and this file hands back Node's own module.
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;

export const { DatabaseSync, StatementSync } = sqlite;
export default sqlite;
