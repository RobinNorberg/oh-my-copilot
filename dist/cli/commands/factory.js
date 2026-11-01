/**
 * Factory command (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * `omg factorylisten` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless harbor session spawn).
 *
 * `omg factoryinit` — seeds the project route table (`.omg/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. It seeds the narrow starter loop; --no-narrow is
 * retired and refuses. Never overwrites without --force. `--check` audits an
 * existing table; `--migrate` rewrites an old one (backup first).
 *
 * `omg factory chain status` (alias `omg factory status`) — the chain audit.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */
import { Command } from 'commander';
import { integerOption } from '../utils/integer-option.js';
import chalk from 'chalk';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { INTAKE_ROUTE_TABLE, startListener, stopListener } from '../../factory/listener.js';
import { readChainStatus } from '../../factory/status.js';
import { canonicalChainSkill, chainSkillStatus } from '../../hooks/session-end/routing.js';
import { LABEL_PATTERN, resolveChainSkill } from '../../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CopilotRunManager, defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { resolveFactoryRunLimits, runCredits } from '../../factory/run/budget.js';
import { cleanFactoryRun } from '../../factory/run/clean.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../../factory/run/engine.js';
import { factoryGuardExec } from '../../factory/run/exec.js';
import { factoryForgeOptions, loadFactoryForgeConfig, originForgeKind } from '../../factory/run/forge-roots.js';
import { CopilotLaneBackend } from '../../factory/run/lane.js';
import { factoryCancelRequested, factoryStatePath, readFactoryState, requestFactoryCancel, verifyFactoryIntegrity } from '../../factory/run/state.js';
import { resolveShipConfig, userConfigLayers } from '../../ship/config.js';
import { defaultExec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { healCommand } from '../../factory/heal/cli.js';
import { defaultFactoryCheckDeps, factoryCheckCommand, ttyConfirm } from './factory-check.js';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { runFactoryEnqueue } from '../../factory/enqueue.js';
import { resolveHealConfig } from '../../factory/heal/config.js';
import { defaultLedgerDir } from '../../factory/run/ledger.js';
import { listenForgeRefusal } from '../../factory/setup/detect.js';
import { factorySetupCommand } from './factory-setup.js';
import { factoryBoardCommand } from './factory-board.js';
import { factoryPollCommand } from './factory-poll.js';
import { defaultPollHealScan } from '../../factory/poll.js';
import { checkEnvFor, fetchBase, forgeReadExec, parseItemId } from '../../factory/check/cli.js';
import { BUCKET_ORDER, checkItems, plainText } from '../../factory/check/score.js';
import { createForge } from '../../forge/index.js';
import { skillSlash } from '../../utils/skill-slash.js';
export function renderChainStatus(status) {
    const lines = [];
    lines.push(`链状态 ${status.directory}`);
    lines.push(`路由表（.omg/factory-routes.json，单一权威）: ${status.routeKeys.length} 键${status.routeKeys.length > 0 ? ` — ${status.routeKeys.join(', ')}` : ''}`);
    lines.push(`活跃 ledger: ${status.activeLedgers}`);
    lines.push(`意图（${status.intents.length}）:`);
    if (status.intents.length === 0)
        lines.push('  （无决策记录）');
    for (const intent of status.intents) {
        const last = intent.lastDecision ? `${intent.lastDecision} @ ${intent.lastDecisionAt ?? '?'}` : '无';
        const stopped = intent.stopped ? `  停链[${intent.stopped.reason}]` : '';
        lines.push(`  ${intent.intentId}  决策 ${intent.decisionCount}  末次 ${last}${stopped}`);
        intent.links.forEach((link, index) => {
            const host = link.host ? ` [${link.host}]` : '';
            const ended = link.closedAt
                ? `已结束 ${link.outcome ?? '?'}→${link.decision ?? '?'}${link.hostSessionId && link.hostSessionId !== link.chainLink ? ` session=${link.hostSessionId}` : ''}`
                : '运行中';
            lines.push(`    环 ${index + 1} ${link.stage}${host} link=${link.chainLink} ${ended}`);
        });
    }
    lines.push(`停滞环（阈值 30min 未推进）: ${status.stalled.length}`);
    for (const stall of status.stalled) {
        lines.push(`  ${stall.intentId} stage=${stall.stage} 停滞 ${Math.round(stall.stalledForMs / 60_000)}min session=${stall.session}`);
    }
    return lines.join('\n');
}
function projectConfig(root) {
    const path = resolveProjectConfigPath(root);
    return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
}
export const defaultFactoryRunDeps = {
    exec: defaultExec,
    // `omg factory run` without --dry-run is itself the opt-in to live, billed lanes.
    lanes: () => new CopilotLaneBackend(new CopilotRunManager(defaultCopilotRunDeps()), { allowLive: true }),
    limits: (root) => resolveFactoryRunLimits(userConfigLayers().trustedUser, projectConfig(root)),
    base: (root) => {
        const pick = (c) => c?.ship?.base;
        return resolveShipConfig({ base: pick(projectConfig(root)) ?? pick(userConfigLayers().user) }).base;
    },
    forge: (root, base) => loadFactoryForgeConfig(factoryGuardExec(defaultExec), root, base, userConfigLayers().trustedUser, projectConfig(root)),
};
class FactoryUsageError extends Error {
}
/** --dry-run never starts a lane: any call is a bug and throws. */
const NO_LANES = {
    kind: 'local-sdk',
    start: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
    poll: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
    wait: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
    cancel: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
};
function parseIssue(raw) {
    const n = Number(String(raw ?? '').replace(/^#/, ''));
    if (!Number.isInteger(n) || n <= 0)
        throw new FactoryUsageError(`issue must be a positive number, got ${JSON.stringify(raw)}`);
    return n;
}
function factoryRoot(exec) {
    const r = exec('git', ['rev-parse', '--show-toplevel']);
    if (r.status !== 0)
        throw new FactoryUsageError('omg factory run must run inside a git repository');
    return r.stdout.trim();
}
/**
 * The `omg factory run --json` documents on stdout. `omg factory poll`'s
 * auto-start parses them (parseRunNextOutcome; its contract test builds its
 * fixtures from these writers).
 */
export const factoryRunJson = {
    nothingRunnable: (counts) => JSON.stringify({ ok: true, next: null, message: 'nothing runnable', counts }, null, 2),
    outcome: (outcome, next) => JSON.stringify({ ok: outcome.exitCode === 0, ...(next !== undefined ? { next } : {}), ...outcome }, null, 2),
    error: (message) => JSON.stringify({ ok: false, error: message }, null, 2),
};
async function factoryGuarded(json, fn) {
    try {
        process.exitCode = await fn();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json)
            console.log(factoryRunJson.error(message));
        else
            console.error(chalk.red(`Error: ${message}`));
        process.exitCode = error instanceof FactoryUsageError ? 2 : 1;
    }
}
export function renderFactoryRunState(state) {
    const lines = [`${chalk.bold(`factory run #${state.issue}`)}  phase=${chalk.cyan(state.phase)}  base=${state.base}  branch=${state.branch}${state.pr ? `  PR #${state.pr}` : ''}`];
    if (state.gate)
        lines.push(chalk.yellow(`awaiting-human: ${state.gate.name}: ${state.gate.reason}`));
    if (state.cancelRequested && state.phase !== 'cancelled')
        lines.push(chalk.yellow('cancel requested'));
    if (state.head)
        lines.push(`head ${state.head.slice(0, 12)}`);
    lines.push(`lanes ${state.lanes.length}  run AI credits ${runCredits(state).toFixed(2)}  elapsed ${Math.round(state.elapsedMs / 60_000)} min`);
    for (const lane of state.lanes) {
        const credits = lane.usage ? `${lane.usage.credits.toFixed(2)}/${lane.maxCredits}` : `-/${lane.maxCredits}`;
        lines.push(`  ${lane.id} ${lane.status}${lane.verdict ? ` ${lane.verdict}` : ''} credits ${credits}${lane.jobId ? ` job ${lane.jobId}` : ''}${lane.sandbox ? ` sandbox ${lane.sandbox.mode}` : ''}`);
    }
    for (const h of state.history.slice(-5))
        lines.push(chalk.gray(`  ${h.at} ${h.from ?? '-'} -> ${h.to}: ${h.note}`));
    return lines.join('\n');
}
/**
 * `run --next`: the first runnable item in `omg factory check` order
 * (priority, then id) among the spec's children (`--parent`) or the intake
 * source, read through check's read-only guard. A merged, cancelled, failed
 * or active run, an own factory PR open or merged, or an unsatisfied
 * dependency is never runnable (check/rules.ts), so --next never re-runs a
 * finished item. Null with the checked rows when nothing is runnable.
 */
function pickNext(deps, root, base, loaded, parent) {
    const { config } = loaded;
    const source = config.intake.source;
    if (parent === undefined && !source)
        throw new FactoryUsageError('--next needs --parent <spec> or factory.intake.source');
    const read = forgeReadExec(deps.exec, config, root);
    const forge = createForge(read.exec, root, config, read.options);
    const warnings = [];
    const baseSha = fetchBase(read.exec, root, base, warnings);
    const ids = parent !== undefined ? forge.tracker.viewItem(parent).children : forge.tracker.queryItems(source, config.intake.limit);
    const items = checkItems(forge, ids, checkEnvFor(read.exec, root, config, base, baseSha));
    return { next: items.find((r) => r.bucket === 'runnable') ?? null, items, warnings };
}
const bucketCounts = (items) => Object.fromEntries(BUCKET_ORDER.map((b) => [b, items.filter((r) => r.bucket === b).length]));
function printOutcome(json, outcome, next) {
    if (json) {
        console.log(factoryRunJson.outcome(outcome, next));
        return;
    }
    if (outcome.state)
        console.log(renderFactoryRunState(outcome.state));
    const color = outcome.exitCode === 0 ? chalk.green : outcome.exitCode === 1 ? chalk.red : chalk.yellow;
    console.log(color(outcome.message));
}
/** `omg factory run <issue>`, `run cancel|clean|status <issue>` (experimental; manual trigger only; merge is always human). */
export function factoryRunCommand(deps = defaultFactoryRunDeps) {
    const exec = factoryGuardExec(deps.exec);
    const run = new Command('run');
    run
        .description('Experimental: drive one issue through implement -> draft PR -> independent review / fix rounds -> prepare -> CI gates, then park for the human merge')
        .argument('[issue]', 'GitHub issue or Azure DevOps work item number')
        .option('--next', 'Run the next runnable item (omg factory check order: priority, then id); exit 0 when nothing is runnable')
        .option('--parent <spec>', 'With --next: pick among the children of this spec item instead of factory.intake.source')
        .option('--dry-run', 'Resolve the issue and plan and print the next step; no state, lanes or pushes')
        .option('--json', 'JSON output')
        .action((issueRaw, o) => factoryGuarded(Boolean(o.json), async () => {
        if (o.next && issueRaw !== undefined)
            throw new FactoryUsageError('--next takes no issue: it picks the next runnable item');
        if (o.parent !== undefined && !o.next)
            throw new FactoryUsageError('--parent applies to --next');
        let parent;
        try {
            parent = o.parent === undefined ? undefined : parseItemId(o.parent);
        }
        catch (error) {
            throw new FactoryUsageError(error instanceof Error ? error.message : String(error));
        }
        const root = factoryRoot(exec);
        const { limits, warnings } = deps.limits(root);
        for (const w of warnings)
            console.error(chalk.yellow(w));
        const base = deps.base(root);
        const loaded = deps.forge?.(root, base);
        for (const w of loaded?.warnings ?? [])
            console.error(chalk.yellow(w));
        let issue;
        let picked;
        if (o.next) {
            if (!loaded)
                throw new FactoryUsageError('--next needs the forge config (omg factory setup)');
            const { next, items, warnings: pickWarnings } = pickNext(deps, root, base, loaded, parent);
            for (const w of pickWarnings)
                console.error(chalk.yellow(plainText(w)));
            const counts = bucketCounts(items);
            if (!next) {
                if (o.json)
                    console.log(factoryRunJson.nothingRunnable(counts));
                else
                    console.log(`nothing runnable (${BUCKET_ORDER.map((b) => `${counts[b]} ${b}`).join(', ')})`);
                return 0;
            }
            issue = picked = next.id;
            if (!o.json)
                console.log(chalk.cyan(`next runnable: #${next.id} ${next.title}`));
        }
        else {
            issue = parseIssue(issueRaw);
        }
        // The full untrusted roots, never a partial list (critic amendments §A.14; the engine re-checks).
        const forge = loaded ? { config: loaded.config, options: factoryForgeOptions(root) } : undefined;
        let signals = 0;
        const onSignal = () => {
            signals += 1;
            if (signals > 1)
                process.exit(130);
            console.error(chalk.yellow('omg factory run: stopping after the current poll (cancelling the lane); press again to exit at once'));
        };
        if (!o.dryRun) {
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);
        }
        try {
            const outcome = await runFactoryEngine({
                root, issue, exec: deps.exec, limits, base, dryRun: Boolean(o.dryRun),
                lanes: o.dryRun ? NO_LANES : deps.lanes(root),
                ...(forge ? { forge } : {}),
                ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}),
                ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
                interrupted: () => signals > 0,
                warn: (m) => console.error(chalk.yellow(m)),
            });
            printOutcome(Boolean(o.json), outcome, picked);
            return outcome.exitCode;
        }
        finally {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        }
    }));
    run
        .command('cancel <issue>')
        .description('Ask the running engine to cancel the lane and stop (the PR, branch and worktrees are kept)')
        .option('--json', 'JSON output')
        .action((issueRaw, _o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const state = requestFactoryCancel(factoryRoot(exec), issue, new Date().toISOString());
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ok: true, cancelRequested: true, phase: state.phase }, null, 2));
        else
            console.log(chalk.green(`cancel requested for factory run #${issue} (phase ${state.phase}); a running engine stops within seconds, otherwise the next run finishes the cancel`));
        return 0;
    }));
    run
        .command('clean <issue>')
        .description('Remove the worktrees and local branches of a merged or cancelled run, only when nothing would be lost (the PR branch on GitHub is kept)')
        .option('--json', 'JSON output')
        .action((issueRaw, _o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const result = cleanFactoryRun({ root: factoryRoot(exec), issue, exec: deps.exec, ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ok: result.kept.length === 0, ...result }, null, 2));
        else {
            for (const path of result.removed)
                console.log(chalk.green(`removed ${path}`));
            for (const k of result.kept)
                console.log(chalk.yellow(`kept ${k.worktree}: ${k.reason}`));
            if (result.removed.length === 0 && result.kept.length === 0)
                console.log(`nothing to clean for factory run #${issue}`);
        }
        return result.kept.length === 0 ? 0 : EXIT_AWAITING_HUMAN;
    }));
    run
        .command('status <issue>')
        .description('Print the persisted factory run state (read-only)')
        .option('--json', 'JSON output')
        .action((issueRaw, _o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const stored = readFactoryState(root, issue);
        if (!stored)
            throw new FactoryUsageError(`no factory run for issue #${issue} (${factoryStatePath(root, issue)})`);
        const state = factoryCancelRequested(root, issue) ? { ...stored, cancelRequested: true } : stored;
        const integrity = verifyFactoryIntegrity(stored);
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ...state, integrityOk: integrity, runCredits: runCredits(state) }, null, 2));
        else {
            console.log(renderFactoryRunState(state));
            if (!integrity)
                console.log(chalk.red('integrity check FAILED: the state was edited outside omg factory run'));
        }
        return 0;
    }));
    return run;
}
/** `omg factory enqueue` (shipyard ↔ factory design §3.2-§3.4); the command lives in src/factory/enqueue.ts. */
export function factoryEnqueueCommand(deps) {
    return new Command('enqueue')
        .description('Push launch\'s approved tickets to the tracker as children of a spec (GitHub or Azure DevOps; idempotent by shipyard-key)')
        .requiredOption('--spec <id>', 'the parent spec issue')
        .requiredOption('--file <path>', 'the ticket file launch wrote (schemaVersion 1)')
        .option('--dry-run', 'print the exact writes and write nothing')
        .option('--json', 'JSON output (schemaVersion 1)')
        .addHelpText('after', [
        '',
        'Without --dry-run, enqueue creates or updates the items (with the intake label and a priority label),',
        'rewrites the spec\'s task list, then runs the mark step `omg factory check <ids> --mark --yes` over',
        'this file\'s created, updated and unchanged items (never orphans), which adds factory.intake.marker',
        'to the runnable ones. The launch C3 signature is the confirmation',
        'for all of it: run --dry-run first and show its output at C3. Items already claimed by a factory run',
        'are never edited, and items whose key left the file are reported as orphaned, never closed.',
        'On Azure DevOps the items are work items of factory.intake.itemTypes[0] with the AC and priority fields,',
        'linked to the spec (parent) and their predecessors; the spec itself is not edited.',
    ].join('\n'))
        .action(async (o) => {
        try {
            process.exitCode = await runFactoryEnqueue(o, deps);
        }
        catch (error) {
            const message = plainText(error instanceof Error ? error.message : String(error));
            if (o.json)
                deps.out(JSON.stringify({ ok: false, error: message }, null, 2));
            else
                deps.err(chalk.red(`Error: ${message}`));
            process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
        }
    });
}
export function factoryCommand() {
    const cmd = new Command('factory');
    cmd.description('Software factory automation (chain trigger + intake listener)');
    cmd.addCommand(factoryRunCommand());
    cmd.addCommand(factoryCheckCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryEnqueueCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryBoardCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryPollCommand({
        ...defaultFactoryCheckDeps(defaultFactoryRunDeps.base),
        healScan: defaultPollHealScan(defaultExec, (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)), defaultLedgerDir()),
    }));
    cmd.addCommand(healCommand({
        exec: defaultExec,
        base: defaultFactoryRunDeps.base,
        config: (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)),
        now: () => new Date(),
        // `omg factory heal run` without --dry-run is itself the opt-in to one billed, capped debugger lane;
        // `omg factory heal approve` is the human's opt-in to the ci-heal run's billed, capped lanes.
        lanes: defaultFactoryRunDeps.lanes,
        ledgerDir: defaultLedgerDir(),
        runLimits: defaultFactoryRunDeps.limits,
        forgeKind: (root) => originForgeKind(factoryGuardExec(defaultExec), root),
        // Azure DevOps only: the trusted forge config naming factory.heal.pipeline (GitHub never loads it).
        forge: defaultFactoryRunDeps.forge,
    }));
    cmd.addCommand(factorySetupCommand());
    cmd
        .command('listen')
        .description('Run the intake listener daemon: HMAC-verified webhook events -> intake label gate -> headless harbor sessions')
        .option('--port <n>', 'port to listen on (transport adapters forward here)', integerOption(0, 65535), 7788)
        .option('--host <addr>', 'host to bind to (default: 127.0.0.1 for localhost only; set to 0.0.0.0 only when transport adapter runs on another machine)', '127.0.0.1')
        .requiredOption('--repo <names>', 'repository whitelist, comma-separated owner/name')
        .option('--cwd <dir>', 'repository whose .omg state root the daemon writes to', process.cwd())
        .action((options) => {
        const forgeRefusal = listenForgeRefusal(defaultExec, resolve(options.cwd), userConfigLayers().trustedUser);
        if (forgeRefusal) {
            console.error(chalk.red(forgeRefusal));
            process.exitCode = 1;
            return;
        }
        const secret = process.env.OMC_FACTORY_HMAC_SECRET;
        if (!secret) {
            console.error(chalk.red('refused: no HMAC secret. Set OMC_FACTORY_HMAC_SECRET.'));
            process.exitCode = 1;
            return;
        }
        const whitelist = options.repo.split(',').map((s) => s.trim()).filter(Boolean);
        if (whitelist.length === 0) {
            console.error(chalk.red('refused: --repo whitelist is empty.'));
            process.exitCode = 1;
            return;
        }
        const cwd = resolve(options.cwd);
        void startListener({ port: options.port, secret, whitelist, cwd, host: options.host }).then((server) => {
            const addr = server.address();
            const port = addr && typeof addr !== 'string' ? addr.port : options.port;
            const host = addr && typeof addr !== 'string' ? addr.address : options.host;
            console.log(chalk.green(`factory listener on ${host}:${port} — whitelist: ${whitelist.join(', ')}`));
            console.log(chalk.gray(`liveness: GET http://${host === '::' ? '[::1]' : host}:${port}/status or check .omg/state/factory-listener.json`));
            const stop = () => {
                stopListener(server, cwd);
                process.exit(0);
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
        });
    });
    cmd
        .command('init')
        .description('Seed the project route table .omg/factory-routes.json (the chain-routing source of truth) and validate factory prerequisites')
        // Negatable option: Commander defaults `narrow` to true. --no-narrow is
        // kept only so that it refuses with a pointer instead of "unknown option".
        .option('--no-narrow', 'retired: the full-pipeline template (intake -> intent -> launch -> diagnose) now refuses')
        .option('--cwd <dir>', 'project directory to seed (defaults to the working directory)', process.cwd())
        .option('--force', 'replace an existing route table (read it first — it is the routing source of truth)', false)
        .option('--check', 'print every route of the existing table with its status and replacement (read-only; exit 1 when a route needs --migrate)')
        .option('--migrate', 'rewrite an old table to the narrow one: captain/retired routes removed, intake -> harbor; writes a .bak first')
        .option('--yes', 'confirm --migrate without a prompt (required without an interactive terminal)')
        .action(async (options) => {
        let result;
        if (options.check && options.migrate)
            result = { exitCode: 2, message: 'factory init: --check and --migrate are mutually exclusive' };
        else if (options.check)
            result = checkFactoryRoutes(options.cwd);
        else if (options.migrate) {
            result = await migrateFactoryRoutes({ cwd: options.cwd, yes: options.yes, isTTY: Boolean(process.stdin.isTTY), confirm: ttyConfirm });
        }
        else
            result = runFactoryInit({ narrow: options.narrow, cwd: options.cwd, force: options.force });
        if (result.exitCode === 0) {
            console.log(options.check ? result.message : chalk.green(result.message));
        }
        else {
            console.error(options.check ? result.message : chalk.red(result.message));
            process.exitCode = result.exitCode;
        }
    });
    // Read-only audit view of this project's chain: decision trail, stop
    // markers, live ledgers, stalled links (D2). Never writes.
    const chainStatus = (options) => {
        const status = readChainStatus(process.cwd());
        console.log(options.json ? JSON.stringify(status, null, 2) : renderChainStatus(status));
    };
    const chain = cmd.command('chain').description('Legacy SessionEnd chain (frozen: single intake -> harbor hop)');
    chain
        .command('status')
        .description('Summarize this project\'s chain decisions, stop markers, and stalled links (read-only)')
        .option('--json', 'Output as JSON')
        .action(chainStatus);
    // Kept so existing scripts work; `omg factory run status <issue>` is the engine's.
    cmd
        .command('status')
        .description('Alias of omg factory chain status (legacy chain audit, read-only)')
        .option('--json', 'Output as JSON')
        .action(chainStatus);
    return cmd;
}
/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> harbor hop. Everything after a completed harbor session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export function buildRouteTableNarrow() {
    return { ...INTAKE_ROUTE_TABLE };
}
/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omg/state/`) and the yard's two day-one
 * faces drydock seeds (`CLAUDE.md` + `GLOSSARY.md`).
 */
export function validateFactoryPrerequisites(cwd) {
    const missing = [];
    if (!existsSync(join(getOmcRoot(cwd), 'state')))
        missing.push('.omg/state/');
    for (const face of ['CLAUDE.md', 'GLOSSARY.md']) {
        if (!existsSync(join(cwd, face)))
            missing.push(face);
    }
    return { ok: missing.length === 0, missing };
}
/**
 * `omg factoryinit`: seed `.omg/factory-routes.json` with the narrow starter
 * table. narrow:false (the retired full template) refuses. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export function runFactoryInit(options = {}) {
    if (options.narrow === false) {
        return {
            exitCode: 1,
            message: 'factory init refused: --no-narrow is retired. Its full template (intake -> intent -> launch -> diagnose) chained launch, which needs a live captain, into a diagnose skill that does not exist. Run launch in a session and deliver each issue with omg factory run <issue>; CI: failed push runs of ci.yml on the dev branch are queued by the listener (workflow_run) and processed by the next omg factory heal scan; failures on other branches or workflows are no longer acted on by the listener (run omg factory heal scan manually). See the factory section of docs/REFERENCE.md.',
        };
    }
    const cwd = resolve(options.cwd ?? process.cwd());
    const routesPath = join(getOmcRoot(cwd), 'factory-routes.json');
    const prerequisites = validateFactoryPrerequisites(cwd);
    if (!prerequisites.ok) {
        return {
            exitCode: 1,
            message: `factory init refused: missing prerequisites (${prerequisites.missing.join(', ')}). Harbor needs .omg/state/ (run an OMC session or omg setup first); the yard faces CLAUDE.md and GLOSSARY.md come from ${skillSlash('drydock')}. Point --cwd at the project root.`,
        };
    }
    if (existsSync(routesPath) && !options.force) {
        return {
            exitCode: 1,
            message: `factory init refused: ${routesPath} already exists and the project route table is never overwritten. Read it first, then pass --force to replace it.`,
        };
    }
    const table = buildRouteTableNarrow();
    try {
        mkdirSync(join(routesPath, '..'), { recursive: true });
        writeFileSync(routesPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
    }
    catch (error) {
        return { exitCode: 1, message: `factory init failed: cannot write ${routesPath}: ${error.message}` };
    }
    const routes = Object.entries(table).map(([key, directive]) => `${key} -> ${directive.stage}/${directive.skill}`).join('; ');
    return {
        exitCode: 0,
        message: `factory init wrote ${routesPath} (narrow starter table): ${routes}. The SessionEnd chain enqueuer reads this file as the single source of truth — a missing route halts the chain, and skill "stop" marks a terminal stage.`,
    };
}
function readRawRoutes(routesPath) {
    if (!existsSync(routesPath))
        return null;
    const raw = readFileSync(routesPath, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return { ok: true, raw, table: parsed };
    }
    catch {
        // reported below
    }
    return { ok: false, message: `${routesPath} is not a JSON object; fix it by hand or re-run omg factory init --force` };
}
function classifyRoute(cwd, key, value) {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const stage = typeof entry.stage === 'string' ? entry.stage : '';
    const skill = typeof entry.skill === 'string' ? entry.skill : '';
    const row = (status, replacement) => ({ key, stage, skill, status, replacement });
    if (!key.includes(':') || typeof entry.stage !== 'string' || typeof entry.skill !== 'string') {
        return row('invalid', 'ignored by the chain: not an outcome:reason route with a stage and a skill');
    }
    const name = canonicalChainSkill(skill);
    const status = chainSkillStatus(skill);
    if (status === 'retired')
        return row(status, 'none: omg factory heal scan handles CI failures');
    if (status === 'captain') {
        return row(status, name === 'launch'
            ? `none: run ${skillSlash('launch')} with the accepted intent`
            : `none: run ${skillSlash(name)} in a session (it needs a live captain)`);
    }
    if (!LABEL_PATTERN.test(stage) || !LABEL_PATTERN.test(skill))
        return row('invalid', 'ignored by the chain: stage or skill has characters outside [A-Za-z0-9_.-]');
    if (name === 'stop')
        return row('terminal', '');
    if (status === 'deprecated') {
        return row(status, key === 'success:intake' ? 'success:intake -> harbor' : 'still spawns; tracker intake belongs to harbor');
    }
    const resolved = resolveChainSkill(cwd, skill);
    if (resolved.ok)
        return row('ok', '');
    return row('unknown', resolved.hint
        ? `halts the chain (route-unknown): ${resolved.hint}`
        : 'halts the chain (route-unknown): no bundled or project skill of this name');
}
function renderRouteRows(rows) {
    const cells = [['route', 'skill', 'status', 'replacement'], ...rows.map((r) => [r.key, r.skill, r.status, r.replacement])];
    const widths = [0, 1, 2].map((i) => Math.max(...cells.map((c) => c[i].length)));
    return cells.map((c) => c.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join('  ').trimEnd()).join('\n');
}
/** Routes `--migrate` rewrites: refused skills drop out, the old intake -> intent hop becomes intake -> harbor. */
function needsMigration(row) {
    return row.status === 'captain' || row.status === 'retired' || (row.status === 'deprecated' && row.key === 'success:intake');
}
/**
 * `omg factory init --check`: classify every route of the project table
 * (read-only). Exit 1 when a route halts at runtime (captain or retired
 * skill) or the table is malformed, so `--migrate` is due; else 0.
 */
export function checkFactoryRoutes(cwd = process.cwd()) {
    const root = resolve(cwd);
    const routesPath = join(getOmcRoot(root), 'factory-routes.json');
    const read = readRawRoutes(routesPath);
    if (!read)
        return { exitCode: 0, rows: [], message: `no route table at ${routesPath}; nothing to check` };
    if (!read.ok)
        return { exitCode: 1, rows: [], message: `factory init --check: ${read.message}` };
    const rows = Object.entries(read.table).map(([key, value]) => classifyRoute(root, key, value));
    const due = rows.filter(needsMigration);
    const summary = due.some((r) => r.status === 'captain' || r.status === 'retired')
        ? `${due.length} route(s) need migration: captain and retired routes halt the chain (route-retired:<skill>). Run omg factory init --migrate.`
        : due.length > 0
            ? `${due.length} route(s) can be migrated (omg factory init --migrate).`
            : 'no route needs migration.';
    return {
        exitCode: rows.some((r) => r.status === 'captain' || r.status === 'retired') ? 1 : 0,
        rows,
        message: `${routesPath}\n${rows.length > 0 ? renderRouteRows(rows) : '(empty table)'}\n${summary}`,
    };
}
/**
 * `omg factory init --migrate`: back the table up to
 * `factory-routes.json.bak-<timestamp>` (never overwriting a backup), then
 * drop the captain/retired routes and turn `success:intake -> intent` into
 * `-> harbor`. Every other entry stays byte-for-byte. Asks on a TTY; needs
 * `--yes` otherwise.
 */
export async function migrateFactoryRoutes(options = {}) {
    const root = resolve(options.cwd ?? process.cwd());
    const routesPath = join(getOmcRoot(root), 'factory-routes.json');
    const read = readRawRoutes(routesPath);
    if (!read)
        return { exitCode: 0, message: `no route table at ${routesPath}; nothing to migrate` };
    if (!read.ok)
        return { exitCode: 1, message: `factory init --migrate refused: ${read.message}` };
    // The rename below would replace the link with a regular file and silently
    // detach the table from its real target.
    if (lstatSync(routesPath).isSymbolicLink()) {
        return { exitCode: 1, message: `factory init --migrate refused: ${routesPath} is a symlink; migrate its target by hand (omg factory init --check shows the routes)` };
    }
    const rows = Object.entries(read.table).map(([key, value]) => classifyRoute(root, key, value));
    const due = rows.filter(needsMigration);
    if (due.length === 0)
        return { exitCode: 0, message: `${routesPath}: nothing to migrate` };
    const plan = due.map((r) => `  ${r.key} -> ${r.skill}: ${r.status === 'deprecated' ? 'becomes success:intake -> harbor' : 'removed'}`).join('\n');
    if (!options.yes) {
        if (!options.isTTY || !options.confirm) {
            return { exitCode: 2, message: `factory init --migrate needs --yes without an interactive terminal. It would rewrite ${routesPath}:\n${plan}` };
        }
        if (!await options.confirm(`Rewrite ${routesPath}?\n${plan}\nA backup is written first.`)) {
            return { exitCode: 1, message: 'factory init --migrate cancelled; nothing written' };
        }
    }
    const migrated = {};
    for (const [key, value] of Object.entries(read.table)) {
        const row = rows.find((r) => r.key === key);
        if (!needsMigration(row))
            migrated[key] = value;
        else if (row.status === 'deprecated')
            migrated[key] = { ...value, stage: 'harbor', skill: 'harbor' };
    }
    const stamp = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    const backupPath = `${routesPath}.bak-${stamp}`;
    try {
        writeFileSync(backupPath, read.raw, { encoding: 'utf8', flag: 'wx' });
    }
    catch (error) {
        return { exitCode: 1, message: `factory init --migrate refused: cannot write the backup ${backupPath} (${error.message}); nothing changed` };
    }
    const tmp = `${routesPath}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
        renameSync(tmp, routesPath);
    }
    catch (error) {
        try {
            unlinkSync(tmp);
        }
        catch { /* never written */ }
        return { exitCode: 1, message: `factory init --migrate failed: cannot write ${routesPath} (${error.message}); the backup is ${backupPath}` };
    }
    return { exitCode: 0, message: `factory init --migrate rewrote ${routesPath} (backup: ${backupPath}):\n${plan}` };
}
//# sourceMappingURL=factory.js.map