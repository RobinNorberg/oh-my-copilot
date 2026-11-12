/**
 * Opt-in auto-merge (auto-merge.ts): the user-config resolver, the tier
 * classifier, every condition of the verdict, and the guard's one admitted
 * GitHub merge shape. Pure: no git, no gh.
 */
import { describe, expect, it } from 'vitest';
import { githubAutoMergeArgs, githubCommitReadArgs, isGithubAutoMergeArgs } from '../../../forge/github/merge.js';
import { assertFactoryCommand, FactorySafetyError } from '../exec.js';
import {
  autoMergeComment,
  autoMergeVerdict,
  baseInstallFiles,
  baseTestSetup,
  hasFrontmatter,
  classifyChanges,
  committedMergeConfig,
  deniedPaths,
  isDocsPath,
  isFrontmatterCandidate,
  isTestPath,
  MANUAL_MERGE_LABEL,
  parseChangedEntries,
  patchLines,
  resolveAutoMergeConfig,
  type AutoMergeConfig,
  type AutoMergeInput,
  type ChangedEntry,
} from '../auto-merge.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const URL = 'https://github.com/o/r';
const ROOT = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const userWith = (auto: unknown) => ({ factory: { merge: { auto } } });
const gh = { url: URL, root: ROOT, local: false };

const file = (path: string, added = 1, deleted = 0, mode = '100644'): ChangedEntry => ({ path, status: 'M', oldMode: mode, newMode: mode, added, deleted });
const gone = (path: string, deleted = 5): ChangedEntry => ({ path, status: 'D', oldMode: '100644', newMode: '000000', added: 0, deleted });
const added = (path: string, lines = 5): ChangedEntry => ({ path, status: 'A', oldMode: '000000', newMode: '100644', added: lines, deleted: 0 });
const all: AutoMergeConfig = { enabled: true, tiers: ['docs', 'tests', 'small'] };

describe('resolveAutoMergeConfig (user config only, per repository)', () => {
  it('is off without an entry for this repository, and on with one', () => {
    expect(resolveAutoMergeConfig(undefined, gh)).toEqual({});
    expect(resolveAutoMergeConfig(userWith({ 'https://github.com/o/other': { enabled: true, tiers: ['docs'] } }), gh)).toEqual({});
    expect(resolveAutoMergeConfig(userWith({ 'git@github.com:O/R.git': { enabled: true, tiers: ['docs'] } }), gh).config).toEqual({ enabled: true, tiers: ['docs'] });
    expect(resolveAutoMergeConfig(userWith({ [URL]: { enabled: false, tiers: ['docs'] } }), gh)).toEqual({ key: URL });
  });

  it('the local forge keys by the repository root path; a path never matches a hosted repository', () => {
    const local = { url: '/state/mirror.git', root: ROOT, local: true };
    expect(resolveAutoMergeConfig(userWith({ [ROOT]: { enabled: true, tiers: ['small'], maxChangedLines: 5 } }), local).config).toEqual({ enabled: true, tiers: ['small'], maxChangedLines: 5 });
    expect(resolveAutoMergeConfig(userWith({ [URL]: { enabled: true, tiers: ['small'] } }), local)).toEqual({});
    expect(resolveAutoMergeConfig(userWith({ [ROOT]: { enabled: true, tiers: ['small'] } }), gh)).toEqual({});
  });

  it('a malformed value is an error and leaves auto-merge off', () => {
    for (const bad of [
      [],
      { [URL]: true },
      { [URL]: { enabled: 'yes', tiers: ['docs'] } },
      { [URL]: { enabled: true, tiers: [] } },
      { [URL]: { enabled: true, tiers: ['everything'] } },
      { [URL]: { enabled: true, tiers: ['docs'], maxChangedLines: 0 } },
      { [URL]: { enabled: true, tiers: ['docs'], maxFiles: 1.5 } },
      { [URL]: { enabled: true, tiers: ['docs'], allowProtected: true } },
      { [URL]: { enabled: true, tiers: ['docs'] }, 'https://github.com/O/R.git': { enabled: true, tiers: ['docs'] } },
    ]) {
      const r = resolveAutoMergeConfig(userWith(bad), gh);
      expect(r.error, JSON.stringify(bad)).toBeTruthy();
      expect(r.config).toBeUndefined();
    }
  });

  it('a committed factory.merge is detected so the engine can say it is ignored', () => {
    expect(committedMergeConfig({ factory: { merge: { auto: {} } } })).toBe(true);
    expect(committedMergeConfig({ factory: { run: {} } })).toBe(false);
    expect(committedMergeConfig(undefined)).toBe(false);
  });
});

describe('parseChangedEntries', () => {
  const raw = (rows: Array<[string, string, string, string]>) => rows.map(([o, n, s, p]) => `:${o} ${n} ${'1'.repeat(40)} ${'2'.repeat(40)} ${s}\0${p}\0`).join('');
  it('joins raw modes and numstat counts by path; binary is null', () => {
    const r = raw([['100644', '100644', 'M', 'docs/a.md'], ['000000', '100644', 'A', 'img.png']]);
    expect(parseChangedEntries(r, '3\t1\tdocs/a.md\0-\t-\timg.png\0')).toEqual([
      { path: 'docs/a.md', status: 'M', oldMode: '100644', newMode: '100644', added: 3, deleted: 1 },
      { path: 'img.png', status: 'A', oldMode: '000000', newMode: '100644', added: null, deleted: null },
    ]);
  });
  it('a disagreement or malformed record is null (fail closed)', () => {
    expect(parseChangedEntries(raw([['100644', '100644', 'M', 'a.md']]), '1\t0\tb.md\0')).toBeNull();
    expect(parseChangedEntries(raw([['100644', '100644', 'M', 'a.md'], ['100644', '100644', 'M', 'b.md']]), '1\t0\ta.md\0')).toBeNull();
    expect(parseChangedEntries('garbage\0a.md\0', '1\t0\ta.md\0')).toBeNull();
    expect(parseChangedEntries(raw([['100644', '100644', 'M', 'a.md']]), 'x\ty\ta.md\0')).toBeNull();
  });
});

describe('tiers and denied paths', () => {
  it('docs and tests globs', () => {
    expect(isDocsPath('README.md')).toBe(true);
    expect(isDocsPath('src/x/NOTES.MD')).toBe(false);
    expect(isDocsPath('docs/guide/setup.txt')).toBe(true);
    expect(isDocsPath('src/docs/a.ts')).toBe(false);
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('src/__tests__/helpers.ts')).toBe(true);
    expect(isTestPath('pkg/x_test.go')).toBe(true);
    expect(isTestPath('tests/test_api.py')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
    expect(isTestPath('tests/run.sh')).toBe(false);
  });

  it('CI, config, manifests, lockfiles, agent and factory files are denied anywhere, folded as Windows opens them', () => {
    const paths = [
      '.github/workflows/ci.yml', '.GitHub/CODEOWNERS', '.copilot/omg.jsonc', '.omg/state/x.json', 'pkg/.copilot/backlog/1.md',
      'package.json', 'packages/a/package.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'requirements-dev.txt',
      'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.mjs', '.env.local', 'AGENTS.md', 'docs/CLAUDE.md',
      'home/AppData/Roaming/claude-omc/config.jsonc', 'omg.jsonc', '.gitlab-ci.yml', 'azure-pipelines.yml', '.gitattributes',
      'docs/a.md.', 'docs/a:stream.md', 'docs/../.github/x.md', '.circleci/config.yml', 'Jenkinsfile', '.husky/pre-commit',
    ];
    expect(deniedPaths(paths)).toEqual(paths.filter((p) => p !== 'docs/a.md.'));
    expect(deniedPaths(['docs/a.md.', 'flaky.json'], ['flaky.json'])).toEqual(['flaky.json']);
    expect(deniedPaths(['docs/guide.md', 'src/a.ts', 'src/a.test.ts'])).toEqual([]);
  });

  it('classifyChanges picks the first enabled tier every file fits', () => {
    expect(classifyChanges([file('README.md'), file('docs/x.md')], all).tier).toBe('docs');
    expect(classifyChanges([file('src/a.test.ts', 200)], all).tier).toBe('tests');
    expect(classifyChanges([file('src/a.ts', 10), file('src/a.test.ts', 10)], all).tier).toBe('small');
    expect(classifyChanges([file('src/a.ts', 81)], all).reasons[0]).toMatch(/no enabled tier fits .*small: 81 changed lines > maxChangedLines 80/);
    expect(classifyChanges([file('src/a.ts')], { enabled: true, tiers: ['docs'] }).reasons[0]).toMatch(/docs: src\/a\.ts is not docs/);
    expect(classifyChanges([file('docs/a.md'), file('docs/b.md')], { enabled: true, tiers: ['docs'], maxFiles: 1 }).reasons[0]).toMatch(/2 files > maxFiles 1/);
    expect(classifyChanges(null, all).reasons[0]).toMatch(/fails closed/);
    expect(classifyChanges([], all).reasons[0]).toMatch(/changes no file/);
  });

  it('adversarial: a docs-only PR with a symlink, an executable bit, a gitlink or a binary never fits', () => {
    expect(classifyChanges([file('docs/a.md'), { ...file('docs/link.md'), oldMode: '000000', newMode: '120000' }], all).reasons[0]).toMatch(/non-plain file modes.*docs\/link\.md 000000->120000/);
    expect(classifyChanges([{ ...file('docs/run.md'), newMode: '100755' }], all).reasons[0]).toMatch(/non-plain/);
    expect(classifyChanges([{ ...file('docs/sub'), oldMode: '000000', newMode: '160000' }], all).reasons[0]).toMatch(/non-plain/);
    expect(classifyChanges([file('docs/a.png', null as unknown as number, null as unknown as number)], all).reasons[0]).toMatch(/binary/);
  });

  it('adversarial: renaming a CI file into docs/ shows its deletion (no renames), which is denied', () => {
    const r = classifyChanges([gone('.github/workflows/ci.yml', 20), added('docs/ci.yml', 20)], all);
    expect(r.tier).toBeUndefined();
    expect(r.reasons[0]).toMatch(/always need a human.*\.github\/workflows\/ci\.yml/);
  });

  it('adversarial: a lane editing user-config-looking files never fits any tier', () => {
    for (const p of ['docs/claude-omc/config.jsonc', 'docs/.copilot/omg.jsonc', 'notes/omc.jsonc', 'docs/.mcp.json']) {
      expect(classifyChanges([file(p)], all).reasons[0], p).toMatch(/always need a human/);
    }
  });
});

describe('review-498 adversarial paths', () => {
  const docsOnly: AutoMergeConfig = { enabled: true, tiers: ['docs'] };
  const testsOnly: AutoMergeConfig = { enabled: true, tiers: ['tests'] };
  const smallOnly: AutoMergeConfig = { enabled: true, tiers: ['small'] };

  it('H1: agent prompts, rules and executable docs never auto-merge in any tier', () => {
    for (const p of ['skills/x/SKILL.md', 'skills/execute/notes.md', 'agents/x.md', 'commands/ship.md', 'templates/pr.md', 'prompts/a.md',
      '.cursor/rules/x.mdc', 'rules/x.mdc', '.gemini/styleguide.md', '.codex/x.md', '.windsurf/rules.md', '.clinerules', '.cursorrules',
      'docs/review.prompt.md', 'notes/x.instructions.md', 'a.chatmode.md', 'docs/.vitepress/config.mts', 'docs/.vitepress/theme/index.ts',
      '.githooks/post-merge', 'hooks/pre-commit', 'scripts/hooks/post-merge', 'src/__mocks__/fs.ts']) {
      expect(deniedPaths([p]), p).toEqual([p]);
      expect(classifyChanges([file(p)], all).tier, p).toBeUndefined();
    }
  });

  it('H1: the docs tier is an allowlist of .md/.rst (and .txt under docs/): no .mdx, scripts, HTML, site config or images', () => {
    for (const p of ['docs/install.sh', 'docs/install.ps1', 'x.mdx', 'docs/x.mdx', 'docs/index.html', 'docs/site.js', 'docs/logo.svg', 'notes.txt']) {
      expect(isDocsPath(p), p).toBe(false);
      expect(classifyChanges([file(p)], docsOnly).tier, p).toBeUndefined();
    }
    expect(classifyChanges([file('docs/guide.md'), file('README.rst'), file('docs/a.txt')], docsOnly).tier).toBe('docs');
  });

  it('H1: user docsDenied globs keep matching Markdown out of the docs tier', () => {
    const cfg: AutoMergeConfig = { ...docsOnly, docsDenied: ['docs/security/', 'RUNBOOK.md'] };
    expect(classifyChanges([file('docs/security/policy.md')], cfg).reasons[0]).toMatch(/docs: docs\/security\/policy\.md is not docs/);
    expect(classifyChanges([file('ops/RUNBOOK.md')], cfg).tier).toBeUndefined();
    expect(classifyChanges([file('docs/guide.md')], cfg).tier).toBe('docs');
  });

  it('M2a/b: test-file names and test directories are anchored', () => {
    expect(isTestPath('lib/latest.rb')).toBe(false);
    expect(isTestPath('lib/contest.rb')).toBe(false);
    expect(isTestPath('spec/user_spec.rb')).toBe(true);
    expect(isTestPath('test.rb')).toBe(true);
    expect(isTestPath('src/cli/commands/test/index.ts')).toBe(false);
    expect(classifyChanges([file('src/cli/commands/test/index.ts')], testsOnly).tier).toBeUndefined();
    expect(isTestPath('tests/helpers.ts')).toBe(true);
    expect(isTestPath('src/deep/__tests__/x.ts')).toBe(true);
  });

  it('M2c: setup files named in the BASE test config, setup/teardown/bench files and __mocks__ never fit the tests tier', () => {
    const testSetup = baseTestSetup([{ path: 'vitest.config.ts', text: "export default { test: { setupFiles: ['./tests/setup.ts'], globalSetup: 'tests/global' } }" }]);
    expect(testSetup).toEqual({ paths: ['./tests/setup.ts', 'tests/global'] });
    const r = classifyChanges([file('tests/setup.ts')], testsOnly, { testSetup });
    expect(r.reasons[0]).toMatch(/base test config runs around every test run.*tests\/setup\.ts/);
    expect(classifyChanges([file('tests/global.ts')], all, { testSetup }).tier).toBeUndefined();
    expect(classifyChanges([file('src/__tests__/setup/x.ts')], testsOnly).tier).toBeUndefined();
    expect(classifyChanges([file('tests/teardown.ts')], testsOnly).tier).toBeUndefined();
    expect(classifyChanges([file('tests/sum.bench.ts')], testsOnly).tier).toBeUndefined();
    expect(classifyChanges([file('__mocks__/x.ts')], all).reasons[0]).toMatch(/always need a human.*__mocks__\/x\.ts/);
    expect(classifyChanges([file('tests/a.test.ts')], testsOnly, { testSetup }).tier).toBe('tests');
  });

  it('M2c: a setup value the engine cannot read as literals keeps the tests and small tiers off (docs still works)', () => {
    for (const text of ['export default { test: { setupFiles: files } }', 'export default { test: { setupFiles: [`${dir}/s.ts`] } }', '{ globalSetup: require("x") }']) {
      const s = baseTestSetup([{ path: 'vitest.config.ts', text }]);
      expect(s.problem, text).toBeTruthy();
      expect(classifyChanges([file('tests/a.test.ts')], all, { testSetup: s }).reasons[0], text).toMatch(/tests: vitest\.config\.ts: (setupFiles|globalSetup) is not/);
      expect(classifyChanges([file('docs/a.md')], all, { testSetup: s }).tier).toBe('docs');
    }
    expect(baseTestSetup([{ path: 'package.json', text: JSON.stringify({ jest: { setupFilesAfterEnv: ['<rootDir>/jest.setup.js'] } }) }])).toEqual({ paths: ['<rootDir>/jest.setup.js'] });
    expect(classifyChanges([file('jest.setup.js')], smallOnly, { testSetup: { paths: ['<rootDir>/jest.setup.js'] } }).tier).toBeUndefined();
  });

  it('M2d: a deleted test file never auto-merges, in any tier', () => {
    expect(classifyChanges([gone('src/a.test.ts')], all).reasons[0]).toMatch(/deletes test files.*src\/a\.test\.ts/);
    expect(classifyChanges([gone('tests/security-regression.ts')], all).tier).toBeUndefined();
    expect(classifyChanges([gone('src/old.ts')], smallOnly).tier).toBe('small');
  });

  it('INFO: the small tier never touches the factory, ship, copilot-run or forge sources, even in a 5-line PR', () => {
    const r = classifyChanges([file('src/factory/run/exec.ts', 3, 2)], smallOnly);
    expect(r.tier).toBeUndefined();
    expect(r.reasons[0]).toMatch(/small: src\/factory\/run\/exec\.ts is not small-tier files/);
    for (const p of ['src/ship/merge.ts', 'src/copilot-run/sandbox.ts', 'src/forge/github/merge.ts', 'SRC/Factory/x.ts']) expect(classifyChanges([file(p)], smallOnly).tier, p).toBeUndefined();
    expect(classifyChanges([file('src/greet.ts', 3, 2)], smallOnly).tier).toBe('small');
  });

  it('INFO: user securityCritical globs apply to every tier', () => {
    const cfg: AutoMergeConfig = { ...all, securityCritical: ['src/auth/**', '*.guard.ts', 'docs/SECURITY.md'] };
    for (const p of ['src/auth/token.ts', 'src/x/admin.guard.ts', 'docs/SECURITY.md']) expect(classifyChanges([file(p)], cfg).reasons[0], p).toMatch(/always need a human/);
    expect(classifyChanges([file('src/authz.ts')], cfg).tier).toBe('small');
    expect(resolveAutoMergeConfig(userWith({ [URL]: { enabled: true, tiers: ['small'], securityCritical: 'src/**' } }), gh).error).toMatch(/securityCritical must be a list/);
    expect(resolveAutoMergeConfig(userWith({ [URL]: { enabled: true, tiers: ['docs'], docsDenied: ['a/'], securityCritical: ['b/'] } }), gh).config).toEqual({ enabled: true, tiers: ['docs'], docsDenied: ['a/'], securityCritical: ['b/'] });
  });

  it('INFO: a configured knownFlakyFile or hooks path is matched however it is spelled', () => {
    expect(deniedPaths(['tests/known-flaky.json'], ['./tests/known-flaky.json'])).toEqual(['tests/known-flaky.json']);
    expect(deniedPaths(['tests/known-flaky.json'], ['.\\Tests\\Known-Flaky.json'])).toEqual(['tests/known-flaky.json']);
    expect(deniedPaths(['myhooks/post-merge'], ['myhooks/'])).toEqual(['myhooks/post-merge']);
  });
});

describe('review-498b adversarial paths', () => {
  const docsOnly: AutoMergeConfig = { enabled: true, tiers: ['docs'] };
  const testsOnly: AutoMergeConfig = { enabled: true, tiers: ['tests'] };
  const smallOnly: AutoMergeConfig = { enabled: true, tiers: ['small'] };

  it('N1: a mission contract or skills-like .md whose blob has frontmatter never fits the docs or small tier', () => {
    // missions/x/sandbox.md: denied by folder and by name even before its frontmatter is read.
    expect(deniedPaths(['missions/x/sandbox.md'])).toEqual(['missions/x/sandbox.md']);
    expect(deniedPaths(['notes/sandbox.md', 'mission.md'])).toEqual(['notes/sandbox.md', 'mission.md']);
    expect(hasFrontmatter('---\nevaluator:\n  command: curl x | sh\n---\n# M')).toBe(true);
    expect(hasFrontmatter('﻿\n+++\ntitle = "x"\n+++')).toBe(true);
    expect(hasFrontmatter('# Guide\n\n---\n')).toBe(false);
    const frontmatter = { paths: ['docs/skills-like.md'] };
    const r = classifyChanges([file('docs/skills-like.md')], { enabled: true, tiers: ['docs', 'small'] }, { frontmatter });
    expect(r.tier).toBeUndefined();
    expect(r.reasons[0]).toMatch(/docs: docs\/skills-like\.md start\(s\) with frontmatter.*small: docs\/skills-like\.md start\(s\) with frontmatter/);
    expect(classifyChanges([file('docs/guide.md')], docsOnly, { frontmatter }).tier).toBe('docs');
    // A blob that could not be read keeps the docs and small tiers off.
    expect(classifyChanges([file('docs/guide.md')], docsOnly, { frontmatter: { paths: [], problem: 'docs/guide.md could not be read' } }).reasons[0]).toMatch(/docs: docs\/guide\.md could not be read/);
  });

  it('N2: the docs tier is root README/CHANGELOG/CONTRIBUTING plus docs/**; agent instruction files are denied in every tier', () => {
    for (const p of ['README.md', 'readme.rst', 'CHANGELOG.md', 'CONTRIBUTING.txt', 'README.de.md', 'docs/guide.md', 'docs/a/b.rst', 'docs/notes.txt']) expect(isDocsPath(p), p).toBe(true);
    for (const p of ['src/notes.md', 'NOTES.md', 'pkg/README.md', 'docs.md', 'README', 'README.html']) expect(isDocsPath(p), p).toBe(false);
    expect(classifyChanges([file('README.md')], docsOnly).tier).toBe('docs');
    expect(classifyChanges([file('docs/guide.md')], docsOnly).tier).toBe('docs');
    expect(classifyChanges([file('src/notes.md')], docsOnly).reasons[0]).toMatch(/docs: src\/notes\.md is not docs/);
    for (const p of ['CLAUDE.local.md', 'AGENTS.override.md', 'WARP.md', 'CONVENTIONS.md', '.omx/plans/x.md', '.junie/guidelines.md', '.amazonq/rules/a.md',
      '.trae/rules/a.md', '.opencode/a.md', '.augment/rules/a.md', '.zed/a.md', 'memory-bank/a.md', '.claude-plugin/plugin.json', 'missions/m/notes.md', 'docs/CLAUDE.local.md']) {
      expect(deniedPaths([p]), p).toEqual([p]);
      expect(classifyChanges([file(p)], all).tier, p).toBeUndefined();
    }
  });

  it('N2: docsDenied keeps docs that agents are told to read (docs/shared/, docs/partials/) out of the docs tier', () => {
    const cfg: AutoMergeConfig = { ...docsOnly, docsDenied: ['docs/shared/', 'docs/partials/'] };
    expect(classifyChanges([file('docs/shared/agent-tiers.md')], cfg).tier).toBeUndefined();
    expect(classifyChanges([file('docs/partials/x.md')], cfg).tier).toBeUndefined();
    expect(classifyChanges([file('docs/guide.md')], cfg).tier).toBe('docs');
  });

  it('N3: files the base package.json runs on install or publish, its bin targets, bridge/ and dist/ are denied in every tier', () => {
    const pkg = JSON.stringify({
      scripts: { postinstall: 'node scripts/postinstall-contained-fs.mjs', prepare: 'npm run build:hooks && husky', 'build:hooks': 'node ./tools/gen-hooks.js --out x', test: 'vitest run scripts/other.mjs' },
      bin: { omg: 'bin/omg.js' },
    });
    const installFiles = baseInstallFiles(pkg);
    expect(installFiles.paths).toEqual(['scripts/postinstall-contained-fs.mjs', 'tools/gen-hooks.js', 'bin/omg.js']);
    for (const p of ['scripts/postinstall-contained-fs.mjs', 'bin/omg.js', 'tools/gen-hooks.js']) {
      expect(classifyChanges([file(p, 1, 1)], all, { installFiles }).reasons[0], p).toMatch(/always need a human/);
    }
    for (const p of ['bridge/cli.cjs', 'dist/index.js', 'dist/README.md']) expect(classifyChanges([file(p)], all).reasons[0], p).toMatch(/always need a human/);
    // review-498c L-b: a lifecycle that runs a repository file (whose imports are not followed) keeps the small tier off.
    expect(installFiles.problem).toMatch(/postinstall" runs node scripts\/postinstall-contained-fs\.mjs/);
    expect(classifyChanges([file('scripts/other.mjs')], smallOnly, { installFiles }).tier).toBeUndefined();
    expect(classifyChanges([file('scripts/other.mjs')], smallOnly, { installFiles: baseInstallFiles(JSON.stringify({ scripts: { prepare: 'husky' }, bin: 'cli.js' })) }).tier).toBe('small');
    expect(baseInstallFiles(JSON.stringify({ bin: 'cli.js' }))).toEqual({ paths: ['cli.js'] });
    expect(baseInstallFiles(JSON.stringify({ scripts: { prepare: 'yarn gen', gen: 'node tools/gen.js', prepublishOnly: 'sh ./release.sh' } })).paths).toEqual(['tools/gen.js', 'release.sh']);
    expect(baseInstallFiles(null)).toEqual({ paths: [] });
  });

  it('N3: a lifecycle script the engine cannot read as literal words keeps the small tier off (docs still works)', () => {
    for (const pkg of [{ scripts: { postinstall: 'node $SCRIPT' } }, { scripts: { prepare: 'node scripts/*.js' } }, { scripts: { install: ['x'] } }, { bin: ['a'] }, { scripts: { prepare: 'npm run' } }]) {
      const installFiles = baseInstallFiles(JSON.stringify(pkg));
      expect(installFiles.problem, JSON.stringify(pkg)).toBeTruthy();
      expect(classifyChanges([file('src/greet.ts')], smallOnly, { installFiles }).tier, JSON.stringify(pkg)).toBeUndefined();
      expect(classifyChanges([file('docs/a.md')], all, { installFiles }).tier).toBe('docs');
    }
    expect(baseInstallFiles('{nope').problem).toMatch(/could not be parsed/);
  });

  it('N4: shorthand, computed, merged or imported test config keeps the tests and small tiers off; more runner keys count', () => {
    for (const text of [
      'const setupFiles = ["./tests/env.ts"]; export default { test: { setupFiles } }',
      "export default { test: { ['setupFiles']: ['./x.ts'] } }",
      "import base from './vitest.base'; export default base",
      "const base = require('./jest.base'); module.exports = base",
      "import { mergeConfig } from 'vitest/config'; export default mergeConfig(a, b)",
      "export default defineWorkspace(['packages/*'])",
      "export default { test: { reporters: [['./tests/reporter.ts', {}]] } }",
    ]) {
      const s = baseTestSetup([{ path: 'vitest.config.ts', text }]);
      expect(s.problem, text).toBeTruthy();
      expect(classifyChanges([file('tests/a.test.ts')], { enabled: true, tiers: ['tests', 'small'] }, { testSetup: s }).tier, text).toBeUndefined();
    }
    expect(baseTestSetup([{ path: 'vitest.config.ts', text: "export default { test: { environment: 'jsdom', reporters: ['default', './tests/rep.ts'], sequence: { sequencer: './tests/seq.ts' } } }" }]))
      .toEqual({ paths: ['jsdom', 'default', './tests/rep.ts', './tests/seq.ts'] });
    expect(baseTestSetup([{ path: 'package.json', text: JSON.stringify({ jest: { testEnvironment: './tests/env.js', transform: { '^.+\\.ts$': ['ts-jest', { a: 1 }] }, reporters: ['default', ['./tests/reporter.js', {}]] } }) }]))
      .toEqual({ paths: ['default', './tests/reporter.js', './tests/env.js', 'ts-jest'] });
    // The name backstop: environment and reporter files never fit the tests tier.
    for (const p of ['tests/env.ts', 'tests/reporter.ts', 'tests/global-setup.ts', 'tests/serializer.ts']) expect(classifyChanges([file(p)], testsOnly).tier, p).toBeUndefined();
  });

  it('N5: a gutted test (more lines deleted than added) or an added skip, focus or empty assertion fits no tests or small tier', () => {
    expect(classifyChanges([file('src/a.test.ts', 1, 200)], all).tier).toBeUndefined();
    expect(classifyChanges([file('src/a.test.ts', 1, 200)], all).reasons[0]).toMatch(/tests: src\/a\.test\.ts lose\(s\) more lines \(or assertion lines\) than it gains/);
    for (const line of ["  it.skip('checks auth', () => {", "describe.only('x', () => {", 'xit("x", () => {', "  it.todo('later')", '  expect(true).toBe(true);', 'test.skipIf(process.env.CI)("x", () => {']) {
      const patch = patchLines(`diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,1 +1,2 @@\n ctx\n+${line}\n`);
      expect(patch).toEqual([{ path: 'b/src/a.test.ts', sign: '+', text: line }]);
      const r = classifyChanges([file('src/a.test.ts', 1, 0)], { enabled: true, tiers: ['tests', 'small'] }, { patch });
      expect(r.tier, line).toBeUndefined();
      expect(r.reasons[0], line).toMatch(/tests: an added line skips, focuses or empties a test/);
    }
    expect(classifyChanges([file('src/a.test.ts', 3, 0)], testsOnly, { patch: [{ path: 'b/src/a.test.ts', sign: '+', text: "  it('works', () => expect(sum(1, 2)).toBe(3));" }] }).tier).toBe('tests');
    // An unreadable patch (or a coloured one) keeps the tests and small tiers off; docs never reads it.
    expect(patchLines('\u001b[32m+x\u001b[m')).toBeNull();
    expect(classifyChanges([file('src/a.test.ts')], testsOnly, { patch: null }).reasons[0]).toMatch(/patch could not be read/);
    expect(classifyChanges([file('docs/a.md')], docsOnly, { patch: null }).tier).toBe('docs');
  });
});

describe('review-498c follow-ups (fail closed)', () => {
  const docsOnly: AutoMergeConfig = { enabled: true, tiers: ['docs'] };
  const testsOnly: AutoMergeConfig = { enabled: true, tiers: ['tests'] };
  const smallOnly: AutoMergeConfig = { enabled: true, tiers: ['small'] };
  const testsSmall: AutoMergeConfig = { enabled: true, tiers: ['tests', 'small'] };

  it('L-a: a docs path in a non-canonical spelling is read for frontmatter and never fits the docs tier', () => {
    for (const p of ['README.md.', 'README.md ', 'README.ｍｄ', 'READ‍ME.md', 'docs/x.md.', 'docs/x.ｍｄ', 'docs/x.m‍d', 'Docs./x.md', 'ｄocs/x.md']) {
      expect(isFrontmatterCandidate(p), p).toBe(true);
      expect(classifyChanges([file(p)], docsOnly).tier, p).toBeUndefined();
    }
    // A small-tier file spelled to dodge the Markdown test is read for frontmatter too.
    expect(isFrontmatterCandidate('src/notes.ｍｄ')).toBe(true);
    expect(isFrontmatterCandidate('src/x.ts')).toBe(false);
    for (const p of ['README.md', 'readme.MD', 'docs/guide.md', 'CHANGELOG.rst']) expect(classifyChanges([file(p)], docsOnly).tier, p).toBe('docs');
  });

  it('L-b: install scripts the engine cannot follow keep the small tier off', () => {
    const tools = { setup: 'node tools/setup.js' };
    for (const pkg of [
      { scripts: { postinstall: 'node .' } },
      { scripts: { postinstall: 'node lib' } },
      { scripts: { postinstall: 'node scripts/postinstall' } },
      { scripts: { postinstall: "node -e \"require('./lib/install')\"" } },
      { scripts: { postinstall: 'npm run -s setup', ...tools } },
      { scripts: { postinstall: 'npm --silent run setup', ...tools } },
      { scripts: { postinstall: 'pnpm -s setup', ...tools } },
      { scripts: { postinstall: 'run-s setup', ...tools } },
      { scripts: { postinstall: 'npm-run-all setup', ...tools } },
      { scripts: { postinstall: 'concurrently "npm:setup"', ...tools } },
      { scripts: { postinstall: 'npx --yes ./tools/x' } },
      { scripts: { postinstall: 'npm run setup -w pkg-a', setup: 'husky' } },
      { scripts: { install: 'node-gyp rebuild' } },
      { scripts: { dependencies: 'husky && tsx tools/dep.ts' } },
      { scripts: { preprepare: 'node tools/pp.js' } },
      { scripts: { postprepare: 'node tools/pq.js' } },
      { scripts: { postinstall: 'yarn workspace a build' } },
      { scripts: { prepare: 'bun tools/x.ts' } },
      { gypfile: true },
      { workspaces: ['packages/*'] },
    ]) {
      const installFiles = baseInstallFiles(JSON.stringify(pkg));
      expect(installFiles.problem, JSON.stringify(pkg)).toBeTruthy();
      expect(classifyChanges([file('src/greet.ts')], smallOnly, { installFiles }).tier, JSON.stringify(pkg)).toBeUndefined();
    }
    for (const root of [['binding.gyp'], ['pnpm-workspace.yaml'], ['Binding.GYP']]) {
      expect(baseInstallFiles(null, root).problem, root[0]).toBeTruthy();
      expect(baseInstallFiles(JSON.stringify({ scripts: { prepare: 'husky' } }), root).problem, root[0]).toBeTruthy();
    }
    // Commands that run no repository file stay fine: the small tier still works.
    for (const pkg of [{ scripts: { prepare: 'husky' } }, { scripts: { prepare: 'npm run hooks', hooks: 'husky' } }, { scripts: { postinstall: 'yarn && husky' } }, { scripts: { test: 'node scripts/t.js' } }]) {
      const installFiles = baseInstallFiles(JSON.stringify(pkg), ['package.json', 'src']);
      expect(installFiles.problem, JSON.stringify(pkg)).toBeUndefined();
      expect(classifyChanges([file('src/greet.ts')], smallOnly, { installFiles }).tier, JSON.stringify(pkg)).toBe('small');
    }
  });

  it('L-c: more skip and empty-assertion spellings, and assertion loss hidden by padding, keep the tests and small tiers off', () => {
    const one = (line: string, path = 'tests/a.test.ts') => classifyChanges([file(path, 1, 1)], testsSmall, { patch: [{ path: `b/${path}`, sign: '+', text: line }] });
    for (const line of ["it['skip']('x', () => {})", 'it[`skip`]("x")', "if (false) it('x', f)", 'expect(x).toBe(x)', 'expect(!0).toBe(true)', 'expect.assertions(0)', "it.each([])('x')", 'return; // early', "self.skipTest('x')", "pytest.skip('x')", "describe.concurrent.skip('x')"]) {
      expect(one(line).tier, line).toBeUndefined();
      expect(one(line).reasons[0], line).toMatch(/an added line skips, focuses or empties a test/);
    }
    // Test-file-only patterns do not fire in source: an early return is ordinary code.
    expect(one('  return;', 'src/greet.ts').tier).toBe('small');
    expect(one("  it('adds', () => expect(sum(1, 2)).toBe(3));").tier).toBe('tests');
    // +200/-200 with the assertions swapped for padding: still gutted.
    const padded = [
      ...Array.from({ length: 3 }, (_, n) => ({ path: 'b/tests/a.test.ts', sign: '-' as const, text: `  expect(auth(${n})).toBe(false);` })),
      ...Array.from({ length: 3 }, () => ({ path: 'b/tests/a.test.ts', sign: '+' as const, text: '  // pad' })),
    ];
    const r = classifyChanges([file('tests/a.test.ts', 200, 200)], testsSmall, { patch: padded });
    expect(r.tier).toBeUndefined();
    expect(r.reasons[0]).toMatch(/lose\(s\) more lines \(or assertion lines\)/);
    // A rewritten assertion (one out, one in) is fine.
    expect(classifyChanges([file('tests/a.test.ts', 1, 1)], testsOnly, { patch: [{ ...padded[0] }, { path: 'b/tests/a.test.ts', sign: '+', text: '  expect(auth(0)).toBe(true);' }] }).tier).toBe('tests');
    // The patch parser keeps each line's file, deletions included.
    expect(patchLines('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n---- a/y\n'))
      .toEqual([{ path: 'b/x.ts', sign: '-', text: 'old' }, { path: 'b/x.ts', sign: '+', text: 'new' }, { path: 'a/t.test.ts', sign: '-', text: '--- a/y' }]);
  });

  it('L-d: projects, workspace, extends, foreign imports, computed loads and more runner keys keep the tests and small tiers off', () => {
    for (const [text, path] of [
      ["import base from '@repo/vitest-config'; export default defineConfig({ ...base })", 'vitest.config.ts'],
      ["export default defineConfig({ test: { projects: ['packages/*'] } })", 'vitest.config.ts'],
      ["export default defineConfig({ test: { workspace: ['packages/*'] } })", 'vitest.config.ts'],
      ["export default { test: { extends: './vitest.base.ts' } }", 'vitest.config.ts'],
      ["import base from 'src/vitest.base'; export default base", 'vitest.config.ts'],
      ["import base from '/abs/vitest.base'; export default base", 'vitest.config.ts'],
      ['const r = require(`${__dirname}/base`); module.exports = r', 'jest.config.js'],
      ["module.exports = require(path.join(__dirname, 'base'))", 'jest.config.js'],
      [JSON.stringify({ jest: { projects: ['<rootDir>/packages/*'], setupFiles: ['./s.js'] } }), 'package.json'],
    ] as const) {
      const s = baseTestSetup([{ path, text }]);
      expect(s.problem, text).toBeTruthy();
      expect(classifyChanges([file('tests/a.test.ts')], testsSmall, { testSetup: s }).tier, text).toBeUndefined();
    }
    expect(baseTestSetup([{ path: 'vitest.config.ts', text: "export default { test: { setupFiles: ['./a.ts'], pool: './tools/p.ts', typecheck: { checker: './tools/tc.ts' }, coverage: { provider: 'custom', customProviderModule: './tools/cov.ts' } } }" }]))
      .toEqual({ paths: ['./a.ts', './tools/p.ts', './tools/tc.ts', './tools/cov.ts'] });
    // vitest, vite and node builtins (and a JSDoc type import) stay readable.
    expect(baseTestSetup([{ path: 'vitest.config.ts', text: "import { defineConfig } from 'vitest/config';\nimport { resolve } from 'node:path';\n/** @type {import('vitest').UserConfig} */\nexport default defineConfig({ test: { setupFiles: ['./tests/setup.ts'] } })" }]))
      .toEqual({ paths: ['./tests/setup.ts'] });
  });

  it('L-e: git hook names at the repository root (core.hooksPath ".") fit no tier', () => {
    for (const p of ['post-merge', 'post-checkout', 'pre-commit', 'POST-MERGE', 'post-merge.', 'post-merge.exe', 'reference-transaction']) {
      expect(deniedPaths([p]), p).toEqual([p]);
      expect(classifyChanges([added(p)], all).tier, p).toBeUndefined();
    }
    expect(deniedPaths(['src/post-merge.ts', 'docs/pre-commit.md'])).toEqual([]);
  });
});

describe('autoMergeVerdict', () => {
  const ok: AutoMergeInput = {
    head: HEAD,
    config: all,
    run: { ciHeal: false, forgeKind: 'github', history: [{ note: 'implement' }] },
    decision: { ok: true, reasons: [], checks: ['Test', 'Lint'], blocking: [] },
    verdict: { sha: HEAD, verdict: 'approve', reviewer: 'factory-review' },
    human: { commentOnly: 0 },
    labels: ['factory'],
    changes: classifyChanges([file('docs/a.md')], all),
  };

  it('all conditions hold: ok with the tier and one evidence line per condition', () => {
    const v = autoMergeVerdict(ok);
    expect(v).toMatchObject({ ok: true, tier: 'docs', reasons: [] });
    expect(v.evidence.join('\n')).toMatch(/CI green at aaaaaaaaaaaa: `Test`, `Lint`/);
    expect(v.evidence.join('\n')).toMatch(/every file fits tier docs/);
    expect(autoMergeComment('issue #3', 'docs', HEAD, v.evidence, 'the factory')).toMatch(/^Factory run for issue #3: auto-merged by tier docs at aaaaaaaaaaaa/);
  });

  it('a benign earlier park (the human merge, a CI failure a fix round solved) does not block, and a required check that succeeded counts', () => {
    const history = [{ note: 'awaiting-human: merge: merge is a human step' }, { note: 'awaiting-human: ci-failed: Test failed' }];
    expect(autoMergeVerdict({ ...ok, run: { ...ok.run, history }, requiredChecks: ['Test'] })).toMatchObject({ ok: true, tier: 'docs' });
    // N6: with required checks set, a skipped non-required check (a docs-only path filter) does not block.
    expect(autoMergeVerdict({ ...ok, decision: { ok: true, reasons: [], checks: ['Test'], unsettled: ['Docs preview'], blocking: [] }, requiredChecks: ['Test'] })).toMatchObject({ ok: true });
  });

  it('forge-reported check names reach the park text and evidence only as sanitised code spans', () => {
    const evil = '[click](http://x.test) owner/repo#1 @user\nline2 | cell `tick`';
    const park = autoMergeVerdict({ ...ok, decision: { ok: true, reasons: [], checks: ['labeler'], unsettled: [evil], blocking: [] } }).reasons.join('\n');
    expect(park).toContain('`[click](http://x.test) owner/repo#1 ＠user line2 ¦ cell \'tick\'`');
    expect(park).not.toMatch(/[@|]|\n.*line2/);
    const good = autoMergeVerdict({ ...ok, decision: { ok: true, reasons: [], checks: [evil], blocking: [] } });
    expect(good.evidence.join('\n')).toContain('`[click](http://x.test) owner/repo#1 ＠user line2 ¦ cell \'tick\'` succeeded');
    // Decisions still use the raw names: the required check matches by its raw name.
    expect(autoMergeVerdict({ ...ok, decision: { ok: true, reasons: [], checks: [evil], blocking: [] }, requiredChecks: [evil] }).ok).toBe(true);
  });

  const fails: Array<[string, Partial<AutoMergeInput>, RegExp]> = [
    ['Azure DevOps', { run: { ...ok.run, forgeKind: 'azure-devops' } }, /Azure DevOps PRs always merge by a human/],
    ['ci-heal', { run: { ...ok.run, ciHeal: true } }, /ci-heal runs/],
    ['merge rule reason', { decision: { ok: false, reasons: ['PR is a draft'], checks: ['Test'] } }, /merge rule has reasons: PR is a draft/],
    ['verdict on another head', { verdict: { sha: OTHER, verdict: 'approve', reviewer: 'r' } }, /did not approve this exact head/],
    ['changes requested', { verdict: { sha: HEAD, verdict: 'changes-requested', reviewer: 'r' } }, /did not approve/],
    ['no verdict', { verdict: undefined }, /latest: none/],
    ['no CI configured', { decision: { ok: true, reasons: [], noChecks: true, checks: [] } }, /no CI check succeeded/],
    ['empty check list', { decision: { ok: true, reasons: [], checks: [] } }, /no CI check succeeded/],
    // M1: every check SKIPPED (paths-ignore on a docs PR): mergeDecision passes no succeeded check, so nothing counts.
    ['all checks skipped', { decision: { ok: true, reasons: [], checks: [] } }, /skipped, neutral or no checks never auto-merge/],
    // N6: no required checks and a labeler SUCCESS while the tests were SKIPPED: every check must succeed.
    ['labeler-only SUCCESS with skipped tests', { decision: { ok: true, reasons: [], checks: ['labeler'], unsettled: ['Test'] } }, /checks skipped or neutral on this head \(`Test`\); without required checks every check must succeed/],
    ['required check did not run', { decision: { ok: true, reasons: [], checks: ['Lint'] }, requiredChecks: ['Test'] }, /no required check \(`Test`\) succeeded/],
    // INFO: the history check is an allowlist: an unknown park keeps the merge human.
    ['unknown park in history', { run: { ...ok.run, history: [{ note: 'awaiting-human: some-future-park: why' }] } }, /parked at some-future-park/],
    ['human review off', { human: undefined }, /factory\.review\.human is "off"/],
    ['comment-only review', { human: { commentOnly: 1 } }, /1 comment-only human review/],
    ['manual-merge label', { labels: ['Factory:Manual-Merge'] }, new RegExp(`carries ${MANUAL_MERGE_LABEL}`)],
    ['labels unreadable', { labels: null }, /labels could not be read/],
    ['secret park', { run: { ...ok.run, history: [{ note: 'awaiting-human: secret-shaped-content: lane x: ...' }] } }, /parked at secret-shaped-content/],
    ['tamper hold', { run: { ...ok.run, history: [{ note: 'tamper hold released' }] } }, /tamper or quarantine/],
    ['unsandboxed lanes ack', { run: { ...ok.run, unsandboxedAck: HEAD } }, /--allow-unsandboxed-lanes/],
    ['unsandboxed gates ack', { run: { ...ok.run, unsandboxedGatesAck: HEAD } }, /--allow-unsandboxed-gates/],
    ['gate change ack', { run: { ...ok.run, gateChangeApproved: 'x' } }, /--allow-gate-change/],
    ['secret ack', { run: { ...ok.run, secretAck: [{}] } }, /--allow-secret-shapes/],
    ['allow flag in history', { run: { ...ok.run, history: [{ note: 'accepted (--allow-unsandboxed-lanes)' }] } }, /an --allow-\* flag/],
    ['tier miss', { changes: classifyChanges([file('package.json')], all) }, /always need a human/],
  ];
  for (const [name, over, reason] of fails) {
    it(`refuses: ${name}`, () => {
      const v = autoMergeVerdict({ ...ok, ...over });
      expect(v.ok).toBe(false);
      expect(v.tier).toBeUndefined();
      expect(v.reasons.join('\n')).toMatch(reason);
    });
  }
});

describe('the GitHub auto-merge shape and the factory guard', () => {
  const step = { repo: 'github.com/o/r', pr: 12, head: HEAD };
  const args = githubAutoMergeArgs(step)!;

  it('is a head-pinned REST merge without an admin bypass', () => {
    expect(args).toEqual(['api', '--hostname', 'github.com', '--method', 'PUT', 'repos/o/r/pulls/12/merge', '-f', `sha=${HEAD}`, '-f', 'merge_method=merge']);
    expect(githubAutoMergeArgs({ ...step, head: 'HEAD' })).toBeUndefined();
    expect(githubAutoMergeArgs({ ...step, repo: 'github.com/../r' })).toBeUndefined();
    expect(githubAutoMergeArgs({ ...step, pr: 0 })).toBeUndefined();
  });

  it('the guard admits it only inside the engine step for exactly that repository, PR and sha', () => {
    expect(isGithubAutoMergeArgs(args, step)).toBe(true);
    expect(isGithubAutoMergeArgs(args, undefined)).toBe(false);
    expect(isGithubAutoMergeArgs(args, { ...step, head: OTHER })).toBe(false);
    expect(isGithubAutoMergeArgs(args, { ...step, pr: 13 })).toBe(false);
    const ctx = (autoMerge?: { pr: number; head: string }) => ({ repo: 'github.com/o/r', ...(autoMerge ? { autoMerge } : {}) });
    expect(() => assertFactoryCommand('gh', args, [], undefined, undefined, undefined, undefined, ctx({ pr: 12, head: HEAD }))).not.toThrow();
    expect(() => assertFactoryCommand('gh', args, [], undefined, undefined, undefined, undefined, ctx())).toThrow(FactorySafetyError);
    expect(() => assertFactoryCommand('gh', args, [], undefined, undefined, undefined, undefined, ctx({ pr: 12, head: OTHER }))).toThrow(FactorySafetyError);
    // `gh pr merge` stays refused, in or out of the step.
    expect(() => assertFactoryCommand('gh', ['pr', 'merge', '12', '--admin', '--merge', '--match-head-commit', HEAD], [], undefined, undefined, undefined, undefined, ctx({ pr: 12, head: HEAD }))).toThrow(FactorySafetyError);
    // A variant with the admin bypass or another method is not the shape.
    const swapped = [...args];
    swapped[4] = 'POST';
    expect(() => assertFactoryCommand('gh', swapped, [], undefined, undefined, undefined, undefined, ctx({ pr: 12, head: HEAD }))).toThrow(FactorySafetyError);
  });

  it('the guard admits the two diff reads of the tier check and nothing wider', () => {
    const range = `${OTHER}...${HEAD}`;
    for (const flag of ['--raw', '--numstat']) {
      expect(() => assertFactoryCommand('git', ['diff', '--no-ext-diff', '--no-textconv', flag, '-z', '--no-renames', '--no-abbrev', range])).not.toThrow();
    }
    expect(() => assertFactoryCommand('git', ['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-renames', '--output=/tmp/x', range])).toThrow();
  });

  it('the guard admits the base root listing, the core.hooksPath read and the merge-commit read, exact shape only', () => {
    expect(() => assertFactoryCommand('git', ['ls-tree', '-z', '--name-only', OTHER])).not.toThrow();
    expect(() => assertFactoryCommand('git', ['ls-tree', '-z', '--name-only', 'HEAD'])).toThrow();
    expect(() => assertFactoryCommand('git', ['config', '--show-scope', '--get-all', 'core.hooksPath'])).not.toThrow();
    expect(() => assertFactoryCommand('git', ['config', '--show-scope', '--get-all', 'core.sshCommand'])).toThrow();
    const ctx = { repo: 'github.com/o/r' };
    const read = githubCommitReadArgs('github.com/o/r', HEAD)!;
    expect(read).toEqual(['api', '--hostname', 'github.com', `repos/o/r/commits/${HEAD}`]);
    expect(() => assertFactoryCommand('gh', read, [], undefined, undefined, undefined, undefined, ctx)).not.toThrow();
    expect(() => assertFactoryCommand('gh', githubCommitReadArgs('github.com/o/other', HEAD)!, [], undefined, undefined, undefined, undefined, ctx)).toThrow(FactorySafetyError);
    expect(() => assertFactoryCommand('gh', [...read, '--method', 'POST'], [], undefined, undefined, undefined, undefined, ctx)).toThrow(FactorySafetyError);
  });
});
