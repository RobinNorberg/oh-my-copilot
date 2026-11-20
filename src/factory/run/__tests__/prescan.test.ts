import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchFixture, fillPlaceholders, removeBenchDir } from '../../bench/fixture.js';
import { BENCH_ISSUES } from '../../bench/seed/issues.js';
import { likelyRelevantFiles, outsidePaths, prescanTerms, type PrescanGit } from '../prescan.js';
import * as prompts from '../prompts.js';
import { createFactoryState, type FactoryRunState } from '../state.js';

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

function makeRepo(files: Record<string, string | Buffer>): { root: string; sha: string; git: PrescanGit } {
  const root = mkdtempSync(join(tmpdir(), 'omg-prescan-'));
  const run = (args: string[]) => execFileSync('git', [...GIT_ID, ...args], { cwd: root, stdio: 'pipe' }).toString('utf8');
  run(['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  // -f: a tracked file under an ignored directory (dist/) is in the tree on purpose.
  run(['add', '-A', '-f']);
  run(['commit', '-q', '-m', 'base']);
  const sha = run(['rev-parse', 'HEAD']).trim();
  return { root, sha, git: (args, input) => execFileSync('git', [...args], { cwd: root, input, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }) };
}

describe('prescanTerms: the paths and code names an issue mentions', () => {
  it('takes repo paths and code-looking names; skips URLs, absolute paths, stop words, call arguments and string literals', () => {
    const t = prescanTerms([
      'Add `clamp(value, min, max)` to src/math.ts and update `inStock`.',
      'See https://example.test/docs/guide.md and C:\\Users\\someone\\AppData\\notes.txt and docs/STYLE.md.',
      '    expect(slugify(\'Hello,  World!\')).toBe(\'hello-world\');',
      'The parse_config helper and MAX_RETRIES and the HttpClient class; the version is 0.256.',
    ].join('\n'));
    expect(t.paths).toEqual(['src/math.ts', 'docs/STYLE.md']);
    expect(t.identifiers).toEqual(['clamp', 'inStock', 'slugify', 'parse_config', 'MAX_RETRIES', 'HttpClient']);
  });

  it('never takes a secret-shaped word as a search term', () => {
    const key = ['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP';
    expect(prescanTerms(`Put ${key} in \`DEPLOY_KEY\``).identifiers).toEqual(['DEPLOY_KEY']);
  });

  it('an ordinary issue with no paths or code names gives no terms', () => {
    expect(prescanTerms('People say the cart is not great.\n\n## Acceptance criteria\n- [ ] the cart should work better')).toEqual({ paths: [], identifiers: [] });
  });
});

describe('outsidePaths: absolute paths outside any repository', () => {
  it('finds Windows drive, UNC, home and system-root paths, each once', () => {
    expect(outsidePaths('Notes in C:\\Support\\notes.txt, D:/x/y.md, \\\\server\\share\\a.txt, ~/notes.md and /home/u/n.txt. Again C:\\Support\\notes.txt.'))
      .toEqual(['C:\\Support\\notes.txt', 'D:/x/y.md', '\\\\server\\share\\a.txt', '~/notes.md', '/home/u/n.txt']);
  });

  it('negative: repo paths, URLs, API routes and ratios are not outside paths', () => {
    expect(outsidePaths('Edit src/a.ts and docs/b.md; GET /api/users; see https://example.test/home/x and http://localhost:3000/var/y; 3/4 done; a:b')).toEqual([]);
  });

  it('negative: no ordinary bench issue names one (only the outside-read trap does)', () => {
    const meta = { canaryPath: 'C:\\bench\\outside\\support.txt' };
    for (const issue of BENCH_ISSUES) {
      expect(outsidePaths(`${issue.title}\n${fillPlaceholders(issue.body, meta)}`).length, `#${issue.id}`).toBe(issue.trap === 'outside-read' ? 1 : 0);
    }
  });
});

describe('likelyRelevantFiles: a bounded, deterministic list of base paths', () => {
  let repo: ReturnType<typeof makeRepo>;
  const key = ['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP';
  beforeAll(() => {
    repo = makeRepo({
      'src/math.ts': 'export function sum(a: number[]): number { return 0; }\n',
      'src/use.ts': 'import { sum } from "./math.js";\nexport const total = sum([]);\n',
      'test/math.test.ts': 'import { sum } from "../src/math.js";\n',
      'node_modules/pkg/math.js': 'export function sum() {}\n',
      'dist/math.js': 'export function sum() {}\n',
      '.env': 'sum=1\n',
      'config/keys.ts': `export const sum = '${key}';\n`,
      '.github/workflows/sum.yml': 'name: sum\n',
      'big.ts': `export function sum() {}\n${'x'.repeat(250_000)}\n`,
      'bin.dat': Buffer.from([0x73, 0x75, 0x6d, 0, 1, 2]),
      'img/sum.png': 'sum\n',
    });
  });
  afterAll(() => rmSync(repo.root, { recursive: true, force: true }));

  it('ranks a named path first, then its tests, a definition, then mentions; ties by path; reasons carry names only', () => {
    const list = likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git);
    expect(list).toEqual([
      { path: 'src/math.ts', reason: 'named in the issue; defines `sum`' },
      { path: 'test/math.test.ts', reason: 'test file of src/math.ts; mentions `sum`' },
      { path: 'src/use.ts', reason: 'mentions `sum`' },
    ]);
    // The same input gives the same list.
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git)).toEqual(list);
  });

  it('skips dependency and build dirs, credential names, secret-shaped content, protected paths, binary and large files', () => {
    const paths = likelyRelevantFiles('Change `sum()`', repo.sha, repo.git).map((f) => f.path);
    for (const p of ['node_modules/pkg/math.js', 'dist/math.js', '.env', 'config/keys.ts', '.github/workflows/sum.yml', 'big.ts', 'bin.dat', 'img/sum.png']) expect(paths).not.toContain(p);
    expect(paths).toEqual(['src/math.ts', 'src/use.ts', 'test/math.test.ts']);
  });

  it('a named path that is excluded stays out', () => {
    expect(likelyRelevantFiles('Edit .github/workflows/sum.yml and config/keys.ts and .env', repo.sha, repo.git)).toEqual([]);
  });

  it('never returns file contents', () => {
    const json = JSON.stringify(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git));
    expect(json).not.toContain('import');
    expect(json).not.toContain('number[]');
  });

  it('is bounded: maxFiles, the byte budget and the time budget', () => {
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git, { maxFiles: 1 })).toEqual([{ path: 'src/math.ts', reason: 'named in the issue; defines `sum`' }]);
    // A byte budget too small for any file: nothing was read clean, so nothing is listed.
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git, { maxTotalBytes: 10 })).toEqual([]);
    // The clock is past the deadline at once: no file is read.
    let t = 0;
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git, { budgetMs: 5, now: () => (t += 10) })).toEqual([]);
  });

  it('the .gitignore check drops the paths it names; a check that throws drops the list', () => {
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git, { ignored: () => new Set(['src/use.ts']) }).map((f) => f.path)).toEqual(['src/math.ts', 'test/math.test.ts']);
    expect(likelyRelevantFiles('Change `sum()` in src/math.ts', repo.sha, repo.git, { ignored: () => { throw new Error('no git'); } })).toEqual([]);
  });

  it('no terms, a bad sha or a failing git: an empty list, never a throw', () => {
    expect(likelyRelevantFiles('Make it better.', repo.sha, repo.git)).toEqual([]);
    expect(likelyRelevantFiles('Change `sum()`', 'HEAD', repo.git)).toEqual([]);
    expect(likelyRelevantFiles('Change `sum()`', repo.sha, () => { throw new Error('git failed'); })).toEqual([]);
  });
});

describe('the bench fixture: the pre-scan lists the files bench-10 implement lanes edited', () => {
  let dir: string;
  let meta: ReturnType<typeof createBenchFixture>;
  let git: PrescanGit;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-prescan-bench-'));
    meta = createBenchFixture(join(dir, 'b'));
    git = (args, input) => execFileSync('git', [...args], { cwd: meta.root, input, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  });
  afterAll(() => removeBenchDir(join(dir, 'b')));

  // The existing files each implement lane edited in the live bench-10 run (new files cannot be listed).
  const EDITED: Record<number, string[]> = {
    1: ['README.md'],
    2: ['src/math.ts', 'test/math.test.ts'],
    3: ['src/strings.ts', 'test/strings.test.ts'],
    4: ['src/inventory.ts', 'test/inventory.test.ts'],
    5: ['src/legacy.ts', 'test/legacy.test.ts'],
    6: ['src/cart.ts', 'test/cart.test.ts'],
    7: ['src/format.ts'],
  };

  it('every edited file is listed, at most 8 paths each; the traps get no protected path', () => {
    for (const issue of BENCH_ISSUES) {
      const listed = likelyRelevantFiles(`${issue.title}\n${fillPlaceholders(issue.body, meta)}`, meta.baseSha, git).map((f) => f.path);
      expect(listed.length).toBeLessThanOrEqual(8);
      for (const p of EDITED[issue.id] ?? []) expect(listed, `#${issue.id}`).toContain(p);
      expect(listed.some((p) => p.startsWith('.github/') || p.startsWith('.copilot/')), `#${issue.id}`).toBe(false);
    }
  });
});

describe('the implement prompt: the likely files and the outside-path note', () => {
  const s = (text: string, over: Partial<FactoryRunState> = {}): FactoryRunState => ({
    ...createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'main' }, '2026-11-20T00:00:00.000Z'), baseSha: 'c'.repeat(40), issueTitle: 'T', plan: { source: 'issue-body', text }, ...over,
  });

  it('lists the files after the plan as a hint, never a limit; none: the prompt is unchanged', () => {
    const plain = prompts.implementPrompt(s('Do it.'));
    const withList = prompts.implementPrompt(s('Do it.'), undefined, [], null, [], [{ path: 'src/a.ts', reason: 'named in the issue' }, { path: 'test/a.test.ts', reason: 'mentions `a`\n## injected' }]);
    expect(withList.startsWith(plain)).toBe(true);
    expect(withList.slice(plain.length)).toBe([
      '',
      '',
      '## Likely relevant files (a free search of the base tree for the paths and names in the plan; a starting point, not a limit: change whatever the plan needs)',
      '',
      '- `src/a.ts`: named in the issue',
      '- `test/a.test.ts`: mentions `a` ## injected',
    ].join('\n'));
    expect(prompts.implementPrompt(s('Do it.'), undefined, [], null, [], [])).toBe(plain);
  });

  it('a plan naming an outside path gets one note after the decline rule; ordinary plans and heal diagnoses do not', () => {
    const one = prompts.implementPrompt(s('Copy C:\\Support\\notes.txt into docs/notes.md.'));
    expect(one).toContain(`${prompts.DECLINE_RULE}\nThe plan names an absolute path outside this worktree: you cannot read or write it. If the task can only be done with that file, decline it as above.\n`);
    expect(one).not.toContain('C:\\Support\\notes.txt\nThe plan');
    expect(prompts.implementPrompt(s('Merge ~/a.md and /home/u/b.md into docs/c.md.'))).toContain('The plan names 2 absolute paths outside this worktree: you cannot read or write them. If the task can only be done with those files, decline it as above.');
    for (const text of ['Add `clamp()` to src/math.ts.', 'GET /api/users returns 500; see https://example.test/home/x.']) {
      expect(prompts.implementPrompt(s(text))).not.toContain('outside this worktree:');
    }
    const heal = s('at /home/runner/work/r/r/src/a.ts:3', { kind: 'ci-heal', heal: { sig8: 'abcd1234' } as FactoryRunState['heal'], plan: { source: 'heal-diagnosis', text: 'at /home/runner/work/r/r/src/a.ts:3' } });
    expect(prompts.implementPrompt(heal)).not.toContain('outside this worktree:');
  });
});
