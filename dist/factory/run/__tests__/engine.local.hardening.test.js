/**
 * The local forge side of the git store hardening (item 3): the mirror's
 * hooks never run on the engine's pushes (H1), the trusted base is the sha
 * the engine synced, not the mirror's ref (H2), and the prepare checkout is
 * read through the git links recorded at its creation (M5). Real git, fake
 * lanes and gate, no gh / az / copilot.
 */
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveForgeConfig } from '../../../forge/config.js';
import { localCheckRecordPath, readMirrorRef, writeLocalCheckRecord } from '../../../forge/local/index.js';
import { createForge } from '../../../forge/index.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { forgetWorktreeGitLinks } from '../../../team/git-worktree.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { checkoutPath } from '../prepare.js';
import { factoryStatePath, overwriteFactoryState, readFactoryState, requestFactoryCancel } from '../state.js';
import { cleanFactoryRun } from '../clean.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { EngineLedger } from '../ledger.js';
import { resetFactoryRun } from '../reset.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localTestGateConfig, localWorld } from './engine-local-harness.js';
/** A configured prepare check, so prepare runs the PR's code (a `node` the harness answers) in the checkout. */
const withCheck = {
    gateConfig: (...a) => {
        const g = localTestGateConfig(...a);
        return { ...g, config: { ...g.config, prepareChecks: [['node', 'check.mjs']] } };
    },
};
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const isNode = (cmd) => cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd);
describe('factory run on the local forge: git hardening', () => {
    it('H1: hooks planted in the mirror run on none of the engine pushes', async () => {
        w = localWorld();
        const mirror = w.config.repo.url;
        mkdirSync(dirname(mirror), { recursive: true });
        gitIn(w.dir, 'init', '-q', '--bare', mirror);
        const marker = join(w.dir, 'mirror-hook-ran');
        for (const hook of ['pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction']) {
            writeFileSync(join(mirror, 'hooks', hook), `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
        }
        // Parks at the budget right after the publish: the base sync push and the branch push both went to the mirror.
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet()]), { limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 34 } }));
        expect(out.gate?.name, out.message).toBe('budget');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(readMirrorRef(mirror, `factory/issue-${LOCAL_ISSUE}`)).toBe(state.head);
        expect(readMirrorRef(mirror, BASE)).toBe(gitIn(w.root, 'rev-parse', BASE));
        expect(existsSync(marker)).toBe(false);
    }, 300_000);
    it('H2: a mirror base moved after the engine synced it parks at lane-tampered; the PR is not read as merged', async () => {
        w = localWorld();
        const mirror = w.config.repo.url;
        const inner = w.exec;
        let planted = false;
        w.exec = (cmd, args, opts) => {
            const res = inner(cmd, args, opts);
            // Right after the base sync of prepare's PR read (its last git call reads the tracking ref): something else rewrites the mirror's base.
            if (!planted && cmd === 'git' && args.includes('rev-parse') && args.includes(`refs/remotes/omg-local/${BASE}`) && readFactoryState(w.root, LOCAL_ISSUE)?.phase === 'prepare') {
                planted = true;
                writeFileSync(join(mirror, 'refs', 'heads', BASE), `${readFactoryState(w.root, LOCAL_ISSUE).head}\n`);
            }
            return res;
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(planted).toBe(true);
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(new RegExp(`mirror's ${BASE} is at [0-9a-f]{12}, but the engine synced it to your ${BASE}`));
        expect(readFactoryState(w.root, LOCAL_ISSUE).phase).not.toBe('merged');
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
    it('M5: a prepare check that rewrites the checkout `.git` file parks; no git follows it and the gate never runs', async () => {
        w = localWorld();
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        w.exec = (cmd, args, opts) => {
            // The PR's own code in prepare: point the checkout at the main repository's git dir.
            // Git for Windows hides the `.git` file, and a hidden file cannot be opened with `w`: rewrite it in place.
            if (isNode(cmd) && opts?.cwd === checkout) {
                const fd = openSync(join(checkout, '.git'), 'r+');
                try {
                    ftruncateSync(fd);
                    writeSync(fd, `gitdir: ${join(w.root, '.git')}\n`);
                }
                finally {
                    closeSync(fd);
                }
            }
            return inner(cmd, args, opts);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        // Either the shared-state compare or the read through the recorded links stops it; never the checkout's `.git`.
        expect(out.gate?.reason).toMatch(/^prepare's checks \(the PR's own code\)/);
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
    it('M5: an untracked file a prepare check leaves in the checkout parks before the gate runs', async () => {
        w = localWorld();
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        w.exec = (cmd, args, opts) => {
            if (isNode(cmd) && opts?.cwd === checkout)
                writeFileSync(join(checkout, 'planted.test.js'), 'process.exit(0)\n');
            return inner(cmd, args, opts);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/working tree differs from it \(planted\.test\.js\)/);
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
    it.each([
        ['a skip-worktree edit', (checkout) => {
                writeFileSync(join(checkout, 'src', 'greet.js'), 'export const greet = () => "pwned";\n');
                gitIn(checkout, 'update-index', '--skip-worktree', 'src/greet.js');
                expect(gitIn(checkout, 'status', '--porcelain')).toBe('');
            }, /src\/greet\.js/],
        ['an edit that keeps the size and the mtime', (checkout) => {
                const file = join(checkout, 'src', 'greet.js');
                const { atime, mtime } = statSync(file);
                writeFileSync(file, 'export const greet = () => "HI";\n');
                utimesSync(file, atime, mtime);
            }, /src\/greet\.js/],
    ])('M-A: %s a prepare check leaves in the checkout parks before the gate runs', async (_what, plant, listed) => {
        w = localWorld();
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        let planted = false;
        w.exec = (cmd, args, opts) => {
            const res = inner(cmd, args, opts);
            if (!planted && isNode(cmd) && opts?.cwd === checkout) {
                planted = true;
                plant(checkout);
            }
            return res;
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(planted).toBe(true);
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/working tree differs from it \(/);
        expect(out.gate?.reason).toMatch(listed);
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
    it('B1: ignored output a prepare check writes (dist/, .omg/) stays for the gate, which can read it; the node_modules link and its target are untouched', async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\ndist/\nnode_modules/\n');
        gitIn(w.root, 'commit', '-q', '-am', 'ignore build output');
        // A temp-dir node_modules in the test repository (never a real one): the engine links it into its checkout.
        mkdirSync(join(w.root, 'node_modules'));
        writeFileSync(join(w.root, 'node_modules', 'marker.txt'), 'keep\n');
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        w.exec = (cmd, args, opts) => {
            if (isNode(cmd) && opts?.cwd === checkout) {
                mkdirSync(join(checkout, 'dist', 'sub'), { recursive: true });
                writeFileSync(join(checkout, 'dist', 'sub', 'out.js'), 'built\n');
                mkdirSync(join(checkout, '.omg'), { recursive: true });
                writeFileSync(join(checkout, '.omg', 'setup.js'), 'process.exit(0)\n');
            }
            return inner(cmd, args, opts);
        };
        const seen = [];
        const gate = w.gate;
        w.gate = async (argv, cwd, ...rest) => {
            seen.push({ dist: existsSync(join(cwd, 'dist', 'sub', 'out.js')) ? readFileSync(join(cwd, 'dist', 'sub', 'out.js'), 'utf8') : null, omg: existsSync(join(cwd, '.omg')), marker: existsSync(join(cwd, 'node_modules', 'marker.txt')) });
            return gate(argv, cwd, ...rest);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(seen).toEqual([{ dist: 'built\n', omg: true, marker: true }]);
        expect(readFileSync(join(w.root, 'node_modules', 'marker.txt'), 'utf8')).toBe('keep\n');
    }, 300_000);
    it("B1: a previous gate's ignored output in the reused checkout (a resume after a PENDING gate) stays and is not parked on", async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\ncoverage/\n');
        gitIn(w.root, 'commit', '-q', '-am', 'ignore coverage');
        // The first gate writes its output, then the engine "dies" (a gate that never reports: no record, parked).
        w.gate = async (_argv, cwd) => {
            mkdirSync(join(cwd, 'coverage'), { recursive: true });
            writeFileSync(join(cwd, 'coverage', 'lcov.info'), 'TN:\n');
            return { status: 127, stdout: '', stderr: '', timedOut: false, startError: 'simulated crash' };
        };
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('gates');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        expect(existsSync(join(checkout, 'coverage', 'lcov.info'))).toBe(true);
        writeLocalCheckRecord(w.stateDir, w.root, { name: 'local-gate', head: state.head, state: 'PENDING', argv: ['node', '--test'], runId: 1, startedAt: '2020-01-01T00:00:00.000Z' });
        const seen = [];
        w.gate = async (_argv, cwd) => {
            seen.push(existsSync(join(cwd, 'coverage')));
            return { status: 0, stdout: 'ok\n', stderr: '', timedOut: false };
        };
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(again.gate?.name, again.message).toBe('merge');
        expect(seen).toEqual([true]);
    }, 300_000);
    it('B1: an ignored junction or symlink a prepare check leaves (pulling content from outside) parks before the gate', async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\ndist/\n');
        gitIn(w.root, 'commit', '-q', '-am', 'ignore build output');
        const outside = join(w.dir, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'planted.test.js'), 'process.exit(0)\n');
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        w.exec = (cmd, args, opts) => {
            if (isNode(cmd) && opts?.cwd === checkout && !existsSync(join(checkout, 'dist'))) {
                mkdirSync(join(checkout, 'dist', 'sub'), { recursive: true });
                symlinkSync(outside, join(checkout, 'dist', 'sub', 'ext'), process.platform === 'win32' ? 'junction' : 'dir');
            }
            return inner(cmd, args, opts);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/has an ignored symlink or junction dist\/sub\/ext the engine did not make/);
        expect(w.gateRuns).toEqual([]);
        expect(existsSync(join(outside, 'planted.test.js'))).toBe(true);
    }, 300_000);
    it('a prepare checkout removed by hand is prepared again on the next run; the gate then runs in the fresh checkout', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        // This test repository has no node_modules, so no link is inside the checkout.
        gitIn(w.root, 'worktree', 'remove', '--force', checkout);
        rmSync(localCheckRecordPath(w.stateDir, w.root, head));
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(again.gate?.name, again.message).toBe('merge');
        expect(w.gateRuns).toHaveLength(2);
        expect(w.gateRuns[1].cwd).toBe(checkout);
        expect(existsSync(checkout)).toBe(true);
    }, 300_000);
    it("M-E: the user's own git gc, commit-graph and multi-pack-index writes during prepare do not park; the run reaches the merge gate", async () => {
        w = localWorld();
        const inner = w.exec;
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        let wrote = false;
        w.exec = (cmd, args, opts) => {
            if (!wrote && isNode(cmd) && opts?.cwd === checkout) {
                wrote = true;
                // What a user's `git gc` (pack-refs, repack with update-server-info, commit-graph) and maintenance write.
                gitIn(w.root, 'gc', '--quiet');
                gitIn(w.root, 'commit-graph', 'write', '--reachable');
                gitIn(w.root, 'multi-pack-index', 'write', '--bitmap');
            }
            return inner(cmd, args, opts);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
        expect(wrote).toBe(true);
        expect(existsSync(join(w.root, '.git', 'objects', 'pack', 'multi-pack-index'))).toBe(true);
        expect(out.gate?.name, out.message).toBe('merge');
        expect(w.gateRuns).toHaveLength(1);
    }, 300_000);
    it('M-B: a sibling admin dir the checkout `.git` names in a later invocation parks; the gate never runs', async () => {
        w = localWorld(null);
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.reason, first.message).toMatch(/no local gate/);
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        const admin = join(w.root, '.git', 'worktrees', state.checkoutAdmin);
        expect(existsSync(admin)).toBe(true);
        // Between invocations: a copy of the admin dir (its own HEAD and index) that the checkout's `.git` now names.
        const sibling = `${admin}-x`;
        cpSync(admin, sibling, { recursive: true });
        const fd = openSync(join(checkout, '.git'), 'r+');
        try {
            ftruncateSync(fd);
            writeSync(fd, `gitdir: ${sibling}\n`);
        }
        finally {
            closeSync(fd);
        }
        // A new process: nothing recorded in memory.
        forgetWorktreeGitLinks(checkout);
        w.config = resolveForgeConfig({ factory: { forge: { kind: 'local', local: { gate: ['node', '--test'] } } } }, undefined, undefined, undefined, { root: w.root, stateDir: w.stateDir }).config;
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(new RegExp(`names the admin dir .*-x, but the engine's \`worktree add\` made ${state.checkoutAdmin}`));
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
    it('M-B upgrade: a checkout made before checkoutAdmin was recorded names the recovery; cancel, clean (B3: mirror checked), reset and a rerun prepare a fresh one', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        // What an older release left: the same state without checkoutAdmin (written and recorded as that engine would), a new process.
        const { checkoutAdmin: _a, ...older } = readFactoryState(w.root, LOCAL_ISSUE);
        const { content } = overwriteFactoryState(w.root, LOCAL_ISSUE, older);
        EngineLedger.open(w.ledgerDir, w.root, LOCAL_ISSUE).record(factoryStatePath(w.root, LOCAL_ISSUE), content);
        forgetWorktreeGitLinks(checkout);
        // A checks rerun: the gate is due again.
        rmSync(localCheckRecordPath(w.stateDir, w.root, older.head));
        const parked = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(parked.gate?.name, parked.message).toBe('lane-tampered');
        expect(parked.gate?.reason).toMatch(/a checkout made before this release.*run omg factory run cancel 7, omg factory run clean 7, omg factory run reset 7, then omg factory run 7: the new run prepares again/);
        expect(w.gateRuns).toHaveLength(1);
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        expect((await runFactoryEngine(localOpts(w, lanesFor(w, [])))).phase).toBe('cancelled');
        const owner = { pid: 4242, hostname: 'test-host', isAlive: () => false };
        // B3: clean's fetch and ls-remote check the mirror like the engine's: a planted commondir refuses it.
        const commondir = join(w.config.repo.url, 'commondir');
        writeFileSync(commondir, `${join(w.dir, 'evil.git')}\n`);
        expect(() => cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner })).toThrow(/has commondir, which would point git at another repository/);
        expect(existsSync(checkout)).toBe(true);
        rmSync(commondir);
        const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner });
        expect(cleaned.kept, JSON.stringify(cleaned.kept)).toEqual([]);
        expect(existsSync(checkout)).toBe(false);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner });
        const rerun = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(rerun.gate?.name, rerun.message).toBe('merge');
        expect(w.gateRuns).toHaveLength(2);
        expect(w.gateRuns[1].cwd).toBe(checkout);
        expect(readFactoryState(w.root, LOCAL_ISSUE).checkoutAdmin).toBeTruthy();
    }, 600_000);
    it('M-C: a PR store set to MERGED while your base does not contain the head parks; the run is not merged', async () => {
        w = localWorld();
        const prs = join(w.config.repo.url.replace(/\.git$/, ''), 'prs.json');
        const inner = w.exec;
        let planted = false;
        w.exec = (cmd, args, opts) => {
            if (!planted && cmd === 'git' && existsSync(prs) && readFactoryState(w.root, LOCAL_ISSUE)?.phase === 'prepare') {
                planted = true;
                const store = JSON.parse(readFileSync(prs, 'utf8'));
                for (const p of store.prs)
                    Object.assign(p, { state: 'MERGED', mergedHead: readFactoryState(w.root, LOCAL_ISSUE).head, mergedAt: new Date().toISOString() });
                writeFileSync(prs, JSON.stringify(store));
            }
            return inner(cmd, args, opts);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(planted).toBe(true);
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(new RegExp(`reports PR #\\d+ merged, but your ${BASE} [0-9a-f]{12} does not contain the head the engine pushed`));
        expect(readFactoryState(w.root, LOCAL_ISSUE).phase).not.toBe('merged');
        expect(w.gateRuns).toEqual([]);
    }, 300_000);
});
//# sourceMappingURL=engine.local.hardening.test.js.map