/**
 * `omg release <version>`: the maintainer-only release pipeline as ordered,
 * resumable phases (src/release/engine.ts). `--dry-run` prints the plan and
 * runs nothing; without `--from` a run resumes at the first phase not yet ok.
 *
 * `--drive` keeps going through CI waits and transient GitHub errors until a
 * terminal state; `--detach` runs that loop in a detached process, and
 * `--status` / `--stop` inspect or end it (src/release/drive.ts).
 *
 * Exit codes: 0 ok, 1 a phase failed or is blocked, 2 usage error.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { loadTrustedShipConfig, userConfigLayers } from '../../ship/config.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveBareExe } from '../../utils/windows-search.js';
import { parseReleaseVersion, suiteShellFor } from '../../release/checks.js';
import { defaultReleaseExec, defaultReleaseExecAsync, flakyCandidatesPath, isPhaseId, PHASES, readReleaseState, runRelease, UsageError, } from '../../release/engine.js';
import { emitReleaseProgress, releaseProgressFile } from '../../release/progress.js';
import { defaultDriveProcess, detachDriver, driveLockPath, driveLogPath, driveRelease, DRIVE_MAX_HOURS, lastLines, readDriveLock, stopDriver, throttleHeartbeats, withDriveLock, } from '../../release/drive.js';
function phaseOption(raw, flag) {
    if (raw === undefined)
        return undefined;
    if (!isPhaseId(raw))
        throw new UsageError(`${flag} must be one of ${PHASES.join(', ')}, got ${JSON.stringify(raw)}`);
    return raw;
}
async function ttyConfirm(question) {
    if (!process.stdin.isTTY) {
        console.error('No interactive terminal to confirm on; pass --yes to confirm the tag without a prompt.');
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    }
    finally {
        rl.close();
    }
}
function printResult(result) {
    if (result.dryRun) {
        console.log(chalk.bold(`omg release ${result.version} --dry-run: plan only, nothing runs (state ${result.statePath})`));
        for (const p of result.phases) {
            console.log(`${chalk.cyan(String(PHASES.indexOf(p.id) + 1).padStart(2))} ${chalk.bold(p.id)}`);
            for (const s of p.steps ?? [])
                console.log(`     - ${s}`);
        }
        return;
    }
    const color = result.ok ? chalk.green : chalk.red;
    console.log(color(`release ${result.version}: ${result.ok ? 'ok' : 'stopped'} (state ${result.statePath})`));
}
/** The detached driver's command line: this invocation with --drive and without --detach / --json. */
export function releaseDriveArgv(version, o, baseline) {
    return [
        'release', version, '--drive', '--drive-max', o.driveMax, '--timeout', o.timeout,
        ...(o.from ? ['--from', o.from] : []),
        ...(o.to ? ['--to', o.to] : []),
        ...(o.yes ? ['--yes'] : []),
        ...(o.suite ? ['--suite', o.suite] : []),
        ...(baseline ? ['--baseline', baseline] : []),
        ...(o.liveSmoke ? ['--live-smoke'] : []),
        ...(o.forceSmoke ? ['--force-smoke'] : []),
        '--triage-runs', o.triageRuns, '--triage-timeout', o.triageTimeout,
        ...(o.allowSkippedSmoke ? ['--allow-skipped-smoke'] : []),
        ...(o.fixOrphans ? ['--fix-orphans'] : []),
    ];
}
function monitorHint(progressFile) {
    return `omg progress watch --file ${progressFile} --until settled --stall 30m`;
}
export function releaseCommand(overrides = {}) {
    const cmd = new Command('release');
    cmd
        .description('Maintainer-only release: preflight, bump, build, gates, commit, suite, smoke, PR to dev, promote to main, tag, verify (resumable)')
        .argument('<version>', 'Release version X.Y.Z')
        .option('--from <phase>', `Start at this phase (${PHASES.join(', ')}); default: the first phase not yet ok`)
        .option('--to <phase>', 'Stop after this phase')
        .option('--dry-run', 'Print the plan for the selected phases without running anything')
        .option('--json', 'JSON output')
        .option('--yes', 'Create and push the tag without the interactive confirmation')
        .option('--suite <suite>', 'vitest suite (suite phase, after commit): none, targeted (related to src changed since the last tag) or full; recorded per release, default: the recorded level, else none')
        .option('--baseline <file>', 'Full-suite baseline (vitest JSON report or one "<file> > <title>" per line); only new failing titles fail')
        .option('--live-smoke', 'Run the live Tier 2 smoke (two prompts, about 0.6 AI credits); skipped otherwise')
        .option('--force-smoke', 'Run the live smoke even when its inputs hash to the last green smoke (implies --live-smoke); without it an identical input hash reuses that smoke')
        .option('--triage-runs <n>', 'Isolated reruns of each new failing full-suite title (pass every rerun = load-flaky, warns; fail some = mixed, blocks; fail all = real, fails)', '3')
        .option('--triage-timeout <minutes>', 'Minutes each isolated rerun may take; a timeout counts as a failed rerun', '5')
        .option('--flaky-candidates', 'Print the known-flaky candidates of the full-suite triage, ready to paste into .github/known-flaky-tests.json after review; run nothing')
        .option('--allow-skipped-smoke', 'Let the pr phase run although the live smoke was skipped')
        .option('--fix-orphans', 'Remove tracked dist outputs whose src source is gone')
        .option('--timeout <minutes>', 'Minutes the pr / promote / verify phases wait on CI per run', '60')
        .option('--drive', 'Keep driving until done, a real failure or a human decision: a CI wait past --timeout or a transient GitHub error resumes after a minute (never prompts; the tag still needs --yes)')
        .option('--drive-max <hours>', 'Hard ceiling of a --drive run; then blocked', String(DRIVE_MAX_HOURS))
        .option('--detach', 'Run the --drive loop as a detached process that outlives this session (log: <state root>/release/<v>.drive.log)')
        .option('--status', 'Print the drive lock, the last progress events and the phase table, run nothing')
        .option('--stop', 'Stop the detached driver of this release and remove its lock')
        .action(async (versionRaw, o) => {
        const json = Boolean(o.json);
        try {
            let version;
            try {
                version = parseReleaseVersion(versionRaw);
            }
            catch (error) {
                throw new UsageError(error.message);
            }
            if (o.suite !== undefined && !['none', 'targeted', 'full'].includes(o.suite))
                throw new UsageError(`--suite must be none, targeted or full, got ${JSON.stringify(o.suite)}`);
            if (o.baseline && o.suite !== undefined && o.suite !== 'full')
                throw new UsageError('--baseline needs --suite full');
            const timeoutMinutes = Number(o.timeout);
            if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)
                throw new UsageError('--timeout must be a positive number of minutes');
            const driveMaxHours = Number(o.driveMax);
            if (!Number.isFinite(driveMaxHours) || driveMaxHours <= 0)
                throw new UsageError('--drive-max must be a positive number of hours');
            const triageRuns = Number(o.triageRuns);
            if (!Number.isInteger(triageRuns) || triageRuns < 1)
                throw new UsageError('--triage-runs must be a positive whole number');
            const triageTimeoutMinutes = Number(o.triageTimeout);
            if (!Number.isFinite(triageTimeoutMinutes) || triageTimeoutMinutes <= 0)
                throw new UsageError('--triage-timeout must be a positive number of minutes');
            if ([o.status, o.stop, o.flakyCandidates].filter(Boolean).length > 1)
                throw new UsageError('pass one of --status / --stop / --flaky-candidates');
            if (o.detach && o.dryRun)
                throw new UsageError('--detach runs the release; drop --dry-run');
            const from = phaseOption(o.from, '--from');
            const to = phaseOption(o.to, '--to');
            if (from && to && PHASES.indexOf(from) > PHASES.indexOf(to))
                throw new UsageError(`--from ${from} comes after --to ${to}`);
            if (o.suite !== undefined && to && PHASES.indexOf(to) < PHASES.indexOf('suite')) {
                console.error(chalk.yellow(`Warning: --to ${to} stops before the suite phase, so --suite ${o.suite} does not run in this invocation (it is recorded for the release and runs when a later run reaches suite).`));
            }
            const exec = overrides.exec ?? defaultReleaseExec;
            const root = overrides.root ?? (() => {
                const r = exec('git', ['rev-parse', '--show-toplevel']);
                if (r.status !== 0)
                    throw new UsageError('omg release must run inside a git repository');
                return r.stdout.trim();
            })();
            const stateRoot = overrides.stateRoot ?? getOmcRoot(root);
            const deps = {
                exec,
                // A scripted exec (tests) runs the suite through itself too, with no PATH check.
                execAsync: overrides.execAsync ?? (overrides.exec ? undefined : defaultReleaseExecAsync),
                suiteShell: overrides.suiteShell ?? (overrides.exec ? undefined : () => {
                    // An absolute git: a bare name may resolve in the cwd on Node 20 (see resolveBareExe).
                    const gitExe = process.platform === 'win32' ? resolveBareExe('git') : null;
                    const git = gitExe ? exec(gitExe, ['--exec-path']) : null;
                    return suiteShellFor(process.platform, process.env, existsSync, git?.status === 0 && git.stdout.trim() ? git.stdout : null);
                }),
                root,
                stateRoot,
                node: overrides.node ?? process.execPath,
                loadShipConfig: overrides.loadShipConfig ?? ((ctx) => loadTrustedShipConfig({ ...ctx, ...userConfigLayers() })),
                progress: overrides.progress ?? ((event) => { emitReleaseProgress({ agent: 'release', ...event }, stateRoot); }),
                log: overrides.log ?? ((line) => { if (!json)
                    console.error(line); }),
                confirm: overrides.confirm ?? ttyConfirm,
                sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                now: overrides.now ?? (() => Date.now()),
            };
            const proc = overrides.driveProcess ?? defaultDriveProcess;
            const releaseDir = join(stateRoot, 'release');
            const lockPath = driveLockPath(releaseDir, version);
            const logPath = driveLogPath(releaseDir, version);
            const progressFile = releaseProgressFile(stateRoot);
            if (o.status) {
                const lock = readDriveLock(lockPath);
                const liveness = lock ? await proc.liveness(lock) : undefined;
                const state = readReleaseState(stateRoot, version);
                const events = lastLines(progressFile, 5);
                if (json) {
                    console.log(JSON.stringify({ lock, liveness, lockPath, logPath, progressFile, events, phases: state?.phases ?? {} }, null, 2));
                }
                else {
                    console.log(lock
                        ? `driver: pid ${lock.pid} on ${lock.host} since ${lock.startedAt} (${liveness}); log ${logPath}`
                        : `driver: none (no ${lockPath})`);
                    if (lock && liveness === 'live')
                        console.log(`wake on it: ${monitorHint(progressFile)}`);
                    else
                        console.log(`resume: omg release ${version} --drive --detach`);
                    console.log(`last events (${progressFile}):`);
                    for (const line of events)
                        console.log(`  ${line}`);
                    for (const id of PHASES) {
                        const p = state?.phases[id];
                        console.log(`  ${id.padEnd(9)} ${p ? `${p.status}: ${p.note}` : '-'}`);
                    }
                }
                process.exitCode = 0;
                return;
            }
            if (o.flakyCandidates) {
                const path = flakyCandidatesPath(stateRoot, version);
                const content = existsSync(path) ? readFileSync(path, 'utf8') : null;
                let tests = [];
                try {
                    tests = content ? JSON.parse(content).tests ?? [] : [];
                }
                catch (error) {
                    throw new UsageError(`${path} is not valid JSON (${error.message}); delete it and re-run --from suite --suite full to regenerate`);
                }
                if (json)
                    console.log(JSON.stringify({ path, tests }, null, 2));
                else if (tests.length === 0)
                    console.log(`no known-flaky candidates for ${version} (${path})`);
                else {
                    console.log(`${tests.length} known-flaky candidate(s) of the ${version} full-suite triage (${path}).`);
                    console.log('Owner approval needed: review the evidence, then paste approved entries into "tests" of .github/known-flaky-tests.json (drop "evidence"):');
                    console.log(JSON.stringify(tests, null, 2));
                }
                process.exitCode = 0;
                return;
            }
            if (o.stop) {
                const stopped = await stopDriver(lockPath, proc);
                if (stopped.stopped) {
                    deps.progress({ phase: 'release', status: 'blocked', note: `drive of ${version} stopped by --stop (pid ${stopped.pid}); resume: omg release ${version} --drive --detach` });
                }
                const message = stopped.stopped ? `stopped the driver (pid ${stopped.pid}) and removed ${lockPath}` : stopped.reason;
                if (json)
                    console.log(JSON.stringify({ ...stopped, lockPath }, null, 2));
                else
                    console.log(message);
                process.exitCode = !stopped.stopped && stopped.refused ? 1 : 0;
                return;
            }
            const baseline = o.baseline ? resolve(o.baseline) : undefined;
            if (o.detach) {
                const argv = releaseDriveArgv(version, o, baseline);
                const detached = await detachDriver({
                    lockPath, logPath, argv, cwd: root, proc, sleep: deps.sleep, spawnImpl: overrides.spawnDriver,
                    entry: overrides.entry ?? process.argv[1], statusCommand: `omg release ${version} --status`,
                });
                if (json)
                    console.log(JSON.stringify({ ...detached, lockPath, logPath, progressFile, monitor: monitorHint(progressFile) }, null, 2));
                else if (!detached.ok)
                    console.error(chalk.red(`Error: ${detached.reason}`));
                else {
                    console.log(chalk.green(`release ${version}: driving detached as pid ${detached.pid}${detached.locked ? '' : ' (it has not taken the lock yet; check --status and the log)'}`));
                    console.log(`  log      ${logPath}`);
                    console.log(`  status   omg release ${version} --status   stop: omg release ${version} --stop`);
                    console.log(`  wake on  ${monitorHint(progressFile)}`);
                }
                process.exitCode = detached.ok ? 0 : 1;
                return;
            }
            const options = {
                version,
                from,
                to,
                dryRun: o.dryRun,
                yes: o.yes,
                suite: o.suite,
                baseline: o.baseline,
                liveSmoke: o.liveSmoke,
                forceSmoke: o.forceSmoke,
                triageRuns,
                triageTimeoutMinutes,
                allowSkippedSmoke: o.allowSkippedSmoke,
                fixOrphans: o.fixOrphans,
                timeoutMinutes,
            };
            let result;
            if (o.drive && !o.dryRun) {
                const driveDeps = { ...deps, progress: throttleHeartbeats(deps.progress, deps.now) };
                const held = await withDriveLock(lockPath, process.argv.slice(2), proc, deps.log, async () => {
                    try {
                        return await driveRelease(driveDeps, options, { maxHours: driveMaxHours });
                    }
                    catch (error) {
                        // A terminal event for the Monitor even when the engine throws (bad state file, usage error).
                        deps.progress({ phase: 'release', status: 'fail', note: `${error instanceof Error ? error.message : String(error)}; fix it, then omg release ${version} --drive --detach` });
                        throw error;
                    }
                });
                if (!held.held) {
                    throw new Error(`another driver holds ${lockPath}${held.holder ? ` (pid ${held.holder.pid} on ${held.holder.host}, started ${held.holder.startedAt})` : ''}; see omg release ${version} --status`);
                }
                result = held.value;
            }
            else {
                result = await runRelease(deps, { ...options, drive: o.drive });
            }
            if (json)
                console.log(JSON.stringify(result, null, 2));
            else
                printResult(result);
            process.exitCode = result.ok ? 0 : 1;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (json)
                console.log(JSON.stringify({ ok: false, error: message }, null, 2));
            else
                console.error(chalk.red(`Error: ${message}`));
            process.exitCode = error instanceof UsageError ? 2 : 1;
        }
    });
    return cmd;
}
//# sourceMappingURL=release.js.map