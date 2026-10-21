import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  compareVersions,
  failingTitlesFromVitestJson,
  findDistOrphans,
  newFailures,
  parseBaselineTitles,
  parseReleaseVersion,
  releaseProseProblems,
  remoteTagTarget,
  smokeProblems,
  stampVersion,
  tagTargetProblem,
  VERSION_STAMPS,
} from '../checks.js';
import { formatReleaseProgress } from '../progress.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('release versions', () => {
  it('parses X.Y.Z with an optional leading v and refuses anything else', () => {
    expect(parseReleaseVersion('v5.12.2')).toBe('5.12.2');
    expect(() => parseReleaseVersion('5.12')).toThrow(/X\.Y\.Z/);
    expect(() => parseReleaseVersion('5.12.2-rc.1')).toThrow(/X\.Y\.Z/);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('5.10.0', '5.9.9')).toBeGreaterThan(0);
    expect(compareVersions('5.12.1', '5.12.1')).toBe(0);
    expect(compareVersions('5.12.1', '5.12.2')).toBeLessThan(0);
  });
});

describe('release prose', () => {
  const changelog = '# Changelog\n\n# oh-my-copilot v5.12.2\n\n## [5.12.2] - 2026-10-22\n\nFixes.\n';

  it('accepts the H1, the Keep-a-Changelog section and a body naming the version', () => {
    expect(releaseProseProblems('5.12.2', changelog, '# oh-my-copilot v5.12.2\n')).toEqual([]);
  });

  it('names each missing piece', () => {
    expect(releaseProseProblems('5.12.2', '## [5.12.2] - 2026-10-22\n', 'old body for 5.12.1')).toEqual([
      'CHANGELOG.md has no "# oh-my-copilot v5.12.2" heading (the release boundary greps for it)',
      '.github/release-body.md does not mention 5.12.2',
    ]);
    expect(releaseProseProblems('5.12.2', '# oh-my-copilot v5.12.2\n', null)).toEqual([
      'CHANGELOG.md has no "## [5.12.2] - YYYY-MM-DD" section',
      '.github/release-body.md is missing or empty',
    ]);
    // 5.12.20 must not satisfy 5.12.2.
    expect(releaseProseProblems('5.12.2', '# oh-my-copilot v5.12.20\n## [5.12.20]\n', '5.12.2')).toHaveLength(2);
  });
});

describe('version stamps', () => {
  it('replaces every stamp and reports a file without one', () => {
    const doc = VERSION_STAMPS.find((s) => s.file === 'docs/CLAUDE.md')!;
    expect(stampVersion('x <!-- OMC:VERSION:5.12.1 --> y', doc, '5.12.2')).toBe('x <!-- OMC:VERSION:5.12.2 --> y');
    expect(stampVersion('no stamp here', doc, '5.12.2')).toBeNull();
    const market = VERSION_STAMPS.find((s) => s.file === '.claude-plugin/marketplace.json')!;
    expect(stampVersion('{"version": "1"}\n{"version": "1"}', market, '2.0.0')).toBe('{"version": "2.0.0"}\n{"version": "2.0.0"}');
  });

  it('stamps only the top-level version of a plugin manifest', () => {
    const manifest = '{\n  "name": "x",\n  "version": "5.12.1",\n  "mcpServers": { "t": { "version": "1.0.0" } }\n}\n';
    for (const file of ['plugin.json', '.claude-plugin/plugin.json']) {
      const stamp = VERSION_STAMPS.find((s) => s.file === file)!;
      expect(stampVersion(manifest, stamp, '5.12.2'), file).toBe(manifest.replace('"version": "5.12.1"', '"version": "5.12.2"'));
    }
  });

  it('covers every file scripts/sync-version.sh stamps', () => {
    const script = readFileSync(join(REPO, 'scripts', 'sync-version.sh'), 'utf8');
    const files = [...script.matchAll(/="\$ROOT\/([^"]+)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) expect(VERSION_STAMPS.map((s) => s.file)).toContain(file);
  });

  it('finds a stamp in every listed file of this repository', () => {
    for (const stamp of VERSION_STAMPS) {
      const content = readFileSync(join(REPO, stamp.file), 'utf8');
      expect(stampVersion(content, stamp, '9.9.9'), stamp.file).not.toBeNull();
    }
  });
});

describe('dist orphans (fixture tree)', () => {
  it('lists tracked tsc outputs whose src source is gone, ignoring non-tsc files', () => {
    const root = mkdtempSync(join(tmpdir(), 'omg-release-orphans-'));
    try {
      for (const f of ['src/a.ts', 'src/b/c.tsx', 'src/d.js']) {
        mkdirSync(dirname(join(root, f)), { recursive: true });
        writeFileSync(join(root, f), '');
      }
      const tracked = [
        'dist/a.js', 'dist/a.d.ts', 'dist/a.js.map', 'dist/a.d.ts.map',
        'dist/b/c.js', 'dist/d.js',
        'dist/gone.js', 'dist/gone.d.ts.map', 'dist\\b\\removed.d.ts',
        'dist/config/builtin.json', 'dist/hooks/skill-bridge.cjs',
      ];
      expect(findDistOrphans(tracked, (p) => existsSync(join(root, p)))).toEqual(['dist/gone.js', 'dist/gone.d.ts.map', 'dist/b/removed.d.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('suite baseline diff', () => {
  const report = (prefix: string) => JSON.stringify({
    testResults: [
      { name: `${prefix}/src/a.test.ts`, status: 'failed', assertionResults: [{ fullName: 'a > breaks', status: 'failed' }, { fullName: 'a > works', status: 'passed' }] },
      { name: `${prefix}/tests/b.test.ts`, status: 'failed', assertionResults: [] },
      { name: `${prefix}/src/c.test.ts`, status: 'passed', assertionResults: [{ fullName: 'c > fine', status: 'passed' }] },
    ],
  });

  it('extracts repo-relative titles from Windows and POSIX reports alike', () => {
    const win = failingTitlesFromVitestJson(report('C:\\Code\\OMC').replace(/\//g, '\\\\'));
    const posix = failingTitlesFromVitestJson(report('/home/runner/work/x'));
    expect(win).toEqual(['src/a.test.ts > a > breaks', 'tests/b.test.ts']);
    expect(posix).toEqual(win);
  });

  it('fails only on titles absent from the baseline (JSON or text)', () => {
    const failing = ['src/a.test.ts > a > breaks', 'src/new.test.ts > new > breaks'];
    expect(newFailures(failing, parseBaselineTitles(report('/other/tree')))).toEqual(['src/new.test.ts > new > breaks']);
    expect(newFailures(failing, parseBaselineTitles('# known\nC:\\x\\src\\a.test.ts > a > breaks\n'))).toEqual(['src/new.test.ts > new > breaks']);
    expect(newFailures(failing, [])).toEqual(failing);
  });
});

describe('smoke report', () => {
  it('passes only when every check passed and nothing was skipped', () => {
    expect(smokeProblems('banner\n{"ok":true,"checks":[{"id":"a","ok":true}]}')).toEqual([]);
    expect(smokeProblems('{"ok":false,"checks":[{"id":"scn.guardrail","ok":false,"detail":"push not denied"}]}')).toEqual(['scn.guardrail: push not denied']);
    expect(smokeProblems('{"ok":true,"skipped":"copilot not found","checks":[]}')).toEqual(['smoke skipped: copilot not found', 'smoke reported no checks']);
    expect(smokeProblems('not json')).toEqual(['smoke did not print a JSON report']);
  });
});

describe('tag targets', () => {
  it('reads the peeled commit of an annotated remote tag', () => {
    expect(remoteTagTarget(`${OTHER}\trefs/tags/v5.12.2\n${SHA}\trefs/tags/v5.12.2^{}\n`, 'v5.12.2')).toEqual({ object: OTHER, commit: SHA, annotated: true });
    expect(remoteTagTarget(`${SHA}\trefs/tags/v5.12.2\n`, 'v5.12.2')).toEqual({ object: SHA, commit: SHA, annotated: false });
    expect(remoteTagTarget(`${SHA}\trefs/tags/v5.12.20\n`, 'v5.12.2')).toBeNull();
    expect(remoteTagTarget('', 'v5.12.2')).toBeNull();
  });

  it('requires an annotated tag peeling to the main merge commit', () => {
    expect(tagTargetProblem('v1.0.0', 'tag\n', `${SHA}\n`, SHA)).toBeNull();
    expect(tagTargetProblem('v1.0.0', 'commit', SHA, SHA)).toMatch(/not an annotated tag/);
    expect(tagTargetProblem('v1.0.0', 'tag', OTHER, SHA)).toMatch(/not the main merge commit/);
  });
});

describe('progress line contract', () => {
  it('writes <ISO> phase= status= note= with quoting', () => {
    const at = new Date('2026-10-21T12:00:00.000Z');
    expect(formatReleaseProgress({ phase: 'build', status: 'ok' }, at)).toBe('2026-10-21T12:00:00.000Z phase=build status=ok');
    expect(formatReleaseProgress({ phase: 'pr', status: 'heartbeat', note: 'PR #3 "x"', agent: 'release' }, at))
      .toBe('2026-10-21T12:00:00.000Z phase=pr status=heartbeat note="PR #3 \\"x\\"" agent=release');
  });
});
