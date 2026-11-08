/**
 * The engine on the local (offline) forge (offline forge plan §1.1, lane B):
 * fake lanes, a real repository with no origin, the engine-owned bare mirror
 * under a temp forge state dir. No gh, az or copilot runs, and no AI credits.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCheckRecordPath, readLocalCheckRecord, readMirrorRef } from '../../../forge/local/index.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine, EXIT_AWAITING_HUMAN } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { checkoutPath } from '../prepare.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { BASE, foreignCommands, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const BRANCH = `factory/issue-${LOCAL_ISSUE}`;
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
describe('factory run on the local forge', () => {
    it('intake -> plan -> implement -> publish to the mirror -> review -> prepare -> local gate -> parks at the human git merge', async () => {
        w = localWorld();
        const warnings = [];
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes, { warn: (m) => warnings.push(m) }));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state).toMatchObject({ phase: 'merge', forgeKind: 'local', remote: 'omg-local', repoUrl: w.config.repo.url, pr: 1 });
        expect(state.plan?.source).toBe('issue-body');
        // The mirror is engine-owned, under the forge state dir, and holds the base and the pushed head.
        const mirror = w.config.repo.url;
        expect(mirror.startsWith(w.stateDir)).toBe(true);
        expect(readMirrorRef(mirror, BRANCH)).toBe(state.head);
        expect(readMirrorRef(mirror, BASE)).toBe(gitIn(w.root, 'rev-parse', BASE));
        expect(gitIn(w.root, 'remote')).toBe('omg-local');
        expect(gitIn(w.root, 'remote', 'get-url', 'omg-local')).toBe(mirror);
        // The gate ran once, for the pushed head, in the engine's prepare checkout; its record is the one check.
        expect(w.gateRuns).toEqual([{ argv: ['node', '--test'], cwd: checkoutPath(w.root, LOCAL_ISSUE), head: state.head }]);
        expect(readLocalCheckRecord(w.stateDir, w.root, state.head)).toMatchObject({ state: 'SUCCESS', exitCode: 0 });
        // The configured GitHub check name is replaced, with a warning.
        expect(warnings.join('\n')).toMatch(/ignores ship\.requiredChecks Test; the gates wait for local-gate only/);
        // The human merge is a local git merge of the exact head; the engine never merges.
        expect(out.mergeCommand).toBe(`git -C ${w.root} merge --no-ff ${state.head}`);
        // Offline: no gh/az/copilot, nothing on origin, every mirror transport pinned to the stock pack programs.
        expect(foreignCommands(w)).toEqual([]);
        expect(w.calls.filter((c) => /\borigin\b/.test(c))).toEqual([]);
        const transports = w.raw.filter((c) => c.cmd === 'git' && c.args.some((a, i) => (a === 'push' || a === 'fetch' || a === 'ls-remote') && (c.args[i + 1] === 'omg-local' || c.args[i + 1] === mirror)));
        expect(transports.length).toBeGreaterThan(0);
        for (const t of transports)
            expect(t.args).toContain('remote.omg-local.receivepack=git-receive-pack');
        // Every push names the mirror path (no remote fetch refspec moves a local ref), every fetch an explicit refspec.
        expect(w.calls.filter((c) => c.startsWith('git push omg-local'))).toEqual([]);
        expect(w.calls.filter((c) => c.startsWith(`git push ${mirror} `)).length).toBeGreaterThan(0);
        expect(w.calls.filter((c) => c.startsWith('git fetch') && !c.includes('--refmap= omg-local +refs/heads/'))).toEqual([]);
    });
    it('after the human merge on the base, the next run syncs the mirror and finishes the run as merged', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        gitIn(w.root, 'merge', '--no-ff', '--no-edit', head);
        const second = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(second.exitCode, second.message).toBe(0);
        expect(readFactoryState(w.root, LOCAL_ISSUE).phase).toBe('merged');
        expect(readMirrorRef(w.config.repo.url, BASE)).toBe(gitIn(w.root, 'rev-parse', BASE));
        const store = JSON.parse(readFileSync(join(w.config.repo.url.slice(0, -'.git'.length), 'prs.json'), 'utf8'));
        expect(store.prs.find((p) => p.number === 1)?.state).toBe('MERGED');
    });
    it('a failing gate is a failed check: the run takes the ci-fix path, and the new head gets its own gate run', async () => {
        w = localWorld();
        w.gateStatus = [1, 0];
        const lanes = lanesFor(w, [greet(), review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(lanes.started.map((s) => s.laneId)).toContain(`issue-${LOCAL_ISSUE}-ci-fix-1`);
        const [failed, passed] = w.gateRuns;
        expect(readLocalCheckRecord(w.stateDir, w.root, failed.head)).toMatchObject({ state: 'FAILURE', exitCode: 1 });
        expect(passed.head).not.toBe(failed.head);
        expect(readLocalCheckRecord(w.stateDir, w.root, passed.head)).toMatchObject({ state: 'SUCCESS' });
        expect(out.gate?.name, out.message).toBe('merge');
        expect(foreignCommands(w)).toEqual([]);
    });
    it('no factory.forge.local.gate: the run parks at awaiting-human: gates instead of passing', async () => {
        w = localWorld(null);
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('gates');
        expect(out.gate?.reason).toMatch(/no local gate: set factory\.forge\.local\.gate/);
        expect(w.gateRuns).toEqual([]);
    });
    it('a hostile remote.omg-local.pushurl in the checkout is never pushed to: the sync refuses before any push', async () => {
        w = localWorld();
        const evil = join(w.dir, 'evil.git');
        gitIn(w.dir, 'init', '-q', '--bare', evil);
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'config', 'remote.omg-local.pushurl', evil);
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        // An unusable forge (exit 5), like every other refusal of the mirror remote.
        expect(out.exitCode).toBe(5);
        expect(out.message).toMatch(/refusing to sync the local forge mirror: remote omg-local pushes to/);
        expect(lanes.started).toEqual([]);
        expect(w.calls.filter((c) => c.startsWith('git push'))).toEqual([]);
        expect(readdirSync(join(evil, 'refs', 'heads'))).toEqual([]);
        expect(existsSync(join(evil, 'packed-refs'))).toBe(false);
    });
    it('a gate that cannot start parks at awaiting-human: gates (no FAILURE, no ci-fix); a gate changed after that is refused', async () => {
        w = localWorld();
        w.gate = async () => ({ status: 127, stdout: '', stderr: '', timedOut: false, startError: 'the local gate executable npm is not on PATH' });
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('gates');
        expect(out.gate?.reason).toMatch(/the local gate could not start: the local gate executable npm is not on PATH/);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(readLocalCheckRecord(w.stateDir, w.root, state.head)).toBeUndefined();
        expect(lanes.started.map((s) => s.laneId).filter((id) => id.includes('ci-fix'))).toEqual([]);
        // The run recorded the gate it tried.
        expect(state.localGate).toEqual(['node', '--test']);
        // The trusted config now names another gate: the rerun refuses it instead of judging the head with it.
        const changed = { ...w.config, local: { ...w.config.local, gate: ['node', '--test', '--experimental'] } };
        let ran = 0;
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), {
            forge: { config: changed, options: { ...factoryForgeOptions(w.root), stateDir: w.stateDir } },
            localGate: async () => { ran += 1; return { status: 0, stdout: '', stderr: '', timedOut: false }; },
        }));
        expect(again.exitCode, again.message).toBe(EXIT_AWAITING_HUMAN);
        expect(again.gate?.reason).toMatch(/refuses the local gate `node --test --experimental`: this run recorded `node --test`/);
        expect(ran).toBe(0);
    });
    it('remote.omg-local.vcs in the checkout refuses the run as an unusable forge (exit 5) before any transport', async () => {
        w = localWorld();
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'config', 'remote.omg-local.vcs', 'ext');
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(5);
        expect(out.message).toMatch(/unsupported forge: refusing the local forge: the git config sets remote\.omg-local\.vcs/);
        expect(lanes.started).toEqual([]);
        expect(w.calls.filter((c) => /^git (push|fetch|ls-remote)\b/.test(c))).toEqual([]);
    });
    it('a planted url.<evil>.insteadOf of the mirror path refuses the run (exit 5): nothing reaches the rewrite target', async () => {
        w = localWorld();
        const evil = join(w.dir, 'evil.git');
        gitIn(w.dir, 'init', '-q', '--bare', evil);
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url.replace(/\\/g, '/'));
        gitIn(w.root, 'config', `url.${evil}.insteadOf`, w.config.repo.url);
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(5);
        expect(out.message).toMatch(/refusing the local forge: the git config sets url\..*\.insteadof=/);
        expect(lanes.started).toEqual([]);
        expect(w.calls.filter((c) => /^git (push|fetch|ls-remote)\b/.test(c))).toEqual([]);
        expect(gitIn(evil, 'for-each-ref', '--format=%(refname)')).toBe('');
    });
    it('a remote named after the mirror path with a planted url refuses the run (exit 5): nothing reaches that url', async () => {
        w = localWorld();
        const evil = join(w.dir, 'evil.git');
        gitIn(w.dir, 'init', '-q', '--bare', evil);
        gitIn(w.root, 'config', `remote.${w.config.repo.url}.url`, evil);
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(5);
        expect(out.message).toMatch(/refusing the local forge: the git config sets remote\..*\.url=/);
        expect(lanes.started).toEqual([]);
        expect(w.calls.filter((c) => /^git (push|fetch|ls-remote)\b/.test(c))).toEqual([]);
        expect(gitIn(evil, 'for-each-ref', '--format=%(refname)')).toBe('');
    });
    it.each([
        ['after the gates deadline', DEFAULT_FACTORY_RUN_LIMITS.gatesTimeoutMs + 60_000],
        // The default gate timeout is 20 minutes: a full gate starting 19 minutes before the deadline would overrun it.
        ['less than one gate timeout before the gates deadline', DEFAULT_FACTORY_RUN_LIMITS.gatesTimeoutMs - 19 * 60_000],
    ])('a gate due again (its record removed) %s is a gates timeout, not one more gate run', async (_when, jump) => {
        w = localWorld();
        let offset = 0;
        let removed = false;
        let jumped = false;
        const now = () => {
            const head = readFactoryState(w.root, LOCAL_ISSUE)?.head;
            // Once the gate recorded its verdict, a rerun removes the record (checks.rerun)...
            if (!removed && head && readLocalCheckRecord(w.stateDir, w.root, head)?.state === 'SUCCESS') {
                removed = true;
                rmSync(localCheckRecordPath(w.stateDir, w.root, head), { force: true });
            }
            // ...and ship's watch, which reads the checks next, starts after the gates deadline.
            if (removed && !jumped && new Error().stack?.includes('watchGates')) {
                jumped = true;
                offset += jump;
            }
            return Date.now() + offset;
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { now }));
        expect(jumped).toBe(true);
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('gates-timeout');
        expect(w.gateRuns).toHaveLength(1);
    });
    it('a mirror base that is not an ancestor of the local base refuses the sync (fast-forward only)', async () => {
        w = localWorld();
        await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        // Rewrite the local base so the mirror's base is no longer in it.
        gitIn(w.root, 'commit', '-q', '--amend', '-m', 'rewritten', '--allow-empty');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(out.exitCode).toBe(1);
        expect(out.message).toMatch(/fast-forward only/);
    });
    it('--dry-run reads the backlog at the local base and writes nothing: no mirror, no remote, no fetch, no push', async () => {
        w = localWorld();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, []), { dryRun: true }));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.plan?.next).toBe('implement');
        expect(existsSync(w.config.repo.url)).toBe(false);
        expect(existsSync(w.stateDir)).toBe(false);
        expect(gitIn(w.root, 'remote')).toBe('');
        expect(w.calls.filter((c) => /^git (fetch|push|init|remote add)\b/.test(c))).toEqual([]);
        expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
    });
});
//# sourceMappingURL=engine.local.test.js.map