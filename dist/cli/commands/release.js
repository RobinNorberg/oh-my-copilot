/**
 * `omg release <version>`: the maintainer-only release pipeline as ordered,
 * resumable phases (src/release/engine.ts). `--dry-run` prints the plan and
 * runs nothing; without `--from` a run resumes at the first phase not yet ok.
 *
 * Exit codes: 0 ok, 1 a phase failed or is blocked, 2 usage error.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { loadTrustedShipConfig, userConfigLayers } from '../../ship/config.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { parseReleaseVersion } from '../../release/checks.js';
import { defaultReleaseExec, isPhaseId, PHASES, runRelease, UsageError, } from '../../release/engine.js';
import { emitReleaseProgress } from '../../release/progress.js';
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
        .option('--allow-skipped-smoke', 'Let the pr phase run although the live smoke was skipped')
        .option('--fix-orphans', 'Remove tracked dist outputs whose src source is gone')
        .option('--timeout <minutes>', 'Minutes the pr / promote / verify phases wait on CI per run', '60')
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
            const result = await runRelease(deps, {
                version,
                from,
                to,
                dryRun: o.dryRun,
                yes: o.yes,
                suite: o.suite,
                baseline: o.baseline,
                liveSmoke: o.liveSmoke,
                allowSkippedSmoke: o.allowSkippedSmoke,
                fixOrphans: o.fixOrphans,
                timeoutMinutes,
            });
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