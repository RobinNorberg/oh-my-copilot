import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveShipConfig } from '../../ship/config.js';
import { defaultReleaseExec, PHASES, readReleaseState, releaseStatePath, resumePoint, runRelease, } from '../engine.js';
const V = '5.12.2';
const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const TAGOBJ = '4'.repeat(40);
const OTHER = '5'.repeat(40);
const DEVMERGE = '6'.repeat(40);
const PR_URL = 'https://github.com/RobinNorberg/oh-my-copilot/pull/301';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const no = (stderr = 'failed', status = 1) => ({ status, stdout: '', stderr });
describe('omg release engine (scripted git/gh/npm, no network)', () => {
    let root;
    let stateRoot;
    let calls;
    let events;
    let logs;
    let handlers;
    let confirmAnswer;
    let confirms;
    let shipBlock;
    const exec = (cmd, args) => {
        const key = `${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`;
        calls.push(key);
        for (const h of handlers) {
            const r = h(key, args);
            if (r)
                return r;
        }
        return ok();
    };
    const deps = () => ({
        exec,
        root,
        stateRoot,
        node: process.execPath,
        loadShipConfig: () => resolveShipConfig(shipBlock),
        progress: (e) => events.push(e),
        log: (l) => logs.push(l),
        confirm: async (q) => { confirms.push(q); return confirmAnswer; },
        sleep: async () => { },
        now: () => Date.parse('2026-10-21T12:00:00Z'),
    });
    const release = (opts = {}) => runRelease(deps(), { version: V, ...opts });
    function write(rel, content) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
    function okPhases(okThrough) {
        const phases = {};
        for (const id of PHASES.slice(0, PHASES.indexOf(okThrough) + 1))
            phases[id] = { status: 'ok', note: 'seeded', at: '2026-10-21T11:00:00Z' };
        return phases;
    }
    /** A state whose phases through `okThrough` passed, with the facts those phases leave behind (bumped package.json, release commit). */
    function seedState(okThrough, extra = {}) {
        const through = PHASES.indexOf(okThrough);
        if (through >= PHASES.indexOf('bump'))
            write('package.json', JSON.stringify({ name: 'oh-my-copilot', version: V }));
        const facts = {
            ...(through >= PHASES.indexOf('commit') ? { headSha: HEAD } : {}),
            ...(through >= PHASES.indexOf('suite') ? { suiteSha: HEAD } : {}),
        };
        mkdirSync(join(stateRoot, 'release'), { recursive: true });
        writeFileSync(releaseStatePath(stateRoot, V), JSON.stringify({ version: 1, release: V, createdAt: 'x', updatedAt: 'x', phases: okPhases(okThrough), reruns: {}, ...facts, ...extra }));
    }
    const prJson = (number, base, state, merge, head = HEAD) => JSON.stringify({
        number, state, isDraft: false, baseRefName: base, baseRefOid: BASE, headRefOid: head, url: PR_URL, mergeCommit: merge ? { oid: merge } : null,
    });
    /** The release PR merged into dev at DEVMERGE, the promotion into main at MERGE, whose package.json is the release. */
    const landed = (key) => {
        if (key.startsWith('gh pr view 301 --json'))
            return ok(prJson(301, 'dev', 'MERGED', DEVMERGE));
        if (key.startsWith('gh pr view 302 --json'))
            return ok(prJson(302, 'main', 'MERGED', MERGE));
        if (key === `git show ${MERGE}:package.json`)
            return ok(`{"version":"${V}"}`);
        return undefined;
    };
    const landedState = { devPr: 301, devMergeSha: DEVMERGE, mainPr: 302, mainMergeSha: MERGE };
    /** Run attempts: `gh run rerun` starts attempt n+1 after `delay` further views. */
    function attempts(delay = 0) {
        return (key, args) => {
            if (!/^gh run view \d+ --json attempt$/.test(key))
                return undefined;
            const rerun = `gh run rerun ${args[2]} --failed`;
            const reruns = calls.filter((c) => c === rerun).length;
            const viewsSince = calls.slice(calls.lastIndexOf(rerun) + 1).filter((c) => c === key).length;
            return ok(JSON.stringify({ attempt: reruns > 0 && viewsSince > delay ? 1 + reruns : Math.max(1, reruns) }));
        };
    }
    /** A preflight that passes: clean tree on release/v5.12.2 over origin/dev 5.12.1. */
    const preflightOk = (key) => {
        if (key === 'git status --porcelain')
            return ok('');
        if (key === 'git rev-parse --abbrev-ref HEAD')
            return ok(`release/v${V}\n`);
        if (key === 'git show refs/remotes/origin/dev:package.json')
            return ok('{"version":"5.12.1"}');
        if (key === 'npm view oh-my-copilot dist-tags.latest')
            return ok('5.12.1\n');
        if (key === 'git rev-parse --git-path index.lock')
            return ok('.git/index.lock\n');
        if (key.startsWith('git ls-remote --tags origin refs/tags/v'))
            return ok('');
        return undefined;
    };
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'omg-release-'));
        stateRoot = join(root, '.omg');
        calls = [];
        events = [];
        logs = [];
        handlers = [];
        confirmAnswer = false;
        confirms = [];
        shipBlock = { allowAdminMerge: true, requiredChecks: ['Test'] };
        write('package.json', JSON.stringify({ name: 'oh-my-copilot', version: '5.12.1' }));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });
    describe('dry run', () => {
        it('prints every phase in order and runs nothing', async () => {
            const result = await release({ dryRun: true });
            expect(calls).toEqual([]);
            expect(events).toEqual([]);
            expect(existsSync(releaseStatePath(stateRoot, V))).toBe(false);
            expect(result.phases.map((p) => p.id)).toEqual([...PHASES]);
            expect(result.phases.every((p) => p.status === 'planned' && (p.steps?.length ?? 0) > 0)).toBe(true);
            expect(result.phases.find((p) => p.id === 'smoke').steps[0]).toMatch(/^SKIPPED/);
        });
        it('plans only the --from..--to range', async () => {
            const result = await release({ dryRun: true, from: 'tag', to: 'verify', yes: true });
            expect(result.phases.map((p) => p.id)).toEqual(['tag', 'verify']);
            expect(result.phases[0].steps.join('\n')).toContain('--yes given');
            expect(calls).toEqual([]);
        });
    });
    describe('phase ordering and resume', () => {
        it('resumes at the first phase not yet ok', () => {
            expect(resumePoint(null)).toBe('preflight');
            const state = { phases: { preflight: { status: 'ok' }, bump: { status: 'ok' }, build: { status: 'fail' } } };
            expect(resumePoint(state)).toBe('build');
            expect(resumePoint(state, 'preflight')).toBe('preflight');
        });
        it('runs phases in order, records each, and a later run resumes after them', async () => {
            write('CHANGELOG.md', `# oh-my-copilot v${V}\n\n## [${V}] - 2026-10-22\n`);
            write('.github/release-body.md', `v${V} fixes things`);
            write('.claude-plugin/plugin.json', '{\n  "version": "5.12.1"\n}\n');
            write('plugin.json', '{\n  "version": "5.12.1"\n}\n');
            write('.claude-plugin/marketplace.json', '{"plugins":[{"version": "5.12.1"}],\n"version": "5.12.1"}\n');
            for (const f of ['docs/CLAUDE.md', 'CLAUDE.md', '.github/CLAUDE.md', 'tests/fixtures/prompt-projection/claude-managed-block.golden']) {
                write(f, 'head\n<!-- OMC:VERSION:5.12.1 -->\nbody\n');
            }
            write('.github/upstream-port.json', '{\n  "upstream_sha": "abc",\n  "fork_version": "5.12.1"\n}\n');
            handlers.push(preflightOk);
            const first = await release({ to: 'bump' });
            expect(first.ok).toBe(true);
            expect(events.map((e) => `${e.phase}:${e.status}`)).toEqual(['preflight:start', 'preflight:ok', 'bump:start', 'bump:ok', 'release:done']);
            expect(calls).toContain(`npm version ${V} --no-git-tag-version --ignore-scripts --allow-same-version`);
            expect(calls).toContain('node scripts/generate-prompt-projections.mjs');
            expect(readFileSync(join(root, 'docs/CLAUDE.md'), 'utf8')).toContain(`<!-- OMC:VERSION:${V} -->`);
            expect(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8').match(new RegExp(`"version": "${V}"`, 'g'))).toHaveLength(2);
            expect(readFileSync(join(root, '.github/upstream-port.json'), 'utf8')).toContain(`"fork_version": "${V}"`);
            const state = readReleaseState(stateRoot, V);
            expect(Object.keys(state.phases)).toEqual(['preflight', 'bump']);
            // Nothing past --to bump is left: a second run with the same range does nothing.
            calls = [];
            const again = await release({ to: 'bump' });
            expect(again.phases).toEqual([]);
            expect(calls).toEqual([]);
        });
        it('stops at the first failing phase and resumes there', async () => {
            seedState('build');
            handlers.push((key) => (key === 'node node_modules/typescript/bin/tsc --noEmit' ? no('error TS2322: bad') : undefined));
            const result = await release({ to: 'commit' });
            expect(result.ok).toBe(false);
            expect(result.phases.map((p) => `${p.id}:${p.status}`)).toEqual(['gates:fail']);
            expect(result.phases[0].details).toContain('error TS2322: bad');
            expect(calls.some((c) => c.startsWith('git commit'))).toBe(false);
            expect(resumePoint(readReleaseState(stateRoot, V))).toBe('gates');
        });
        it('refuses --from past a phase that never passed', async () => {
            seedState('gates');
            const result = await release({ from: 'commit', to: 'commit' });
            expect(result.phases).toEqual([expect.objectContaining({ id: 'commit', status: 'blocked' })]);
            expect(result.phases[0].details).toContain('smoke: has not passed (run it: --from smoke)');
            expect(calls.some((c) => c.startsWith('git commit') || c.startsWith('git add'))).toBe(false);
        });
        it('refuses a resume on another branch or a HEAD that does not descend from the release commit, unless --from preflight', async () => {
            seedState('suite', { branch: `release/v${V}` });
            handlers.push((key) => (key === 'git rev-parse --abbrev-ref HEAD' ? ok('feat/other\n') : undefined));
            const onOther = await release({ to: 'pr' });
            expect(onOther.phases[0]).toMatchObject({ id: 'pr', status: 'blocked' });
            expect(onOther.phases[0].details).toContain(`state: HEAD is feat/other, but this release state was recorded on release/v${V}`);
            handlers = [(key) => (key === `git merge-base --is-ancestor ${HEAD} HEAD` ? no('', 1) : undefined), preflightOk];
            const unrelated = await release({ to: 'pr' });
            expect(unrelated.phases[0].details).toContain('state: HEAD does not descend from the recorded release commit 111111111111');
            expect(calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr'))).toBe(false);
            const over = await release({ from: 'preflight', to: 'preflight' });
            expect(over.ok).toBe(true);
            expect(readReleaseState(stateRoot, V)).toMatchObject({ branch: `release/v${V}` });
            expect(readReleaseState(stateRoot, V).headSha).toBeUndefined();
        });
        it('a fresh start at preflight forgets the PRs, merges and tag run of an earlier release attempt', async () => {
            seedState('verify', { ...landedState, tagRunId: 901, branch: `release/v${V}` });
            handlers.push(preflightOk);
            const result = await release({ from: 'preflight', to: 'preflight' });
            expect(result.ok).toBe(true);
            const state = readReleaseState(stateRoot, V);
            for (const key of ['devPr', 'devMergeSha', 'mainPr', 'mainMergeSha', 'tagRunId', 'headSha'])
                expect(state[key]).toBeUndefined();
        });
        it('refuses to skip past commit when HEAD moved off the release commit: new commits go back through the gates', async () => {
            seedState('pr', { devPr: 301, devMergeSha: DEVMERGE });
            handlers.push((key) => (key === 'git rev-parse HEAD' ? ok(`${OTHER}\n`) : undefined), landed);
            const result = await release({ from: 'promote', to: 'promote' });
            expect(result.phases[0]).toMatchObject({ id: 'promote', status: 'blocked' });
            expect(result.phases[0].details).toContain('commit: HEAD 555555555555 is not the recorded release commit 111111111111; new local commits must go back through the gates and the suite (--from gates)');
        });
        it('refuses to skip pr when the recorded dev merge does not contain the release commit', async () => {
            seedState('pr', { devPr: 301, devMergeSha: DEVMERGE });
            handlers.push((key) => {
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                if (key === `git merge-base --is-ancestor ${HEAD} ${DEVMERGE}`)
                    return no('', 1);
                return undefined;
            }, landed);
            const result = await release({ from: 'promote', to: 'promote' });
            expect(result.phases[0]).toMatchObject({ id: 'promote', status: 'blocked' });
            expect(result.phases[0].details).toContain('pr: the dev merge 666666666666 does not contain the release commit 111111111111 (--from pr)');
            expect(calls).toContain('git fetch origin dev');
        });
        it('reports a git error from merge-base (missing object) as an error, never as "does not contain"', async () => {
            seedState('pr', { devPr: 301, devMergeSha: DEVMERGE });
            handlers.push((key) => {
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                if (key === `git merge-base --is-ancestor ${HEAD} ${DEVMERGE}`)
                    return no(`fatal: Not a valid commit name ${DEVMERGE}\n`, 128);
                return undefined;
            }, landed);
            const result = await release({ from: 'promote', to: 'promote' });
            expect(result.phases[0]).toMatchObject({ id: 'promote', status: 'blocked' });
            expect(result.phases[0].details).toContain(`pr: git merge-base --is-ancestor ${HEAD} ${DEVMERGE} failed (exit 128): fatal: Not a valid commit name ${DEVMERGE}`);
            expect(result.phases[0].details.join('\n')).not.toMatch(/does not contain/);
        });
    });
    describe('preflight refusals', () => {
        it('collects every problem and never deletes the index lock', async () => {
            write('.git/index.lock', '');
            handlers.push((key) => {
                if (key === 'git status --porcelain')
                    return ok(' M CHANGELOG.md\n M src/x.ts\n?? stray.txt\n');
                if (key === 'git rev-parse --abbrev-ref HEAD')
                    return ok('feat/other\n');
                if (key === 'git merge-base --is-ancestor refs/remotes/origin/dev HEAD')
                    return no('', 1);
                if (key === 'git show refs/remotes/origin/dev:package.json')
                    return ok(`{"version":"${V}"}`);
                if (key === 'npm view oh-my-copilot dist-tags.latest')
                    return ok('5.13.0\n');
                if (key === 'gh auth status')
                    return no('not logged in');
                if (key === 'git rev-parse --git-path index.lock')
                    return ok('.git/index.lock\n');
                if (key.startsWith('git ls-remote --tags origin'))
                    return ok(`${TAGOBJ}\trefs/tags/v${V}\n`);
                return undefined;
            });
            const result = await release({ to: 'preflight' });
            expect(result.ok).toBe(false);
            const details = result.phases[0].details.join('\n');
            expect(details).toContain('working tree is not clean: src/x.ts, stray.txt');
            expect(details).not.toContain('CHANGELOG.md');
            expect(details).toContain('HEAD is feat/other, expected release/v5.12.2');
            expect(details).toContain('HEAD does not contain origin/dev');
            expect(details).toContain(`${V} is not above origin/dev's version ${V}`);
            expect(details).toContain(`${V} is not above npm latest 5.13.0`);
            expect(details).toContain('gh is not authenticated');
            expect(details).toMatch(/index\.lock exists; another git process may hold it \(not deleted/);
            expect(details).toContain(`tag v${V} already exists on origin`);
            expect(existsSync(join(root, '.git', 'index.lock'))).toBe(true);
            expect(events.at(-1)).toMatchObject({ phase: 'preflight', status: 'fail' });
        });
        it('treats an unpublished package (E404) as no npm latest', async () => {
            handlers.push((key) => (key === 'npm view oh-my-copilot dist-tags.latest' ? no('npm error code E404') : undefined), preflightOk);
            expect((await release({ to: 'preflight' })).ok).toBe(true);
        });
        it('accepts a staged rename only when both sides are prose files', async () => {
            handlers.push((key) => (key === 'git status --porcelain' ? ok('R  README.md -> docs/REFERENCE.md\nR  src/x.ts -> CHANGELOG.md\n') : undefined), preflightOk);
            const result = await release({ to: 'preflight' });
            expect(result.phases[0].details).toEqual(['working tree is not clean: src/x.ts -> CHANGELOG.md']);
        });
    });
    describe('bump', () => {
        it('refuses before touching anything when the release prose is missing', async () => {
            seedState('preflight');
            write('CHANGELOG.md', '# Changelog\n');
            const result = await release({ to: 'bump' });
            expect(result.ok).toBe(false);
            expect(result.phases[0].note).toMatch(/release prose is missing/);
            expect(calls).toEqual([]);
        });
    });
    describe('build: orphans, untracked files, probes', () => {
        beforeEach(() => {
            seedState('bump');
            write('src/kept.ts', '');
            handlers.push((key) => {
                if (key === 'git ls-files dist')
                    return ok('dist/kept.js\ndist/kept.d.ts\ndist/gone.js\ndist/gone.js.map\n');
                if (key === 'node dist/cli/index.js --version' || key === 'node bridge/cli.cjs --version')
                    return ok(`${V}\n`);
                return undefined;
            });
        });
        it('fails with the orphan list unless --fix-orphans', async () => {
            const result = await release({ to: 'build' });
            expect(result.ok).toBe(false);
            expect(result.phases[0].details).toEqual(['dist/gone.js', 'dist/gone.js.map']);
            expect(calls.some((c) => c.startsWith('git rm'))).toBe(false);
        });
        it('removes orphans with --fix-orphans and runs the probes', async () => {
            const result = await release({ to: 'build', fixOrphans: true });
            expect(result.ok).toBe(true);
            expect(calls).toContain('git rm -q -- dist/gone.js dist/gone.js.map');
            expect(calls).toContain('npm run build');
            expect(calls).toContain('git add -f dist bridge');
            expect(calls).toContain('node dist/mcp/standalone-server.js');
            expect(calls.some((c) => c.startsWith('node --input-type=module -e'))).toBe(true);
        });
        it('fails on untracked dist/bridge files and a wrong --version', async () => {
            handlers.unshift((key) => {
                if (key === 'git ls-files --others dist bridge')
                    return ok('dist/new.js\n');
                if (key === 'node bridge/cli.cjs --version')
                    return ok('5.12.1\n');
                return undefined;
            });
            const result = await release({ to: 'build', fixOrphans: true });
            expect(result.phases[0].note).toMatch(/untracked files/);
            expect(result.phases[0].details).toEqual(['dist/new.js']);
        });
    });
    describe('suite', () => {
        it('runs after the commit phase, never in gates', async () => {
            seedState('build');
            const gates = await release({ to: 'gates', suite: 'full' });
            expect(gates.ok).toBe(true);
            expect(calls.some((c) => c.includes('vitest'))).toBe(false);
            expect(PHASES.indexOf('suite')).toBe(PHASES.indexOf('commit') + 1);
        });
        it('--suite full never reads a stale report left by an earlier run', async () => {
            seedState('commit');
            handlers.push((key) => (key === 'git rev-parse HEAD' ? ok(HEAD) : undefined));
            const report = join(stateRoot, 'release', `${V}-vitest.json`);
            mkdirSync(dirname(report), { recursive: true });
            writeFileSync(report, JSON.stringify({ testResults: [] }));
            const result = await release({ from: 'suite', to: 'suite', suite: 'full' });
            expect(result.phases[0]).toMatchObject({ status: 'fail', note: expect.stringMatching(/vitest wrote no JSON report/) });
        });
        it('a suite recorded for an earlier HEAD does not let pr be skipped', async () => {
            seedState('suite', { suiteSha: OTHER });
            handlers.push((key) => (key === 'git rev-parse HEAD' ? ok(HEAD) : undefined));
            const result = await release({ from: 'pr', to: 'pr' });
            expect(result.phases[0]).toMatchObject({ id: 'pr', status: 'blocked' });
            expect(result.phases[0].details).toContain('suite: the suite did not run on the recorded release commit (--from suite)');
        });
    });
    describe('smoke', () => {
        it('is skipped loudly without --live-smoke', async () => {
            seedState('gates');
            const result = await release({ to: 'smoke' });
            expect(result.phases).toEqual([expect.objectContaining({ id: 'smoke', status: 'skipped' })]);
            expect(logs.join('\n')).toMatch(/SKIPPED the live Tier 2 smoke/);
            expect(calls).toEqual([]);
        });
        it('requires every check green with --live-smoke', async () => {
            seedState('gates');
            handlers.push((key) => (key === 'node bridge/cli.cjs smoke copilot --tier 2 --json'
                ? { status: 1, stdout: '{"ok":false,"checks":[{"id":"scn.guardrail","ok":false,"detail":"not denied"}]}', stderr: '' }
                : undefined));
            const result = await release({ to: 'smoke', liveSmoke: true });
            expect(result.phases[0]).toMatchObject({ status: 'fail', details: ['scn.guardrail: not denied'] });
        });
    });
    describe('commit', () => {
        it('commits the release, then the inventory last, and requires a clean tree', async () => {
            seedState('smoke');
            let inventoryWritten = false;
            handlers.push((key) => {
                if (key === 'git diff --cached --quiet')
                    return no('', 1);
                if (key === 'node scripts/generate-inventory-graph.mjs --write') {
                    inventoryWritten = true;
                    return ok();
                }
                if (key === 'git diff --cached --quiet -- inventory')
                    return inventoryWritten ? no('', 1) : ok();
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                return undefined;
            });
            const result = await release({ to: 'commit' });
            expect(result.ok).toBe(true);
            const order = ['git commit -m chore(release): v5.12.2', 'node scripts/generate-inventory-graph.mjs --write', 'git commit -m chore(release): regenerate inventory for v5.12.2 -- inventory', 'node scripts/generate-inventory-graph.mjs --verify', 'git status --porcelain'];
            expect(order.map((c) => calls.indexOf(c))).toEqual([...order.map((c) => calls.indexOf(c))].sort((a, b) => a - b));
            expect(order.every((c) => calls.includes(c))).toBe(true);
            expect(readReleaseState(stateRoot, V).headSha).toBe(HEAD);
        });
    });
    describe('pr: the ship merge rule with a config-driven allow-list', () => {
        const checks = (advisoryState, testState = 'SUCCESS') => JSON.stringify([
            { name: 'Test', state: testState, link: 'https://github.com/o/r/actions/runs/77/job/88' },
            { name: 'No Committed Build Artifacts', state: advisoryState, link: 'https://github.com/o/r/actions/runs/77/job/89' },
            { name: 'Authorize generated artifacts from base trust root', state: advisoryState, link: 'https://github.com/o/r/actions/runs/78/job/90' },
        ]);
        let prState;
        let prHead;
        let checksJson;
        beforeEach(() => {
            seedState('suite');
            prState = 'OPEN';
            prHead = HEAD;
            checksJson = checks('FAILURE');
            handlers.push(attempts(), (key) => {
                if (key.startsWith('gh pr list --head release/v5.12.2 --base dev'))
                    return ok('[]');
                if (key.startsWith('gh pr create --base dev'))
                    return ok(`${PR_URL}\n`);
                if (key.startsWith('gh pr view 301 --json number,state'))
                    return ok(prJson(301, 'dev', prState, prState === 'MERGED' ? MERGE : null, prHead));
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                if (key === 'gh pr view 301 --json headRefOid')
                    return ok(JSON.stringify({ headRefOid: prHead }));
                if (key.startsWith('gh pr checks 301'))
                    return ok(checksJson);
                if (key.startsWith(`gh run list --commit ${prHead}`))
                    return ok('[{"databaseId":77,"status":"completed","conclusion":"failure","workflowName":"CI"}]');
                if (key.startsWith('gh pr merge 301')) {
                    prState = 'MERGED';
                    return ok();
                }
                if (key === 'gh run view --job 88 --log')
                    return ok('Test\tRun tests\t2026-10-21T12:00:00.000Z  FAIL  src/a.test.ts > suite > breaks\n');
                return undefined;
            });
        });
        it('merges when only the allow-listed red-by-design checks fail', async () => {
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(true);
            expect(calls).toContain('git push origin HEAD:refs/heads/release/v5.12.2');
            expect(calls).toContain(`gh pr merge 301 --admin --merge --match-head-commit ${HEAD}`);
            expect(readReleaseState(stateRoot, V)).toMatchObject({ devPr: 301, devMergeSha: MERGE });
            expect(events.some((e) => e.phase === 'pr' && e.status === 'heartbeat')).toBe(true);
        });
        it('pushes again on a re-run while the PR is open, and blocks on a refused push without forcing', async () => {
            seedState('suite', { devPr: 301 });
            handlers.unshift((key) => (key === 'git push origin HEAD:refs/heads/release/v5.12.2' ? no('! [rejected] HEAD -> release/v5.12.2 (fetch first)') : undefined));
            const result = await release({ to: 'pr' });
            expect(calls).toContain('git push origin HEAD:refs/heads/release/v5.12.2');
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/never force: git fetch origin release\/v5\.12\.2 && git merge/) });
            expect(calls.some((c) => c.includes('--force') || c.startsWith('gh pr merge'))).toBe(false);
        });
        it('refuses to merge a PR whose head is not local HEAD', async () => {
            prHead = OTHER;
            const result = await release({ to: 'pr' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/head is 555555555555, not local HEAD 111111111111/) });
            expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
        });
        it('waits for the rerun attempt to start before re-reading the checks', async () => {
            shipBlock = { ...shipBlock, advisoryChecks: [] };
            handlers.unshift(attempts(2));
            await release({ to: 'pr' });
            const rerun = calls.indexOf('gh run rerun 77 --failed');
            const nextChecks = calls.findIndex((c, i) => i > rerun && c.startsWith('gh pr checks 301'));
            const views = calls.slice(rerun, nextChecks).filter((c) => c === 'gh run view 77 --json attempt');
            expect(rerun).toBeGreaterThan(-1);
            expect(views).toHaveLength(3);
        });
        it('blocks when a rerun attempt never starts', async () => {
            shipBlock = { ...shipBlock, advisoryChecks: [] };
            handlers.unshift((key) => (key === 'gh run view 77 --json attempt' ? ok('{"attempt":1}') : undefined));
            const result = await release({ to: 'pr' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/run 77 was rerun but attempt 2 has not started/) });
            expect(calls.filter((c) => c.startsWith('gh run rerun'))).toEqual(['gh run rerun 77 --failed']);
        });
        it('treats the same checks as failures when the config allow-list omits them: one rerun, then the failing titles', async () => {
            shipBlock = { ...shipBlock, advisoryChecks: [] };
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(false);
            expect(calls.filter((c) => c.startsWith('gh run rerun'))).toEqual(['gh run rerun 77 --failed', 'gh run rerun 78 --failed']);
            expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
            expect(result.phases[0].note).toMatch(/after the one automatic rerun/);
            expect(readReleaseState(stateRoot, V).reruns).toEqual({ 77: 1, 78: 1 });
        });
        it('names the failing tests of a real failure', async () => {
            checksJson = checks('FAILURE', 'FAILURE');
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(false);
            expect(result.phases[0].details).toContain('  Test: src/a.test.ts > suite > breaks');
            expect(calls.filter((c) => c === 'gh run rerun 77 --failed')).toHaveLength(1);
        });
        it('prints the merge command instead of merging without ship.allowAdminMerge', async () => {
            shipBlock = { ...shipBlock, allowAdminMerge: false };
            const result = await release({ to: 'pr' });
            expect(result.phases[0].status).toBe('blocked');
            expect(result.phases[0].details).toEqual([`gh pr merge 301 --admin --merge --match-head-commit ${HEAD}`]);
            expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
        });
        it('re-run after the owner merged picks the merge commit up without pushing again', async () => {
            seedState('suite', { devPr: 301 });
            prState = 'MERGED';
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(true);
            expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
        });
        it('blocks on an already-merged release PR whose merge does not contain local HEAD, with a follow-up PR route', async () => {
            seedState('suite', { devPr: 301 });
            prState = 'MERGED';
            prHead = OTHER;
            handlers.unshift((key) => (key === `git merge-base --is-ancestor ${HEAD} ${MERGE}` || key === `git merge-base --is-ancestor ${HEAD} refs/remotes/origin/dev` ? no('', 1) : undefined));
            const result = await release({ to: 'pr' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/The release PR #301 is merged at 333333333333 without commit\(s\) up to 111111111111\. Open a follow-up PR into dev for the extra commits and re-run omg release 5\.12\.2 --from pr after it merges/) });
            expect(result.phases[0].note).not.toMatch(/--from preflight/);
            expect(calls).toContain('git fetch origin dev');
            expect(calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr merge') || c.startsWith('gh pr create'))).toBe(false);
            expect(readReleaseState(stateRoot, V).devMergeSha).toBeUndefined();
        });
        it('accepts the merged release PR once a follow-up PR into dev carried the missing commits: the dev tip is the dev merge', async () => {
            seedState('suite', { devPr: 301 });
            prState = 'MERGED';
            handlers.unshift((key) => {
                if (key === `git merge-base --is-ancestor ${HEAD} ${MERGE}`)
                    return no('', 1);
                if (key === 'git rev-parse refs/remotes/origin/dev')
                    return ok(`${DEVMERGE}\n`);
                return undefined;
            });
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(true);
            expect(calls).toContain(`git merge-base --is-ancestor ${HEAD} refs/remotes/origin/dev`);
            expect(calls).toContain(`git merge-base --is-ancestor ${MERGE} refs/remotes/origin/dev`);
            expect(calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr merge'))).toBe(false);
            expect(readReleaseState(stateRoot, V).devMergeSha).toBe(DEVMERGE);
        });
        it('reuses a merged PR of the branch only when its merge commit contains HEAD', async () => {
            handlers.unshift((key) => {
                if (key.startsWith('gh pr list --head release/v5.12.2 --base dev'))
                    return ok(JSON.stringify([{ number: 250, state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: MERGE } }]));
                if (key.startsWith('gh pr view 250 --json'))
                    return ok(prJson(250, 'dev', 'MERGED', MERGE, OTHER));
                // The PR head is not in HEAD (the old, reversed rule would refuse it); its merge contains HEAD.
                if (key === `git merge-base --is-ancestor ${OTHER} HEAD`)
                    return no('', 1);
                return undefined;
            });
            const result = await release({ to: 'pr' });
            expect(result.ok).toBe(true);
            expect(calls.find((c) => c.startsWith('gh pr list'))).toContain('--json number,state,headRefOid,mergeCommit');
            expect(calls).toContain(`git merge-base --is-ancestor HEAD ${MERGE}`);
            expect(calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
            expect(readReleaseState(stateRoot, V)).toMatchObject({ devPr: 250, devMergeSha: MERGE });
        });
        it('blocks instead of opening another PR when a merged PR of the branch does not contain HEAD', async () => {
            handlers.unshift((key) => {
                if (key.startsWith('gh pr list --head release/v5.12.2 --base dev'))
                    return ok(JSON.stringify([{ number: 250, state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: MERGE } }]));
                if (key.startsWith('gh pr view 250 --json'))
                    return ok(prJson(250, 'dev', 'MERGED', MERGE, OTHER));
                if (key === `git merge-base --is-ancestor HEAD ${MERGE}` || key === `git merge-base --is-ancestor ${HEAD} ${MERGE}`)
                    return no('', 1);
                if (key === `git merge-base --is-ancestor ${HEAD} refs/remotes/origin/dev`)
                    return no('', 1);
                return undefined;
            });
            const result = await release({ to: 'pr' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/The release PR #250 is merged at 333333333333 without commit\(s\) up to 111111111111/) });
            expect(calls.some((c) => c.startsWith('gh pr create') || c.startsWith('gh pr merge'))).toBe(false);
            expect(readReleaseState(stateRoot, V).devMergeSha).toBeUndefined();
        });
        it('blocks after a bounded number of rounds when a merge never takes, even when the clock does not move', async () => {
            handlers.unshift((key) => (key.startsWith('gh pr merge 301') ? ok() : undefined));
            const result = await release({ to: 'pr' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/PR #301 is still not merged after \d+ rounds/) });
        });
    });
    describe('promote: only a merged release', () => {
        beforeEach(() => {
            seedState('pr', { devPr: 301, devMergeSha: DEVMERGE });
            handlers.push((key) => {
                if (key.startsWith('gh pr list --head dev --base main'))
                    return ok('[{"number":302,"state":"OPEN"}]');
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                return undefined;
            }, landed);
        });
        it('refuses to merge a promotion PR whose head does not contain the dev merge', async () => {
            handlers.unshift((key) => {
                if (key.startsWith('gh pr view 302 --json'))
                    return ok(prJson(302, 'main', 'OPEN', null, OTHER));
                if (key.startsWith('gh pr checks 302'))
                    return ok(JSON.stringify([{ name: 'Test', state: 'SUCCESS', link: 'https://github.com/o/r/actions/runs/79/job/91' }]));
                if (key.startsWith('gh run list --commit'))
                    return ok('[]');
                if (key === `git merge-base --is-ancestor ${DEVMERGE} ${OTHER}`)
                    return no('', 1);
                return undefined;
            });
            const result = await release({ to: 'promote' });
            expect(result.phases[0]).toMatchObject({ status: 'blocked', note: expect.stringMatching(/PR #302 head 555555555555 does not contain 666666666666/) });
            expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
        });
        it('records the main merge when it contains the dev merge', async () => {
            const result = await release({ to: 'promote' });
            expect(result.ok).toBe(true);
            expect(calls).toContain(`git merge-base --is-ancestor ${DEVMERGE} ${MERGE}`);
            expect(readReleaseState(stateRoot, V)).toMatchObject({ mainPr: 302, mainMergeSha: MERGE, devMergeSha: DEVMERGE });
        });
        it('promotes the recorded follow-up dev merge, which contains the release PR merge, not the release PR merge itself', async () => {
            seedState('pr', { devPr: 301, devMergeSha: OTHER });
            const result = await release({ from: 'promote', to: 'promote' });
            expect(result.ok).toBe(true);
            expect(calls).toContain(`git merge-base --is-ancestor ${DEVMERGE} ${OTHER}`);
            expect(calls).toContain(`git merge-base --is-ancestor ${HEAD} ${OTHER}`);
            expect(calls).toContain(`git merge-base --is-ancestor ${OTHER} ${MERGE}`);
            expect(readReleaseState(stateRoot, V)).toMatchObject({ devMergeSha: OTHER, mainMergeSha: MERGE });
        });
        it('refuses --from promote while the release PR is not merged', async () => {
            handlers.unshift((key) => (key.startsWith('gh pr view 301 --json') ? ok(prJson(301, 'dev', 'OPEN', null)) : undefined));
            const result = await release({ from: 'promote', to: 'promote' });
            expect(result.phases[0]).toMatchObject({ id: 'promote', status: 'blocked' });
            expect(result.phases[0].details).toContain('pr: PR #301 is not merged, not at the recorded 666666666666 (--from pr)');
            expect(calls.some((c) => c.startsWith('gh pr create') || c.startsWith('gh pr merge') || c.startsWith('gh pr list'))).toBe(false);
        });
        it('fails when the main merge does not contain the dev merge', async () => {
            handlers.unshift((key) => (key === `git merge-base --is-ancestor ${DEVMERGE} ${MERGE}` ? no('', 1) : undefined));
            const result = await release({ to: 'promote' });
            expect(result.phases[0]).toMatchObject({ status: 'fail', note: expect.stringMatching(/does not contain the dev merge 666666666666/) });
            expect(readReleaseState(stateRoot, V).mainMergeSha).toBeUndefined();
        });
    });
    describe('tag: sha verification and confirmation', () => {
        let pushed;
        let localTag;
        beforeEach(() => {
            seedState('promote', landedState);
            pushed = false;
            localTag = null;
            handlers.push(landed, (key) => {
                if (key === 'git rev-parse HEAD')
                    return ok(`${HEAD}\n`);
                if (key.startsWith('git ls-remote --tags origin'))
                    return ok(pushed ? `${TAGOBJ}\trefs/tags/v${V}\n${MERGE}\trefs/tags/v${V}^{}\n` : '');
                if (key === `git merge-base --is-ancestor ${MERGE} refs/remotes/origin/main`)
                    return ok();
                if (key === `git rev-parse -q --verify refs/tags/v${V}`)
                    return localTag ? ok(TAGOBJ) : no('', 1);
                if (key === `git tag -a v${V} -m v${V} ${MERGE}`) {
                    localTag = { type: 'tag', peeled: MERGE };
                    return ok();
                }
                if (key === `git cat-file -t refs/tags/v${V}`)
                    return ok(`${localTag?.type ?? ''}\n`);
                if (key === `git rev-parse refs/tags/v${V}^{}`)
                    return ok(`${localTag?.peeled ?? ''}\n`);
                if (key === `git push origin refs/tags/v${V}:refs/tags/v${V}`) {
                    pushed = true;
                    return ok();
                }
                return undefined;
            });
        });
        it('is blocked without --yes when the confirmation is declined, and creates nothing', async () => {
            const result = await release({ to: 'tag' });
            expect(result.phases[0].status).toBe('blocked');
            expect(confirms).toEqual([`Create and push annotated tag v${V} on main 333333333333? This publishes oh-my-copilot@${V} to npm.`]);
            expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
        });
        it('warns in the confirmation when the live smoke was skipped', async () => {
            seedState('promote', { ...landedState, phases: { ...okPhases('promote'), smoke: { status: 'skipped', note: '', at: '' } } });
            await release({ from: 'tag', to: 'tag' });
            expect(confirms[0]).toMatch(/WARNING: the live Tier 2 smoke was skipped/);
        });
        it('asks before pushing a matching local tag too', async () => {
            localTag = { type: 'tag', peeled: MERGE };
            const result = await release({ to: 'tag' });
            expect(result.phases[0].status).toBe('blocked');
            expect(confirms).toEqual([`Push the existing local annotated tag v${V} on main 333333333333? This publishes oh-my-copilot@${V} to npm.`]);
            expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
        });
        it('refuses to tag a main merge whose package.json is not the release version', async () => {
            handlers.unshift((key) => (key === `git show ${MERGE}:package.json` ? ok('{"version":"5.12.1"}') : undefined));
            const result = await release({ to: 'tag', yes: true });
            expect(result.phases[0]).toMatchObject({ status: 'fail', note: `package.json on the main merge 333333333333 is 5.12.1, not ${V}` });
            expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
        });
        it('refuses to tag a main merge that does not contain the dev merge', async () => {
            handlers.unshift((key) => (key === `git merge-base --is-ancestor ${DEVMERGE} ${MERGE}` ? no('', 1) : undefined));
            const result = await release({ from: 'tag', to: 'tag', yes: true });
            expect(result.phases[0].status).not.toBe('ok');
            expect(JSON.stringify(result.phases[0])).toMatch(/does not contain the dev merge 666666666666/);
            expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
        });
        it('re-verifies the promotion before --from tag: a main PR merged elsewhere is refused', async () => {
            handlers.unshift((key) => (key.startsWith('gh pr view 302 --json') ? ok(prJson(302, 'main', 'MERGED', OTHER)) : undefined));
            const result = await release({ from: 'tag', to: 'tag', yes: true });
            expect(result.phases[0]).toMatchObject({ id: 'tag', status: 'blocked' });
            expect(result.phases[0].details).toContain('promote: PR #302 is merged at 555555555555, not at the recorded 333333333333 (--from promote)');
            expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
        });
        it('creates the annotated tag on the main merge commit, verifies it, pushes it and checks the remote', async () => {
            const result = await release({ to: 'tag', yes: true });
            expect(result.ok).toBe(true);
            expect(confirms).toEqual([]);
            expect(calls).toContain(`git tag -a v${V} -m v${V} ${MERGE}`);
            expect(calls).toContain(`git push origin refs/tags/v${V}:refs/tags/v${V}`);
        });
        it('refuses a local tag that peels elsewhere (an upstream tag) and never pushes it', async () => {
            localTag = { type: 'tag', peeled: OTHER };
            const result = await release({ to: 'tag', yes: true });
            expect(result.ok).toBe(false);
            expect(result.phases[0].note).toMatch(/not the main merge commit/);
            expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
            expect(calls.some((c) => c.startsWith('git tag -d'))).toBe(false);
        });
        it('refuses a remote tag on another commit', async () => {
            handlers.unshift((key) => (key.startsWith('git ls-remote --tags origin') ? ok(`${OTHER}\trefs/tags/v${V}\n`) : undefined));
            const result = await release({ to: 'tag', yes: true });
            expect(result.phases[0].note).toMatch(/exists on origin at 555555555555 \(lightweight\)/);
        });
        it('--from tag once main is merged does not read the working-tree package.json (the tag phase checks the main merge)', async () => {
            write('package.json', JSON.stringify({ name: 'oh-my-copilot', version: '5.12.1' }));
            const result = await release({ from: 'tag', to: 'tag', yes: true });
            expect(result.ok).toBe(true);
            expect(calls).toContain(`git show ${MERGE}:package.json`);
        });
        it('needs the promote phase merge commit', async () => {
            seedState('promote', { devPr: 301, devMergeSha: DEVMERGE });
            const result = await release({ to: 'tag', yes: true });
            expect(result.phases[0].note).toMatch(/no main merge commit recorded/);
            expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
        });
    });
    describe('verify', () => {
        let conclusion;
        let published;
        beforeEach(() => {
            seedState('tag', landedState);
            conclusion = 'failure';
            published = false;
            handlers.push(landed, attempts(), (key) => {
                if (key.startsWith('git ls-remote --tags origin'))
                    return ok(`${TAGOBJ}\trefs/tags/v${V}\n${MERGE}\trefs/tags/v${V}^{}\n`);
                if (key.startsWith(`gh run list --workflow ci.yml --event push --commit ${MERGE}`)) {
                    return ok(JSON.stringify([
                        { databaseId: 900, headBranch: 'dev', headSha: MERGE, event: 'push', status: 'completed', conclusion: 'success' },
                        { databaseId: 901, headBranch: `v${V}`, headSha: MERGE, event: 'push', status: 'completed', conclusion },
                    ]));
                }
                if (key === `npm view oh-my-copilot@${V} version`)
                    return published ? ok(`${V}\n`) : no('npm error code E404');
                if (key === 'gh run rerun 901 --failed') {
                    conclusion = 'success';
                    return ok();
                }
                if (key === 'gh run view 901 --json jobs') {
                    return ok(JSON.stringify({ jobs: [{ databaseId: 5, name: 'Create GitHub Release', conclusion }, { databaseId: 6, name: 'Copilot smoke (tier 2)', conclusion: 'success' }] }));
                }
                if (key.startsWith(`npm view oh-my-copilot@${V}`))
                    return ok(JSON.stringify({ version: V, 'dist-tags.latest': V, 'dist.attestations': { url: 'x' } }));
                if (key.startsWith(`gh release view v${V}`))
                    return ok(JSON.stringify({ tagName: `v${V}`, isDraft: false }));
                return undefined;
            });
        });
        it('reruns a failed tag run once, then checks npm and the GitHub Release', async () => {
            const result = await release({ to: 'verify' });
            expect(result.ok).toBe(true);
            expect(calls.filter((c) => c === 'gh run rerun 901 --failed')).toHaveLength(1);
            expect(readReleaseState(stateRoot, V).tagRunId).toBe(901);
        });
        it('stops with the failed job and its failing tests after the rerun', async () => {
            handlers.unshift((key) => {
                if (key === 'gh run rerun 901 --failed')
                    return ok();
                if (key === 'gh run view --job 5 --log')
                    return ok('x\ty\t FAIL  src/b.test.ts > b > flakes\n');
                return undefined;
            });
            const result = await release({ to: 'verify' });
            expect(result.ok).toBe(false);
            expect(result.phases[0].details).toEqual(['failed job: Create GitHub Release', '  src/b.test.ts > b > flakes']);
        });
        it('fails when npm latest or provenance is missing', async () => {
            conclusion = 'success';
            handlers.unshift((key) => (key.startsWith(`npm view oh-my-copilot@${V}`) ? ok(JSON.stringify({ version: V, 'dist-tags.latest': '5.12.1' })) : undefined));
            const result = await release({ to: 'verify' });
            expect(result.phases[0].details).toEqual(['npm dist-tags.latest is "5.12.1", not 5.12.2', 'npm reports no dist.attestations (SLSA provenance)']);
        });
        it('does not rerun a failed tag run whose version is already on npm, and points at Release Recovery', async () => {
            published = true;
            handlers.unshift((key) => (key.startsWith(`gh release view v${V}`) ? no('release not found') : undefined));
            const result = await release({ to: 'verify' });
            expect(result.phases[0]).toMatchObject({ status: 'fail', note: expect.stringMatching(/oh-my-copilot@5\.12\.2 is already on npm: not rerun/) });
            expect(result.phases[0].details.join('\n')).toMatch(/Release Recovery workflow \(release\.yml/);
            expect(calls.some((c) => c.startsWith('gh run rerun'))).toBe(false);
        });
        it('names the failed job and the published release instead of suggesting Release Recovery', async () => {
            published = true;
            const result = await release({ to: 'verify' });
            expect(result.phases[0]).toMatchObject({
                status: 'fail',
                note: expect.stringMatching(/failed job\(s\) Create GitHub Release; oh-my-copilot@5\.12\.2 is on npm and GitHub Release v5\.12\.2 is published, so no Release Recovery/),
            });
            expect(result.phases[0].details.join('\n')).not.toMatch(/Release Recovery workflow/);
            expect(calls.some((c) => c.startsWith('gh run rerun'))).toBe(false);
        });
        it('resumes --from verify off the release branch once the main merge is recorded, still checking the merges and the tag', async () => {
            conclusion = 'success';
            seedState('tag', { ...landedState, branch: `release/v${V}` });
            handlers.unshift((key) => {
                if (key === 'git rev-parse --abbrev-ref HEAD')
                    return ok('main\n');
                if (key === 'git rev-parse HEAD')
                    return ok(`${OTHER}\n`);
                if (key === `git merge-base --is-ancestor ${HEAD} HEAD`)
                    return no('', 1);
                return undefined;
            });
            const result = await release({ from: 'verify', to: 'verify' });
            expect(result.ok).toBe(true);
            expect(calls).toContain(`git merge-base --is-ancestor ${HEAD} ${DEVMERGE}`);
            expect(calls).toContain(`git merge-base --is-ancestor ${DEVMERGE} ${MERGE}`);
            expect(calls.some((c) => c.startsWith('git ls-remote --tags origin'))).toBe(true);
        });
        it('takes the tag run of the main merge commit, not another run on the tag name', async () => {
            conclusion = 'success';
            handlers.unshift((key) => (key.startsWith('gh run list --workflow ci.yml')
                ? ok(JSON.stringify([
                    { databaseId: 902, headBranch: `v${V}`, headSha: OTHER, event: 'push', status: 'completed', conclusion: 'failure' },
                    { databaseId: 901, headBranch: `v${V}`, headSha: MERGE, event: 'push', status: 'completed', conclusion: 'success' },
                ]))
                : undefined));
            const result = await release({ to: 'verify' });
            expect(result.ok).toBe(true);
            expect(readReleaseState(stateRoot, V).tagRunId).toBe(901);
            expect(calls.find((c) => c.startsWith('gh run list'))).toContain(`--commit ${MERGE}`);
        });
    });
});
describe('defaultReleaseExec environment', () => {
    it('does not give the suite runner the ship scrub (node keeps GIT_* variables and has no forced GIT_NO_REPLACE_OBJECTS)', () => {
        const saved = { idx: process.env.GIT_INDEX_FILE, repl: process.env.GIT_NO_REPLACE_OBJECTS };
        process.env.GIT_INDEX_FILE = 'kept-for-node';
        delete process.env.GIT_NO_REPLACE_OBJECTS;
        try {
            const r = defaultReleaseExec(process.execPath, ['-p', 'JSON.stringify([process.env.GIT_INDEX_FILE, process.env.GIT_NO_REPLACE_OBJECTS ?? null])']);
            expect(JSON.parse(r.stdout)).toEqual(['kept-for-node', null]);
        }
        finally {
            if (saved.idx === undefined)
                delete process.env.GIT_INDEX_FILE;
            else
                process.env.GIT_INDEX_FILE = saved.idx;
            if (saved.repl !== undefined)
                process.env.GIT_NO_REPLACE_OBJECTS = saved.repl;
        }
    });
});
//# sourceMappingURL=engine.test.js.map