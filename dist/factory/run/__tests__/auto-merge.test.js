/**
 * Opt-in auto-merge (auto-merge.ts): the user-config resolver, the tier
 * classifier, every condition of the verdict, and the guard's one admitted
 * GitHub merge shape. Pure: no git, no gh.
 */
import { describe, expect, it } from 'vitest';
import { githubAutoMergeArgs, githubCommitReadArgs, isGithubAutoMergeArgs } from '../../../forge/github/merge.js';
import { assertFactoryCommand, FactorySafetyError } from '../exec.js';
import { autoMergeComment, autoMergeVerdict, baseTestSetup, classifyChanges, committedMergeConfig, deniedPaths, isDocsPath, isTestPath, MANUAL_MERGE_LABEL, parseChangedEntries, resolveAutoMergeConfig, } from '../auto-merge.js';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const URL = 'https://github.com/o/r';
const ROOT = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const userWith = (auto) => ({ factory: { merge: { auto } } });
const gh = { url: URL, root: ROOT, local: false };
const file = (path, added = 1, deleted = 0, mode = '100644') => ({ path, status: 'M', oldMode: mode, newMode: mode, added, deleted });
const gone = (path, deleted = 5) => ({ path, status: 'D', oldMode: '100644', newMode: '000000', added: 0, deleted });
const added = (path, lines = 5) => ({ path, status: 'A', oldMode: '000000', newMode: '100644', added: lines, deleted: 0 });
const all = { enabled: true, tiers: ['docs', 'tests', 'small'] };
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
    const raw = (rows) => rows.map(([o, n, s, p]) => `:${o} ${n} ${'1'.repeat(40)} ${'2'.repeat(40)} ${s}\0${p}\0`).join('');
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
        expect(isDocsPath('src/x/NOTES.MD')).toBe(true);
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
        expect(classifyChanges([file('a.md'), file('b.md')], { enabled: true, tiers: ['docs'], maxFiles: 1 }).reasons[0]).toMatch(/2 files > maxFiles 1/);
        expect(classifyChanges(null, all).reasons[0]).toMatch(/fails closed/);
        expect(classifyChanges([], all).reasons[0]).toMatch(/changes no file/);
    });
    it('adversarial: a docs-only PR with a symlink, an executable bit, a gitlink or a binary never fits', () => {
        expect(classifyChanges([file('docs/a.md'), { ...file('docs/link.md'), oldMode: '000000', newMode: '120000' }], all).reasons[0]).toMatch(/non-plain file modes.*docs\/link\.md 000000->120000/);
        expect(classifyChanges([{ ...file('docs/run.md'), newMode: '100755' }], all).reasons[0]).toMatch(/non-plain/);
        expect(classifyChanges([{ ...file('docs/sub'), oldMode: '000000', newMode: '160000' }], all).reasons[0]).toMatch(/non-plain/);
        expect(classifyChanges([file('docs/a.png', null, null)], all).reasons[0]).toMatch(/binary/);
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
    const docsOnly = { enabled: true, tiers: ['docs'] };
    const testsOnly = { enabled: true, tiers: ['tests'] };
    const smallOnly = { enabled: true, tiers: ['small'] };
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
        const cfg = { ...docsOnly, docsDenied: ['docs/security/', 'RUNBOOK.md'] };
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
        for (const p of ['src/ship/merge.ts', 'src/copilot-run/sandbox.ts', 'src/forge/github/merge.ts', 'SRC/Factory/x.ts'])
            expect(classifyChanges([file(p)], smallOnly).tier, p).toBeUndefined();
        expect(classifyChanges([file('src/greet.ts', 3, 2)], smallOnly).tier).toBe('small');
    });
    it('INFO: user securityCritical globs apply to every tier', () => {
        const cfg = { ...all, securityCritical: ['src/auth/**', '*.guard.ts', 'docs/SECURITY.md'] };
        for (const p of ['src/auth/token.ts', 'src/x/admin.guard.ts', 'docs/SECURITY.md'])
            expect(classifyChanges([file(p)], cfg).reasons[0], p).toMatch(/always need a human/);
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
describe('autoMergeVerdict', () => {
    const ok = {
        head: HEAD,
        config: all,
        run: { ciHeal: false, forgeKind: 'github', history: [{ note: 'implement' }] },
        decision: { ok: true, reasons: [], checks: ['Test', 'Lint'] },
        verdict: { sha: HEAD, verdict: 'approve', reviewer: 'factory-review' },
        human: { commentOnly: 0 },
        labels: ['factory'],
        changes: classifyChanges([file('docs/a.md')], all),
    };
    it('all conditions hold: ok with the tier and one evidence line per condition', () => {
        const v = autoMergeVerdict(ok);
        expect(v).toMatchObject({ ok: true, tier: 'docs', reasons: [] });
        expect(v.evidence.join('\n')).toMatch(/CI green at aaaaaaaaaaaa: Test, Lint/);
        expect(v.evidence.join('\n')).toMatch(/every file fits tier docs/);
        expect(autoMergeComment('issue #3', 'docs', HEAD, v.evidence, 'the factory')).toMatch(/^Factory run for issue #3: auto-merged by tier docs at aaaaaaaaaaaa/);
    });
    it('a benign earlier park (the human merge, a CI failure a fix round solved) does not block, and a required check that succeeded counts', () => {
        const history = [{ note: 'awaiting-human: merge: merge is a human step' }, { note: 'awaiting-human: ci-failed: Test failed' }];
        expect(autoMergeVerdict({ ...ok, run: { ...ok.run, history }, requiredChecks: ['Test'] })).toMatchObject({ ok: true, tier: 'docs' });
    });
    const fails = [
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
        ['required check did not run', { decision: { ok: true, reasons: [], checks: ['Lint'] }, requiredChecks: ['Test'] }, /no required check \(Test\) succeeded/],
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
    const args = githubAutoMergeArgs(step);
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
        const ctx = (autoMerge) => ({ repo: 'github.com/o/r', ...(autoMerge ? { autoMerge } : {}) });
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
        const read = githubCommitReadArgs('github.com/o/r', HEAD);
        expect(read).toEqual(['api', '--hostname', 'github.com', `repos/o/r/commits/${HEAD}`]);
        expect(() => assertFactoryCommand('gh', read, [], undefined, undefined, undefined, undefined, ctx)).not.toThrow();
        expect(() => assertFactoryCommand('gh', githubCommitReadArgs('github.com/o/other', HEAD), [], undefined, undefined, undefined, undefined, ctx)).toThrow(FactorySafetyError);
        expect(() => assertFactoryCommand('gh', [...read, '--method', 'POST'], [], undefined, undefined, undefined, undefined, ctx)).toThrow(FactorySafetyError);
    });
});
//# sourceMappingURL=auto-merge.test.js.map