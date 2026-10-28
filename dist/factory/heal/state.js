/**
 * Heal signature state (design §2): `.omg/state/factory/heal/<sig8>.json`
 * under the state root, one file per failure signature, plus the per-UTC-day
 * counters in `limits.json`. A run already counted for a signature is never
 * counted again, so rescans are idempotent. A signature with an open heal run,
 * or closed by a human as won't-fix within WONT_FIX_DAYS, only increments its
 * count. Lane-eligible signatures over a limit are queued with
 * `blocked: rate-limit` and re-evaluated by the next scan.
 *
 * The scan starts no heal run and no lane: `next` records what the next stage
 * would do, and a rerun is recorded as an intent (at most one per signature),
 * never issued. `omg factory heal run` (run.ts) starts the heal run and its
 * debugger lane and records them here.
 *
 * `webhook-queue.json` holds the run ids the listener's `workflow_run`
 * handler enqueued. It is a hint only: the scan (the poller) stays the
 * source of truth, re-reads every queued run through `gh`, and clears the
 * entries it has seen.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
export const SIG8 = /^[0-9a-f]{8}$/;
export const WONT_FIX_DAYS = 14;
/** Open heal runs at a time (fixed). */
export const MAX_OPEN_HEAL_RUNS = 1;
/** Reruns the classifier records per signature (fixed). */
export const MAX_RERUNS_PER_SIGNATURE = 1;
const MAX_SEEN_RUNS = 50;
export function healStateDir(root) {
    return join(getOmcRoot(root), 'state', 'factory', 'heal');
}
export function healStatePath(root, sig8) {
    if (!SIG8.test(sig8))
        throw new Error(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
    return join(healStateDir(root), `${sig8}.json`);
}
function parseState(raw, path) {
    const s = JSON.parse(raw);
    if (s?.version !== 1 || typeof s.sig8 !== 'string' || !SIG8.test(s.sig8) || typeof s.count !== 'number' || !Array.isArray(s.seenRuns)) {
        throw new Error(`${path}: not a heal signature state`);
    }
    return s;
}
export function readHealState(root, sig8) {
    const path = healStatePath(root, sig8);
    return existsSync(path) ? parseState(readFileSync(path, 'utf8'), path) : null;
}
export function listHealStates(root) {
    const dir = healStateDir(root);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
        .flatMap((f) => {
        const path = join(dir, f);
        try {
            return [parseState(readFileSync(path, 'utf8'), path)];
        }
        catch (error) {
            console.warn(`omg factory heal: skipping corrupt signature file ${path}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    })
        .sort((a, b) => b.lastSeen.at.localeCompare(a.lastSeen.at));
}
const utcDay = (now) => now.toISOString().slice(0, 10);
/** Today's counters in one counters file; a file from an earlier UTC day reads as zero. */
export function readDailyCountersAt(path, now) {
    const zero = { day: utcDay(now), healRuns: 0, debugLanes: 0, credits: 0 };
    if (!existsSync(path))
        return zero;
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (c.day !== zero.day)
        return zero;
    return { day: zero.day, healRuns: Number(c.healRuns) || 0, debugLanes: Number(c.debugLanes) || 0, credits: Number(c.credits) || 0 };
}
export const dailyCountersPath = (root) => join(healStateDir(root), 'limits.json');
/** Today's counters; a file from an earlier UTC day reads as zero. */
export function readDailyCounters(root, now) {
    return readDailyCountersAt(dailyCountersPath(root), now);
}
export function writeDailyCountersAt(path, counters) {
    ensureDirSync(dirname(path));
    atomicWriteFileSync(path, `${JSON.stringify(counters, null, 2)}\n`);
}
/** Why a lane-eligible signature may not start a heal run now, or null. */
export function healLimitReason(states, counters, config) {
    const open = states.filter((s) => s.healRun?.open).length;
    if (open >= MAX_OPEN_HEAL_RUNS)
        return `${open} heal run(s) open (max ${MAX_OPEN_HEAL_RUNS})`;
    if (counters.healRuns >= config.dailyRuns)
        return `${counters.healRuns} heal run(s) started today (factory.heal.dailyRuns ${config.dailyRuns})`;
    if (counters.debugLanes >= config.dailyDebugLanes)
        return `${counters.debugLanes} debugger lane(s) today (factory.heal.dailyDebugLanes ${config.dailyDebugLanes})`;
    return null;
}
/**
 * Fold one classified run into its signature state (pure: the caller writes
 * it). `others` are the other signatures' states, for the open-run limit.
 */
export function foldSignature(prev, input, others, counters, config, now) {
    const at = now.toISOString();
    // A PR run only adds weight to a dev push signature: its classification (first red sha = PR code) never replaces the push one.
    const c = prev?.source === 'push' && input.source === 'pr' ? prev.classification : input.classification;
    if (prev?.seenRuns.includes(input.runId))
        return { state: prev, changed: false, suppressed: false };
    const wontFix = prev?.wontFixAt !== undefined && now.getTime() - Date.parse(prev.wontFixAt) < WONT_FIX_DAYS * 86_400_000;
    if (prev && (prev.healRun?.open || wontFix)) {
        const state = { ...prev, count: prev.count + 1, lastSeen: { runId: input.runId, at }, seenRuns: [...prev.seenRuns, input.runId].slice(-MAX_SEEN_RUNS), updatedAt: at };
        return { state, changed: true, suppressed: true };
    }
    const rerunIntents = [...(prev?.rerunIntents ?? [])];
    if (c.rerun && rerunIntents.length < MAX_RERUNS_PER_SIGNATURE)
        rerunIntents.push(c.rerun);
    // A rerun class (env-change included) waits for its probe's outcome, which PR 1 never records.
    const next = c.rerun ? 'rerun-probe' : c.laneEligible ? 'debug-lane' : 'report';
    const blocked = next === 'debug-lane' && healLimitReason(others.filter((s) => s.sig8 !== c.sig8), counters, config) !== null;
    const state = {
        version: 1,
        sig8: c.sig8,
        signature: c.signature,
        class: c.class,
        classification: c,
        source: prev?.source === 'push' ? 'push' : input.source,
        firstSeen: prev?.firstSeen ?? { runId: input.runId, at },
        lastSeen: { runId: input.runId, at },
        count: (prev?.count ?? 0) + 1,
        seenRuns: [...(prev?.seenRuns ?? []), input.runId].slice(-MAX_SEEN_RUNS),
        ...(input.prBranches ? { prBranches: input.prBranches } : prev?.prBranches ? { prBranches: prev.prBranches } : {}),
        ...(prev?.healRun ? { healRun: prev.healRun } : {}),
        ...(prev?.lanes ? { lanes: prev.lanes } : {}),
        ...(prev?.diagnosis ? { diagnosis: prev.diagnosis } : {}),
        ...(prev?.wontFixAt ? { wontFixAt: prev.wontFixAt } : {}),
        next,
        ...(blocked ? { blocked: 'rate-limit' } : {}),
        rerunIntents,
        updatedAt: at,
    };
    return { state, changed: true, suppressed: false };
}
/** Entries kept in the webhook queue (oldest dropped first). */
export const MAX_QUEUED_RUNS = 50;
/** A queued run the scan has not seen after this long is dropped. */
export const QUEUE_TTL_MS = 7 * 86_400_000;
export const webhookQueuePath = (root) => join(healStateDir(root), 'webhook-queue.json');
export function readWebhookQueue(root) {
    const path = webhookQueuePath(root);
    if (!existsSync(path))
        return [];
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(raw.runs)
            ? raw.runs.filter((r) => typeof r?.runId === 'string' && /^\d{1,20}$/.test(r.runId) && typeof r.receivedAt === 'string')
            : [];
    }
    catch {
        return [];
    }
}
function writeWebhookQueue(root, runs) {
    ensureDirSync(healStateDir(root));
    atomicWriteFileSync(webhookQueuePath(root), `${JSON.stringify({ runs }, null, 2)}\n`);
}
/** Add one run id (idempotent); false when it was already queued. The caller holds the scan lock. */
export function enqueueWebhookRun(root, runId, now) {
    if (!/^\d{1,20}$/.test(runId))
        throw new Error(`run id must be numeric, got ${JSON.stringify(runId)}`);
    const runs = readWebhookQueue(root);
    if (runs.some((r) => r.runId === runId))
        return false;
    writeWebhookQueue(root, [...runs, { runId, receivedAt: now.toISOString() }].slice(-MAX_QUEUED_RUNS));
    return true;
}
/** Drop queued runs the scan saw and expired ones; returns what is left. The caller holds the scan lock. */
export function pruneWebhookQueue(root, seen, now) {
    const runs = readWebhookQueue(root);
    const left = runs.filter((r) => !seen.has(r.runId) && now.getTime() - Date.parse(r.receivedAt) < QUEUE_TTL_MS);
    if (left.length !== runs.length)
        writeWebhookQueue(root, left);
    return left;
}
export function writeHealState(root, state) {
    ensureDirSync(healStateDir(root));
    atomicWriteFileSync(healStatePath(root, state.sig8), `${JSON.stringify(state, null, 2)}\n`);
}
//# sourceMappingURL=state.js.map