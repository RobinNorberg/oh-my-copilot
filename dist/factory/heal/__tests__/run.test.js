import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseKnownFlaky } from '../../../ship/config.js';
import { defaultExec } from '../../../ship/exec.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../../team/git-worktree.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { HEAL_APPROVE_GATE } from '../../run/state.js';
import { classifyRun } from '../classify.js';
import { healCommand, renderHealState } from '../cli.js';
import { DEFAULT_HEAL_CONFIG } from '../config.js';
import { evidenceDir } from '../heal-evidence.js';
import { runHealEngine } from '../implement.js';
import { parseJob } from '../logs.js';
import { closeHeal, HEAL_UNCONFINED_ENV, HealRunRefused, healSealSubject, readHealCounters, readHealSealSubject, runHeal, verifyHealSeal, writeHealScanRecord, writeHealSeal } from '../run.js';
import { DELIMITER_PREFIX } from '../sanitize.js';
import { runSignature } from '../signature.js';
import { dailyCountersPath, foldSignature, readHealState, writeDailyCountersAt, writeHealState } from '../state.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const KNOWN = parseKnownFlaky(readFileSync(join(HERE, '../../../../.github/known-flaky-tests.json'), 'utf8'), 'known-flaky');
const NOW = new Date('2026-10-28T09:00:00Z');
const DELIM = `${DELIMITER_PREFIX}00112233aabbccdd`;
const RUNS = JSON.parse(fixture('runs.json')).runs;
const LOGS = { 122329975951: fixture('git256-red.log'), 122329976558: fixture('policy-only.log'), 122472747061: fixture('git256-green.log') };
let root;
let ledgerDir;
let wtBase;
let greenSha;
let redSha;
let ghCalls;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function classification() {
    const red = parseJob({ jobId: '122329975951', name: 'Test', failedSteps: ['Run functional tests'] }, LOGS[122329975951], KNOWN);
    const green = parseJob({ jobId: '122472747061', name: 'Test', failedSteps: [] }, LOGS[122472747061], KNOWN);
    const sig = runSignature([red]);
    return classifyRun({
        signature: sig.signature,
        sig8: sig.sig8,
        firstRed: { runId: '40542274776', sha: redSha },
        lastGreen: { runId: '40584638028', sha: greenSha },
        range: { commits: 1, codeFiles: 0, files: ['README.md'] },
        jobs: [{ red: { runId: '40542274776', sha: redSha, job: red }, green: { runId: '40584638028', sha: greenSha, job: green }, sameShaGreen: [], range: { commits: 1, codeFiles: 0, files: ['README.md'] } }],
    });
}
function seed(c = classification()) {
    const { state } = foldSignature(null, { classification: c, runId: c.firstRed.runId, source: 'push' }, [], { day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 0 }, DEFAULT_HEAL_CONFIG, NOW);
    writeHealState(root, state);
    writeHealScanRecord(ledgerDir, root, state);
    return state;
}
const exec = (cmd, args, opts) => {
    if (cmd !== 'gh')
        return defaultExec(cmd, args, opts);
    ghCalls.push(args);
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    if (args[1] === 'view' && args[3] === '--json')
        return ok(JSON.stringify({ jobs: RUNS.find((r) => String(r.databaseId) === args[2]).jobs }));
    if (args[1] === 'view' && args[2] === '--job')
        return ok(LOGS[args[3]] ?? '');
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
const GOOD = {
    class: 'env-change',
    rootCause: 'Git 2.56 changed the malformed-metadata error; the test pins the 2.55 text.',
    evidence: ['failures/1.log:2', 'env-diff.json:git'],
    reproduced: false,
    fix: { summary: 'Accept both git messages.', files: ['src/tools/__tests__/state-tools-nongit-ownership.test.ts'], acceptance: ['passes on git 2.55 and 2.56'] },
};
const answer = (o) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`;
let laneSeq = 0;
class FakeLanes {
    finalText;
    during;
    credits;
    kind = 'local-sdk';
    starts = [];
    lanes = new Map();
    constructor(finalText, during, credits = 3) {
        this.finalText = finalText;
        this.during = during;
        this.credits = credits;
    }
    async start(input) {
        this.starts.push(input);
        const id = `job${++laneSeq}`;
        const wt = join(wtBase, id);
        git('worktree', 'add', '-q', '-b', `omc-team/copilot-run/${id}`, wt, input.baseRef);
        // Like copilot_run: the git links are recorded at creation.
        recordWorktreeGitLinks(wt, readWorktreeGitLinks(wt));
        this.lanes.set(id, { input, wt });
        this.during?.(wt);
        return { remoteId: id };
    }
    result(id) {
        const { input, wt } = this.lanes.get(id);
        return {
            state: 'completed', branch: `omc-team/copilot-run/${id}`, pr: null, headSha: input.baseRef, baseSha: input.baseRef, worktree: wt,
            changes: { diffStat: '', changedFiles: [], untrackedFiles: [], protectedChanges: [] }, finalText: this.finalText, logsUrl: null,
            usage: { premiumRequests: 1, credits: this.credits, source: 'measured', detail: '' }, remoteId: id, error: null, notes: [], process: null,
        };
    }
    poll = async (id) => this.result(id);
    wait = async (id) => this.result(id);
    cancel = async (id) => ({ supported: true, result: this.result(id) });
}
function deps(lanes, extra = {}) {
    return { exec, lanes: () => lanes, ledgerDir, now: () => NOW, delimiter: () => DELIM, pollMs: 1, env: { [HEAL_UNCONFINED_ENV]: '1' }, warn: () => { }, ...extra };
}
const run = (lanes, config = {}, extra = {}, sig8 = classification().sig8, dryRun = false) => runHeal({ root, base: 'dev', sig8, config: { ...DEFAULT_HEAL_CONFIG, ...config }, dryRun, lockTimeoutMs: 2_000 }, deps(lanes, extra));
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-heal-run-'));
    ledgerDir = mkdtempSync(join(tmpdir(), 'omg-heal-ledger-'));
    wtBase = mkdtempSync(join(tmpdir(), 'omg-heal-wt-'));
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 'heal@example.invalid');
    git('config', 'user.name', 'heal test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'README.md'), 'green\n');
    writeFileSync(join(root, '.gitignore'), '.omg/\n');
    git('add', '.');
    git('commit', '-q', '-m', 'green');
    greenSha = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'README.md'), 'red\n');
    git('commit', '-q', '-am', 'red');
    redSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/dev', redSha);
    ghCalls = [];
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of [root, ledgerDir, wtBase])
        rmSync(d, { recursive: true, force: true });
});
describe('omg factory heal run', () => {
    it('--dry-run writes the bundle and returns the prompt; no lane, no counters', async () => {
        const s = seed();
        const lanes = new FakeLanes(answer(GOOD));
        const out = await run(lanes, {}, {}, s.sig8, true);
        expect(out.exitCode).toBe(0);
        expect(out.prompt).toContain(`<<<${DELIM} BEGIN file=failures/1.log`);
        expect(existsSync(join(evidenceDir(root, s.sig8), 'failures', '1.log'))).toBe(true);
        expect(lanes.starts).toHaveLength(0);
        expect(existsSync(dailyCountersPath(root))).toBe(false);
        expect(ghCalls.every((a) => a[0] === 'run' && a[1] === 'view')).toBe(true);
    });
    it('a valid diagnosis parks at heal-approve; the lane is read-only, capped at 30, at the red sha', async () => {
        const s = seed();
        const lanes = new FakeLanes(answer(GOOD));
        const out = await run(lanes);
        expect(out).toMatchObject({ exitCode: 4, next: 'heal-approve', diagnosis: { outcome: 'valid', diagnosis: { class: 'env-change' } } });
        expect(out.message).toMatch(/^awaiting-human: heal-approve/);
        expect(lanes.starts).toHaveLength(1);
        expect(lanes.starts[0]).toMatchObject({ laneId: `heal-${s.sig8}-debug-1`, profile: 'review', maxCredits: 30, baseRef: redSha, cwd: root });
        const state = readHealState(root, s.sig8);
        expect(state).toMatchObject({ next: 'heal-approve', healRun: { id: `heal-${s.sig8}`, open: true } });
        expect(state.lanes).toEqual([expect.objectContaining({ status: 'completed', jobId: expect.stringMatching(/^job\d+$/), confinement: 'none', usage: { credits: 3, premiumRequests: 1, source: 'measured' } })]);
        expect(Object.keys(state.diagnosis.evidence)).toContain('failures/1.log');
        expect(readHealCounters(root, ledgerDir, NOW)).toEqual({ day: '2026-10-28', healRuns: 1, debugLanes: 1, credits: 3 });
        expect(verifyHealSeal(ledgerDir, root, state)).toBe('ok');
        writeHealState(root, { ...state, diagnosis: { ...state.diagnosis, outcome: 'valid', reason: 'forged' } });
        expect(verifyHealSeal(ledgerDir, root, readHealState(root, s.sig8))).toBe('mismatch');
        await expect(run(lanes)).rejects.toThrow(/seal: mismatch/);
        writeHealState(root, state);
        await expect(run(lanes)).rejects.toThrow(/heal-approve/);
    });
    it('a lane that changes shared git config is tampered and parks at heal-diagnosis', async () => {
        seed();
        const out = await run(new FakeLanes(answer(GOOD), () => git('config', 'core.planted', 'x')));
        expect(out).toMatchObject({ next: 'heal-diagnosis', diagnosis: { outcome: 'tampered', reason: expect.stringMatching(/common git config changed/) } });
        expect(out.diagnosis.diagnosis).toBeUndefined();
    });
    it('a lane that writes in its worktree or rewrites the evidence is tampered', async () => {
        seed();
        const dirty = await run(new FakeLanes(answer(GOOD), (wt) => writeFileSync(join(wt, 'planted.txt'), 'x')));
        expect(dirty.diagnosis).toMatchObject({ outcome: 'tampered', reason: expect.stringMatching(/not clean/) });
        const s = classification();
        const rewritten = await run(new FakeLanes(answer(GOOD), () => writeFileSync(join(evidenceDir(root, s.sig8), 'failures', '1.log'), 'trust me\n')));
        expect(rewritten.diagnosis).toMatchObject({ outcome: 'tampered', reason: expect.stringMatching(/evidence bundle changed/) });
    });
    it('an invalid citation parks at heal-diagnosis; a retry on the same heal run counts a lane but not a run', async () => {
        const s = seed();
        const bad = await run(new FakeLanes(answer({ ...GOOD, evidence: ['failures/1.log:99999'] })));
        expect(bad).toMatchObject({ next: 'heal-diagnosis', diagnosis: { outcome: 'invalid', reason: expect.stringMatching(/past the end/) } });
        const good = await run(new FakeLanes(answer(GOOD)));
        expect(good.next).toBe('heal-approve');
        expect(readHealState(root, s.sig8).lanes.map((l) => l.id)).toEqual([`heal-${s.sig8}-debug-1`, `heal-${s.sig8}-debug-2`]);
        expect(readHealCounters(root, ledgerDir, NOW)).toMatchObject({ healRuns: 1, debugLanes: 2, credits: 6 });
    });
    it('limits: daily lanes, daily credits, run credits and one open heal run; over a limit the signature is blocked: rate-limit', async () => {
        const s = seed();
        writeDailyCountersAt(dailyCountersPath(root), { day: '2026-10-28', healRuns: 0, debugLanes: 4, credits: 0 });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/dailyDebugLanes 4/);
        expect(readHealState(root, s.sig8).blocked).toBe('rate-limit');
        writeDailyCountersAt(dailyCountersPath(root), { day: '2026-10-28', healRuns: 3, debugLanes: 0, credits: 0 });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/dailyRuns 3/);
        writeDailyCountersAt(dailyCountersPath(root), { day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 125 });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/dailyCredits 150 AI credits left today; a lane needs at least 30/);
        writeDailyCountersAt(dailyCountersPath(root), { day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 0 });
        const other = { ...s, sig8: 'abcdef12', healRun: { id: 'heal-abcdef12', open: true, startedAt: NOW.toISOString() } };
        writeHealState(root, other);
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/1 other heal run\(s\) open/);
        rmSync(join(dirname(dailyCountersPath(root)), 'abcdef12.json'));
        // A spent run: three lanes of 31 against the 120 cap leave less than one lane.
        const spent = { ...readHealState(root, s.sig8), healRun: { id: `heal-${s.sig8}`, open: true, startedAt: NOW.toISOString() }, next: 'heal-diagnosis',
            lanes: [1, 2, 3].map((n) => ({ id: `heal-${s.sig8}-debug-${n}`, kind: 'debug', startSha: redSha, status: 'failed', maxCredits: 30, startedAt: NOW.toISOString(), pid: 1, confinement: 'none', usage: { credits: 31, premiumRequests: 0, source: 'measured' } })) };
        writeHealState(root, spent);
        writeHealSeal(ledgerDir, root, spent, healSealSubject(s.class, s.classification, s.source));
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/heal run has 27\.00 of factory\.heal\.maxRunCredits 120/);
    });
    it('the out-of-repo counters survive a lane resetting limits.json', async () => {
        seed();
        await run(new FakeLanes(answer({ ...GOOD, evidence: ['nope.txt:1'] }), () => writeFileSync(dailyCountersPath(root), '{}')));
        expect(readHealCounters(root, ledgerDir, NOW)).toMatchObject({ healRuns: 1, debugLanes: 1 });
    });
    it('a confinement may not loosen the lane; the lane never starts and the run parks at heal-diagnosis', async () => {
        seed();
        const lanes = new FakeLanes(answer(GOOD));
        const loose = { name: 'loose', confine: (i) => ({ ...i, maxCredits: 500 }) };
        const out = await run(lanes, {}, { confinement: loose });
        expect(lanes.starts).toHaveLength(0);
        expect(out.diagnosis).toMatchObject({ outcome: 'lane-failed', reason: expect.stringMatching(/loosened/) });
        expect(out.lane).toMatchObject({ status: 'start-failed', confinement: 'loose', usage: { credits: 0 } });
    });
    it('settles a running lane left by a dead process as lost, counted at its cap', async () => {
        const s = seed();
        const stale = { ...s, healRun: { id: `heal-${s.sig8}`, open: true, startedAt: NOW.toISOString() },
            lanes: [{ id: `heal-${s.sig8}-debug-1`, kind: 'debug', startSha: redSha, status: 'running', maxCredits: 30, startedAt: NOW.toISOString(), pid: 2 ** 22 + 12345, confinement: 'none' }] };
        writeHealState(root, stale);
        writeHealSeal(ledgerDir, root, stale, healSealSubject(s.class, s.classification, s.source));
        const out = await run(new FakeLanes(answer(GOOD)));
        expect(out.next).toBe('heal-approve');
        const lanes = readHealState(root, s.sig8).lanes;
        expect(lanes[0]).toMatchObject({ status: 'lost', usage: { credits: 30, source: 'estimated' } });
        expect(lanes[1].id).toBe(`heal-${s.sig8}-debug-2`);
    });
    it('refuses report-only classes and a red sha missing locally', async () => {
        const c = classification();
        seed({ ...c, class: 'intermittent', laneEligible: false });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(HealRunRefused);
        seed({ ...c, firstRed: { ...c.firstRed, sha: 'f'.repeat(40) } });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/not in the local repository/);
    });
    it('CLI: heal run exits 4 when parked, 3 when refused, 2 on a bad id', async () => {
        seed();
        const out = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
        vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
        const cliExec = (cmd, args, opts) => (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? { status: 0, stdout: `${root}\n`, stderr: '' } : exec(cmd, args, opts));
        const d = { exec: cliExec, base: () => 'dev', config: () => ({ config: DEFAULT_HEAL_CONFIG, warnings: [] }), now: () => NOW, lanes: () => new FakeLanes(answer(GOOD)), ledgerDir, runLimits: () => ({ limits: DEFAULT_FACTORY_RUN_LIMITS, warnings: [] }), run: { delimiter: () => DELIM, pollMs: 1, env: { [HEAL_UNCONFINED_ENV]: '1' }, warn: () => { } } };
        const cli = async (...argv) => { process.exitCode = undefined; await healCommand(d).parseAsync(argv, { from: 'user' }); return Number(process.exitCode ?? 0); };
        const sig8 = classification().sig8;
        expect(await cli('run', sig8)).toBe(4);
        expect(out.join('\n')).toMatch(/awaiting-human: heal-approve/);
        expect(await cli('run', sig8)).toBe(3);
        expect(await cli('run', 'XYZ')).toBe(2);
        out.length = 0;
        expect(await cli('status', sig8)).toBe(0);
        expect(out.join('\n')).toMatch(/diagnosis valid/);
        expect(out.join('\n')).toMatch(/seal: ok/);
        out.length = 0;
        expect(await cli('close', sig8)).toBe(0);
        expect(out.join('\n')).toMatch(/closed heal run/);
        expect(await cli('close', sig8)).toBe(3);
    });
    it('only a dev push signature starts a lane: a PR-only signature is refused, a PR run never replaces the push classification', async () => {
        const c = classification();
        const fold = (prev, cl, runId, source) => foldSignature(prev, { classification: cl, runId, source, ...(source === 'pr' ? { prBranches: ['a', 'b'] } : {}) }, [], { day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 0 }, DEFAULT_HEAL_CONFIG, NOW).state;
        const prOnly = fold(null, c, '1', 'pr');
        writeHealState(root, prOnly);
        writeHealScanRecord(ledgerDir, root, prOnly);
        const lanes = new FakeLanes(answer(GOOD));
        await expect(run(lanes)).rejects.toThrow(/pull request runs only/);
        expect(lanes.starts).toHaveLength(0);
        expect(existsSync(dailyCountersPath(root))).toBe(false);
        // A PR run with its own (attacker) head sha folds into a push signature as weight only.
        const attacker = { ...c, firstRed: { runId: '2', sha: 'a'.repeat(40) } };
        const pushed = fold(fold(null, c, '1', 'push'), attacker, '2', 'pr');
        expect(pushed).toMatchObject({ source: 'push', count: 2, classification: { firstRed: { sha: redSha } } });
        // A PR signature later seen on a dev push takes the push classification.
        expect(fold(fold(null, attacker, '1', 'pr'), c, '2', 'push')).toMatchObject({ source: 'push', classification: { firstRed: { sha: redSha } } });
    });
    it('refuses a red sha that is not on origin/<base>', async () => {
        const s = seed();
        git('checkout', '-q', '-b', 'pr-branch');
        writeFileSync(join(root, 'README.md'), 'pr\n');
        git('commit', '-q', '-am', 'pr');
        const prSha = git('rev-parse', 'HEAD');
        writeHealScanRecord(ledgerDir, root, { ...s, classification: { ...s.classification, firstRed: { ...s.classification.firstRed, sha: prSha } } });
        const lanes = new FakeLanes(answer(GOOD));
        await expect(run(lanes)).rejects.toThrow(/is not on origin\/dev/);
        expect(lanes.starts).toHaveLength(0);
    });
    it('an unconfined lane is refused by default; OMG_HEAL_UNCONFINED=1 warns and is recorded; a named confinement needs no opt-in', async () => {
        const s = seed();
        const lanes = new FakeLanes(answer({ ...GOOD, evidence: ['nope.txt:1'] }));
        await expect(run(lanes, {}, { env: {} })).rejects.toThrow(/no OS confinement yet.*OMG_HEAL_UNCONFINED=1/);
        expect(lanes.starts).toHaveLength(0);
        expect(existsSync(dailyCountersPath(root))).toBe(false);
        expect((await run(lanes, {}, {}, s.sig8, true)).exitCode).toBe(0); // --dry-run needs no opt-in
        const warnings = [];
        await run(lanes, {}, { warn: (m) => warnings.push(m) });
        expect(warnings.join('\n')).toMatch(/WITHOUT OS confinement/);
        expect(readHealState(root, s.sig8).lanes[0]).toMatchObject({ confinement: 'none', unconfinedOptIn: true });
        const boxed = { name: 'test-box', confine: (i) => i };
        await run(lanes, {}, { env: {}, confinement: boxed });
        expect(readHealState(root, s.sig8).lanes[1]).toMatchObject({ confinement: 'test-box' });
        expect(readHealState(root, s.sig8).lanes[1].unconfinedOptIn).toBeUndefined();
    });
    it('every lane starts credential-free; a confinement that drops it loosens the lane', async () => {
        seed();
        const lanes = new FakeLanes(answer({ ...GOOD, evidence: ['nope.txt:1'] }));
        await run(lanes);
        expect(lanes.starts[0].scrubCredentials).toBe(true);
        const leaky = { name: 'leaky', confine: (i) => ({ ...i, scrubCredentials: false }) };
        const out = await run(lanes, {}, { confinement: leaky });
        expect(lanes.starts).toHaveLength(1);
        expect(out.diagnosis).toMatchObject({ outcome: 'lane-failed', reason: expect.stringMatching(/credential-free/) });
    });
    it('a lane that corrupts its state file or cites Object.prototype names is settled, never left running', async () => {
        const s = seed();
        const corrupt = await run(new FakeLanes(answer(GOOD), () => writeFileSync(join(dirname(dailyCountersPath(root)), `${s.sig8}.json`), '{not json')));
        expect(corrupt).toMatchObject({ next: 'heal-diagnosis', diagnosis: { outcome: 'tampered' }, lane: { status: 'completed' } });
        expect(readHealState(root, s.sig8).lanes.at(-1).status).toBe('completed');
        const proto = await run(new FakeLanes(answer({ ...GOOD, evidence: ['constructor:1', '__proto__:1'] })));
        expect(proto).toMatchObject({ next: 'heal-diagnosis', diagnosis: { outcome: 'invalid', reason: expect.stringMatching(/outside the bundle/) } });
        expect(readHealState(root, s.sig8).lanes.every((l) => l.status !== 'running')).toBe(true);
    });
    it('heal close frees the open-run slot at heal-approve or heal-diagnosis only', async () => {
        const s = seed();
        expect(() => closeHeal(root, s.sig8, { ledgerDir, now: () => NOW })).toThrow(/no open heal run/);
        await run(new FakeLanes(answer(GOOD)));
        const other = { ...s, sig8: 'abcdef12', classification: { ...s.classification, sig8: 'abcdef12' } };
        writeHealState(root, other);
        writeHealScanRecord(ledgerDir, root, other);
        await expect(run(new FakeLanes(answer(GOOD)), {}, {}, 'abcdef12')).rejects.toThrow(/1 other heal run\(s\) open/);
        const closed = closeHeal(root, s.sig8, { ledgerDir, now: () => NOW });
        expect(closed.healRun).toMatchObject({ open: false, closedAt: NOW.toISOString() });
        expect(verifyHealSeal(ledgerDir, root, readHealState(root, s.sig8))).toBe('ok');
        expect(() => closeHeal(root, s.sig8, { ledgerDir, now: () => NOW })).toThrow(/no open heal run/);
        expect((await run(new FakeLanes(answer(GOOD)), {}, {}, 'abcdef12')).next).toBe('heal-approve');
        writeHealState(root, { ...readHealState(root, 'abcdef12'), next: 'debug-lane' });
        expect(() => closeHeal(root, 'abcdef12', { ledgerDir, now: () => NOW })).toThrow(/only a heal run parked/);
    });
    it('a scan-time source that differs from the sealed one is refused while the heal run is open', async () => {
        const s = seed();
        expect((await run(new FakeLanes(answer(GOOD)))).next).toBe('heal-approve');
        expect(readHealSealSubject(ledgerDir, root, s.sig8).source).toBe('push');
        writeHealScanRecord(ledgerDir, root, { ...s, source: 'pr' });
        await expect(run(new FakeLanes(answer(GOOD)))).rejects.toThrow(/differs from the one its open heal run was sealed with/);
    });
    const scanRecordFile = (sig8) => {
        for (const d of readdirSync(join(ledgerDir, 'heal'))) {
            const p = join(ledgerDir, 'heal', d, `${sig8}.subject.json`);
            if (existsSync(p))
                return p;
        }
        throw new Error(`no scan-time record of ${sig8}`);
    };
    it('a class edited in .omg/ between two heal runs is ignored: the second run keeps the scan-time class and autoImplement still excludes regression-or-env', async () => {
        const s = seed({ ...classification(), class: 'regression-or-env' });
        const forge = () => writeHealState(root, { ...readHealState(root, s.sig8), class: 'regression', classification: { ...readHealState(root, s.sig8).classification, class: 'regression' } });
        // Lane 1 rewrites the class and returns an invalid diagnosis, so the run parks at heal-diagnosis.
        const first = await run(new FakeLanes(answer({ ...GOOD, evidence: ['failures/1.log:99999'] }), forge));
        expect(first.next).toBe('heal-diagnosis');
        forge();
        expect(verifyHealSeal(ledgerDir, root, readHealState(root, s.sig8))).toBe('ok');
        const warnings = [];
        const second = await run(new FakeLanes(answer(GOOD)), {}, { warn: (m) => warnings.push(m) });
        expect(second.next).toBe('heal-approve');
        expect(warnings.join('\n')).toMatch(/differs from the scan-time record outside the repository; it is ignored/);
        expect(readHealSealSubject(ledgerDir, root, s.sig8).class).toBe('regression-or-env');
        expect(readHealState(root, s.sig8).class).toBe('regression-or-env');
        forge();
        const engine = await runHealEngine({ root, base: 'dev', sig8: s.sig8, config: { ...DEFAULT_HEAL_CONFIG, autoImplement: true }, approved: false, dryRun: true }, { exec, lanes: () => new FakeLanes(''), limits: () => ({ limits: DEFAULT_FACTORY_RUN_LIMITS, warnings: [] }), ledgerDir, now: () => NOW, warn: () => { } });
        expect(engine.plan).toMatchObject({ next: 'awaiting-human', reason: HEAL_APPROVE_GATE });
    });
    it('a missing or corrupt scan-time record refuses and asks for heal scan', async () => {
        const s = seed();
        const lanes = new FakeLanes(answer(GOOD));
        const file = scanRecordFile(s.sig8);
        const good = readFileSync(file, 'utf8');
        writeFileSync(file, good.replace('"class": "env-change"', '"class": "regression"'));
        await expect(run(lanes)).rejects.toThrow(/scan-time classification outside the repository is missing or corrupt; re-run omg factory heal scan/);
        writeFileSync(file, '{not json');
        await expect(run(lanes)).rejects.toThrow(/re-run omg factory heal scan/);
        rmSync(file);
        await expect(run(lanes, {}, {}, s.sig8, true)).rejects.toThrow(/re-run omg factory heal scan/);
        expect(lanes.starts).toHaveLength(0);
        writeFileSync(file, good);
        expect((await run(lanes)).next).toBe('heal-approve');
    });
    it('a tampered seal is refused: a changed seal, a deleted seal, a record stripped of its heal run', async () => {
        const s = seed();
        await run(new FakeLanes(answer({ ...GOOD, evidence: ['failures/1.log:99999'] })));
        const sealFile = join(dirname(scanRecordFile(s.sig8)), `${s.sig8}.seal.json`);
        const sealed = readFileSync(sealFile, 'utf8');
        const lanes = new FakeLanes(answer(GOOD));
        writeFileSync(sealFile, sealed.replace(/"seal": "[0-9a-f]+"/, `"seal": "${'0'.repeat(64)}"`));
        await expect(run(lanes)).rejects.toThrow(/seal: mismatch/);
        rmSync(sealFile);
        await expect(run(lanes)).rejects.toThrow(/seal: missing/);
        writeFileSync(sealFile, sealed);
        const { healRun: _h, lanes: _l, diagnosis: _d, ...stripped } = readHealState(root, s.sig8);
        writeHealState(root, stripped);
        await expect(run(lanes)).rejects.toThrow(/seal: mismatch/);
        expect(lanes.starts).toHaveLength(0);
    });
    it('heal status strips control characters from state text', () => {
        const s = seed();
        writeHealState(root, { ...s, lanes: [{ id: 'x', kind: 'debug', startSha: redSha, status: 'failed', maxCredits: 30, startedAt: NOW.toISOString(), pid: 1, confinement: 'none', note: 'evil \u001b]0;pwned\u0007 ‮' }] });
        const text = renderHealState(readHealState(root, s.sig8));
        expect(text).toContain('evil  ]0;pwned');
        expect(text).not.toMatch(/\u0007|‮|\u001b\]/);
    });
});
//# sourceMappingURL=run.test.js.map