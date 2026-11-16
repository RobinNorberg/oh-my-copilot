/**
 * Gate engine for `omg ship gates`: classify `gh pr checks --json` output
 * under the fork's merge rule, attribute failures to known-flaky tests from
 * the failed job's log, and watch until green / failed / timeout.
 *
 * Merge rule: green only when every check outside the advisory list is
 * SUCCESS or SKIPPED, every name in `ship.requiredChecks` has been reported
 * (a missing one is pending: `needs:`-dependent jobs appear late), and every
 * Actions workflow run for the head sha has status `completed`. Unknown
 * states count as failed (fail closed), and a PR with no required checks yet
 * is pending, never green.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ghHeadSha, ghJobLog, ghPrChecks, ghRerun, ghRunsForHead } from '../forge/github/checks.js';
import { oneLine } from '../lib/one-line.js';
import { CI_WORKFLOW, jobCheckNames } from './workflow.js';
export const CHECK_FIELDS = 'name,state,bucket,link,workflow,event,startedAt,completedAt';
export const RUN_FIELDS = 'databaseId,status,conclusion,workflowName,headSha';
/**
 * The settle window: how long the set of reported checks must stay quiet
 * (no check started or completed) before the gate decides it is complete.
 * Bounded by the caller's own timeout (the factory's gatesTimeoutMinutes).
 */
export const CHECK_SETTLE_MS = 120_000;
/** Carried into the merge park and the PR note when a head was green with no CI at all. */
export const NO_CI_CHECKS_NOTE = 'no CI checks are configured for this repository';
/** A forge timestamp in ms, or undefined (absent, unparsable, or gh's zero time for a queued check). */
function stamp(value) {
    const ms = value ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? ms : undefined;
}
/** How to fix a required name that never reports, by where it came from. */
export function missingCheckHint(missing, config) {
    const names = missing.join(', ');
    return config.requiredChecksFrom === 'branch-protection'
        ? `required check(s) ${names} never reported for this head although the base branch's protection requires them: fix the CI workflow that should report them, or the branch protection / ruleset`
        : `required check(s) ${names} never reported for this head: no CI job has that name; fix ship.requiredChecks in your user config or in the base branch's committed .copilot/omg.jsonc (exact check names as the PR's checks show them)`;
}
/**
 * The settle window over one gate report (CHECK_SETTLE_MS from the newest
 * check start / completion the forge reports; a check without a timestamp,
 * or no check at all, counts from `watchedSince`; undefined = this read has
 * no history, so a window that needs it has not passed: fail closed).
 *
 * - `requiredChecks` empty (the reported-checks rule): a green read waits
 *   out the window (a late check may still appear), and a head with no check
 *   and no workflow run is green with `noChecks` once the window passed,
 *   but only when `reads.baseChecks` says the base commit reported no check
 *   either, `reads.ciDefinitions` finds no CI definition in the base or head
 *   tree, and the head's check suites read succeeded and are empty;
 *   otherwise (or any of them unreadable, or no `reads`) it stays pending
 *   with `noHeadChecks`.
 * - `reads.suites` (the head's check suites, when readable): green also needs
 *   each suite completed (openSuites).
 * - names required: when every reported check and run completed, nothing
 *   failed, and only required names are pending past the window, they are
 *   `missing` with a hint (the verdict stays pending).
 */
export function applySettle(report, config, now, watchedSince, reads, head) {
    const stamps = report.checks.map((c) => Math.max(stamp(c.startedAt) ?? -Infinity, stamp(c.completedAt) ?? -Infinity));
    const undated = report.checks.length === 0 || stamps.some((s) => s === -Infinity);
    const newest = Math.max(...stamps, undated ? (watchedSince ?? Infinity) : -Infinity);
    const settled = now - newest >= CHECK_SETTLE_MS;
    const suites = reads && head ? reads.suites(head) : undefined;
    const open = openSuites(suites, settled, reads?.baseSuites);
    return applyOpenSuites(settleChecks(report, config, settled, reads, open.length > 0, suites), open);
}
/** applySettle's rules on the checks; while a check suite is open (`suiteOpen`) a head that reported nothing stays pending as is. */
function settleChecks(report, config, settled, reads, suiteOpen, suites) {
    if (config.requiredChecks.length === 0) {
        if (report.verdict === 'green' && !settled) {
            return { ...report, verdict: 'pending', pending: [...report.pending, `settle window: waiting ${Math.round(CHECK_SETTLE_MS / 1000)} s after the last check activity for late checks`] };
        }
        if (report.verdict === 'pending' && report.checks.length === 0 && report.pending.length === 1 && report.pending[0] === NO_WORKFLOWS_TRIGGERED && settled && !suiteOpen) {
            // "No CI" only when the base commit reported no check either: a head that reports nothing on a repository that
            // runs CI (Actions disabled or delayed, a push that triggered no workflow) stays pending. Unreadable = has CI.
            // Nor when the base or head tree holds a CI definition (CI that runs only on pull_request leaves the base
            // commit without checks), nor unless the head's check suites read succeeded and is empty.
            const base = reads?.baseChecks();
            const defs = base === undefined || base.length > 0 ? undefined : reads.ciDefinitions();
            const noHeadChecks = base === undefined ? {}
                : base.length > 0 ? { base: [...base] }
                    : defs === undefined || defs.length > 0 ? { base: [], ciDefinitions: [...(defs ?? [])] }
                        : suites === undefined ? { base: [], suites: 'unreadable' }
                            : suites.length > 0 ? { base: [], suites: 'present' }
                                : undefined;
            if (noHeadChecks) {
                return { ...report, noHeadChecks, suggestions: [...report.suggestions.filter((s) => !s.startsWith(NO_WORKFLOWS_TRIGGERED)), noHeadChecksText(noHeadChecks)] };
            }
            return { ...report, verdict: 'green', pending: [], noChecks: true, suggestions: [...report.suggestions.filter((s) => !s.startsWith(NO_WORKFLOWS_TRIGGERED)), `${NO_CI_CHECKS_NOTE} (nothing reported for this head within ${Math.round(CHECK_SETTLE_MS / 1000)} s, the base commit reported no check either, and neither the base nor the head tree holds a CI definition)`] };
        }
        return report;
    }
    const reported = new Set(report.checks.map((c) => c.name));
    const missing = config.requiredChecks.filter((n) => !reported.has(n) && !config.advisoryChecks.includes(n));
    if (missing.length === 0 || report.checks.length === 0 || report.failed.length > 0 || !settled)
        return report;
    if (!report.pending.every((p) => missing.includes(p)))
        return report;
    return { ...report, missing, suggestions: [...report.suggestions, missingCheckHint(missing, config)] };
}
/** Why a head that reported nothing is not "no CI" (GateReport.noHeadChecks): the park, heartbeat and suggestion text. */
export function noHeadChecksText(n) {
    const window = `${Math.round(CHECK_SETTLE_MS / 1000)} s`;
    const causes = 'Actions may be disabled, delayed, or the push did not trigger workflows';
    if (n.ciDefinitions) {
        if (n.ciDefinitions.length === 0)
            return `nothing has reported a check for this head within ${window}, and the CI definitions in the base and head trees could not be read, so the gates do not assume this repository has no CI: ${causes}`;
        const files = `${n.ciDefinitions.slice(0, 5).map((f) => oneLine(f)).join(', ')}${n.ciDefinitions.length > 5 ? `, and ${n.ciDefinitions.length - 5} more` : ''}`;
        return `this repository has CI definitions (${files}) but nothing reported for this commit within ${window} (the base commit reported no check either, as CI that runs only on pull requests leaves it): ${causes}`;
    }
    if (n.suites === 'present')
        return `nothing has reported a check for this head within ${window}, but GitHub lists check suites for it, so the gates do not assume this repository has no CI: ${causes}`;
    if (n.suites === 'unreadable')
        return `nothing has reported a check for this head within ${window}, and its check suites could not be read (GitHub API error, rate limit or too many pages), so the gates do not assume this repository has no CI: ${causes}`;
    if (n.base === undefined) {
        return `nothing has reported a check for this head within ${window}, and the base commit's checks could not be read, so the gates do not assume this repository has no CI: Actions may be disabled, delayed, or the push did not trigger workflows`;
    }
    const names = `${n.base.slice(0, 5).map((f) => oneLine(f)).join(', ')}${n.base.length > 5 ? `, and ${n.base.length - 5} more` : ''}`;
    return `the base commit ran CI (${names}) but nothing has reported for this head: Actions may be disabled, delayed, or the push did not trigger workflows`;
}
/**
 * The head's check suites that still block green: every suite not
 * `completed`, except one with no check run whose app is not GitHub Actions
 * and that is still `queued` once the settle window passed. GitHub creates a
 * suite for every installed app that subscribes to check events and leaves it
 * queued forever when that app does not run on this event, so such a suite
 * would block every run. A queued Actions suite is a workflow still
 * registering (its runs appear late) and always blocks; a suite without an
 * app slug counts as Actions. Undefined suites (unreadable) block nothing:
 * the settle window alone decides, as before this read existed.
 */
function openSuites(suites, settled, baseSuites) {
    let base = null;
    // Idle on the base too: no suite of that app on the PR's base commit ran a check. Unreadable base suites = not idle.
    const idleOnBase = (app) => {
        if (base === null)
            base = baseSuites ? baseSuites() : undefined;
        return base !== undefined && base.every((b) => b.app !== app || b.runs === 0);
    };
    return (suites ?? [])
        .filter((s) => s.status.toLowerCase() !== 'completed')
        .filter((s) => !(settled && s.runs === 0 && s.app !== undefined && s.app !== 'github-actions' && s.status.toLowerCase() === 'queued' && idleOnBase(s.app)))
        .map((s) => `check suite ${s.app ?? '(unnamed app)'} (${s.status.toLowerCase()})`);
}
function applyOpenSuites(report, open) {
    if (open.length === 0)
        return report;
    return { ...report, verdict: report.verdict === 'green' ? 'pending' : report.verdict, pending: [...report.pending, ...open] };
}
/**
 * ShipConfig.requiredCheckApps on the head's check runs (`runApps`): a
 * required name whose check runs all come from another app is pending (a
 * same-named check of another app does not satisfy it; GitHub itself keeps
 * it expected). Unreadable runs (undefined) keep name matching, and so does
 * a commit status, which carries no app id: the check-runs API is the only
 * place GitHub exposes the app, so a status of the name keeps it pending.
 */
export function applyRequiredApps(report, config, runApps) {
    const apps = Object.entries(config.requiredCheckApps ?? {});
    if (apps.length === 0 || runApps === undefined)
        return report;
    const wrong = apps.filter(([name, app]) => report.checks.some((c) => c.name === name && c.class === 'pass')
        && !runApps.some((r) => r.name === name && r.appId === app));
    if (wrong.length === 0)
        return report;
    const names = new Set(wrong.map(([n]) => n));
    const checks = report.checks.map((c) => (names.has(c.name) && c.class === 'pass' ? { ...c, class: 'pending' } : c));
    return {
        ...report,
        checks,
        verdict: report.verdict === 'green' ? 'pending' : report.verdict,
        pending: [...report.pending, ...wrong.map(([n, app]) => `${n} (required from GitHub App ${app}; no check run of that app reported it)`)],
    };
}
// NEUTRAL: a check run that concluded without a verdict (CodeQL, some apps); GitHub's protection counts it as passing.
const PASS_STATES = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);
export class GhChecksError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GhChecksError';
    }
}
/** A transient GitHub failure (5xx, GraphQL "Something went wrong"): worth a retry, never a verdict. */
export const TRANSIENT_GH_ERROR = /Something went wrong|HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error/i;
/** Parse `gh pr checks --json` stdout; throws GhChecksError on anything but an array of {name,state}. */
export function parseChecksJson(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new GhChecksError('gh pr checks did not print JSON');
    }
    if (!Array.isArray(parsed))
        throw new GhChecksError('gh pr checks JSON is not an array');
    return parsed.map((raw, i) => {
        const c = raw;
        if (typeof c?.name !== 'string' || typeof c.state !== 'string') {
            throw new GhChecksError(`gh pr checks entry ${i} lacks name/state`);
        }
        return c;
    });
}
function actionsIds(link) {
    const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link ?? '');
    return m ? { runId: m[1], jobId: m[2] } : {};
}
/** `advisory` is set only by a forge adapter (an ADO non-blocking policy); gh's JSON has no such field. */
export function classifyCheck(check, advisory) {
    const state = check.state.toUpperCase();
    const cls = advisory.includes(check.name) || check.advisory === true
        ? 'advisory'
        : PASS_STATES.has(state) ? 'pass' : PENDING_STATES.has(state) ? 'pending' : 'failed';
    return { ...check, class: cls, ...actionsIds(check.link) };
}
/**
 * Pure merge-rule evaluation without log analysis (failed stays failed). A
 * `requiredChecks` name absent from `checks` is listed as pending.
 */
export function evaluateChecks(pr, checks, config) {
    const classified = checks.map((c) => classifyCheck(c, config.advisoryChecks));
    const names = (cls) => classified.filter((c) => c.class === cls).map((c) => c.name);
    const reported = new Set(classified.map((c) => c.name));
    const missing = config.requiredChecks.filter((n) => !reported.has(n) && !config.advisoryChecks.includes(n));
    const pending = [...names('pending'), ...missing];
    const failed = names('failed');
    const required = classified.filter((c) => c.class !== 'advisory');
    const advisoryFailed = classified
        .filter((c) => c.class === 'advisory' && !PASS_STATES.has(c.state.toUpperCase()))
        .map((c) => c.name);
    const verdict = failed.length > 0 ? 'failed' : pending.length > 0 || required.length === 0 ? 'pending' : 'green';
    const suggestions = [];
    if (required.length === 0)
        suggestions.push('No required checks reported yet; CI may not have started.');
    if (missing.length > 0)
        suggestions.push(`Required checks not reported yet (counted as pending): ${missing.join(', ')}`);
    return { pr, verdict, checks: classified, pending, failed, advisoryFailed, flaky: [], rerunnable: [], suggestions };
}
/** Parse `gh run list --json` stdout; throws GhChecksError on anything but an array of {databaseId,status}. */
export function parseRunsJson(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new GhChecksError('gh run list did not print JSON');
    }
    if (!Array.isArray(parsed))
        throw new GhChecksError('gh run list JSON is not an array');
    return parsed.map((raw, i) => {
        const r = raw;
        if (typeof r?.databaseId !== 'number' || typeof r.status !== 'string') {
            throw new GhChecksError(`gh run list entry ${i} lacks databaseId/status`);
        }
        return r;
    });
}
const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
/** Pending label when the head sha has no checks and no workflow runs at all. */
export const NO_WORKFLOWS_TRIGGERED = 'no-workflows-triggered';
/**
 * A green report stays green only when every workflow run for the head sha is
 * `completed`; a queued / in-progress run (jobs not yet reported) is pending.
 * The latest run of each workflow that completed with a conclusion other than
 * success / skipped / neutral and reported no check (a workflow that failed at
 * startup, e.g. an invalid workflow file) is failed. A run whose jobs did
 * report is judged by its checks (its advisory jobs may fail).
 */
export function applyWorkflowRuns(report, runs) {
    const open = runs.filter((r) => r.status.toLowerCase() !== 'completed');
    const latest = new Map();
    for (const r of runs) {
        const key = r.workflowName ?? `#${r.databaseId}`;
        const seen = latest.get(key);
        if (!seen || r.databaseId > seen.databaseId)
            latest.set(key, r);
    }
    const reportedRuns = new Set(report.checks.map((c) => c.runId).filter(Boolean));
    const broken = [...latest.values()].filter((r) => r.status.toLowerCase() === 'completed'
        && !OK_CONCLUSIONS.has((r.conclusion ?? '').toLowerCase())
        && !reportedRuns.has(String(r.databaseId)));
    if (open.length === 0 && broken.length === 0)
        return report;
    const label = (r, what) => `workflow run ${r.workflowName ?? r.databaseId} (${what})`;
    const failed = [...report.failed, ...broken.map((r) => label(r, `${(r.conclusion || 'no conclusion').toLowerCase()}, no checks reported`))];
    const pending = [...report.pending, ...open.map((r) => label(r, r.status.toLowerCase()))];
    const verdict = broken.length > 0 ? 'failed' : report.verdict === 'green' ? 'pending' : report.verdict;
    return { ...report, verdict, failed, pending };
}
/**
 * No check and no workflow run for the head: a PR opened or pushed with the
 * Actions GITHUB_TOKEN (draft bot PRs) triggers no workflows, so waiting
 * would be pending forever. Reported as a distinct pending reason.
 */
export function applyNoWorkflows(report, runs, headSha) {
    if (report.checks.length > 0 || runs.length > 0)
        return report;
    return {
        ...report,
        verdict: 'pending',
        pending: [...report.pending.filter((p) => p !== NO_WORKFLOWS_TRIGGERED), NO_WORKFLOWS_TRIGGERED],
        suggestions: [
            ...report.suggestions,
            `${NO_WORKFLOWS_TRIGGERED}: no checks and no workflow runs exist for head ${headSha.slice(0, 12)}. A PR opened or pushed with the Actions GITHUB_TOKEN triggers no workflows: push the branch from a PAT, or close and reopen the PR.`,
        ],
    };
}
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const GH_LOG_PREFIX = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/;
/** An Azure Pipelines log line's timestamp (after a byte-order mark on the first line); stripped only when the GitHub prefix is absent. */
export const ADO_LOG_PREFIX = /^\p{Cf}?\d{4}-\d\d-\d\dT[\d:.]+Z /u;
// With vitest projects the file follows a project label: `|main|` without
// colour, ` main ` on a coloured background with it (plain after ANSI stripping).
const FAIL_LINE = /^\s*FAIL\s+(?:\|[^|]+\|\s+|(?!\S+\.(?:test|spec|bench)\.)\S+\s+(?=\S+\.(?:test|spec|bench)\.))?(\S+\.(?:test|spec|bench)\.[cm]?[jt]sx?)(.*)$/;
/** Extract vitest ` FAIL  <file> > <title>` lines from a GitHub Actions or Azure Pipelines log. */
export function parseFailingTests(log) {
    const seen = new Set();
    const out = [];
    for (const rawLine of log.split(/\r?\n/)) {
        const plain = rawLine.replace(ANSI, '');
        const line = GH_LOG_PREFIX.test(plain) ? plain.replace(GH_LOG_PREFIX, '') : plain.replace(ADO_LOG_PREFIX, '');
        const m = FAIL_LINE.exec(line);
        if (!m)
            continue;
        const file = m[1].replace(/\\/g, '/');
        const rest = m[2].trim();
        const title = rest.startsWith('>') ? rest.slice(1).split(/\s+>\s+/).map((s) => s.trim()).join(' > ') : undefined;
        const key = `${file}\u0000${title ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(title ? { file, title } : { file });
    }
    return out;
}
/** A file-level failure (no title) never matches: it is a collection error, not a flaky test. */
export function isKnownFlaky(test, known) {
    return test.title !== undefined && known.some((k) => k.file === test.file && Boolean(k.title) && test.title.includes(k.title));
}
const UNHANDLED = /\bUnhandled (?:Errors?|Rejections?)\b/;
const FAILED_SUITES = /\bFailed Suites \d+/;
const STEP_ERROR = /##\[error\]/;
/** An Azure Pipelines job log has no step column: each step opens with this marker. */
const ADO_STEP_START = /^##\[section\]Starting: (.*)$/;
/**
 * Each log line without ANSI codes and its prefix, with its step: the GitHub
 * log's second tab column, or on an Azure Pipelines log the last
 * `##[section]Starting:` marker.
 */
function logLines(log) {
    const out = [];
    let adoStep = '';
    for (const rawLine of log.split(/\r?\n/)) {
        const plain = rawLine.replace(ANSI, '');
        const github = GH_LOG_PREFIX.test(plain);
        const line = github ? plain.replace(GH_LOG_PREFIX, '') : plain.replace(ADO_LOG_PREFIX, '');
        if (!github)
            adoStep = ADO_STEP_START.exec(line)?.[1].trim() ?? adoStep;
        out.push({ step: rawLine.split('\t').length >= 3 ? rawLine.split('\t')[1] : adoStep, line });
    }
    return out;
}
/**
 * Evidence in a job log that the job did not fail only because of its failing
 * tests: vitest unhandled errors, failed suites (collection errors), or an
 * `##[error]` in a step that printed no FAIL line (a non-test step failed).
 */
export function logBlockers(log) {
    const blockers = new Set();
    const testSteps = new Set();
    const errorSteps = new Set();
    for (const { step, line } of logLines(log)) {
        if (UNHANDLED.test(line))
            blockers.add('vitest reported unhandled errors');
        if (FAILED_SUITES.test(line))
            blockers.add('vitest reported failed suites (collection errors)');
        if (FAIL_LINE.test(line))
            testSteps.add(step);
        if (STEP_ERROR.test(line))
            errorSteps.add(step);
    }
    for (const step of errorSteps) {
        if (!testSteps.has(step))
            blockers.add(`step "${step || '(unnamed)'}" failed without a failing test`);
    }
    return [...blockers];
}
/**
 * The `::error` lines of this repo's ci.yml aggregators: CI Gate (the needs
 * keys that did not succeed or skip) and the Test summary (the shard matrix
 * result). Matched at line start: logLines strips the log prefix.
 */
const AGGREGATE_ERROR = /^##\[error\](?:not success or skipped: (.+?)|test shards: \w+)\s*$/;
const EXIT_ERROR = /^##\[error\]Process completed with exit code \d+\.?\s*$/;
/**
 * The job keys a job that failed only because jobs it needs failed names:
 * every step with an `##[error]` logged an aggregator line (AGGREGATE_ERROR)
 * and otherwise only its exit code, and vitest reported no unhandled error or
 * failed suite. CI Gate's line names the keys; the Test summary's is
 * `test-shards`. Undefined when the job failed on its own (any other error,
 * or a CI Gate naming the evidence job).
 */
export function aggregateOnly(log) {
    const steps = new Map();
    const keys = new Set();
    for (const { step, line } of logLines(log)) {
        if (UNHANDLED.test(line) || FAILED_SUITES.test(line))
            return undefined;
        if (!STEP_ERROR.test(line))
            continue;
        const s = steps.get(step) ?? { aggregate: false, other: false };
        const m = AGGREGATE_ERROR.exec(line);
        const named = m ? (m[1] === undefined ? ['test-shards'] : m[1].split(/,\s*/).filter(Boolean)) : [];
        if (m && named.length > 0 && !named.includes('evidence')) {
            s.aggregate = true;
            for (const k of named)
                keys.add(k);
        }
        else if (!EXIT_ERROR.test(line))
            s.other = true;
        steps.set(step, s);
    }
    return steps.size > 0 && [...steps.values()].every((s) => s.aggregate && !s.other) ? [...keys] : undefined;
}
/**
 * True when every job key an aggregator names is accounted for in its run:
 * the key maps (`jobChecks`, from ci.yml) to check names, at least one of
 * them is a non-passing check of the run, and every non-passing one has been
 * analysed. Otherwise the aggregator stays a blocker.
 */
export function needsExplained(keys, jobChecks, run) {
    return keys.length > 0 && keys.every((key) => {
        const names = jobChecks.get(key);
        const hit = names ? run.filter((c) => c.failed && names.includes(c.name)) : [];
        return hit.length > 0 && hit.every((c) => c.analysed);
    });
}
/** ci.yml's job key -> check names from `root`; empty when it is missing (no aggregator is set aside). */
export function readJobChecks(root) {
    try {
        return jobCheckNames(readFileSync(join(root, CI_WORKFLOW), 'utf8'));
    }
    catch {
        return new Map();
    }
}
export function analyzeFailedLog(check, runId, log, known, jobId) {
    const failingTests = parseFailingTests(log);
    const unknown = failingTests.filter((t) => !isKnownFlaky(t, known));
    const blockers = logBlockers(log);
    const aggregate = aggregateOnly(log);
    return {
        check,
        runId,
        ...(jobId ? { jobId } : {}),
        failingTests,
        unknown,
        blockers,
        knownFlaky: failingTests.length > 0 && unknown.length === 0 && blockers.length === 0,
        ...(aggregate ? { aggregate } : {}),
    };
}
const analysisKey = (jobId, name) => (jobId ? `job:${jobId}` : `name:${name}`);
/**
 * Fold log analyses into a report: verdict becomes `flaky` when every failed
 * required check is a known-flaky failure (matched by job id); a run is
 * rerunnable only when all its required jobs are finished. An aggregator
 * check (CI Gate, the Test summary) that failed only because jobs it needs
 * failed is judged by those jobs: it is set aside only when every job it
 * names is a failed, analysed check of its run (needsExplained over
 * `jobChecks`, ci.yml's key -> check names; empty = never set aside).
 */
export function applyFlakyAnalysis(report, analyses, kind, jobChecks = new Map()) {
    const byJob = new Map(analyses.map((a) => [analysisKey(a.jobId, a.check), a]));
    const failed = report.checks.filter((c) => c.class === 'failed');
    const derived = new Set(failed
        .filter((c) => {
        const keys = byJob.get(analysisKey(c.jobId, c.name))?.aggregate;
        const run = report.checks
            .filter((o) => c.runId && o.runId === c.runId && o !== c)
            .map((o) => ({ name: o.name, failed: o.class === 'failed', analysed: byJob.has(analysisKey(o.jobId, o.name)) }));
        return keys !== undefined && needsExplained(keys, jobChecks, run);
    })
        .map((c) => analysisKey(c.jobId, c.name)));
    const failedChecks = failed.filter((c) => !derived.has(analysisKey(c.jobId, c.name)));
    const allFlaky = failedChecks.length > 0 && failedChecks.every((c) => byJob.get(analysisKey(c.jobId, c.name))?.knownFlaky === true);
    const runIds = [...new Set(failedChecks.map((c) => c.runId).filter((id) => Boolean(id)))];
    const rerunnable = allFlaky
        ? runIds.filter((id) => !report.checks.some((c) => c.runId === id && c.class === 'pending'))
        : [];
    const suggestions = [...report.suggestions];
    for (const a of analyses) {
        if (derived.has(analysisKey(a.jobId, a.check))) {
            suggestions.push(`${a.check}: failed only because jobs it needs failed; judged by those jobs`);
        }
        else if (a.knownFlaky) {
            // ADO: a build is requeued through its PR policy evaluation, from the PR's checks or the build page.
            const link = report.checks.find((c) => c.jobId === a.jobId)?.link;
            const rerun = kind === 'azure-devops'
                ? `re-queue build ${a.runId ?? '<build-id>'} from the pull request's checks${link ? ` (${link})` : ''}`
                : `gh run rerun ${a.runId ?? '<run-id>'} --failed`;
            suggestions.push(`${a.check}: known-flaky failure (${a.failingTests.map((t) => t.title ?? t.file).join('; ')}) -> ${rerun}`);
        }
        else if (a.blockers.length > 0) {
            suggestions.push(`${a.check}: not flaky: ${a.blockers.join('; ')}`);
        }
        else if (a.failingTests.length > 0) {
            suggestions.push(`${a.check}: real failure: ${a.unknown.map((t) => (t.title ? `${t.file} > ${t.title}` : t.file)).join('; ')}`);
        }
    }
    return {
        ...report,
        verdict: report.verdict === 'failed' && allFlaky ? 'flaky' : report.verdict,
        flaky: analyses,
        rerunnable,
        suggestions,
    };
}
/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list (the GitHub forge's checks). */
export function fetchChecks(exec, pr, cwd) { return ghPrChecks(exec, pr, cwd); }
/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export function fetchHeadSha(exec, pr, cwd) { return ghHeadSha(exec, pr, cwd); }
/**
 * Every Actions workflow run for the head sha (`gh run list --commit`); a run
 * whose reported head_sha is another commit is dropped (the GitHub forge's runsForHead).
 */
export function fetchWorkflowRuns(exec, headSha, cwd) { return ghRunsForHead(exec, headSha, cwd); }
/**
 * One gate evaluation against a single head sha: resolve the head first
 * (unless given), read the checks and the workflow runs for it, then re-read
 * the head; a head that moved in between is pending whatever the verdict
 * (green, failed or flaky), since the read may mix two heads. Failed Actions
 * jobs' logs are read for known-flaky attribution; an aggregator's named jobs
 * are mapped to checks from the checkout's ci.yml. `forge` replaces the gh
 * reads (GateForge); without it every call is the GitHub one.
 * `watchedSince` (ms) feeds the settle window (applySettle): when this
 * head was first read; omitted = a read without history (fail closed).
 * `reads` (GateHeadReads, the factory run only) adds the base commit's
 * checks, the head's check suites and its check runs' apps.
 */
export function evaluateGates(exec, pr, config, known, cwd, headSha, forge, watchedSince, now = Date.now, reads) {
    const readHead = () => (forge ? forge.reviews.prHead(pr).headRefOid : fetchHeadSha(exec, pr, cwd));
    const head = headSha ?? readHead();
    const checked = evaluateChecks(pr, forge ? forge.checks.checks(pr, head) : fetchChecks(exec, pr, cwd), config);
    const runs = forge ? forge.checks.runsForHead(pr, head) : fetchWorkflowRuns(exec, head, cwd);
    const apps = Object.keys(config.requiredCheckApps ?? {}).length > 0 ? applyRequiredApps(checked, config, reads?.runApps(head)) : checked;
    const report = applySettle(applyNoWorkflows(applyWorkflowRuns(apps, runs), runs, head), config, now(), watchedSince, reads, head);
    const after = readHead();
    if (after !== head) {
        return {
            ...report,
            verdict: 'pending',
            pending: [...report.pending, `head moved from ${head.slice(0, 12)} to ${after.slice(0, 12)} during the gate read`],
        };
    }
    if (report.verdict !== 'failed' || known.length === 0)
        return report;
    const analyses = [];
    for (const check of report.checks) {
        if (check.class !== 'failed' || !check.jobId)
            continue;
        const log = forge ? forge.checks.jobLog(check.jobId) : ghJobLog(exec, check.jobId, cwd);
        analyses.push(analyzeFailedLog(check.name, check.runId, log.ok ? log.text : '', known, check.jobId));
    }
    const jobChecks = analyses.some((a) => a.aggregate) ? readJobChecks(cwd ?? process.cwd()) : undefined;
    return applyFlakyAnalysis(report, analyses, forge?.kind, jobChecks);
}
/**
 * Poll until green, a real failure, a flaky failure that is out of rerun
 * budget, or the per-invocation timeout. Each run id is rerun at most once
 * across invocations (the budget lives in the ship state).
 */
export async function watchGates(opts) {
    const { config } = opts;
    const deadline = config.watchTimeoutMinutes > 0 ? opts.now() + config.watchTimeoutMinutes * 60_000 : Infinity;
    const rerun = [];
    const settle = opts.settle ?? {};
    for (;;) {
        let report;
        const key = opts.headSha ?? '';
        if (settle.since === undefined || settle.head !== key)
            Object.assign(settle, { head: key, since: opts.now() });
        try {
            report = evaluateGates(opts.exec, opts.pr, config, opts.known, opts.cwd, opts.headSha, opts.forge, settle.since, opts.now, opts.reads);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!opts.retryTransient || !opts.watch || !(error instanceof GhChecksError) || !TRANSIENT_GH_ERROR.test(message))
                throw error;
            opts.onTransient?.(message);
            if (opts.now() >= deadline)
                throw error;
            await opts.sleep(Math.min(config.pollIntervalSeconds * 1000, Math.max(0, deadline - opts.now())));
            continue;
        }
        opts.onReport?.(report);
        if (!opts.watch || report.verdict === 'green' || report.verdict === 'failed' || (opts.stopOnMissing && report.missing)) {
            return { report, rerun, timedOut: false };
        }
        // A fixed head that moved will never settle: hand the pending report back so the caller re-views the PR.
        if (opts.headSha && report.pending.some((p) => p.startsWith('head moved from ')))
            return { report, rerun, timedOut: false };
        if (report.verdict === 'flaky') {
            const budget = opts.reruns;
            const ready = budget && config.autoRerunFlaky ? report.rerunnable.filter((id) => budget.count(id) < 1) : [];
            // Empty rerunnable = the flaky run still has pending jobs; keep polling.
            const waitingOnSiblings = report.rerunnable.length === 0;
            if (ready.length === 0 && !waitingOnSiblings)
                return { report, rerun, timedOut: false };
            for (const id of ready) {
                // Spend the budget first: a crash after the rerun must not allow a second one.
                budget.record(id);
                const res = opts.forge ? opts.forge.checks.rerun(opts.pr, id) : ghRerun(opts.exec, id, opts.cwd);
                if (!res.ok) {
                    report.suggestions.push(`${opts.forge ? `rerun of ${id}` : `gh run rerun ${id} --failed`} failed: ${res.stderr.trim()}`);
                    return { report, rerun, timedOut: false };
                }
                rerun.push(id);
            }
        }
        if (opts.now() >= deadline)
            return { report, rerun, timedOut: true };
        await opts.sleep(Math.min(config.pollIntervalSeconds * 1000, Math.max(0, deadline - opts.now())));
    }
}
//# sourceMappingURL=gates.js.map