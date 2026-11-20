import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { implementLikelyFiles } from '../engine.js';

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

function makeRepo(files: Record<string, string>): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'omg-engine-prescan-'));
  const run = (args: string[]) => execFileSync('git', [...GIT_ID, ...args], { cwd: root, stdio: 'pipe' }).toString('utf8');
  run(['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  run(['add', '-A', '-f']);
  run(['commit', '-q', '-m', 'base']);
  return { root, sha: run(['rev-parse', 'HEAD']).trim() };
}

describe('implementLikelyFiles: the engine pre-scan through the hardened async host git', () => {
  let ignoring: { root: string; sha: string };
  let plain: { root: string; sha: string };
  beforeAll(() => {
    const files = {
      'src/math.ts': 'export function sum(a: number[]): number { return 0; }\n',
      'src/use.ts': 'import { sum } from "./math.js";\nexport const total = sum([]);\n',
    };
    // A tracked file the checkout's .gitignore names (force-added): the hint leaves it out.
    ignoring = makeRepo({ ...files, 'src/gen.ts': 'export const g = sum([]);\n', '.gitignore': 'src/gen.ts\n' });
    plain = makeRepo(files);
  });
  afterAll(() => {
    for (const r of [ignoring, plain]) rmSync(r.root, { recursive: true, force: true });
  });

  it('a tracked file the .gitignore excludes is not listed; the tracked paths come back', async () => {
    const warnings: string[] = [];
    const out = await implementLikelyFiles(ignoring.root, 'Change `sum()` in src/math.ts', ignoring.sha, (m) => warnings.push(m));
    expect(out.files.map((f) => f.path)).toEqual(['src/math.ts', 'src/use.ts']);
    expect(out.tracked?.has('src/gen.ts')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('check-ignore exit 1 (nothing ignored) is an answer, not a failure', async () => {
    const warnings: string[] = [];
    const out = await implementLikelyFiles(plain.root, 'Change `sum()` in src/math.ts', plain.sha, (m) => warnings.push(m));
    expect(out.files.map((f) => f.path)).toEqual(['src/math.ts', 'src/use.ts']);
    expect(warnings).toEqual([]);
  });

  it('a git failure warns and drops the hint, never throws', async () => {
    const warnings: string[] = [];
    const out = await implementLikelyFiles(plain.root, 'Change `sum()` in src/math.ts', 'f'.repeat(40), (m) => warnings.push(m));
    expect(out.files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^omg factory run: the likely-files pre-scan failed, so the implement prompt carries no file hint: /);
  });
});
