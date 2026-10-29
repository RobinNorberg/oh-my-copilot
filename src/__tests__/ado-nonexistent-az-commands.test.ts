import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// These az subcommands do not exist; the REST API via `az devops invoke` or git replaces them.
const NONEXISTENT = [
  /az repos pr comment\b/,
  /az repos pr diff\b/,
  /az boards iteration team show-capacity\b/,
  /az boards work-item type list\b/,
];

function* walk(dir: string, exts: string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, exts);
    else if (exts.some((e) => name.endsWith(e))) yield p;
  }
}

describe('nonexistent az commands', () => {
  it('appear in no skill or src file', () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join(REPO_ROOT, 'skills'), ['.md']),
      ...walk(join(REPO_ROOT, 'src'), ['.ts']),
    ].filter((f) => !f.endsWith('ado-nonexistent-az-commands.test.ts'));
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const re of NONEXISTENT) {
        if (re.test(text)) offenders.push(`${file}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
