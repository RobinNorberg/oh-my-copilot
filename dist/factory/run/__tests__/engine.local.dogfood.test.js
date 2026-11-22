/**
 * Offline factory dogfood round 2 on the local forge engine (F37-F42): fake
 * lanes, a real repository with no origin, the engine-owned bare mirror
 * under a temp forge state dir. No gh, az or copilot runs, and no AI credits.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMirrorRef } from '../../../forge/local/index.js';
import { createForge } from '../../../forge/index.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { cleanFactoryRun } from '../clean.js';
import { cancelCommand, runFactoryEngine, EXIT_AWAITING_HUMAN } from '../engine.js';
import { factoryForgeOptions, syncLocalMirror } from '../forge-roots.js';
import { ledgerFilePath } from '../ledger.js';
import { resetFactoryRun } from '../reset.js';
import { FactoryBusyError, factoryRepoOwnerPath, factoryStatePath, readFactoryState, requestFactoryCancel } from '../state.js';
import { factoryClaimPath } from '../claims.js';
import { attestedSandbox, commitFile, gitIn, review } from './fake-lanes.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const BRANCH = `factory/issue-${LOCAL_ISSUE}`;
/** Tests that drive the engine several times (each run is a real repository, mirror and prepare checkout). */
const MULTI_RUN_MS = 300_000;
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };
const forgeWith = (gate) => ({ config: { ...w.config, local: { ...w.config.local, gate } }, options: { ...factoryForgeOptions(w.root), stateDir: w.stateDir } });
const prStore = () => JSON.parse(readFileSync(join(w.config.repo.url.slice(0, -'.git'.length), 'prs.json'), 'utf8'));
const notStarted = async () => ({ status: 127, stdout: '', stderr: '', timedOut: false, startError: 'the local gate executable pnpm is not on PATH' });
/** The plain (unsandboxed) gate runner's start errors: factory.run.sandbox.gates "unsandboxed" (under "enforced" the gate runs in the sandbox, where a start failure is no verdict). */
const UNSANDBOXED_GATES = { factory: { run: { sandbox: { gates: 'unsandboxed' } } } };
/** Commit package.json on the base, so the lanes branch from it. */
function basePackage(scripts) {
    const text = `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts }, null, 2)}\n`;
    writeFileSync(join(w.root, 'package.json'), text);
    gitIn(w.root, 'add', 'package.json');
    gitIn(w.root, 'commit', '-q', '-m', 'package.json');
    return text;
}
describe('F37: a sealed gate that never started does not bind the run', () => {
    it('a rerun after the unstartable-gate park adopts the fixed trusted gate and reaches the merge gate', async () => {
        w = localWorld(['pnpm', 'test']);
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { localGate: notStarted, gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(out.gate?.name, out.message).toBe('gates');
        expect(out.gate?.reason).toMatch(/the local gate could not start/);
        expect(readFactoryState(w.root, LOCAL_ISSUE).localGate).toEqual(['pnpm', 'test']);
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { forge: forgeWith(['npm', 'test']) }));
        expect(again.exitCode, again.message).toBe(0);
        expect(again.gate?.name).toBe('merge');
        expect(w.gateRuns.map((r) => r.argv)).toEqual([['npm', 'test']]);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.localGate).toEqual(['npm', 'test']);
        expect(state.history.some((h) => h.note === 'local gate re-sealed as npm test: the recorded pnpm test never started')).toBe(true);
    }, MULTI_RUN_MS);
});
describe('F38: cancel closes the local PR; clean + reset make the item runnable again', () => {
    it('cancel -> local PR CLOSED (cancelled) -> clean -> reset keeps the branch aside -> a new run opens a new PR', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const oldHead = readFactoryState(w.root, LOCAL_ISSUE).head;
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const cancelled = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(cancelled.phase, cancelled.message).toBe('cancelled');
        expect(prStore().prs.find((p) => p.number === 1)).toMatchObject({ state: 'CLOSED', closedReason: 'cancelled', closedHead: oldHead });
        const comments = readFileSync(join(w.root, '.omg', 'factory', 'local', 'prs', '1', 'comments.md'), 'utf8');
        expect(comments).toMatch(/The local PR is closed \(cancelled\).*omg factory run reset 7/);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const resetOpts = { root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER };
        // A live engine in this checkout makes clean and reset busy (exit 6) before any git, forge or ledger step.
        const busyOwner = { ...OWNER, isAlive: () => true };
        writeFileSync(factoryRepoOwnerPath(w.root), JSON.stringify({ pid: 99, hostname: OWNER.hostname, startedAt: 'x', run: '8' }));
        expect(() => cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: busyOwner })).toThrow(FactoryBusyError);
        expect(() => resetFactoryRun({ ...resetOpts, owner: busyOwner })).toThrow(FactoryBusyError);
        rmSync(factoryRepoOwnerPath(w.root));
        const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
        expect(cleaned.kept, JSON.stringify(cleaned.kept)).toEqual([]);
        // A claim on the item that a live engine in another clone holds makes reset busy; this checkout's own parked claim is deleted by it.
        const claimRepo = 'https://github.com/o/r';
        const claim = factoryClaimPath(w.ledgerDir, claimRepo, w.root, LOCAL_ISSUE);
        mkdirSync(dirname(claim), { recursive: true });
        writeFileSync(claim, JSON.stringify({ pid: 99, hostname: OWNER.hostname, startedAt: 'x', run: '7', root: join(dirname(w.root), 'other-clone') }));
        expect(() => resetFactoryRun({ ...resetOpts, claimRepo, owner: busyOwner })).toThrow(/factory run #7 is claimed by a live engine .*claim file/);
        writeFileSync(claim, JSON.stringify({ hostname: OWNER.hostname, startedAt: 'x', run: '7', root: w.root, parkedAt: 'x' }));
        const reset = resetFactoryRun({ ...resetOpts, claimRepo, now: '2026-11-08T10:00:00.000Z' });
        expect(existsSync(claim)).toBe(false);
        expect(reset.closedPr).toBeUndefined(); // the cancel already closed it
        expect(reset.keptBranch).toBe('factory/cancelled/issue-7-2026-11-08t10-00-00-000z');
        expect(readMirrorRef(w.config.repo.url, reset.keptBranch)).toBe(oldHead);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
        expect(existsSync(reset.stateMovedTo)).toBe(true);
        const rerun = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        expect(rerun.exitCode, rerun.message).toBe(0);
        expect(rerun.gate?.name).toBe('merge');
        expect(readFactoryState(w.root, LOCAL_ISSUE).pr).toBe(2);
        expect(prStore().prs.map((p) => [p.number, p.state])).toEqual([[1, 'CLOSED'], [2, 'OPEN']]);
    }, MULTI_RUN_MS);
    it('a reset rerun after one that stopped midway finishes, reusing the kept branch at the same sha', async () => {
        w = localWorld();
        await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        const oldHead = readFactoryState(w.root, LOCAL_ISSUE).head;
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        expect((await runFactoryEngine(localOpts(w, lanesFor(w, [])))).phase).toBe('cancelled');
        cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
        // The first reset kept the branch and moved the ledger aside, then stopped before moving the state.
        const earlier = `factory/cancelled/issue-${LOCAL_ISSUE}-2026-11-08t09-00-00-000z`;
        gitIn(w.root, 'push', '-q', w.config.repo.url, `${oldHead}:refs/heads/${earlier}`);
        const ledger = ledgerFilePath(w.ledgerDir, w.root, LOCAL_ISSUE);
        renameSync(ledger, `${ledger}.reset-2026-11-08T09-00-00-000Z`);
        // A run in between refuses and points at the reset that finishes it.
        const refused = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(refused.exitCode).toBe(1);
        expect(refused.message).toMatch(new RegExp(`Run omg factory run reset ${LOCAL_ISSUE} to finish a reset`));
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const reset = resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER, now: '2026-11-08T10:00:00.000Z' });
        expect(reset.keptBranch).toBe(earlier);
        expect(readMirrorRef(w.config.repo.url, 'factory/cancelled/issue-7-2026-11-08t10-00-00-000z')).toBeUndefined();
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
        // A state the engine never wrote (no ledger, no matching aside) is still refused.
        writeFileSync(factoryStatePath(w.root, LOCAL_ISSUE), readFileSync(reset.stateMovedTo, 'utf8'));
        rmSync(`${ledger}.reset-2026-11-08T09-00-00-000Z`);
        expect(() => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER }))
            .toThrow(/is not the engine's last write/);
    }, MULTI_RUN_MS);
    it('reset refuses a run that is not cancelled', async () => {
        w = localWorld();
        await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        expect(() => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER }))
            .toThrow(/is merge \(awaiting-human: merge\); reset starts over a cancelled run only/);
    });
});
describe('a dotnet gate: its MSBuild files define it, and its write lanes get the dotnet sandbox', () => {
    const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
    function baseProject() {
        mkdirSync(join(w.root, 'src', 'App'), { recursive: true });
        writeFileSync(join(w.root, 'App.sln'), 'Microsoft Visual Studio Solution File\n');
        writeFileSync(join(w.root, 'src', 'App', 'App.csproj'), CSPROJ);
        gitIn(w.root, 'add', '.');
        gitIn(w.root, 'commit', '-q', '-m', 'project');
    }
    it('a code-only change runs the gate and reaches the merge gate; the write lane (not the review lane) is started with dotnet', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App; public static class Greet { }\n'), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        expect(w.gateRuns.map((r) => r.argv)).toEqual([['dotnet', 'test']]);
        expect(lanes.started.map((l) => [l.profile ?? 'write', l.dotnet ?? false])).toEqual([['write', true], ['review', false]]);
    }, MULTI_RUN_MS);
    it('a lane that edits a project file parks at gate-definition-changed, naming that file (nothing pushed)', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', CSPROJ.replace('</PropertyGroup>', '  <Target Name="VSTest" />\n  </PropertyGroup>'))])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/redefines the local gate "dotnet test" \(src\/App\/App\.csproj differ from main\).*diff [0-9a-f]{12} [0-9a-f]{12} -- src\/App\/App\.csproj, then rerun/);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
    }, MULTI_RUN_MS);
    it('a lane that adds a Directory.Build.props parks too', async () => {
        w = localWorld(['dotnet', 'build']);
        baseProject();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('Directory.Build.props', '<Project />\n')])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/\(Directory\.Build\.props differ from main\)/);
    }, MULTI_RUN_MS);
    it('a lane that adds a project\'s .user file (MSBuild imports it beside the project) parks, naming it', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const user = '<Project>\n  <PropertyGroup>\n    <IsTestProject>false</IsTestProject>\n  </PropertyGroup>\n</Project>\n';
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj.user', user)])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/\(src\/App\/App\.csproj\.user differ from main\).* -- src\/App\/App\.csproj\.user, then rerun/);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
    }, MULTI_RUN_MS);
    it('the same change landing on the base (the mirror\'s current base) lets the parked head through on a plain rerun', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const changed = CSPROJ.replace('net10.0', 'net9.0');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/App.csproj', changed)])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        // The human lands the identical project change on main; the run's recorded base is still the old one.
        writeFileSync(join(w.root, 'src', 'App', 'App.csproj'), changed);
        gitIn(w.root, 'commit', '-q', '-am', 'base: net9.0');
        // The mirror's base moves as the engine's own fetch would move it (syncLocalMirror).
        syncLocalMirror(w.exec, w.root, w.config.repo.url, BASE);
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')])));
        expect(again.gate?.name, again.message).not.toBe('gate-definition-changed');
        expect(readFactoryState(w.root, LOCAL_ISSUE).gateChangeApproved).toBeUndefined();
    }, MULTI_RUN_MS);
    it('a git ls-tree failure while comparing the definition fails the step and pushes nothing', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const exec = w.exec;
        const failing = (cmd, args, opts) => (cmd === 'git' && args.includes('ls-tree') && args.includes('--full-tree') ? { status: 128, stdout: '', stderr: 'fatal: not a tree object' } : exec(cmd, args, opts));
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n')]), { exec: failing }));
        expect(out.exitCode, out.message).not.toBe(0);
        expect(out.message).toMatch(/git ls-tree [0-9a-f]{12} failed: fatal: not a tree object/);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('an ignored definition file the PR\'s code left in the prepare checkout parks the next gate run at lane-tampered', async () => {
        w = localWorld(['dotnet', 'test']);
        writeFileSync(join(w.root, '.gitignore'), '.omg/\n*.user\n');
        baseProject();
        // The first gate run (the PR's test code) leaves an ignored App.csproj.user and does not start (no verdict).
        w.gate = async (argv, cwd) => {
            w.gateRuns.push({ argv, cwd, head: gitIn(cwd, 'rev-parse', 'HEAD') });
            writeFileSync(join(cwd, 'src', 'App', 'App.csproj.user'), '<Project />\n');
            return { status: 127, stdout: '', stderr: '', timedOut: false, startError: 'dotnet is not on PATH' };
        };
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(first.gate?.name, first.message).toBe('gates');
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(again.gate?.name, again.message).toBe('lane-tampered');
        expect(again.gate?.reason).toMatch(/untracked file\(s\) that MSBuild reads for the dotnet gate but no commit pins \(src\/App\/App\.csproj\.user\)/);
        expect(w.gateRuns).toHaveLength(1);
    }, MULTI_RUN_MS);
    /** The first gate run (the PR's code) runs `leave` in the checkout and does not start; later runs see what is left. */
    function leaveThenSee(leave, sees) {
        const seen = [];
        w.gate = async (argv, cwd) => {
            const first = w.gateRuns.length === 0;
            w.gateRuns.push({ argv, cwd, head: gitIn(cwd, 'rev-parse', 'HEAD') });
            if (first) {
                leave(cwd);
                return { status: 127, stdout: '', stderr: '', timedOut: false, startError: 'dotnet is not on PATH' };
            }
            const leftover = sees(cwd);
            seen.push(leftover);
            return { status: leftover ? 1 : 0, stdout: '', stderr: '', timedOut: false };
        };
        return seen;
    }
    const writeAt = (cwd, rel, text = '<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>\n') => {
        mkdirSync(dirname(join(cwd, rel)), { recursive: true });
        writeFileSync(join(cwd, rel), text);
    };
    /**
     * The test sandbox (the clean step's logic in process), a gate that did not start reported as handed over with no
     * verdict (the PR's code ran: no ack park), and optionally the clean step replaced.
     */
    const cleanStep = (clean) => {
        const inner = attestedSandbox(() => w.exec, () => w.gate);
        return async (req) => {
            if (req.purpose === 'clean' && clean)
                return clean(req);
            const r = await inner(req);
            return req.purpose === 'gate' && !r.ran ? { ...r, started: true } : r;
        };
    };
    const firstRun = async (over = {}) => {
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), over));
        expect(out.gate?.name, out.message).toMatch(/^gate(s|-no-verdict)$/);
    };
    const staleBuild = (cwd) => {
        writeAt(cwd, 'src/App/obj/App.csproj.nuget.g.targets');
        writeAt(cwd, 'src/App/bin/Debug/net10.0/App.dll', 'stale');
    };
    const seesStale = (cwd) => existsSync(join(cwd, 'src', 'App', 'obj', 'App.csproj.nuget.g.targets')) || existsSync(join(cwd, 'src', 'App', 'bin', 'Debug', 'net10.0', 'App.dll'));
    const ignoreBuild = () => writeFileSync(join(w.root, '.gitignore'), '.omg/\nbin/\nobj/\n');
    it('F1: restore output and a stale build the PR\'s code left under obj/ and bin/ are removed by the sandboxed step before the next gate run; a tracked bin/ file stays', async () => {
        w = localWorld(['dotnet', 'test']);
        ignoreBuild();
        baseProject();
        mkdirSync(join(w.root, 'src', 'App', 'bin'), { recursive: true });
        writeFileSync(join(w.root, 'src', 'App', 'bin', 'tracked.txt'), 'kept\n');
        gitIn(w.root, 'add', '-f', 'src/App/bin/tracked.txt');
        gitIn(w.root, 'commit', '-q', '-m', 'tracked bin file');
        const seen = leaveThenSee(staleBuild, (cwd) => seesStale(cwd) || !existsSync(join(cwd, 'src', 'App', 'bin', 'tracked.txt')));
        const steps = [];
        const inner = cleanStep();
        const gateSandbox = (req) => {
            if (req.purpose === 'clean')
                steps.push(req);
            return inner(req);
        };
        await firstRun({ gateSandbox });
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox }));
        expect(again.gate?.name, again.message).toBe('merge');
        expect(seen).toEqual([false]);
        // One step, through the sandbox runner: node <omg>/dist/.../dotnet-clean-step.js <kept>, no network, in the checkout.
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({ purpose: 'clean', network: 'none', exe: process.execPath, cwd: w.gateRuns[0].cwd });
        expect(steps[0].args[0]).toMatch(/[\\/]dist[\\/]factory[\\/]run[\\/]dotnet-clean-step\.js$/);
        expect(steps[0].args.slice(1)).toEqual(['src/App/bin/tracked.txt']);
        expect(readFactoryState(w.root, LOCAL_ISSUE).history.some((h) => /^removed 2 build output entries under bin\/, obj\/ and artifacts\/ in the prepare checkout in the OS sandbox before the dotnet gate on [0-9a-f]{12} \(\d+ s\)$/.test(h.note))).toBe(true);
    }, MULTI_RUN_MS);
    it('H1: a git repository the PR\'s code made in obj/ (hiding its files from git) is removed by the step and the gate runs clean', async () => {
        w = localWorld(['dotnet', 'test']);
        ignoreBuild();
        baseProject();
        const seen = leaveThenSee((cwd) => {
            staleBuild(cwd);
            writeAt(cwd, 'src/App/obj/Evil.props', '<Project />\n');
            gitIn(join(cwd, 'src', 'App', 'obj'), 'init', '-q');
        }, (cwd) => seesStale(cwd) || existsSync(join(cwd, 'src', 'App', 'obj')));
        const gateSandbox = cleanStep();
        await firstRun({ gateSandbox });
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox }));
        expect(again.gate?.name, again.message).toBe('merge');
        expect(seen).toEqual([false]);
    }, MULTI_RUN_MS);
    it('follow-up 1: a lane whose change commits build output under obj/ parks at gate-definition-changed before any push, naming it', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const lane = (ctx) => {
            writeAt(ctx.worktree, 'src/App/obj/project.assets.json', '{}\n');
            return commitFile('src/App/Greet.cs', 'namespace App;\n')(ctx);
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [lane])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/\(src\/App\/obj\/project\.assets\.json differ from main\); tracked files under bin\/, obj\/ or artifacts\/ are build output MSBuild may reuse instead of building the change, so they count as the gate's definition/);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('follow-up 2: content the PR\'s code wrote under a submodule (gitlink) dir parks at lane-tampered before the dotnet gate, in any gate mode', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        gitIn(w.root, 'update-index', '--add', '--cacheinfo', `160000,${gitIn(w.root, 'rev-parse', 'HEAD').trim()},Lib`);
        gitIn(w.root, 'commit', '-q', '-m', 'submodule Lib');
        leaveThenSee((cwd) => {
            writeAt(cwd, 'Lib/Lib.csproj');
            writeAt(cwd, 'Lib/obj/stale.dll', 'stale');
        }, () => false);
        await firstRun({ gateSandboxUserConfig: UNSANDBOXED_GATES });
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(again.gate?.name, again.message).toBe('lane-tampered');
        expect(again.gate?.reason).toMatch(/has content in the submodule \(gitlink\) dir Lib, which git does not list/);
        expect(w.gateRuns).toHaveLength(1);
    }, MULTI_RUN_MS);
    it('a mixed repo: a nested node_modules the engine did not make (bin/ dirs, a junction-backed package, *.props and *.vcxproj files) is neither cleaned nor parked on', async () => {
        w = localWorld(['dotnet', 'test']);
        writeFileSync(join(w.root, '.gitignore'), '.omg/\nbin/\nobj/\nnode_modules/\n');
        baseProject();
        // What a trusted prepare build's `npm ci --prefix src/Web/ClientApp` (or pnpm) leaves: real packages and a linked one.
        const store = join(w.dir, 'pnpm-store');
        try {
            writeAt(store, 'esbuild/bin/esbuild', 'esbuild');
            const pkgs = 'src/Web/ClientApp/node_modules';
            const seen = leaveThenSee((cwd) => {
                writeAt(cwd, `${pkgs}/vite/bin/vite.js`, 'vite');
                writeAt(cwd, `${pkgs}/addon/build/addon.vcxproj`);
                writeAt(cwd, `${pkgs}/addon/build/config.props`);
                mkdirSync(join(cwd, ...pkgs.split('/')), { recursive: true });
                symlinkSync(join(store, 'esbuild'), join(cwd, ...pkgs.split('/'), 'esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
                staleBuild(cwd);
            }, (cwd) => seesStale(cwd) || !existsSync(join(cwd, ...pkgs.split('/'), 'vite', 'bin', 'vite.js')) || !existsSync(join(cwd, ...pkgs.split('/'), 'esbuild', 'bin', 'esbuild')));
            await firstRun({ gateSandbox: cleanStep() });
            const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox: cleanStep() }));
            expect(again.gate?.name, again.message).toBe('merge');
            expect(seen).toEqual([false]);
            expect(readFileSync(join(store, 'esbuild', 'bin', 'esbuild'), 'utf8')).toBe('esbuild');
            unlinkSync(join(w.gateRuns[0].cwd, ...pkgs.split('/'), 'esbuild'));
        }
        finally {
            rmSync(store, { recursive: true, force: true });
        }
    }, MULTI_RUN_MS);
    it('a head tracking a .NET project under a node_modules dir parks before the dotnet gate: build output there is not cleaned', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        // On the base, so the change does not redefine the gate: the park is about the head's tree, whoever added the file.
        mkdirSync(join(w.root, 'x', 'node_modules', 'App'), { recursive: true });
        writeFileSync(join(w.root, 'x', 'node_modules', 'App', 'App.csproj'), CSPROJ);
        gitIn(w.root, 'add', '.');
        gitIn(w.root, 'commit', '-q', '-m', 'a project under node_modules');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]), { gateSandbox: cleanStep() }));
        expect(out.gate?.name, out.message).toBe('gates');
        expect(out.gate?.reason).toMatch(/a tracked \.NET project under a node_modules directory is not supported: build output there is not cleaned \([0-9a-f]{12} tracks x\/node_modules\/App\/App\.csproj\)/);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('follow-up 4: a base global.json that cannot be read fails the step (it parks), never "not Microsoft.Testing.Platform"', async () => {
        w = localWorld(['dotnet', 'build']);
        baseProject();
        writeFileSync(join(w.root, 'global.json'), '{ "sdk": { "version": "10.0.101" } }\n');
        gitIn(w.root, 'add', 'global.json');
        gitIn(w.root, 'commit', '-q', '-m', 'global.json');
        const exec = w.exec;
        const failing = (cmd, args, opts) => (cmd === 'git' && args.includes('show') && args.some((a) => a.endsWith(':global.json')) ? { status: 128, stdout: '', stderr: 'fatal: bad object' } : exec(cmd, args, opts));
        // A backend that reads the sandbox: the write prompt asks for the Microsoft.Testing.Platform variant (dotnetMtpBase).
        const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n')]);
        lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true });
        const out = await runFactoryEngine(localOpts(w, lanes, { exec: failing }));
        expect(out.exitCode, out.message).not.toBe(0);
        expect(out.message).toMatch(/global\.json could not be read \(git show exit 128: fatal: bad object\)/);
        expect(lanes.started).toEqual([]);
    }, MULTI_RUN_MS);
    it('a nested git repository outside the build dirs parks at lane-tampered before the dotnet gate runs, in any gate mode', async () => {
        w = localWorld(['dotnet', 'test']);
        writeFileSync(join(w.root, '.gitignore'), '.omg/\nvendor/\n');
        baseProject();
        leaveThenSee((cwd) => {
            writeAt(cwd, 'vendor/lib/Directory.Build.props', '<Project />\n');
            gitIn(join(cwd, 'vendor', 'lib'), 'init', '-q');
        }, () => false);
        await firstRun({ gateSandboxUserConfig: UNSANDBOXED_GATES });
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(again.gate?.name, again.message).toBe('lane-tampered');
        expect(again.gate?.reason).toMatch(/untracked nested git repository \(vendor\/lib\/\)/);
        expect(w.gateRuns).toHaveLength(1);
    }, MULTI_RUN_MS);
    it('the engine\'s check after the step parks at lane-tampered when anything is left under a build dir', async () => {
        w = localWorld(['dotnet', 'test']);
        ignoreBuild();
        baseProject();
        leaveThenSee(staleBuild, () => false);
        // A step that reports success but removed nothing.
        const gateSandbox = cleanStep(async () => ({ ran: true, status: 0, output: 'removed 2', timedOut: false }));
        await firstRun({ gateSandbox });
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox }));
        expect(again.gate?.name, again.message).toBe('lane-tampered');
        expect(again.gate?.reason).toMatch(/after the sandboxed step that empties the dotnet gate's build dirs, the engine's prepare checkout .* still holds src\/App\/(bin|obj)\//);
        expect(w.gateRuns).toHaveLength(1);
    }, MULTI_RUN_MS);
    it('a failing or timed-out step parks at lane-tampered with its error lines; a step that cannot start parks at gates; the gate never runs', async () => {
        w = localWorld(['dotnet', 'test']);
        ignoreBuild();
        baseProject();
        leaveThenSee(staleBuild, () => false);
        let answer = { ran: true, status: 1, output: 'removed 0\nerror src/App/obj: EPERM: operation not permitted', timedOut: false };
        const gateSandbox = cleanStep(async () => answer);
        await firstRun({ gateSandbox });
        const failed = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox }));
        expect(failed.gate?.name, failed.message).toBe('lane-tampered');
        expect(failed.gate?.reason).toMatch(/failed \(exit 1\): error src\/App\/obj: EPERM: operation not permitted/);
        const cases = [
            [{ ran: true, status: 124, output: '', timedOut: true }, 'lane-tampered', /timed out after 5 min/],
            [{ ran: false, reason: 'the sandbox runtime failed while the command ran', started: true }, 'lane-tampered', /gave no verdict/],
            [{ ran: false, reason: 'copilot CLI not found' }, 'gates', /did not start \(copilot CLI not found\); nothing was removed/],
        ];
        for (const [next, park, text] of cases) {
            answer = next;
            const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandbox }));
            expect(again.gate?.name, again.message).toBe(park);
            expect(again.gate?.reason).toMatch(text);
        }
        expect(w.gateRuns).toHaveLength(1);
    }, MULTI_RUN_MS);
    it('unsandboxed gates: the engine deletes nothing; the leftovers stay with a history note', async () => {
        w = localWorld(['dotnet', 'test']);
        ignoreBuild();
        baseProject();
        const seen = leaveThenSee(staleBuild, seesStale);
        await firstRun({ gateSandboxUserConfig: UNSANDBOXED_GATES });
        await runFactoryEngine(localOpts(w, lanesFor(w, []), { gateSandboxUserConfig: UNSANDBOXED_GATES }));
        expect(seen).toEqual([true]);
        expect(readFactoryState(w.root, LOCAL_ISSUE).history.some((h) => /^left 2 untracked build output paths under bin\/, obj\/ or artifacts\/ in the prepare checkout before the dotnet gate on [0-9a-f]{12}: the gates run without the OS sandbox/.test(h.note))).toBe(true);
    }, MULTI_RUN_MS);
    it('F3/M1/M2: a dotnet test gate on a base whose global.json selects Microsoft.Testing.Platform parks before any lane on Windows; elsewhere it runs (unverified)', async () => {
        w = localWorld(['dotnet', 'test']);
        writeFileSync(join(w.root, 'global.json'), '{ "test": { "runner": "Microsoft.Testing.Platform" } }\n');
        baseProject();
        const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        if (process.platform === 'win32') {
            expect(out.gate?.name, out.message).toBe('gates');
            expect(out.gate?.reason).toMatch(/^Microsoft\.Testing\.Platform test gates are not supported in the sandbox yet: main's global\.json selects it .* could never pass there and no (further )?lane was started/);
            expect(lanes.started).toEqual([]);
            expect(w.gateRuns).toEqual([]);
        }
        else {
            expect(out.gate?.name, out.message).toBe('merge');
            expect(w.gateRuns).toHaveLength(1);
        }
    }, MULTI_RUN_MS);
    it.runIf(process.platform === 'win32')('L4: on Windows a root Global.json in another case selects Microsoft.Testing.Platform too', async () => {
        w = localWorld(['dotnet', 'test']);
        writeFileSync(join(w.root, 'Global.json'), '{ "test": { "runner": "Microsoft.Testing.Platform" } }\n');
        baseProject();
        const lanes = lanesFor(w, [commitFile('src/App/Greet.cs', 'namespace App;\n'), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.gate?.name, out.message).toBe('gates');
        expect(lanes.started).toEqual([]);
    }, MULTI_RUN_MS);
    it('F4: with a project dir in the gate argv, a comment change in a test file under it runs the gate (no gate-definition-changed)', async () => {
        w = localWorld(['dotnet', 'test', 'tests/Foo.Tests']);
        mkdirSync(join(w.root, 'tests', 'Foo.Tests'), { recursive: true });
        writeFileSync(join(w.root, 'tests', 'Foo.Tests', 'Foo.Tests.csproj'), CSPROJ);
        writeFileSync(join(w.root, 'tests', 'Foo.Tests', 'FooTests.cs'), 'public class FooTests { }\n');
        gitIn(w.root, 'add', '.');
        gitIn(w.root, 'commit', '-q', '-m', 'tests');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('tests/Foo.Tests/FooTests.cs', '// a comment\npublic class FooTests { }\n'), review('approve')])));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(w.gateRuns.map((r) => r.argv)).toEqual([['dotnet', 'test', 'tests/Foo.Tests']]);
    }, MULTI_RUN_MS);
    it('F2: a lane that adds a Microsoft.Testing.Platform launch profile parks at gate-definition-changed', async () => {
        w = localWorld(['dotnet', 'test']);
        baseProject();
        const launch = '{ "profiles": { "Tests": { "commandName": "Project", "commandLineArgs": "--ignore-exit-code 2" } } }\n';
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/App/Properties/launchSettings.json', launch)])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/\(src\/App\/Properties\/launchSettings\.json differ from main\)/);
    }, MULTI_RUN_MS);
    it('a node gate: no lane is started with dotnet', async () => {
        w = localWorld();
        const lanes = lanesFor(w, [greet(), review('approve')]);
        expect((await runFactoryEngine(localOpts(w, lanes))).gate?.name).toBe('merge');
        expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
    }, MULTI_RUN_MS);
});
describe('F41: a lane may not redefine the local gate', () => {
    it('a lane that adds the gate\'s lint script parks at gate-definition-changed (nothing pushed); --allow-gate-change records it and goes on', async () => {
        w = localWorld(['npm', 'run', 'lint']);
        const base = basePackage({ test: 'node --test' });
        const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)])));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('gate-definition-changed');
        expect(out.gate?.reason).toMatch(/redefines the local gate "npm run lint" \(package\.json scripts prelint\/lint\/postlint, \.npmrc, \.yarnrc, \.yarnrc\.yml, \.pnpmfile\.cjs differ from main\).*--allow-gate-change/);
        expect(out.state?.gate?.definition).toMatch(/^[0-9a-f]{64}$/);
        // The cancel hint is the run kind's own command (a ci-heal run: omg factory heal cancel <sig8>).
        expect(out.gate?.reason?.endsWith(`or ${cancelCommand(LOCAL_ISSUE)}`)).toBe(true);
        expect(cancelCommand('heal-0123abcd')).toBe('omg factory heal cancel 0123abcd');
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        // A plain rerun parks again; the explicit flag accepts this definition.
        const plain = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(plain.gate?.name).toBe('gate-definition-changed');
        const parkedOn = plain.state.gate.definition;
        const allowed = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), { allowGateChange: true }));
        expect(allowed.exitCode, allowed.message).toBe(0);
        expect(allowed.gate?.name).toBe('merge');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        // The hash of the accepted definition, never the definition text.
        expect(state.gateChangeApproved).toBe(parkedOn);
        expect(state.history.some((h) => /gate definition change in [0-9a-f]{12} accepted \(--allow-gate-change\): package\.json/.test(h.note))).toBe(true);
    }, MULTI_RUN_MS);
    it('--allow-gate-change without a gate-definition-changed park is ignored with a warning and approves nothing in advance', async () => {
        w = localWorld(['npm', 'run', 'lint']);
        const base = basePackage({ test: 'node --test' });
        const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
        const warnings = [];
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)]), { allowGateChange: true, warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        expect(warnings.some((m) => /--allow-gate-change is ignored: the run for .* is not parked at awaiting-human: gate-definition-changed/.test(m))).toBe(true);
        expect(readFactoryState(w.root, LOCAL_ISSUE).gateChangeApproved).toBeUndefined();
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
    }, MULTI_RUN_MS);
    it('the flag accepts the parked change once: a second change by a later fix lane in the same run parks again', async () => {
        w = localWorld(['npm', 'run', 'lint']);
        const base = basePackage({ test: 'node --test' });
        const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)])));
        expect(out.gate?.name, out.message).toBe('gate-definition-changed');
        const first = out.state.gate.definition;
        const finding = { severity: 'major', file: 'package.json', line: 1, summary: 'lint must check something' };
        const again = await runFactoryEngine(localOpts(w, lanesFor(w, [
            review('request-changes', [finding]),
            commitFile('package.json', withLint.replace('"lint": "exit 0"', '"lint": "node -e 0"')),
        ]), { allowGateChange: true }));
        expect(again.exitCode, again.message).toBe(EXIT_AWAITING_HUMAN);
        expect(again.gate?.name).toBe('gate-definition-changed');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.gateChangeApproved).toBe(first);
        expect(state.gate.definition).toMatch(/^[0-9a-f]{64}$/);
        expect(state.gate.definition).not.toBe(first);
        // The accepted head was published; the fix lane's head was not.
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBe(state.head);
        expect(state.pendingHead).not.toBe(state.head);
    }, MULTI_RUN_MS);
    it('an npm-style gate whose script cannot be told from its argv parks at gate-definition-unknown before any lane', async () => {
        w = localWorld(['npm', '--workspace', 'app', 'test']);
        const lanes = lanesFor(w, [greet()]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('gate-definition-unknown');
        expect(out.gate?.reason).toMatch(/selects workspace packages \(--workspace\).*no further lane was started/);
        expect(out.gate?.reason?.endsWith(`or ${cancelCommand(LOCAL_ISSUE)}`)).toBe(true);
        expect(lanes.started).toEqual([]);
        expect(readFactoryState(w.root, LOCAL_ISSUE).lanes).toEqual([]);
        expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
        // A rerun with the gate still unresolved parks again, still before any lane.
        const again = await runFactoryEngine(localOpts(w, lanes));
        expect(again.gate?.name).toBe('gate-definition-unknown');
        expect(lanes.started).toEqual([]);
    });
    it('--dry-run reports a requested cancel and a cancelled run before the unknown gate', async () => {
        w = localWorld(['npm', '--workspace', 'app', 'test']);
        const lanes = lanesFor(w, []);
        const parked = await runFactoryEngine(localOpts(w, lanes));
        expect(parked.gate?.name).toBe('gate-definition-unknown');
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const asked = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
        expect(asked.message).toMatch(/a cancel is requested/);
        expect(asked.plan).toMatchObject({ next: 'cancelled' });
        const done = await runFactoryEngine(localOpts(w, lanes));
        expect(done.phase).toBe('cancelled');
        const after = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
        expect(after.message).toBe('dry run: the run is cancelled; nothing would run');
        expect(after.plan).toMatchObject({ next: 'cancelled' });
        expect(lanes.started).toEqual([]);
    });
    it('--dry-run reports the gate-definition-unknown park', async () => {
        w = localWorld(['yarn', 'workspace', 'app', 'test']);
        const lanes = lanesFor(w, []);
        const out = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.message).toMatch(/runs yarn workspace, not a package.json script.*awaiting-human: gate-definition-unknown before any lane/);
        expect(out.plan).toMatchObject({ next: 'awaiting-human', reason: 'gate-definition-unknown' });
        expect(lanes.started).toEqual([]);
        expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
    });
    it('an unrelated package.json change does not park', async () => {
        w = localWorld(['npm', 'run', 'lint']);
        const base = basePackage({ lint: 'node --check index.js' });
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', base.replace('"1.0.0"', '"1.1.0"')), review('approve')])));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
    });
});
describe('F42: a fetch that moves no branch is not tampering', () => {
    it('the PR branch fetched into refs/remotes/omg-local during review keeps the verdict', async () => {
        w = localWorld();
        const fetchPr = review('approve', [], ({ root, baseSha }) => gitIn(root, 'update-ref', `refs/remotes/omg-local/${BRANCH}`, baseSha));
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), fetchPr])));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
    });
    it('a tracking ref at another sha still discards the verdict, and the message does not blame the lane alone', async () => {
        w = localWorld();
        const moved = review('approve', [], ({ root }) => gitIn(root, 'update-ref', `refs/remotes/omg-local/${BRANCH}`, gitIn(root, 'rev-parse', 'HEAD')));
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), moved])));
        expect(out.gate?.name, out.message).toBe('review-tampered');
        expect(out.gate?.reason).toMatch(/shared git state changed while review lane .* ran \(by the lane or anyone else working in this repository\)/);
    });
});
describe('F39 + F40: --dry-run applies the pr-exists gate and probes the gate executable', () => {
    it('reports pr-exists for an open local PR on the branch', async () => {
        w = localWorld();
        await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
        const path = factoryStatePath(w.root, LOCAL_ISSUE);
        renameSync(path, `${path}.aside`);
        const dry = await runFactoryEngine(localOpts(w, lanesFor(w, []), { dryRun: true }));
        expect(dry.message).toBe(`dry run: open PR #1 already uses ${BRANCH}; the run would stop at awaiting-human: pr-exists`);
        expect(dry.plan).toMatchObject({ next: 'awaiting-human', reason: 'pr-exists' });
    }, MULTI_RUN_MS);
    it('reports a gate whose executable cannot start, without spawning it', async () => {
        w = localWorld(['./omg-no-such-gate-exe-f40', 'test']);
        const dry = await runFactoryEngine(localOpts(w, lanesFor(w, []), { dryRun: true }));
        expect(dry.message).toMatch(/the run would start an implement lane .*; but the local gate cannot start \(the local gate executable \.\/omg-no-such-gate-exe-f40 .*does not exist.*\), so after review the run would park at awaiting-human: gates$/);
        expect(dry.plan?.gateProblem).toMatch(/omg-no-such-gate-exe-f40/);
        expect(w.gateRuns).toEqual([]);
    });
});
describe('a key in a local backlog item parks at intake before any lane', () => {
    it('names the kind, never the value', async () => {
        w = localWorld();
        const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;
        writeFileSync(join(w.root, '.copilot', 'backlog', `${LOCAL_ISSUE}-add-greet.md`), `---
title: Add greet()
labels: [factory]
---
Use ${key}.

## Acceptance
- [ ] greet() returns hi
`);
        gitIn(w.root, 'add', '.');
        gitIn(w.root, 'commit', '-q', '-m', 'item with a key');
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.gate?.name, out.message).toBe('secret-shaped-content');
        expect(lanes.started).toEqual([]);
        const parked = readFactoryState(w.root, LOCAL_ISSUE);
        expect(parked.phase).toBe('intake');
        expect(JSON.stringify(parked)).not.toContain(key);
    }, MULTI_RUN_MS);
});
//# sourceMappingURL=engine.local.dogfood.test.js.map