/**
 * gh argv-parity baseline, CI self-heal side (factory forges design §A.6):
 * the exact ordered gh sequence of `src/factory/heal/history.ts` (listRuns,
 * viewRunJobs, jobLog) as `omg factory heal scan` (runHealScan) and the
 * evidence collection of `heal run` (collectEvidence) issue it, recorded below
 * healGuardExec. Recorded run and job fixtures of the heal tests. Since ADO
 * parity PR C1 heal reads through ForgeCi (githubCi); `heal scan --dry-run`
 * and `heal run --dry-run` are recorded too, and the sequences are unchanged.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHealScan } from '../../factory/heal/cli.js';
import { DEFAULT_HEAL_CONFIG } from '../../factory/heal/config.js';
import { collectEvidence } from '../../factory/heal/heal-evidence.js';
import { healGuardExec } from '../../factory/heal/history.js';
import { runHeal, writeHealScanRecord } from '../../factory/heal/run.js';
import { foldSignature, listHealStates, writeHealState } from '../../factory/heal/state.js';
import { githubCi } from '../github/ci.js';
import { recordingExec } from './recording-exec.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const HEAL_FIXTURES = join(HERE, '..', '..', 'factory', 'heal', '__tests__', 'fixtures');
const fixture = (name) => readFileSync(join(HEAL_FIXTURES, name), 'utf8');
const KNOWN_FILE = readFileSync(join(HERE, '..', '..', '..', '.github', 'known-flaky-tests.json'), 'utf8');
const NOW = new Date('2026-10-28T00:00:00Z');
const RUNS = JSON.parse(fixture('runs.json')).runs;
const run = (id) => RUNS.find((r) => r.databaseId === id);
/** A second PR branch failing with the same Test failure (cross-PR rule). */
const SECOND_PR = {
    ...run(40542274776), databaseId: 40551187199, headBranch: 'feat/other', createdAt: '2026-10-27T17:30:11Z',
    jobs: [{ databaseId: 500, name: 'Test', conclusion: 'failure', steps: [{ name: 'Run functional tests', conclusion: 'failure' }] }],
};
const LOGS = {
    122329975951: fixture('git256-red.log'),
    500: fixture('git256-red.log'),
    122329976558: fixture('policy-only.log'),
    122472797949: fixture('policy-only.log'),
    122472747061: fixture('git256-green.log'),
    122472798022: fixture('git256-green.log'),
};
let root;
/** Scripted gh and git answering from the run fixtures. */
function world(push, pr) {
    const all = [...push, ...pr];
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    return (cmd, args) => {
        const a = args.join(' ');
        if (cmd === 'git') {
            if (a === 'show refs/remotes/origin/dev:.github/known-flaky-tests.json')
                return ok(KNOWN_FILE);
            if (args[0] === 'cat-file')
                return ok('');
            if (args[0] === 'rev-list')
                return ok('0\n');
            if (args[0] === 'diff')
                return ok('');
            if (args[0] === 'merge-base')
                return ok('');
        }
        if (cmd === 'gh' && args[1] === 'list')
            return ok(JSON.stringify((args.includes('push') ? push : pr).map(({ jobs: _jobs, ...r }) => r)));
        if (cmd === 'gh' && args[1] === 'view' && args[4] === 'jobs')
            return ok(JSON.stringify({ jobs: all.find((r) => String(r.databaseId) === args[2]).jobs }));
        if (cmd === 'gh' && args[2] === '--job')
            return ok(LOGS[args[3]] ?? '');
        return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${a}` };
    };
}
const RUN_FIELDS = 'databaseId,conclusion,status,headSha,headBranch,event,createdAt';
const jobs = (id) => `gh ["run","view","${id}","--json","jobs"] cwd=<root>`;
const log = (id) => `gh ["run","view","--job","${id}","--log"] cwd=<root>`;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-gh-baseline-heal-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});
describe('gh argv baseline: src/factory/heal/history.ts', () => {
    const fixtures = () => world([run(40584638028)], [run(40542274776), SECOND_PR, run(40584652986)]);
    it('heal scan: both run lists, then jobs and logs per run (each read once)', () => {
        const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
        runHealScan({ exec: r.exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => { }, ledgerDir: join(root, '.omg', 'test-ledger') });
        expect(r.calls).toEqual([
            `gh ["run","list","--branch","dev","--workflow","ci.yml","--event","push","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
            `gh ["run","list","--workflow","ci.yml","--event","pull_request","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
            // The policy-only PR run: its jobs, no log (only an ignored PR-policy job failed).
            jobs(40584652986),
            jobs(40551187199), log(500),
            jobs(40542274776), log(122329975951),
            // The last green push run, for the env diff.
            jobs(40584638028), log(122472747061),
        ]);
    });
    it('heal run evidence: the red run\'s jobs and failed job logs, then the green run\'s', () => {
        runHealScan({ exec: fixtures(), root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => { }, ledgerDir: join(root, '.omg', 'test-ledger') });
        const [state] = listHealStates(root);
        const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
        collectEvidence(healGuardExec(r.exec), root, state.classification, DEFAULT_HEAL_CONFIG.ignoreJobs);
        expect(r.calls).toEqual([jobs(40542274776), log(122329975951), jobs(40584638028), log(122472747061)]);
    });
    it('heal scan --dry-run: the same reads as a writing scan', () => {
        const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
        runHealScan({ exec: r.exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: true, warn: () => { }, ledgerDir: join(root, '.omg', 'test-ledger') });
        expect(r.calls).toEqual([
            `gh ["run","list","--branch","dev","--workflow","ci.yml","--event","push","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
            `gh ["run","list","--workflow","ci.yml","--event","pull_request","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
            jobs(40584652986),
            jobs(40551187199), log(500),
            jobs(40542274776), log(122329975951),
            jobs(40584638028), log(122472747061),
        ]);
    });
    it('heal run --dry-run evidence: the red run\'s jobs and failed job logs, then the green run\'s', async () => {
        const ledgerDir = join(root, '.omg', 'test-ledger');
        runHealScan({ exec: fixtures(), root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => { }, ledgerDir });
        // The fixture signature is seen on PR runs only; a debugger lane needs it as a dev push signature.
        const [scanned] = listHealStates(root);
        const { state } = foldSignature(null, { classification: scanned.classification, runId: scanned.classification.firstRed.runId, source: 'push' }, [], { day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 0 }, DEFAULT_HEAL_CONFIG, NOW);
        writeHealState(root, state);
        writeHealScanRecord(ledgerDir, root, state);
        const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
        const outcome = await runHeal({ root, base: 'dev', sig8: state.sig8, config: DEFAULT_HEAL_CONFIG, dryRun: true, lockTimeoutMs: 2_000 }, { exec: r.exec, lanes: () => { throw new Error('a dry run starts no lane'); }, ledgerDir, now: () => NOW, warn: () => { } });
        expect(outcome.exitCode).toBe(0);
        expect(r.calls).toEqual([jobs(40542274776), log(122329975951), jobs(40584638028), log(122472747061)]);
    });
});
describe('heal reads through ForgeCi', () => {
    it('an injected ForgeCi carries the reads and the recorded rerun intent, over the heal-guarded exec', () => {
        const r = recordingExec(world([run(40584638028)], [run(40542274776), SECOND_PR, run(40584652986)]), { '<root>': root }, ['gh']);
        const seen = [];
        runHealScan({
            exec: r.exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => { }, ledgerDir: join(root, '.omg', 'test-ledger'),
            ci: (exec, cwd) => { seen.push(exec); return { ...githubCi(exec, cwd), rerunIntent: (id) => `rerun build ${id} by hand` }; },
        });
        const [state] = listHealStates(root);
        expect(state.rerunIntents.map((i) => i.command)).toEqual(['rerun build 40542274776 by hand']);
        expect(r.calls.length).toBeGreaterThan(0);
        // The factory gets the guarded exec: a rerun through it is refused before it reaches gh.
        expect(() => seen[0]('gh', ['run', 'rerun', '40542274776', '--failed'])).toThrow();
        expect(r.calls.some((c) => c.includes('"rerun"'))).toBe(false);
    });
    it('githubCi records the same rerun command heal always printed', () => {
        expect(githubCi(() => { throw new Error('no exec'); }).rerunIntent('40542274776')).toBe('gh run rerun 40542274776 --failed');
    });
});
//# sourceMappingURL=gh-argv-baseline.heal.test.js.map