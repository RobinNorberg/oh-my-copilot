/**
 * `omg factory bench run`: drive the factory over the bench fixture until
 * every issue is terminal, parked or never runnable, or a cap is hit; then
 * score each issue (score.ts) and write `<out>/<timestamp>.json` + `.md`.
 *
 * - `--fake`: in-process. Each pick is omg factory check's order over the
 *   fixture backlog (the same rules `run --next` uses), each run is
 *   runFactoryEngine with the issue's scripted lanes (fake-lanes.ts), the
 *   engine's own state, ledger and forge state under the bench dir, no user
 *   config. Prepare checks, the local gate and the acceptance run as plain
 *   processes: every line of code in the fixture is the bench's own. Zero cost.
 * - `--live --max-requests N`: real Copilot. Each run is a child `omg
 *   factory run --next --json` in the fixture repository (poll's auto-start
 *   child), so the user's own factory config, sandbox and lanes apply; with
 *   `--parallel N` up to N children at once (each takes a run slot: the
 *   user config must enable parallel runs, as for `omg factory run
 *   --parallel`). Before each start the budget ledger of the fixture
 *   (`<repo>/.omg/state/budget-ledger.json`) is read: no run starts unless
 *   the premium requests used since the bench started leave room for one
 *   more run (MIN_RUN_REQUESTS per run already in flight). A run in flight
 *   is never killed, so the overshoot is bounded by the in-flight runs'
 *   own lane caps (factory.run limits). The acceptance runs in the gate
 *   sandbox (createSandboxRunner, no model turn).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ledgerPath, ledgerTotals, parseLedger } from '../../budget/ledger.js';
import { createForge } from '../../forge/index.js';
import { resolveForgeConfig } from '../../forge/config.js';
import { LOCAL_REMOTE, readMirrorRef } from '../../forge/local/index.js';
import { getRuntimePackageVersion } from '../../lib/version.js';
import { loadBaseKnownFlaky, loadTrustedShipConfig, readBaseFile, userConfigLayers } from '../../ship/config.js';
import { defaultExec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { checkEnvFor, forgeReadExec, localBase, readForgeOptions } from '../check/cli.js';
import { checkItems } from '../check/score.js';
import { defaultPollAutoStart } from '../poll.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../run/budget.js';
import { runFactoryEngine } from '../run/engine.js';
import { factoryForgeOptions, loadFactoryForgeConfig } from '../run/forge-roots.js';
import { defaultLocalGateRunner, resolveLocalGateArgv } from '../run/local-gate.js';
import { linkNodeModules, unlinkNodeModules } from '../run/prepare.js';
import { createSandboxRunner } from '../run/sandbox-exec.js';
import { factoryBranch, readFactoryState } from '../run/state.js';
import { factoryGuardExec } from '../run/exec.js';
import { BENCH_FAKE_PROCESSES, BenchFakeLanes } from './fake-lanes.js';
import { fillPlaceholders, readFixtureMeta, removeBenchDir } from './fixture.js';
import { BENCH_ISSUES } from './fixtures/issues.js';
import { ACCEPTANCE_ARGV, ACCEPTANCE_TEST_PATH, BENCH_FIXTURE_VERSION } from './fixtures/project.js';
import { BENCH_RESULTS_KIND, BENCH_RESULTS_SCHEMA_VERSION, computeTotals, issuePasses, laneUsage, outcomeOf, phaseTimes, renderResultsMarkdown, trapContainment, } from './score.js';
/** The fewest premium requests a run spends (an implement and a review lane): the headroom a live start needs. */
export const MIN_RUN_REQUESTS = 2;
export const DEFAULT_BENCH_MAX_MINUTES = 240;
/** How long one acceptance run may take. */
export const ACCEPTANCE_TIMEOUT_MS = 10 * 60_000;
export class BenchUsageError extends Error {
}
/**
 * The fake mode's gate runner: the command as a plain process (no shell,
 * the gate's scrubbed env), for every purpose. Only the bench's own fixture
 * code ever runs through it.
 */
export const plainGateRunner = async (req) => {
    const r = await defaultLocalGateRunner(req.argv, req.cwd, req.timeoutMs);
    if (r.startError !== undefined)
        return { ran: false, reason: r.startError };
    return { ran: true, status: r.timedOut ? 124 : r.status, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, timedOut: r.timedOut };
};
/** Ship's strict safety-key loader on the local mirror, with no user config: the fixture's committed base only. */
const benchGateConfig = (i) => {
    const config = loadTrustedShipConfig({
        exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, remote: LOCAL_REMOTE, user: null, trustedUser: null, warn: i.warn,
    });
    return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};
/** The fake mode's forge: the fixture's committed config only, its state under the bench dir. */
export function fakeForgeConfig(meta, stateDir, exec = defaultExec) {
    const text = readBaseFile(exec, meta.root, meta.baseSha, '.copilot/omg.jsonc');
    if (!text)
        throw new Error(`omg factory bench: the fixture's .copilot/omg.jsonc is missing at ${meta.baseSha.slice(0, 12)}`);
    return resolveForgeConfig(null, parseJsonc(text), undefined, undefined, { root: meta.root, stateDir }).config;
}
/** omg factory check's verdict on every bench item, at the base (the order run --next picks in). */
export function checkBacklog(exec, root, base, config) {
    const read = forgeReadExec(exec, config, root);
    const warnings = [];
    const baseSha = localBase(read.exec, root, base, warnings);
    if (!baseSha)
        throw new Error(warnings.join('; ') || `omg factory bench: no ${base} branch in ${root}`);
    const forge = createForge(read.exec, root, config, readForgeOptions(config, root, read.options, base, baseSha, false));
    if (!config.intake.source)
        throw new Error('omg factory bench: the fixture config has no factory.intake.source');
    const ids = forge.tracker.queryItems(config.intake.source, config.intake.limit);
    return checkItems(forge, ids, checkEnvFor(read.exec, root, config, base, baseSha));
}
/** Run the issue's hidden test (ACCEPTANCE_ARGV) on a scratch clone of the PR head from the mirror, through `runner`. */
export async function runAcceptance(o) {
    const exec = o.exec ?? defaultExec;
    const scratch = mkdtempSync(join(o.benchDir, 'accept-'));
    const co = join(scratch, 'co');
    const noHooks = join(scratch, 'no-hooks');
    mkdirSync(noHooks);
    try {
        const clone = exec('git', ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', '--branch', o.branch, o.mirror, co]);
        if (clone.status !== 0)
            return { ran: false, passed: false, status: null, detail: `git clone of ${o.branch} failed: ${clone.stderr.trim().slice(0, 300)}` };
        const at = exec('git', ['-C', co, 'rev-parse', 'HEAD']).stdout.trim();
        if (at !== o.head)
            return { ran: false, passed: false, status: null, detail: `the mirror's ${o.branch} is ${at.slice(0, 12)}, not the recorded head ${o.head.slice(0, 12)}` };
        const testPath = join(co, ...ACCEPTANCE_TEST_PATH.split('/'));
        mkdirSync(join(testPath, '..'), { recursive: true });
        writeFileSync(testPath, o.test);
        linkNodeModules(o.meta.root, co);
        const target = resolveLocalGateArgv(ACCEPTANCE_ARGV, { cwd: co });
        if ('missing' in target)
            return { ran: false, passed: false, status: null, detail: target.missing };
        const r = await o.runner({
            purpose: 'gate', argv: ACCEPTANCE_ARGV, exe: target.exe, args: target.args, cwd: co, commonGitDir: join(co, '.git'),
            timeoutMs: o.timeoutMs ?? ACCEPTANCE_TIMEOUT_MS, nodeModulesTarget: join(o.meta.root, 'node_modules'),
        });
        if (!r.ran)
            return { ran: false, passed: false, status: null, detail: r.reason };
        const passed = r.status === 0 && !r.timedOut;
        return { ran: true, passed, status: r.status, ...(r.timedOut ? { timedOut: true } : {}), ...(passed ? {} : { detail: r.output.slice(-1_500) }) };
    }
    finally {
        try {
            unlinkNodeModules(o.meta.root, co);
        }
        catch { /* removeBenchDir unlinks every link anyway */ }
        removeBenchDir(scratch);
    }
}
const defaultLedger = (root) => {
    const path = ledgerPath(root);
    const { ledger, invalid } = parseLedger(path);
    if (invalid)
        throw new Error(`the budget ledger ${path} is unreadable; the bench cannot enforce --max-requests without it`);
    const t = ledgerTotals(ledger);
    return { premiumRequests: t.premiumRequests, credits: t.credits };
};
export async function runBench(o) {
    const now = o.now ?? (() => new Date());
    const t0 = now().getTime();
    const log = (m) => o.log?.(`[${Math.round((now().getTime() - t0) / 1000)} s] ${m}`);
    const benchDir = resolve(o.dir);
    const meta = readFixtureMeta(benchDir);
    const maxMinutes = o.maxMinutes ?? DEFAULT_BENCH_MAX_MINUTES;
    const parallel = o.parallel ?? 1;
    if (o.mode === 'live') {
        if (o.maxRequests === undefined)
            throw new BenchUsageError('--live needs --max-requests <n>: the bench never spends premium requests without an explicit cap');
    }
    else if (parallel !== 1) {
        throw new BenchUsageError('--parallel applies to --live; --fake runs one engine at a time');
    }
    if (!existsSync(join(meta.root, 'node_modules', 'vitest', 'vitest.mjs'))) {
        throw new BenchUsageError(`the fixture has no node_modules with vitest: run npm install in ${meta.root} (or recreate it with omg factory bench init --node-modules <dir>)`);
    }
    const started = now();
    const notes = [];
    const errors = new Map();
    let stopped = null;
    const overTime = () => now().getTime() - started.getTime() >= maxMinutes * 60_000;
    let config;
    let ledgerUsed = null;
    if (o.mode === 'fake') {
        config = fakeForgeConfig(meta, join(benchDir, 'forge-state'));
        const seen = new Set();
        for (;;) {
            if (o.interrupted?.()) {
                stopped = 'interrupted';
                break;
            }
            if (overTime()) {
                stopped = 'max-minutes';
                break;
            }
            const next = checkBacklog(defaultExec, meta.root, meta.base, config).find((r) => r.bucket === 'runnable' && !seen.has(r.id));
            if (!next)
                break;
            seen.add(next.id);
            const issue = BENCH_ISSUES.find((i) => i.id === next.id);
            if (!issue) {
                notes.push(`backlog item #${next.id} is not a bench issue; skipped`);
                continue;
            }
            log(`#${issue.id} ${issue.slug}: running`);
            try {
                const out = await runFactoryEngine({
                    root: meta.root, issue: issue.id, exec: defaultExec, base: meta.base, limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
                    lanes: new BenchFakeLanes(meta.root, issue.fake, (t) => fillPlaceholders(t, meta)),
                    ledgerDir: join(benchDir, 'engine-ledger'), processes: BENCH_FAKE_PROCESSES, pollMs: 5, sleep: async () => { },
                    gateConfig: benchGateConfig, forge: { config, options: { ...factoryForgeOptions(meta.root), stateDir: join(benchDir, 'forge-state') } },
                    gateSandbox: plainGateRunner, gateSandboxUserConfig: null, runUserConfig: null, secretScanUserConfig: null, codingAgentUserConfig: null,
                    warn: () => { },
                });
                log(`#${issue.id} ${issue.slug}: exit ${out.exitCode}: ${out.message.split('\n')[0].slice(0, 200)}`);
            }
            catch (error) {
                errors.set(issue.id, error instanceof Error ? error.message : String(error));
                log(`#${issue.id} ${issue.slug}: error: ${errors.get(issue.id)}`);
            }
        }
    }
    else {
        const trustedUser = o.trustedUser !== undefined ? o.trustedUser : userConfigLayers().trustedUser;
        config = loadFactoryForgeConfig(factoryGuardExec(defaultExec), meta.root, meta.base, trustedUser, undefined).config;
        if (config.kind !== 'local')
            throw new BenchUsageError(`the fixture resolves to the ${config.kind} forge (your user config's factory.forge?); the bench needs the local forge`);
        const ledger = o.ledger ?? defaultLedger;
        const start0 = ledger(meta.root);
        const used = () => {
            const t = ledger(meta.root);
            return { premiumRequests: t.premiumRequests - start0.premiumRequests, credits: t.credits - start0.credits };
        };
        const start = o.liveStart ?? defaultPollAutoStart(process.argv[1], o.signals ? { signals: o.signals } : {});
        const running = new Set();
        let drained = false;
        let runs = 0;
        const maxRuns = BENCH_ISSUES.length * 3;
        const capReason = () => {
            if (o.interrupted?.())
                return 'interrupted';
            if (overTime())
                return 'max-minutes';
            const u = used();
            if (u.premiumRequests + MIN_RUN_REQUESTS * (running.size + 1) > o.maxRequests)
                return 'max-requests';
            if (o.maxCredits !== undefined && u.credits >= o.maxCredits)
                return 'max-credits';
            return null;
        };
        for (;;) {
            while (!drained && !stopped && running.size < parallel && runs < maxRuns) {
                const why = capReason();
                if (why) {
                    stopped = why;
                    break;
                }
                runs += 1;
                const n = runs;
                log(`run ${n}: omg factory run --next`);
                const p = start({ root: meta.root }).then((r) => {
                    log(`run ${n}: exit ${r.exitCode}${r.next !== null ? ` #${r.next}` : ''}: ${r.message.split('\n')[0].slice(0, 200)}`);
                    if (!r.parsed) {
                        notes.push(`run ${n}: ${r.message}`);
                        stopped ??= 'run-error';
                        return;
                    }
                    if (r.exitCode === 0 && r.next === null) {
                        drained = true;
                        return;
                    }
                    // Busy (exit 6): a slot or the engine lock is held; the slot is free for the next start.
                    if (r.exitCode === 6 && parallel === 1) {
                        notes.push(`run ${n}: busy: ${r.message}`);
                        stopped ??= 'run-error';
                    }
                }).finally(() => { running.delete(p); });
                running.add(p);
            }
            if (running.size === 0)
                break;
            await Promise.race(running);
        }
        if (runs >= maxRuns && !drained && !stopped)
            notes.push(`stopped after ${runs} runs (the bench's run limit)`);
        // A stop by the caps leaves the last runs' usage: the ledger after every child ended.
        const u = used();
        ledgerUsed = { premiumRequests: Math.round(u.premiumRequests * 100) / 100, credits: Math.round(u.credits * 100) / 100 };
    }
    log('scoring');
    const runner = o.acceptanceRunner ?? (o.mode === 'fake' ? plainGateRunner : createSandboxRunner(meta.root));
    let buckets = [];
    try {
        buckets = checkBacklog(defaultExec, meta.root, meta.base, config);
    }
    catch (error) {
        notes.push(`omg factory check over the backlog failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const mirror = config.repo.url;
    const issues = [];
    for (const issue of BENCH_ISSUES)
        issues.push(await scoreIssue(issue, { meta, benchDir, mirror, runner, buckets, log, error: errors.get(issue.id) }));
    const results = {
        schemaVersion: BENCH_RESULTS_SCHEMA_VERSION,
        kind: BENCH_RESULTS_KIND,
        mode: o.mode,
        omgVersion: getRuntimePackageVersion(),
        fixtureVersion: BENCH_FIXTURE_VERSION,
        startedAt: started.toISOString(),
        finishedAt: now().toISOString(),
        caps: { maxRequests: o.maxRequests ?? null, maxCredits: o.maxCredits ?? null, maxMinutes, parallel },
        stopped,
        ledger: ledgerUsed,
        notes,
        issues,
        totals: computeTotals(issues),
    };
    const outDir = resolve(o.outDir ?? 'bench-results');
    mkdirSync(outDir, { recursive: true });
    const stamp = results.startedAt.replace(/[:.]/g, '-');
    const jsonPath = join(outDir, `${stamp}-${o.mode}.json`);
    const markdownPath = join(outDir, `${stamp}-${o.mode}.md`);
    writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(markdownPath, renderResultsMarkdown(results));
    return { results, jsonPath, markdownPath };
}
async function scoreIssue(issue, c) {
    let state = null;
    let note = c.error;
    try {
        state = readFactoryState(c.meta.root, issue.id);
    }
    catch (error) {
        note = `run state unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    let outcome = outcomeOf(state);
    if (!state) {
        const bucket = c.buckets.find((b) => b.id === issue.id)?.bucket;
        outcome = c.error || note ? 'error' : bucket && bucket !== 'runnable' ? `not-runnable:${bucket}` : 'not-run';
    }
    const branch = factoryBranch(issue.id);
    const pushed = state ? readMirrorRef(c.mirror, branch) ?? null : null;
    let acceptance = null;
    if (outcome === 'merged-park' && issue.acceptanceTest) {
        c.log(`#${issue.id} ${issue.slug}: acceptance`);
        acceptance = pushed
            ? await runAcceptance({ meta: c.meta, benchDir: c.benchDir, mirror: c.mirror, branch, head: pushed, test: issue.acceptanceTest, runner: c.runner })
            : { ran: false, passed: false, status: null, detail: `no ${branch} in the local forge mirror` };
    }
    let containment = null;
    if (issue.trap) {
        try {
            containment = trapContainment(issue.trap, { exec: defaultExec, mirror: c.mirror, meta: c.meta, head: pushed });
        }
        catch (error) {
            containment = { trap: issue.trap, contained: false, detail: `the containment check failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    const lanes = laneUsage(state);
    const { wallMs, phaseMs } = phaseTimes(state);
    return {
        id: issue.id, slug: issue.slug, title: issue.title, difficulty: issue.difficulty, category: issue.category, ...(issue.trap ? { trap: issue.trap } : {}),
        expect: issue.expect, outcome, pass: issuePasses(issue, outcome, acceptance),
        ...(state?.gate ? { park: { name: state.gate.name, reason: state.gate.reason } } : {}),
        acceptance, containment, head: pushed, pr: state?.pr ?? null,
        premiumRequests: lanes.reduce((n, l) => n + l.premiumRequests, 0),
        credits: Math.round(lanes.reduce((n, l) => n + l.credits, 0) * 100) / 100,
        lanes, wallMs, phaseMs, ...(note ? { note } : {}),
    };
}
//# sourceMappingURL=runner.js.map