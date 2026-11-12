/**
 * `omg factory bench`: measure the factory on a fixed set of seeded issues
 * against the local forge (src/factory/bench/). `init` makes the fixture,
 * `run` drives the engine over it (--fake: scripted lanes, no cost; --live:
 * real Copilot, only with --max-requests) and scores it, `compare` diffs two
 * results files.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { createBenchFixture } from '../../factory/bench/fixture.js';
import { BenchUsageError, DEFAULT_BENCH_MAX_MINUTES, LIVE_CAP_BOUND, parseIssueList, runBench } from '../../factory/bench/runner.js';
import { compareResults, readBenchResults } from '../../factory/bench/score.js';
import { integerOption } from '../utils/integer-option.js';
const fail = (error, usage = false) => {
    console.error(chalk.red(`omg factory bench: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = usage || error instanceof BenchUsageError ? 2 : 1;
};
export function factoryBenchCommand() {
    const bench = new Command('bench').description('Benchmark the factory on seeded issues against the local forge (init a fixture, run it --fake or --live, compare results)');
    bench
        .command('init')
        .argument('<dir>', 'a new or empty directory for the fixture (the repository goes to <dir>/repo)')
        .option('--node-modules <dir>', 'link <dir>/repo/node_modules to this node_modules (it needs vitest and typescript) instead of running npm install there')
        .description('Create the bench fixture: a TypeScript + vitest repository on the local forge with the seeded backlog')
        .action((dir, o) => {
        try {
            const meta = createBenchFixture(dir, o.nodeModules ? { nodeModules: o.nodeModules } : {});
            console.log(chalk.green(`bench fixture v${meta.fixtureVersion} at ${meta.root} (${meta.issues.length} issues)`));
            if (!o.nodeModules)
                console.log(`next: npm install in ${meta.root}, then omg factory bench run ${dir} --fake (or --live --max-requests <n>)`);
        }
        catch (error) {
            fail(error);
        }
    });
    bench
        .command('run')
        .argument('<dir>', 'the fixture directory (omg factory bench init)')
        .option('--fake', 'scripted lanes, no Copilot and no cost: proves the harness, scoring and trap expectations')
        .option('--live', 'real Copilot lanes through omg factory run <id> in the fixture repository; needs --max-requests and the gate sandbox enforced (factory.run.sandbox.gates "enforced", or isolation "container")')
        .option('--max-requests <n>', `the premium-request cap: ${LIVE_CAP_BOUND}`, integerOption(1, 10_000))
        .option('--max-credits <n>', '--live: no run starts once this many AI credits are recorded (a soft stop: runs in flight finish)', integerOption(1, 1_000_000))
        .option('--max-minutes <n>', `no run starts after this many minutes (default ${DEFAULT_BENCH_MAX_MINUTES})`, integerOption(1, 24 * 60))
        .option('--parallel <n>', '--live: up to n runs at once (needs factory.run.maxConcurrent above 1 and layout "private" in your user config)', integerOption(1, 16))
        .option('--allow-multiplier <n>', '--live: accept a default Copilot model that bills up to n premium requests per call (refused above 1 without it)', integerOption(1, 1_000))
        .option('--issues <ids>', 'run only these issues (comma-separated ids, e.g. 2,6,9,10); the results record the subset')
        .option('--out <dir>', 'results directory (default ./bench-results)')
        .option('--json', 'print the results JSON instead of the summary')
        .description('Run the factory over the fixture until every issue is parked, finished or not runnable, then score it')
        .action(async (dir, o) => {
        if (Boolean(o.fake) === Boolean(o.live))
            return fail(new Error('pass exactly one of --fake and --live'), true);
        let issues;
        try {
            issues = o.issues === undefined ? undefined : parseIssueList(o.issues);
        }
        catch (error) {
            return fail(error, true);
        }
        let interrupted = false;
        const forwards = new Set();
        const onSignal = () => {
            if (interrupted)
                process.exit(130);
            interrupted = true;
            console.error(chalk.yellow('omg factory bench: no new run starts; the running ones stop after their current poll (press again to exit at once)'));
            for (const f of forwards)
                f('SIGINT');
        };
        process.on('SIGINT', onSignal);
        try {
            const out = await runBench({
                dir, mode: o.fake ? 'fake' : 'live', ...(o.maxRequests !== undefined ? { maxRequests: o.maxRequests } : {}),
                ...(o.maxCredits !== undefined ? { maxCredits: o.maxCredits } : {}), ...(o.maxMinutes !== undefined ? { maxMinutes: o.maxMinutes } : {}),
                ...(o.parallel !== undefined ? { parallel: o.parallel } : {}), ...(o.out ? { outDir: o.out } : {}), ...(issues ? { issues } : {}),
                ...(o.allowMultiplier !== undefined ? { allowMultiplier: o.allowMultiplier } : {}),
                log: (m) => { if (!o.json)
                    console.error(chalk.gray(m)); },
                // The lanes' model and multiplier, before any run starts (also with --json: stderr).
                announce: (m) => console.error(chalk.cyan(m)),
                interrupted: () => interrupted,
                signals: (forward) => { forwards.add(forward); return () => { forwards.delete(forward); }; },
            });
            const t = out.results.totals;
            if (o.json)
                console.log(JSON.stringify(out.results, null, 2));
            else {
                console.log(`pass ${t.passed}/${t.issues}; merged parks ${t.mergedParks}; premium requests ${t.premiumRequests}; traps contained ${t.trapsContained}/${t.traps}${out.results.stopped ? `; stopped: ${out.results.stopped}` : ''}`);
                console.log(`results: ${out.jsonPath}`);
                console.log(`summary: ${out.markdownPath}`);
            }
            process.exitCode = t.passed === t.issues ? 0 : 1;
        }
        catch (error) {
            fail(error);
        }
        finally {
            process.off('SIGINT', onSignal);
        }
    });
    bench
        .command('compare')
        .argument('<a>', 'a results JSON (bench-results/*.json)')
        .argument('<b>', 'another results JSON')
        .option('--out <file>', 'also write the markdown diff to this file')
        .option('--allow-subset-diff', 'compare results that cover different issues (--issues); the totals are then not like for like')
        .description('Diff two bench results: totals side by side and every issue whose outcome or pass verdict changed')
        .action((a, b, o) => {
        try {
            const text = compareResults(readBenchResults(a), readBenchResults(b), [a, b], { allowSubsetDiff: Boolean(o.allowSubsetDiff) });
            if (o.out)
                writeFileSync(o.out, text);
            console.log(text);
        }
        catch (error) {
            fail(error);
        }
    });
    return bench;
}
//# sourceMappingURL=factory-bench.js.map