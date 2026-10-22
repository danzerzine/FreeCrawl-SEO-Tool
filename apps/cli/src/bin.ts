#!/usr/bin/env node
// The installed `freecrawl` command: checks Node before the CLI, and with
// it `node:sqlite`, is loaded.
import { muteSqliteWarning, nodeVersionProblem } from './startup.js';

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(2);
}
muteSqliteWarning();
await import('./index.js');
