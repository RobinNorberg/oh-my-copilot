/**
 * Factory command (spec: the OMC software factory loop, tracker issue #9).
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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { INTAKE_ROUTE_TABLE, startListener, stopListener } from '../../factory/listener.js';
import { readChainStatus } from '../../factory/status.js';
import { canonicalChainSkill, chainSkillStatus } from '../../hooks/session-end/routing.js';
import { LABEL_PATTERN, resolveChainSkill } from '../../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CopilotRunManager, defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { resolveFactoryRunLimits, runCredits } from '../../factory/run/budget.js';
import { cleanFactoryRun, privateRunLockPath } from '../../factory/run/clean.js';
import { resetFactoryRun } from '../../factory/run/reset.js';
import { claimBusyMessage, claimRepoKey, factoryClaimHolder, factoryClaimRepo, isShallowClaimRepo, listFactoryClaims, localFactoryClaimRepo, removeFactoryClaim, SHARED_STATE_WARNING, shallowClaimWarning, trustedFactoryClaimRepo, trustedLocalFactoryClaimRepo } from '../../factory/run/claims.js';
import { EXIT_AWAITING_HUMAN, EXIT_BUSY, runFactoryEngine, sharedLayoutSealed } from '../../factory/run/engine.js';
import { factoryGuardExec, hardenedGitExec } from '../../factory/run/exec.js';
import { EXIT_FORGE_UNAVAILABLE, FactoryForgeUnavailableError, factoryForgeOptions, loadFactoryForgeConfig, originForgeKind, syncLocalMirror } from '../../factory/run/forge-roots.js';
import { visibleLine } from '../../forge/review-feedback.js';
import { CopilotLaneBackend } from '../../factory/run/lane.js';
import { createSandboxRunner } from '../../factory/run/sandbox-exec.js';
import { releaseTamperHold, tamperHoldMessage } from '../../factory/run/tamper-quarantine.js';
import { acquireFactoryRepoOwnerForRun, defaultOwnerDeps, describeOwner, FactoryBusyError, FactoryTamperHoldError, factoryCancelRequested, factoryOwnerPath, factoryRepoOwnerPath, factoryStateDir, factoryStatePath, ownerFromOtherCheckout, ownerHolding, readFactoryState, refuseWhileEngineRuns, runLabel, unreadableOwnerMessage, withOwnerFileLock, requestFactoryCancel, verifyFactoryIntegrity, acquireFactoryOwner, acquireRunSlot, factoryImportLockPath, heldSlots, withRepoImportLock, withRepoImportLockAsync, tryScanLock, SCAN_WAIT_MS, } from '../../factory/run/state.js';
import { remoteRepoMismatch, resolveShipConfig, userConfigLayers } from '../../ship/config.js';
import { defaultExec, TRUSTED_READ_ENV } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { healCommand } from '../../factory/heal/cli.js';
import { defaultFactoryCheckDeps, factoryCheckCommand, ttyConfirm } from './factory-check.js';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE, factoryErrorLine } from '../../factory/check/cli.js';
import { runFactoryEnqueue } from '../../factory/enqueue.js';
import { factoryTriageCommand } from './factory-triage.js';
import { resolveHealConfig } from '../../factory/heal/config.js';
import { defaultLedgerDir, emptyHooksDir } from '../../factory/run/ledger.js';
import { listenForgeRefusal } from '../../factory/setup/detect.js';
import { factorySetupCommand } from './factory-setup.js';
import { factoryBenchCommand } from './factory-bench.js';
import { factoryBoardCommand } from './factory-board.js';
import { factoryDashboardCommand } from './factory-dashboard.js';
import { factoryPrCommand } from './factory-pr.js';
import { factoryPollCommand } from './factory-poll.js';
import { defaultPollAutoStart, defaultPollHealScan } from '../../factory/poll.js';
import { checkEnvFor, fetchBase, FETCH_TIMEOUT_MS, forgeReadExec, localBase, missingLocalBase, parseItemId, readForgeOptions } from '../../factory/check/cli.js';
import { BUCKET_ORDER, checkItems, plainText } from '../../factory/check/score.js';
import { createForge } from '../../forge/index.js';
import { liveCreditReservations, parallelLayoutRefusal, readTrustedBaseLayerAtRef, releaseDeadCreditReservations, resolveParallelSettings, runParallelSupervisor } from '../../factory/run/parallel.js';
import { resolveRunLayout, userParallelOptIn } from '../../factory/run/private-run.js';
import { skillSlash } from '../../utils/skill-slash.js';
export function renderChainStatus(status) {
    const lines = [];
    lines.push(`chain status ${status.directory}`);
    lines.push(`route table (.omg/factory-routes.json, single authority): ${status.routeKeys.length} keys${status.routeKeys.length > 0 ? ` — ${status.routeKeys.join(', ')}` : ''}`);
    lines.push(`active ledgers: ${status.activeLedgers}`);
    lines.push(`intents (${status.intents.length}):`);
    if (status.intents.length === 0)
        lines.push('  (no decisions recorded)');
    for (const intent of status.intents) {
        const last = intent.lastDecision ? `${intent.lastDecision} @ ${intent.lastDecisionAt ?? '?'}` : 'none';
        const stopped = intent.stopped ? `  stopped[${intent.stopped.reason}]` : '';
        lines.push(`  ${intent.intentId}  decisions ${intent.decisionCount}  last ${last}${stopped}`);
        intent.links.forEach((link, index) => {
            const host = link.host ? ` [${link.host}]` : '';
            const ended = link.closedAt
                ? `ended ${link.outcome ?? '?'}→${link.decision ?? '?'}${link.hostSessionId && link.hostSessionId !== link.chainLink ? ` session=${link.hostSessionId}` : ''}`
                : 'running';
            lines.push(`    link ${index + 1} ${link.stage}${host} link=${link.chainLink} ${ended}`);
        });
    }
    lines.push(`stalled links (no progress for 30 min): ${status.stalled.length}`);
    for (const stall of status.stalled) {
        lines.push(`  ${stall.intentId} stage=${stall.stage} stalled ${Math.round(stall.stalledForMs / 60_000)}min session=${stall.session}`);
    }
    return lines.join('\n');
}
/**
 * The production `parallel` dep. Review-487 L-1: undefined (dev's path: no
 * git read, nothing printed) unless the user config opts in, by setting
 * factory.run.maxConcurrent or maxInFlightCredits or layout "private". Then
 * the base layer is read only when the user config leaves a key open, and
 * only at a sha this call read itself: the local forge's base branch, or on
 * GitHub / Azure DevOps the sha `git ls-remote origin` reports, fetched and
 * read under the checkout's scan lock (with parallel runs live, also the
 * import lock), never the tracking ref a lane could have moved.
 */
function defaultParallelLayers(root, base, kind) {
    let user;
    try {
        user = userConfigLayers().trustedUser;
    }
    catch {
        user = null;
    }
    return parallelLayers(root, base, kind, user, factoryGuardExec(hardenedGitExec(defaultExec, emptyHooksDir(defaultLedgerDir())), () => [base]));
}
/** defaultParallelLayers for a given trusted user config and guarded `exec` (exported for its tests). */
export function parallelLayers(root, base, kind, user, exec) {
    const userLayout = resolveRunLayout(user, undefined);
    if (!userParallelOptIn(user))
        return undefined;
    const warn = (m) => console.error(chalk.yellow(plainText(m)));
    const own = resolveParallelSettings(user, undefined, warn);
    // Nothing to read from the base when the user config already decides both keys that matter here.
    const needBase = own.source === 'default' || userLayout.source === 'default';
    const baseLayer = needBase ? readBaseLayerAfterFetch(exec, root, base, kind(), user, warn) : undefined;
    return { settings: resolveParallelSettings(user, baseLayer, warn), layout: resolveRunLayout(user, baseLayer).layout };
}
/** The base layer at a sha this call read (see defaultParallelLayers); undefined (warned) when it cannot be read. */
function readBaseLayerAfterFetch(exec, root, base, forge, user, warn) {
    if (forge?.kind === 'local')
        return readTrustedBaseLayerAtRef(exec, root, base, `refs/heads/${base}`, user, warn);
    // Review-487b BLOCK-2: origin must still be the forge config's repository before git talks to it, as before the engine's fetch.
    const mismatch = remoteRepoMismatch(exec, root, 'origin', forge?.repoUrl);
    if (mismatch) {
        warn(`omg factory run: origin/${base} is not read (${forge ? mismatch : 'no forge config names the repository (omg factory setup)'}); the factory.run keys of the ${base} .copilot/omg.jsonc count as unset`);
        return undefined;
    }
    const held = tryScanLock(root, new Date().toISOString(), defaultOwnerDeps(), SCAN_WAIT_MS);
    if (held instanceof FactoryBusyError)
        throw held;
    // With parallel runs live, the scan also holds the import lock (their fetches and pushes wait); else no engine runs here.
    const inside = (fn) => (held.importLock ? withRepoImportLock(root, 'import:cli', fn, { held: held.importLock }) : fn());
    try {
        return inside(() => {
            const ls = exec('git', ['ls-remote', 'origin', `refs/heads/${base}`], { cwd: root, env: TRUSTED_READ_ENV, timeoutMs: FETCH_TIMEOUT_MS });
            const sha = ls.status === 0 ? ls.stdout.trim().split(/\s+/)[0] ?? '' : '';
            if (!/^[0-9a-f]{40}$/.test(sha)) {
                warn(`omg factory run: origin/${base} could not be read (git ls-remote${ls.status === 0 ? ': no such branch' : ` exit ${ls.status}: ${visibleLine(ls.stderr.trim().split('\n')[0] ?? '')}`}); the factory.run keys of the ${base} .copilot/omg.jsonc count as unset`);
                return undefined;
            }
            // The commit itself (the tracking ref the fetch writes is not read: the layer is read at `sha` only).
            fetchBase(exec, root, base, []);
            return readTrustedBaseLayerAtRef(exec, root, base, sha, user, warn);
        });
    }
    finally {
        held.release();
    }
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
    forge: (root, base, opts) => loadFactoryForgeConfig(factoryGuardExec(defaultExec), root, base, userConfigLayers().trustedUser, projectConfig(root), opts),
    gateSandbox: (root) => createSandboxRunner(root),
    parallel: (root, base, kind) => defaultParallelLayers(root, base, kind),
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
    nothingRunnable: (counts, claimed = []) => JSON.stringify({ ok: true, next: null, message: 'nothing runnable', counts, ...(claimed.length ? { claimed } : {}) }, null, 2),
    outcome: (outcome, next) => JSON.stringify({ ok: outcome.exitCode === 0, ...(next !== undefined ? { next } : {}), ...outcome }, null, 2),
    error: (message, busy = false) => JSON.stringify({ ok: false, error: message, ...(busy ? { busy: true } : {}) }, null, 2),
};
async function factoryGuarded(json, fn) {
    try {
        process.exitCode = await fn();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = error instanceof FactoryForgeUnavailableError;
        const busy = error instanceof FactoryBusyError;
        // F9: no usable forge exits 5 with the prefix check, board and setup print.
        const text = unavailable && !message.startsWith('unsupported forge') ? `unsupported forge: ${message}` : message;
        if (json)
            console.log(factoryRunJson.error(text, busy));
        else if (busy)
            console.error(chalk.yellow(`busy: ${plainText(message)}`));
        else
            console.error(chalk.red(unavailable ? text : `Error: ${message}`));
        process.exitCode = error instanceof FactoryUsageError ? 2 : unavailable ? EXIT_FORGE_UNAVAILABLE : busy ? EXIT_BUSY : 1;
    }
}
export function renderFactoryRunState(state, o = {}) {
    const lines = [`${chalk.bold(`factory run #${state.issue}`)}  phase=${chalk.cyan(state.phase)}  base=${state.base}  branch=${state.branch}${state.pr ? `  PR #${state.pr}` : ''}`];
    if (state.gate && o.gate !== false)
        lines.push(chalk.yellow(`awaiting-human: ${state.gate.name}: ${state.gate.reason}`));
    // H1: the PR code's output for the park; never posted to the forge.
    if (state.gate?.detail)
        lines.push(chalk.gray(`  local only (not posted): ${plainText(state.gate.detail)}`));
    if (state.cancelRequested && state.phase !== 'cancelled')
        lines.push(chalk.yellow('cancel requested'));
    if (state.head)
        lines.push(`head ${state.head.slice(0, 12)}`);
    if (state.layout === 2 && state.privateDir)
        lines.push(`layout private: ${plainText(state.privateDir)}`);
    if (state.unsandboxedAck)
        lines.push(chalk.yellow(`lanes without the enforced sandbox accepted for ${state.unsandboxedAck.slice(0, 12)} (--allow-unsandboxed-lanes)`));
    if (state.pendingCommit)
        lines.push(chalk.yellow(`lane ${plainText(state.pendingCommit.laneId)}'s work is not committed yet (the rerun commits the same worktree)${state.pendingCommit.secretFindings?.length ? `; secret-shaped: ${state.pendingCommit.secretFindings.map((f) => plainText(`${f.path} (${f.kind})`)).join(', ')}` : ''}`));
    if (state.unsandboxedGatesAck)
        lines.push(chalk.yellow(`prepare checks and the local gate without the OS sandbox accepted for ${state.unsandboxedGatesAck.slice(0, 12)} (--allow-unsandboxed-gates)`));
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
 * finished item. A runnable item another engine holds (its run here, or its
 * claim from another clone: claims.ts) is skipped, never waited on, and
 * listed in `claimed`. Null with the checked rows when nothing is runnable.
 */
async function pickNext(deps, root, base, loaded, parent, claimRepo, skip = [], take, lockFetch = (fn) => fn()) {
    const { config } = loaded;
    const source = config.intake.source;
    if (parent === undefined && !source)
        throw new FactoryUsageError('--next needs --parent <spec> or factory.intake.source');
    const read = forgeReadExec(deps.exec, config, root);
    const warnings = [];
    // F29: the local forge's base is the local branch (it has no server to fetch from), read as check reads it.
    // B2 (review-487 M-4): only this fetch runs under the import lock in a parallel run; the tracker calls and the
    // item's owner claim (take) come after it, outside that lock.
    const baseSha = await lockFetch(() => (config.kind === 'local' ? localBase(read.exec, root, base, warnings) : fetchBase(read.exec, root, base, warnings)));
    if (config.kind === 'local' && !baseSha)
        throw new FactoryUsageError(missingLocalBase(base));
    // Committed items only: a working-tree item is never runnable, and a dependency closed only on disk is not met.
    const forge = createForge(read.exec, root, config, readForgeOptions(config, root, read.options, base, baseSha, false));
    const ids = parent !== undefined ? forge.tracker.viewItem(parent).children : forge.tracker.queryItems(source, config.intake.limit);
    const items = checkItems(forge, ids, checkEnvFor(read.exec, root, config, base, baseSha));
    const claimed = [];
    for (const r of items) {
        if (r.bucket !== 'runnable')
            continue;
        if (!skip.includes(r.id) && itemBusy(deps, root, r.id, claimRepo) === null) {
            if (!take)
                return { next: r, items, claimed, warnings };
            // B2 (parallel engines): the item's owner file is taken here, before the item is announced, so two engines never start one item.
            const owner = take(r.id);
            if (owner)
                return { next: r, owner, items, claimed, warnings };
        }
        claimed.push(r.id);
    }
    return { next: null, items, claimed, warnings };
}
/**
 * Why a run of `key` here would be busy now: its owner file in this
 * checkout is held (or unreadable), or its cross-clone claim is held
 * (claims.ts); null when neither. Read-only: the engine's claims at start
 * stay the binding check.
 */
function itemBusy(deps, root, key, claimRepo) {
    const me = defaultOwnerDeps();
    const path = factoryOwnerPath(root, key);
    const h = ownerHolding(path, me);
    if (h === 'unreadable')
        return unreadableOwnerMessage(path);
    if (h)
        return `omg factory run ${runLabel(key)} is already running (${describeOwner(h)})`;
    const claim = claimRepo ? factoryClaimHolder(deps.ledgerDir ?? defaultLedgerDir(), claimRepo, root, key, me) : null;
    return claim ? claimBusyMessage(key, claim) : null;
}
/** readOnlyForgeKind with the repository URL the forge config names. */
function readOnlyParallelForge(deps, root, base) {
    try {
        const config = deps.forge?.(root, base, { dryRun: true }).config;
        return config ? { kind: config.kind, repoUrl: config.repo.url } : undefined;
    }
    catch {
        return undefined;
    }
}
function readOnlyForgeKind(deps, root, base) {
    try {
        return deps.forge?.(root, base, { dryRun: true }).config.kind;
    }
    catch {
        return undefined;
    }
}
/**
 * The repository the claims of this checkout are keyed on, exactly as the
 * engine keys them: the origin through the engine's hardened read
 * (trustedFactoryClaimRepo; L-g), on the local forge the repository's root
 * commit instead (never origin; dogfood F60). A dry run reads it through the
 * plain guard, as the engine's dry run does, and writes nothing. A shallow
 * clone's own key is warned about through `warn` (one per command:
 * shallowWarnOnce).
 */
function cliClaimRepo(deps, root, kind, dryRun = false, warn = shallowWarnOnce()) {
    const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
    if (kind === 'local') {
        const repo = dryRun ? localFactoryClaimRepo(factoryGuardExec(deps.exec), root) : trustedLocalFactoryClaimRepo(deps.exec, root, ledgerDir);
        if (repo && isShallowClaimRepo(repo))
            warn(shallowClaimWarning(root, repo));
        return repo;
    }
    return dryRun ? factoryClaimRepo(factoryGuardExec(deps.exec), root) : trustedFactoryClaimRepo(deps.exec, root, ledgerDir);
}
/** A warner that prints its first line only (stderr): a command reads the claim key more than once. */
function shallowWarnOnce() {
    let done = false;
    return (m) => {
        if (done)
            return;
        done = true;
        console.error(chalk.yellow(m));
    };
}
const OWNER_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;
/** One owner or claim record for `run status`: whitelisted fields, every string through plainText. */
const ownerView = (o) => ({
    ...(o.run !== undefined ? { run: plainText(String(o.run)) } : {}),
    ...(Number.isInteger(o.pid) ? { pid: o.pid } : {}),
    ...(typeof o.hostname === 'string' ? { hostname: plainText(o.hostname) } : {}),
    ...(typeof o.startedAt === 'string' ? { startedAt: plainText(o.startedAt) } : {}),
    ...(typeof o.root === 'string' ? { root: plainText(o.root) } : {}),
    ...(typeof o.parkedAt === 'string' ? { parkedAt: plainText(o.parkedAt) } : {}),
});
/**
 * The live engines of this checkout (its engine lock and every run owner
 * file a live process holds), the owner files nobody can read (held, listed
 * apart), and the cross-clone claims that hold an item of this repository.
 * Read-only.
 */
export function liveFactoryRuns(root, ledgerDir, claimRepo) {
    const me = defaultOwnerDeps();
    const unreadable = [];
    const held = (path) => {
        const h = ownerHolding(path, me);
        if (h === 'unreadable')
            unreadable.push(plainText(path));
        return h === null || h === 'unreadable' ? null : h;
    };
    const engine = held(factoryRepoOwnerPath(root));
    // The engine lock was taken from another folder: it shares this checkout's state root (MEDIUM-C).
    const engineShared = engine !== null && ownerFromOtherCheckout(engine, root);
    let names = [];
    try {
        names = readdirSync(factoryStateDir(root)).sort();
    }
    catch { /* no runs yet */ }
    const runs = [];
    for (const name of names) {
        const m = OWNER_FILE.exec(name);
        if (!m)
            continue;
        const key = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
        const h = held(factoryOwnerPath(root, key));
        if (h)
            runs.push({ key, ...ownerView(h) });
    }
    const claims = claimRepo
        ? listFactoryClaims(ledgerDir, claimRepo, root, me).map((c) => ({ key: c.key, state: c.state, path: plainText(c.path), ...(c.claim ? ownerView(c.claim) : {}), ...(c.sharedState ? { sharedState: true } : {}) }))
        : [];
    // B2: the parallel private-layout engines (their slot, layout and private dir), the import lock's holder, the credits in flight.
    const slots = heldSlots(root, me).map((s) => {
        if (s.owner === 'unreadable') {
            unreadable.push(plainText(s.path));
            return { slot: s.slot, unreadable: true };
        }
        let state = null;
        try {
            state = /^\d+$/.test(String(s.owner.run)) ? readFactoryState(root, Number(s.owner.run)) : null;
        }
        catch {
            state = null;
        }
        return { slot: s.slot, ...ownerView(s.owner), layout: state?.layout === 2 ? 'private' : state ? 'shared' : 'unknown', ...(state?.privateDir ? { privateDir: plainText(state.privateDir) } : {}) };
    });
    const imp = held(factoryImportLockPath(root));
    let credits = [];
    if (claimRepo) {
        try {
            credits = liveCreditReservations(ledgerDir, claimRepoKey(claimRepo, root).slice(0, 8), me).map((r) => ({ lane: plainText(r.id), cap: r.cap, ...(r.run ? { run: plainText(r.run) } : {}), pid: r.pid }));
        }
        catch (error) {
            credits = { unreadable: plainText(error instanceof Error ? error.message : String(error)) };
        }
    }
    // The B2 keys appear only when there is something to show (a checkout without parallel runs reads as before).
    return {
        engine: engine ? { ...ownerView(engine), ...(engineShared ? { sharedState: true } : {}) } : null, runs, unreadable, claims,
        ...(slots.length > 0 ? { slots } : {}), ...(imp ? { importLock: ownerView(imp) } : {}), ...(!Array.isArray(credits) || credits.length > 0 ? { credits } : {}),
    };
}
const bucketCounts = (items) => Object.fromEntries(BUCKET_ORDER.map((b) => [b, items.filter((r) => r.bucket === b).length]));
function printOutcome(json, outcome, next) {
    if (json) {
        console.log(factoryRunJson.outcome(outcome, next));
        return;
    }
    // F35: the message already names the gate when it parks there; print it once.
    const parked = outcome.state?.gate !== undefined && outcome.message.startsWith(`awaiting-human: ${outcome.state.gate.name}:`);
    if (outcome.state)
        console.log(renderFactoryRunState(outcome.state, { gate: !parked }));
    const color = outcome.exitCode === 0 ? chalk.green : outcome.exitCode === 1 ? chalk.red : chalk.yellow;
    console.log(color(outcome.message));
}
/** `omg factory run <issue>`, `run cancel|clean|status <issue>` (experimental; manual trigger only; merge is always human). */
export function factoryRunCommand(deps = defaultFactoryRunDeps) {
    const exec = factoryGuardExec(deps.exec);
    const run = new Command('run');
    run
        .description('Experimental: drive one issue through implement -> draft PR -> independent review / fix rounds -> prepare -> CI gates, then park for the human merge')
        .argument('[issue]', 'the item number: a GitHub issue, an Azure DevOps work item or a local backlog item')
        .option('--next', 'Run the next runnable item (omg factory check order: priority, then id); exit 0 when nothing is runnable')
        .option('--parent <spec>', 'With --next: pick among the children of this spec item instead of factory.intake.source')
        .option('--dry-run', 'Resolve the issue and plan and print the next step; no state, lanes or pushes')
        .option('--allow-gate-change', 'Local forge: accept the one change to the local gate\'s definition (package.json script, package-manager config or gate file) that parked the run at gate-definition-changed; a later change parks again')
        .option('--allow-unsandboxed-lanes', 'Accept, for the parked head only, that write lanes ran without the enforced sandbox (the run parked at human-review for it): you checked the threads and reviews of the PR yourself; a new head parks again')
        .option('--allow-unsandboxed-gates', 'Accept, for the parked head only, that prepare\'s checks and the local gate run the PR\'s code WITHOUT the OS sandbox, as you (the run parked at gates-unsandboxed for it): you reviewed the diff yourself; a new head parks again')
        .option('--allow-secret-shapes', 'Accept the secret-shaped content (the key or token shapes, by path and kind, the park named) that parked a lane commit at secret-shaped-content, for that lane commit only: you checked they are test fixtures, not real secrets; a new path or kind parks again')
        .option('--parallel <n>', 'With --next and factory.run.maxConcurrent above 1 (factory.run.layout "private"): run up to min(n, maxConcurrent) runs at once, each its own `omg factory run --next` process; a slot is refilled when a run ends, until nothing is runnable or Ctrl+C', integerOption(1, 64))
        .option('--max-requests <n>', 'Start no further lane in this run once its lanes recorded n premium requests, or when a lane\'s usage is unknown (the run parks at budget); the lane in flight when the cap is reached finishes, so the run can end above n by that one lane', integerOption(1, 10_000))
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
        let issue = o.next ? undefined : parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const loadedLimits = deps.limits(root);
        for (const w of loadedLimits.warnings)
            console.error(chalk.yellow(w));
        const limits = o.maxRequests !== undefined ? { ...loadedLimits.limits, maxRunRequests: o.maxRequests } : loadedLimits.limits;
        const base = deps.base(root);
        let claimRepo = null;
        const warnShallow = shallowWarnOnce();
        // A real run takes this checkout's engine lock before anything touches git (the forge-config loader fetches
        // origin/<base>): busy (exit 6) means nothing was fetched or written. The engine uses the held lock as its own.
        let held;
        // B2: parallel private-layout runs (factory.run.maxConcurrent > 1 with layout "private", trusted layers only).
        // Review-487 L-1: the settings are read only for a run that could use them: never for a dry run, nor for the
        // resume of a run sealed in the shared layout (it keeps the checkout's engine lock: no migration, it runs alone).
        let par;
        // Review-487b BLOCK-2: a tamper hold refuses the run before anything reads git (the opt-in base read below runs
        // ls-remote and a fetch); the check is a file read, and it runs again under the lock below as on dev.
        if (!o.dryRun) {
            const hold = tamperHoldMessage(deps.ledgerDir ?? defaultLedgerDir(), root);
            if (hold)
                throw new FactoryTamperHoldError(hold);
        }
        if (!o.dryRun && deps.parallel) {
            let sealedShared = false;
            if (issue !== undefined) {
                try {
                    const s = readFactoryState(root, issue);
                    sealedShared = s !== null && sharedLayoutSealed(s);
                }
                catch {
                    sealedShared = true;
                }
            }
            if (!sealedShared)
                par = deps.parallel(root, base, () => readOnlyParallelForge(deps, root, base));
        }
        const refusal = par ? parallelLayoutRefusal(par.settings, par.layout) : null;
        if (refusal)
            throw new FactoryUsageError(refusal);
        const slotMode = par !== undefined && par.settings.maxConcurrent > 1;
        if (o.parallel !== undefined) {
            if (!o.next)
                throw new FactoryUsageError('--parallel applies to --next');
            if (o.dryRun)
                throw new FactoryUsageError('--parallel starts real runs; it does not combine with --dry-run');
            if (o.maxRequests !== undefined)
                throw new FactoryUsageError('--max-requests caps one run; it does not combine with --parallel');
            if (!slotMode)
                throw new FactoryUsageError('--parallel needs factory.run.maxConcurrent above 1 and factory.run.layout: "private"; parallel runs are an opt-in of your user config (factory.run.maxConcurrent, maxInFlightCredits or layout "private" there), and only then can the .copilot/omg.jsonc committed on a trusted base supply the other key');
            return runParallel(deps, root, Math.min(o.parallel, par.settings.maxConcurrent), parent, Boolean(o.json));
        }
        const creditLimit = slotMode ? par.settings.maxInFlightCredits ?? limits.laneMaxCredits * par.settings.maxConcurrent : par?.settings.maxInFlightCredits;
        let signals = 0;
        // Review-487 M-3: the import-lock wait is awaited (signals run meanwhile); a signal during it ends the wait busy.
        const importLocked = async (fn) => (slotMode ? withRepoImportLockAsync(root, 'import:cli', fn, { stopped: () => signals > 0 }) : fn());
        if (!o.dryRun) {
            // A tamper hold stops every run in this checkout (exit 6) before anything is locked or fetched; the engine checks it again.
            const hold = tamperHoldMessage(deps.ledgerDir ?? defaultLedgerDir(), root);
            if (hold)
                throw new FactoryTamperHoldError(hold);
            // A `scan` holder (poll's heal scan or base sync, a read command's fetch) is waited out (SCAN_WAIT_MS, longer than a read fetch can run: FETCH_TIMEOUT_MS).
            // B2: a parallel run takes a slot instead of the engine lock (busy, exit 6, when all are held or a shared engine runs).
            held = slotMode
                ? acquireRunSlot(root, issue ?? 'next', par.settings.maxConcurrent, () => new Date().toISOString())
                : acquireFactoryRepoOwnerForRun(root, issue ?? 'next', () => new Date().toISOString());
            // The claim key before the fetch: the forge kind from the config as it is (no fetch); none on the local forge.
            try {
                claimRepo = cliClaimRepo(deps, root, readOnlyForgeKind(deps, root, base), false, warnShallow);
            }
            catch (error) {
                held.release();
                throw error;
            }
            const busy = issue !== undefined ? itemBusy(deps, root, issue, claimRepo) : null;
            if (busy) {
                held.release();
                throw new FactoryBusyError(busy);
            }
        }
        const onSignal = () => {
            signals += 1;
            if (signals > 1)
                process.exit(130);
            console.error(chalk.yellow('omg factory run: stopping after the current poll (cancelling the lane); press again to exit at once'));
        };
        try {
            // Review-487b BLOCK-3: a parallel run listens before the loader (its import-lock wait ends busy on a signal);
            // every other run keeps dev's order: a Ctrl+C during the loader's fetch ends the CLI at once.
            if (!o.dryRun && slotMode) {
                process.on('SIGINT', onSignal);
                process.on('SIGTERM', onSignal);
            }
            // The loader fetches origin/<base> into your repository: under the import lock in a parallel run.
            const loaded = await importLocked(() => deps.forge?.(root, base, { dryRun: Boolean(o.dryRun) }));
            for (const w of loaded?.warnings ?? [])
                console.error(chalk.yellow(w));
            // The loaded forge is the run's: the claim key the engine and the pick use follows it.
            claimRepo = cliClaimRepo(deps, root, loaded?.config.kind, Boolean(o.dryRun), warnShallow);
            // The full untrusted roots, never a partial list (critic amendments §A.14; the engine re-checks).
            const forge = loaded ? { config: loaded.config, options: factoryForgeOptions(root) } : undefined;
            const skipped = [];
            let picked;
            let runOwner;
            if (!o.dryRun && !slotMode) {
                process.on('SIGINT', onSignal);
                process.on('SIGTERM', onSignal);
            }
            // B2: the pick takes the item's owner file atomically (a busy item is skipped, never waited on).
            const take = slotMode ? (id) => {
                try {
                    return acquireFactoryOwner(root, id, new Date().toISOString());
                }
                catch (error) {
                    if (error instanceof FactoryBusyError)
                        return null;
                    throw error;
                }
            } : undefined;
            for (;;) {
                if (o.next) {
                    if (!loaded)
                        throw new FactoryUsageError('--next needs the forge config (omg factory setup)');
                    const { next, owner: pickedOwner, items, claimed, warnings: pickWarnings } = await pickNext(deps, root, base, loaded, parent, claimRepo, skipped, take, importLocked);
                    runOwner = pickedOwner;
                    for (const w of pickWarnings)
                        console.error(chalk.yellow(plainText(w)));
                    const counts = bucketCounts(items);
                    if (!next) {
                        if (o.json)
                            console.log(factoryRunJson.nothingRunnable(counts, claimed));
                        else
                            console.log(`nothing runnable (${BUCKET_ORDER.map((b) => `${counts[b]} ${b}`).join(', ')})${claimed.length ? `; held by another engine: ${claimed.map((id) => `#${id}`).join(', ')}` : ''}`);
                        return 0;
                    }
                    issue = picked = next.id;
                    held?.relabel(String(issue));
                    if (!o.json)
                        console.log(chalk.cyan(`next runnable: #${next.id} ${plainText(next.title)}`));
                }
                try {
                    const outcome = await runFactoryEngine({
                        root, issue: issue, exec: deps.exec, limits, base, dryRun: Boolean(o.dryRun), claimRepo,
                        ...(held && !slotMode ? { repoOwner: held } : {}),
                        ...(held && slotMode ? { parallel: { maxConcurrent: par.settings.maxConcurrent, slot: held } } : {}),
                        ...(runOwner ? { runOwner } : {}),
                        ...(creditLimit !== undefined && !o.dryRun ? { creditLimit } : {}),
                        ...(o.allowGateChange ? { allowGateChange: true } : {}),
                        ...(o.allowUnsandboxedLanes ? { allowUnsandboxedLanes: true } : {}),
                        ...(o.allowUnsandboxedGates ? { allowUnsandboxedGates: true } : {}),
                        ...(o.allowSecretShapes ? { allowSecretShapes: true } : {}),
                        ...(deps.gateSandbox && !o.dryRun ? { gateSandbox: deps.gateSandbox(root) } : {}),
                        lanes: o.dryRun ? NO_LANES : deps.lanes(root),
                        ...(forge ? { forge } : {}),
                        ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}),
                        ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
                        ...(deps.processes ? { processes: deps.processes } : {}),
                        interrupted: () => signals > 0,
                        warn: (m) => console.error(chalk.yellow(m)),
                    });
                    printOutcome(Boolean(o.json), outcome, picked);
                    return outcome.exitCode;
                }
                catch (error) {
                    // The engine owns (and released) the picked owner file, also when it refused.
                    runOwner = undefined;
                    // L9: another clone claimed the picked item after the pick: pick once more, skipping it (B2: in a parallel run up to 20 times).
                    if (!(error instanceof FactoryBusyError) || error instanceof FactoryTamperHoldError || !o.next || picked === undefined || skipped.length >= (slotMode ? 20 : 1))
                        throw error;
                    skipped.push(picked);
                    if (!o.json)
                        console.error(chalk.yellow(`busy: ${plainText(error.message)}; picking again`));
                }
            }
        }
        finally {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
            held?.release();
        }
    }));
    /**
     * `run --next --parallel N`: the supervisor. Up to `n` children `omg
     * factory run --next --json` (poll's auto-start child: own process group on
     * POSIX, the signals forwarded; Ctrl+C reaches Windows children through the
     * console), each one engine with its own slot; refilled when one ends
     * with a code other than busy, until a child finds nothing runnable or a
     * stop signal (the second exits at once). One line per child; `--json`:
     * `{ ok, parallel, interrupted, exitCode, children: [{ index, exitCode, next, message }], message }`.
     */
    async function runParallel(deps, root, n, parent, json) {
        const forwards = new Set();
        let stops = 0;
        const stoppers = new Set();
        const onSignal = (signal) => {
            stops += 1;
            // Review-487 M-3: a second signal kills every child's process tree (SIGKILL forward: synchronous) before this exits,
            // so no child run (or its lanes) outlives the supervisor.
            for (const f of forwards)
                f(stops > 1 ? 'SIGKILL' : signal);
            if (stops > 1)
                process.exit(130);
            if (!json)
                console.error(chalk.yellow('omg factory run --parallel: no new run starts; waiting for the running ones (each stops after its current poll); press again to exit at once'));
            for (const s of stoppers)
                s();
        };
        const sigint = () => onSignal('SIGINT');
        const sigterm = () => onSignal('SIGTERM');
        process.on('SIGINT', sigint);
        process.on('SIGTERM', sigterm);
        const args = parent !== undefined ? ['--parent', String(parent)] : [];
        const signals = (forward) => { forwards.add(forward); return () => { forwards.delete(forward); }; };
        const child = deps.parallelChild ?? ((c) => defaultPollAutoStart(process.argv[1], { signals: c.signals })({ root: c.root, args: c.args }));
        try {
            const result = await runParallelSupervisor({
                n,
                spawn: () => child({ root, args, signals }),
                onStop: (stop) => { stoppers.add(stop); return () => { stoppers.delete(stop); }; },
                report: (index, r) => {
                    if (!json)
                        console.log(`run ${index + 1}: exit ${r.exitCode}${r.next !== null ? ` #${r.next}` : ''}: ${plainText(r.message)}`);
                },
            });
            const summary = `--parallel ${n}: ${result.children.length} run(s) ended${result.interrupted ? ' (stopped by a signal)' : ''}; exit ${result.exitCode}`;
            if (json)
                console.log(JSON.stringify({ ok: result.exitCode === 0, parallel: n, interrupted: result.interrupted, exitCode: result.exitCode, children: result.children.map((c) => ({ index: c.index, exitCode: c.exitCode, next: c.next, message: plainText(c.message) })), message: summary }, null, 2));
            else
                console.log(summary);
            return result.exitCode;
        }
        finally {
            process.off('SIGINT', sigint);
            process.off('SIGTERM', sigterm);
        }
    }
    run
        .command('cancel <issue>')
        .description('Ask the running engine to cancel the lane and stop (the PR, branch and worktrees are kept)')
        .option('--json', 'JSON output')
        .action((issueRaw, _o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const state = requestFactoryCancel(factoryRoot(exec), issue, new Date().toISOString());
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ok: true, cancelRequested: true, phase: state.phase }, null, 2));
        // L11: a parked run has no engine to finish the cancel: name the command that does.
        else if (state.gate)
            console.log(chalk.green(`cancel requested for factory run #${issue} (phase ${state.phase}, awaiting-human: ${plainText(state.gate.name)}); no engine works on a parked run, so finish the cancel with omg factory run ${issue} (no lane starts), then omg factory run clean ${issue}`));
        else
            console.log(chalk.green(`cancel requested for factory run #${issue} (phase ${state.phase}); a running engine stops within seconds, otherwise the next run finishes the cancel`));
        return 0;
    }));
    run
        .command('clean <issue>')
        .description('Remove the worktrees and local branches of a merged or cancelled run, only when nothing would be lost (the PR branch on GitHub is kept); busy (exit 6) while an engine runs in this checkout')
        .option('--discard', 'A cancelled run only: give up uncommitted lane changes (a cancel mid-lane leaves them), so those worktrees go too; commits are still kept')
        .option('--lane-stopped', 'With a lane whose stop was not confirmed (busy, exit 6): your word that its Copilot child has stopped; recorded in the run history. A child seen alive with its recorded start identity still refuses')
        .option('--seed', 'A private-layout run (factory.run.layout "private"): also remove the repository\'s private store seed once no other run dir is left next to it')
        .option('--json', 'JSON output')
        .action((issueRaw, o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        // The run's own forge (its sealed state) when it has one, else the config as it is (no fetch).
        let kind;
        try {
            kind = readFactoryState(root, issue)?.forgeKind;
        }
        catch {
            kind = undefined;
        }
        const claimRepo = cliClaimRepo(deps, root, kind ?? readOnlyForgeKind(deps, root, deps.base(root)));
        if (o.laneStopped && !o.discard)
            throw new FactoryUsageError('--lane-stopped applies to --discard');
        const result = cleanFactoryRun({ root, issue, exec: deps.exec, claimRepo, ...(o.discard ? { discard: true } : {}), ...(o.laneStopped ? { laneStopped: true } : {}), ...(o.seed ? { seed: true } : {}), ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ok: result.kept.length === 0, ...result }, null, 2));
        else {
            for (const id of result.acknowledged ?? [])
                console.log(chalk.yellow(`lane ${id}: its stop is taken on your word (--lane-stopped), recorded in the run history`));
            for (const path of result.removed)
                console.log(chalk.green(`removed ${path}`));
            for (const k of result.kept)
                console.log(chalk.yellow(`kept ${k.worktree}: ${k.reason}`));
            // F59: a cancel mid-lane leaves partial edits; name the command that gives them up.
            if (!o.discard && result.kept.some((k) => k.reason.startsWith('worktree_dirty')) && readFactoryState(root, issue)?.phase === 'cancelled') {
                console.log(chalk.yellow(`the run is cancelled: omg factory run clean ${issue} --discard gives up the uncommitted lane changes${kind === 'local' ? `, and omg factory run reset ${issue} does that itself before it starts the run over` : ''}`));
            }
            if (result.removed.length === 0 && result.kept.length === 0)
                console.log(`nothing to clean for factory run #${issue}`);
        }
        return result.kept.length === 0 ? 0 : EXIT_AWAITING_HUMAN;
    }));
    run
        .command('reset <issue>')
        .description('Local forge only: start a cancelled run over: remove its worktrees (uncommitted lane changes are given up, commits kept), close its local PR, keep its mirror branch as factory/cancelled/..., move the run state aside; busy (exit 6) while an engine runs in this checkout or another clone claims the item')
        .option('--json', 'JSON output')
        .option('--lane-stopped', 'With a lane whose stop was not confirmed (busy, exit 6): your word that its Copilot child has stopped; recorded in the run history. A child seen alive with its recorded start identity still refuses')
        .action((issueRaw, o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        // The engine lock before the forge-config loader (it may fetch): busy touches nothing.
        const held = acquireFactoryRepoOwnerForRun(root, issue, () => new Date().toISOString());
        try {
            const loaded = deps.forge?.(root, deps.base(root), { dryRun: false });
            if (!loaded || loaded.config.kind !== 'local')
                throw new FactoryUsageError('omg factory run reset is for the local forge only (factory.forge.kind "local")');
            // The local forge keys its claim on the root commit (F60): reset checks it and deletes this checkout's.
            const claimRepo = cliClaimRepo(deps, root, loaded.config.kind);
            const read = forgeReadExec(deps.exec, loaded.config, root);
            const forge = createForge(read.exec, root, loaded.config, { ...read.options, local: { omgRoot: getOmcRoot(root) } });
            const result = resetFactoryRun({ root, issue, exec: deps.exec, forge, mirror: loaded.config.repo.url, repoOwner: held, claimRepo, ...(o.laneStopped ? { laneStopped: true } : {}), ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
            if (c.optsWithGlobals().json)
                console.log(JSON.stringify({ ok: true, ...result }, null, 2));
            else {
                for (const id of result.acknowledgedLanes ?? [])
                    console.log(chalk.yellow(`lane ${id}: its stop is taken on your word (--lane-stopped), recorded in the run history`));
                for (const path of result.removedWorktrees ?? [])
                    console.log(chalk.green(`removed ${path} (uncommitted lane changes given up)`));
                if (result.closedPr !== undefined)
                    console.log(chalk.green(`closed local PR #${result.closedPr} (cancelled)`));
                if (result.keptBranch)
                    console.log(chalk.green(`kept the run's branch as ${result.keptBranch} in the mirror`));
                console.log(chalk.green(`moved the run state to ${result.stateMovedTo}; omg factory run ${issue} starts a new run`));
                if (result.claimKept)
                    console.log(chalk.yellow(`the claim on the item was left in place: ${result.claimKept}`));
            }
            return 0;
        }
        finally {
            held.release();
        }
    }));
    run
        .command('release [issue]')
        .description('A human clears a claim nobody runs: the item\'s cross-clone claim (parked, crashed or unreadable), its owner file here and its private run dir\'s run.lock (dead or unreadable); without an issue, this checkout\'s engine lock. A live holder is busy (exit 6). With --tamper: print what a tamper quarantine moved and clear the hold that stops new runs here')
        .option('--tamper', 'Clear this checkout\'s tamper hold (set after a lane-, review- or prepare-tampered park) after printing what was quarantined and restored')
        .option('--json', 'JSON output')
        .action((issueRaw, o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const root = factoryRoot(exec);
        if (o.tamper) {
            if (issueRaw !== undefined)
                throw new FactoryUsageError('--tamper takes no issue: the hold is on the checkout');
            const lines = releaseTamperHold(deps.ledgerDir ?? defaultLedgerDir(), root);
            if (c.optsWithGlobals().json)
                console.log(JSON.stringify({ ok: true, released: lines !== null, report: (lines ?? []).map(plainText) }, null, 2));
            else if (lines === null)
                console.log('no tamper hold is set on this checkout');
            else
                for (const line of lines)
                    console.log(plainText(line));
            return 0;
        }
        const me = defaultOwnerDeps();
        const removed = [];
        // The check and the unlink under the owner file's lock (L-c): a live holder never loses its file.
        const removeOwnerFile = (path) => withOwnerFileLock(path, () => {
            const h = ownerHolding(path, me);
            if (h && h !== 'unreadable')
                throw new FactoryBusyError(`${path} is held by a live engine (${describeOwner(h)}); omg factory run cancel stops it`);
            if (existsSync(path)) {
                unlinkSync(path);
                removed.push(path);
            }
        });
        const kept = [];
        // B2: a dead (or unreadable) holder's file is removed; a live holder keeps its own (listed as kept).
        const freeIfDead = (path) => withOwnerFileLock(path, () => {
            const h = ownerHolding(path, me);
            if (h && h !== 'unreadable') {
                kept.push(`${path} (${describeOwner(h)})`);
                return;
            }
            if (existsSync(path)) {
                unlinkSync(path);
                removed.push(path);
            }
        });
        if (issueRaw === undefined) {
            removeOwnerFile(factoryRepoOwnerPath(root));
            // B2: a dead (or unreadable) holder's slot, import lock and credit reservations.
            let slotNames = [];
            try {
                slotNames = readdirSync(join(factoryStateDir(root), 'slots')).filter((n) => /^slot-\d+\.owner$/.test(n)).sort();
            }
            catch { /* no slots */ }
            for (const n of slotNames)
                freeIfDead(join(factoryStateDir(root), 'slots', n));
            if (existsSync(factoryImportLockPath(root)))
                freeIfDead(factoryImportLockPath(root));
            const claimRepo = existsSync(join(deps.ledgerDir ?? defaultLedgerDir(), 'credits')) ? cliClaimRepo(deps, root, readOnlyForgeKind(deps, root, deps.base(root))) : null;
            if (claimRepo) {
                const c = releaseDeadCreditReservations(deps.ledgerDir ?? defaultLedgerDir(), claimRepoKey(claimRepo, root).slice(0, 8), me);
                removed.push(...c.freed);
                kept.push(...c.kept.map((k) => `credit reservation ${k}`));
            }
        }
        else {
            const issue = parseIssue(issueRaw);
            refuseWhileEngineRuns(root, me);
            const claimRepo = cliClaimRepo(deps, root, readOnlyForgeKind(deps, root, deps.base(root)));
            const claim = claimRepo ? removeFactoryClaim(deps.ledgerDir ?? defaultLedgerDir(), claimRepo, root, issue, { deps: me }) : null;
            if (claim)
                removed.push(claim);
            removeOwnerFile(factoryOwnerPath(root, issue));
            // Review-487 L-2: the private run dir's run.lock of a dead (or unreadable) holder; a live holder keeps it.
            const lock = privateRunLockPath(root, issue);
            if (lock && existsSync(lock))
                freeIfDead(lock);
        }
        if (c.optsWithGlobals().json)
            console.log(JSON.stringify({ ok: true, removed: removed.map(plainText), ...(kept.length > 0 ? { kept: kept.map(plainText) } : {}) }, null, 2));
        else {
            if (removed.length === 0)
                console.log('nothing to release');
            else
                for (const path of removed)
                    console.log(chalk.green(`released ${plainText(path)}`));
            for (const k of kept)
                console.log(chalk.yellow(`kept ${plainText(k)}: its holder is live (omg factory run cancel stops a run)`));
        }
        return 0;
    }));
    run
        .command('status [issue]')
        .description('Print the persisted factory run state (read-only); without an issue, list the engines running in this checkout and the cross-clone claims on this repository')
        .option('--json', 'JSON output')
        .action((issueRaw, _o, c) => factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const root = factoryRoot(exec);
        if (issueRaw === undefined) {
            const live = liveFactoryRuns(root, deps.ledgerDir ?? defaultLedgerDir(), cliClaimRepo(deps, root, readOnlyForgeKind(deps, root, deps.base(root))));
            const label = (key) => (typeof key === 'number' ? `#${key}` : key);
            const line = (o) => `${o.pid !== undefined ? `pid ${o.pid}` : 'no live process'} on ${o.hostname ?? 'unknown host'} since ${o.startedAt ?? 'unknown'}${o.parkedAt ? `, parked ${o.parkedAt}` : ''}${o.root ? ` in ${o.root}` : ''}`;
            if (c.optsWithGlobals().json)
                console.log(JSON.stringify({ ok: true, ...live }, null, 2));
            else {
                if (!live.engine && live.runs.length === 0 && !live.slots)
                    console.log('no factory engine runs in this checkout');
                if (live.engine)
                    console.log(`engine lock: ${live.engine.run ?? 'run unknown'}, ${line(live.engine)}`);
                for (const s of live.slots ?? []) {
                    if ('unreadable' in s)
                        continue;
                    const v = s;
                    console.log(`slot ${v.slot}: ${v.run !== undefined && /^\d+$/.test(v.run) ? `#${v.run}` : v.run ?? 'run unknown'} (${v.layout} layout${v.privateDir ? `, ${v.privateDir}` : ''}), ${line(v)}`);
                }
                if (live.importLock)
                    console.log(`import lock: ${live.importLock.run ?? 'holder unknown'}, ${line(live.importLock)}`);
                if (live.credits && Array.isArray(live.credits))
                    console.log(`credits in flight: ${live.credits.map((r) => `${r.lane} ${r.cap}`).join(', ')}`);
                else if (live.credits)
                    console.log(chalk.yellow(`credits in flight unknown: ${live.credits.unreadable}`));
                if (live.engine?.sharedState)
                    console.log(chalk.yellow(`engine lock taken in another folder: ${SHARED_STATE_WARNING}`));
                for (const r of live.runs)
                    console.log(`live ${label(r.key)}: ${line(r)}`);
                for (const path of live.unreadable)
                    console.log(chalk.yellow(`unreadable owner file (held until removed: omg factory run release): ${path}`));
                for (const cl of live.claims) {
                    console.log(`claim ${label(cl.key)} (${cl.state}): ${line(cl)}; ${cl.path}`);
                    if (cl.sharedState)
                        console.log(chalk.yellow(`  ${SHARED_STATE_WARNING}`));
                }
            }
            return 0;
        }
        const issue = parseIssue(issueRaw);
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
                deps.err(chalk.red(factoryErrorLine(message)));
            process.exitCode = error instanceof FactoryBusyError ? EXIT_BUSY : error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
        }
    });
}
/**
 * `omg factory poll`'s local forge base sync (FactoryPollDeps.localBaseSync):
 * syncLocalMirror through the engine's exec shape, guarded with the base as
 * the one branch it may push to the mirror and hardened (no hooks, the
 * omg-local pack programs pinned), so a human merge on the base turns the
 * local PR MERGED on the next tick.
 */
export function pollLocalBaseSync(exec, ledgerDir) {
    return ({ root, base, config }) => {
        let basePush;
        const guarded = factoryGuardExec(hardenedGitExec(exec, emptyHooksDir(ledgerDir), () => config.repo.url), () => [base], undefined, undefined, () => ({ mirror: config.repo.url, baseSha: basePush }));
        const sha = syncLocalMirror(guarded, root, config.repo.url, base, (s) => { basePush = s; });
        return `synced ${base} ${sha.slice(0, 12)} to the local forge mirror`;
    };
}
export function factoryCommand() {
    const cmd = new Command('factory');
    cmd.description('Software factory automation (chain trigger + intake listener)');
    cmd.addCommand(factoryRunCommand());
    cmd.addCommand(factoryCheckCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryEnqueueCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryTriageCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryBoardCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryDashboardCommand());
    cmd.addCommand(factoryPrCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
    cmd.addCommand(factoryPollCommand({
        ...defaultFactoryCheckDeps(defaultFactoryRunDeps.base),
        healScan: defaultPollHealScan(defaultExec, (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)), defaultLedgerDir()),
        localBaseSync: pollLocalBaseSync(defaultExec, defaultLedgerDir()),
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
        gateSandbox: defaultFactoryRunDeps.gateSandbox,
        forgeKind: (root) => originForgeKind(factoryGuardExec(defaultExec), root),
        // Azure DevOps only: the trusted forge config naming factory.heal.pipeline (GitHub never loads it).
        forge: defaultFactoryRunDeps.forge,
    }));
    cmd.addCommand(factorySetupCommand());
    cmd.addCommand(factoryBenchCommand());
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