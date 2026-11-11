/**
 * The private layout end to end (item 2 B1b): `factory.run.layout:
 * "private"` on the local forge with fake lanes. Lanes, the prepare checkout
 * and the local gate work in the engine's private repository under the work
 * root; the user's repository only gets the imported commits by sha and the
 * engine's push from it. Real git in temp dirs; no gh, az or copilot.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMirrorRef } from '../../../forge/local/index.js';
import { loadTrustedShipConfig, resolveShipConfig } from '../../../ship/config.js';
import { cleanFactoryRun } from '../clean.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../engine.js';
import { GATE_INSTALL_GATE, REPO_GUARD_GATE } from '../private-run.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { commitFile, FakeLanes, gitIn, review } from './fake-lanes.js';
import { BASE, foreignCommands, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
const T = 600_000;
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
/** The local world plus a lockfile on the base, your node_modules (with a marker) and the private layout in the user config. */
function privateWorld() {
    const world = localWorld();
    writeFileSync(join(world.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    appendFileSync(join(world.root, '.gitignore'), 'node_modules/\n');
    gitIn(world.root, 'add', 'package-lock.json', '.gitignore');
    gitIn(world.root, 'commit', '-q', '-m', 'lockfile');
    mkdirSync(join(world.root, 'node_modules'), { recursive: true });
    writeFileSync(join(world.root, 'node_modules', 'marker.txt'), 'yours\n');
    const work = join(world.dir, 'fw');
    return { w: world, work, user: { factory: { run: { layout: 'private', workDir: work } } } };
}
/** Every file under the user's .git (objects/ aside) with its content hash: what the run may change is asserted against it. */
function gitListing(root) {
    const out = new Map();
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            const rel = relative(join(root, '.git'), p).replace(/\\/g, '/');
            if (rel === 'objects')
                continue;
            const st = lstatSync(p);
            if (st.isDirectory())
                walk(p);
            else
                out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
        }
    };
    walk(join(root, '.git'));
    return out;
}
function changedPaths(before, after) {
    return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
}
const opts = (env, scripts, over = {}) => localOpts(env.w, lanesFor(env.w, scripts), { runUserConfig: env.user, ...over });
describe('factory run with factory.run.layout "private"', () => {
    it('implement -> review -> prepare -> local gate -> merge park: lanes, prepare and the gate work under the work root; the user repository only gets the imported commit and the push', async () => {
        const env = privateWorld();
        w = env.w;
        const before = gitListing(w.root);
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes, { runUserConfig: env.user }));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        expect(s.layout).toBe(2);
        expect(s.privateDir.startsWith(env.work)).toBe(true);
        expect(s.history.some((h) => h.note.startsWith('private layout: the run\'s private repository is '))).toBe(true);
        // The pushed head is the engine's commit, imported: the mirror has it, and the user's object store holds it.
        expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBe(s.head);
        expect(gitIn(w.root, 'cat-file', '-t', s.head)).toBe('commit');
        // Every lane worktree and job dir, and the prepare/gate checkout, under the run dir; none under the checkout.
        for (const start of lanes.started) {
            expect(start.worktree?.path.startsWith(join(s.privateDir, 'w'))).toBe(true);
            expect(start.jobRoot).toBe(join(s.privateDir, 'jobs'));
            expect(start.deniedPaths).toContain(join(s.privateDir, '..', 'seed.git'));
        }
        expect(w.gateRuns.map((r) => r.cwd)).toEqual([join(s.privateDir, 'w', 'prep')]);
        expect(existsSync(join(w.root, '.omg', 'team'))).toBe(false);
        // The prepare checkout links your node_modules (the lockfile is the base's).
        expect(lstatSync(join(s.privateDir, 'w', 'prep', 'node_modules')).isSymbolicLink()).toBe(true);
        // The user's .git: only the local forge's own remote, its tracking refs and fetch bookkeeping changed; no worktree, branch or import ref.
        // The engine's push names the mirror path, yet git on the Linux CI runner moved the omg-local tracking ref of the pushed
        // branch (Windows git does not): it may exist, and then only at the pushed head.
        const pushedTracking = `refs/remotes/omg-local/factory/issue-${LOCAL_ISSUE}`;
        const changed = changedPaths(before, gitListing(w.root));
        expect(changed.filter((p) => !/^(config|FETCH_HEAD|(logs\/)?refs\/remotes\/omg-local\/(main|factory\/issue-\d+))$/.test(p))).toEqual([]);
        const refs = gitIn(w.root, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((l) => l !== '');
        for (const line of refs.filter((l) => l.startsWith(`${pushedTracking} `)))
            expect(line).toBe(`${pushedTracking} ${s.head}`);
        expect(refs.map((l) => l.split(' ')[0]).filter((r) => r !== pushedTracking)).toEqual([`refs/heads/${BASE}`, `refs/remotes/omg-local/${BASE}`]);
        expect(gitIn(w.root, 'status', '--porcelain')).toBe('');
        expect(foreignCommands(w)).toEqual([]);
        expect(out.mergeCommand).toBe(`git -C ${w.root} merge --no-ff --no-edit ${s.head}`);
    }, T);
    it('a hook planted in the private repository by a lane never runs: the lane parks at lane-tampered (control: plain git runs it)', async () => {
        const env = privateWorld();
        w = env.w;
        const marker = join(w.dir, 'hook-ran');
        const plant = (ctx) => {
            const hooks = join(ctx.input.worktree.commonGitDir, 'hooks');
            mkdirSync(hooks, { recursive: true });
            writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
            return greet()(ctx);
        };
        const out = await runFactoryEngine(opts(env, [plant]));
        expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/config, hooks or info changed since the engine wrote them/);
        expect(existsSync(marker)).toBe(false);
        expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        gitIn(join(s.privateDir, 'repo'), 'update-ref', 'refs/control', s.baseSha);
        expect(existsSync(marker)).toBe(true);
    }, T);
    it('a change to your repository\'s hooks during the run parks before the import with an actionable message; a rerun continues', async () => {
        const env = privateWorld();
        w = env.w;
        const plant = (ctx) => {
            // You (or anything with your rights) add a hook while the lane runs.
            writeFileSync(join(w.root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
            return greet()(ctx);
        };
        const first = await runFactoryEngine(opts(env, [plant]));
        expect(first.gate?.name, first.message).toBe(REPO_GUARD_GATE);
        expect(first.gate?.reason).toContain(`your repository's hooks dir: ${join(w.root, '.git', 'hooks')} changed during the run`);
        expect(first.gate?.reason).toMatch(/Your own change does this too.*rerunning omg factory run 7 continues/);
        expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();
        const second = await runFactoryEngine(opts(env, [review('approve')]));
        expect(second.gate?.name, second.message).toBe('merge');
    }, T);
    it('a lockfile the PR changes parks at gate-install-needed by default; "sandboxed" runs npm ci --ignore-scripts in the OS sandbox with the registry', async () => {
        const env = privateWorld();
        w = env.w;
        const bump = commitFile('package-lock.json', '{"lockfileVersion":3,"x":1}\n');
        const first = await runFactoryEngine(opts(env, [bump, review('approve')]));
        expect(first.gate?.name, first.message).toBe(GATE_INSTALL_GATE);
        expect(first.gate?.reason).toMatch(/the PR changes package-lock\.json, so the prepare checkout .* cannot use your node_modules.*factory\.run\.gateInstall "sandboxed"/);
        const installs = [];
        const runner = async (req) => {
            if (req.purpose === 'install') {
                installs.push(req);
                return { ran: true, status: 0, output: 'added 0 packages', timedOut: false };
            }
            if (req.purpose === 'gate') {
                const r = await w.gate(req.argv, req.cwd, req.timeoutMs);
                return { ran: true, status: r.status, output: r.stdout, timedOut: false };
            }
            return { ran: true, status: 0, output: '', timedOut: false };
        };
        const second = await runFactoryEngine(opts({ w, user: { factory: { run: { ...env.user.factory.run, gateInstall: 'sandboxed' } } } }, [], { gateSandbox: runner }));
        expect(second.gate?.name, second.message).toBe('merge');
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        expect(installs).toHaveLength(1);
        expect(installs[0]).toMatchObject({ network: 'registry', cwd: join(s.privateDir, 'w', 'prep'), commonGitDir: join(s.privateDir, 'repo', '.git') });
        expect(installs[0].argv).toEqual(['npm', 'ci', '--ignore-scripts']);
        expect(existsSync(join(s.privateDir, 'w', 'prep', 'node_modules'))).toBe(false);
    }, T);
    it('a failed prepare check after a base merge: the merge is imported first, then the ci-fix lane\'s commit on it', async () => {
        const env = privateWorld();
        w = env.w;
        // The base moves while the implement lane runs: prepare merges it (a private merge commit).
        const moveBase = (ctx) => {
            writeFileSync(join(w.root, 'other.txt'), 'base moved\n');
            gitIn(w.root, 'add', 'other.txt');
            gitIn(w.root, 'commit', '-q', '-m', 'base moves');
            return greet()(ctx);
        };
        let checks = 0;
        const exec = (cmd, args, o) => {
            // The configured prepare check fails once (the attested test sandbox runs it through the exec seam).
            if (/check\.mjs$/.test(args[0] ?? '') && checks++ === 0)
                return { status: 1, stdout: 'not ok\n', stderr: '' };
            return w.exec(cmd, args, o);
        };
        const gateConfig = () => ({ config: { ...localTestConfig(), prepareChecks: [[process.execPath, 'check.mjs']] }, known: [] });
        const lanes = lanesFor(w, [moveBase, review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
        const o = localOpts(w, lanes, { runUserConfig: env.user, gateConfig });
        const out = await runFactoryEngine({ ...o, exec, gateSandbox: attested(exec) });
        expect(out.gate?.name, out.message).toBe('merge');
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        const ciFix = s.lanes.find((l) => l.kind === 'ci-fix');
        // The ci-fix lane started at prepare's merge, which is in the user repository with both its parents.
        const parents = gitIn(w.root, 'rev-list', '--parents', '-n', '1', ciFix.startSha).split(' ');
        expect(parents).toHaveLength(3);
        expect(gitIn(w.root, 'rev-list', '--parents', '-n', '1', ciFix.endSha).split(' ')[1]).toBe(ciFix.startSha);
        expect(gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/omg-import/')).toBe('');
    }, T);
    it('settles a lost lane against the private snapshot, and resumes after an engine crash at the publish push and in the local gate', async () => {
        const env = privateWorld();
        w = env.w;
        const crashes = ['push', 'gate'];
        let pushes = 0;
        const exec = (cmd, args, o) => {
            const plain = args.filter((_, i) => !(args[i] === '-c' || args[i - 1] === '-c'));
            // The publish push of the run's branch (not the mirror's base sync), inside the import section.
            if (crashes[0] === 'push' && plain[0] === 'push' && plain.some((a) => a.includes(':refs/heads/factory/')) && pushes++ === 0) {
                crashes.shift();
                throw new Error('engine crash at the push');
            }
            return w.exec(cmd, args, o);
        };
        let gateCalls = 0;
        const gate = async (argv, cwd, ms) => {
            if (crashes[0] === 'gate' && gateCalls++ === 0) {
                crashes.shift();
                throw new Error('engine crash in the gate');
            }
            return w.gate(argv, cwd, ms);
        };
        const base = { runUserConfig: env.user, exec, localGate: gate };
        // The first implement lane is lost (its job vanished); its child is gone, so it settles and a fresh lane runs.
        // One `running` poll first records its child's pid (dead in FakeProcesses), so the loss can be settled.
        const one = await runFactoryEngine(localOpts(w, new FakeLanes(w.root, [() => ({ lost: true }), greet()], [1]), base));
        expect(one.exitCode, one.message).toBe(1);
        expect(one.message).toMatch(/engine crash at the push/);
        expect(readFactoryState(w.root, LOCAL_ISSUE).lanes.map((l) => l.status)).toEqual(['lost', 'completed']);
        expect(gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/omg-import/')).toBe('');
        const two = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), base));
        expect(two.exitCode, two.message).toBe(1);
        expect(two.message).toMatch(/engine crash in the gate/);
        const three = await runFactoryEngine(localOpts(w, lanesFor(w, []), base));
        expect(three.gate?.name, three.message).toBe('merge');
        expect(readFactoryState(w.root, LOCAL_ISSUE).layout).toBe(2);
    }, T);
    it('a dry run says the private layout would be used; the shared layout\'s dry run is unchanged', async () => {
        const env = privateWorld();
        w = env.w;
        const dry = await runFactoryEngine(opts(env, [], { dryRun: true }));
        expect(dry.message).toMatch(/would start an implement lane capped at \d+ AI credits, in the private layout \(factory\.run\.layout "private" from the user config/);
        const shared = await runFactoryEngine(opts({ w, user: null }, [], { dryRun: true }));
        expect(shared.message).not.toMatch(/layout/);
    }, T);
    it('clean after cancel removes the run dir and never empties your node_modules (the junction target)', async () => {
        const env = privateWorld();
        w = env.w;
        const out = await runFactoryEngine(opts(env, [greet(), review('approve')]));
        expect(out.gate?.name, out.message).toBe('merge');
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const cancelled = await runFactoryEngine(opts(env, []));
        expect(cancelled.phase, cancelled.message).toBe('cancelled');
        const result = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir });
        expect(result.removed).toContain(s.privateDir);
        expect(existsSync(s.privateDir)).toBe(false);
        expect(readFileSync(join(w.root, 'node_modules', 'marker.txt'), 'utf8')).toBe('yours\n');
    }, T);
});
describe('factory.run.layout from the base-committed .copilot/omg.jsonc (review-483 MEDIUM-1)', () => {
    /** The local world with `content` committed as the base's .copilot/omg.jsonc. */
    function baseConfigWorld(content) {
        const world = localWorld();
        mkdirSync(join(world.root, '.copilot'), { recursive: true });
        writeFileSync(join(world.root, '.copilot', 'omg.jsonc'), content);
        gitIn(world.root, 'add', '.copilot/omg.jsonc');
        gitIn(world.root, 'commit', '-q', '-m', 'base config');
        return world;
    }
    const baseConfigReads = () => w.raw.filter((c) => c.args.some((a) => a.endsWith(':.copilot/omg.jsonc'))).length;
    it('a shared run with a base omg.jsonc syntax error runs its lane as before; the strict gate-config load parks on the file later', async () => {
        w = baseConfigWorld('{ "factory": { "run": { "layout": ');
        // The working-tree copy is valid (the project config layer would park on it first: protected paths).
        writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), '{}\n');
        // Ship's strict loader as the engine's local default, without the developer's own user config.
        const gateConfig = (i) => ({
            config: loadTrustedShipConfig({ exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, remote: 'omg-local', user: null, trustedUser: null, warn: i.warn }),
            known: [],
        });
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes, { runUserConfig: null, gateConfig }));
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        expect(s.layout).toBeUndefined();
        expect(s.history.some((h) => /factory\.run\.layout could not be read/.test(h.note))).toBe(false);
        expect(s.lanes.map((l) => l.kind), JSON.stringify(out.gate)).toEqual(['implement', 'review']);
        expect(lanes.started[0].worktree).toBeUndefined();
        // As on dev: the prepare step's strict load fails on the file (a step error the rerun resumes), after the lanes ran.
        expect(out.exitCode, out.message).toBe(1);
        expect(out.gate).toBeUndefined();
        expect(out.message).toMatch(/factory run step prepare failed: the trusted ship config could not be loaded: main [0-9a-f]{12}:\.copilot\/omg\.jsonc is not valid JSONC/);
    }, T);
    it('an untrusted base (not in ship.trustedBases) is never read: its "private" is ignored and the run is shared; a trusted one is read', async () => {
        w = baseConfigWorld('{ "factory": { "run": { "layout": "private" } } }\n');
        const untrusted = lanesFor(w, [greet()]);
        await runFactoryEngine(localOpts(w, untrusted, { runUserConfig: { ship: { trustedBases: ['dev'] } } }));
        expect(baseConfigReads()).toBe(0);
        expect(readFactoryState(w.root, LOCAL_ISSUE).layout).toBeUndefined();
        expect(untrusted.started[0].worktree).toBeUndefined();
        // Control: the same base in a new world, trusted (the defaults name main), is read and makes the run private.
        rmSync(w.dir, { recursive: true, force: true });
        w = baseConfigWorld('{ "factory": { "run": { "layout": "private" } } }\n');
        const work = join(w.dir, 'fw');
        const trusted = lanesFor(w, [greet()]);
        await runFactoryEngine(localOpts(w, trusted, { runUserConfig: { factory: { run: { workDir: work } } } }));
        expect(baseConfigReads()).toBeGreaterThan(0);
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        expect(s.layout).toBe(2);
        expect(trusted.started[0].worktree?.path.startsWith(work)).toBe(true);
    }, T);
});
/** Ship's defaults with the one required check the local forge replaces (as engine-local-harness localTestGateConfig). */
function localTestConfig() {
    return { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [] };
}
function attested(exec) {
    return async (req) => {
        if (req.purpose === 'gate') {
            const r = await w.gate(req.argv, req.cwd, req.timeoutMs);
            return { ran: true, status: r.status, output: r.stdout, timedOut: false };
        }
        if (req.purpose !== 'prepare')
            return { ran: true, status: 0, output: '', timedOut: false };
        const r = exec(req.exe, [...req.args], { cwd: req.cwd });
        return { ran: true, status: r.status, output: `${r.stdout}${r.stderr}`, timedOut: false };
    };
}
//# sourceMappingURL=engine.private.test.js.map