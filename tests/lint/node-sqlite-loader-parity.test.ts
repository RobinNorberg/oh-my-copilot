import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The TypeScript loader and the hook-runtime .mjs copy must silence exactly the
// same warning; a drift would put stderr noise back into one of the runtimes.
const FILTER_PREDICATE = "return type === 'ExperimentalWarning' && message.includes('SQLite');";

describe('node:sqlite loader copies keep the same warning filter', () => {
  it.each(['src/lib/node-sqlite.ts', 'scripts/lib/node-sqlite.mjs'])('%s filters only the SQLite ExperimentalWarning', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain(FILTER_PREDICATE);
  });
});
