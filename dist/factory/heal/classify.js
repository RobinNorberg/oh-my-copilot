/**
 * Deterministic CI failure classifier (design §3). No LLM and no network:
 * the inputs are parsed job logs (logs.ts), the dev history and the sha
 * range, all fetched by the caller. Steps per failed job, in order: infra
 * patterns, known-flaky, history, environment diff (with the rule that one
 * sha green on one image version and red on another is env-change). The run
 * takes the most severe job class.
 */
import { githubRerunIntent } from '../../forge/github/ci.js';
import { ENV_FIELDS } from './logs.js';
/** Most severe first: the run takes the first class any of its jobs has. */
const SEVERITY = ['regression', 'regression-or-env', 'env-change', 'unknown', 'intermittent', 'known-flaky', 'infra'];
/** Classes that get one recorded rerun probe (design §3 step 6). */
export const RERUN_CLASSES = ['infra', 'known-flaky', 'intermittent', 'env-change'];
/** Classes a debugger lane may take (PR 2). */
export const LANE_CLASSES = ['regression', 'regression-or-env', 'env-change'];
export function envDiff(green, red) {
    if (!green)
        return [];
    return ENV_FIELDS.filter((f) => green[f] !== undefined && red[f] !== undefined && green[f] !== red[f])
        .map((field) => ({ field, green: green[field], red: red[field] }));
}
const testKey = (t) => `${t.file}\u0000${t.title ?? ''}`;
/**
 * `intermittent` when a failing test failed, then a green run followed, then
 * it failed again inside the window; `consistent` when it fails in every run
 * since its first red. Undefined without history that names the test.
 */
export function historyPattern(history, tests) {
    if (tests.length === 0)
        return undefined;
    const wanted = new Set(tests.map(testKey));
    let sawRed = false;
    let greenAfterRed = false;
    for (const h of history) {
        const red = !h.green && (h.failedTests ?? []).some((t) => wanted.has(testKey(t)));
        if (red && greenAfterRed)
            return 'intermittent';
        if (red)
            sawRed = true;
        else if (h.green && sawRed)
            greenAfterRed = true;
    }
    return sawRed ? 'consistent' : undefined;
}
export function classifyJob(input) {
    const { job } = input.red;
    const changed = envDiff(input.green?.job.env, job.env);
    const base = {
        job: job.name,
        failingTests: job.failingTests,
        blockers: job.blockers,
        infra: job.infra,
        env: { red: job.env, ...(input.green ? { green: input.green.job.env } : {}), changed },
    };
    if (job.failingTests.length === 0 && job.infra.length > 0) {
        return { ...base, class: 'infra', reason: `no failing test; infra pattern ${job.infra.join(', ')}` };
    }
    if (job.knownFlaky)
        return { ...base, class: 'known-flaky', reason: 'every failing test is on the known-flaky list' };
    if (job.failingTests.length === 0) {
        return { ...base, class: 'unknown', reason: 'no failing test parsed from the log (the job may not have reached the test step)' };
    }
    const history = historyPattern(input.history ?? [], job.failingTests);
    const withHistory = history ? { ...base, history } : base;
    if (history === 'intermittent')
        return { ...withHistory, class: 'intermittent', reason: 'the failing test also failed earlier with green runs in between' };
    const sameSha = (input.sameShaGreen ?? []).find((g) => g.sha === input.red.sha && g.job.env.imageVersion && job.env.imageVersion && g.job.env.imageVersion !== job.env.imageVersion);
    if (sameSha) {
        return {
            ...withHistory,
            class: 'env-change',
            reason: `sha ${input.red.sha.slice(0, 9)} is green on image ${sameSha.job.env.imageVersion} and red on ${job.env.imageVersion}`,
            sameShaImages: { green: sameSha.job.env.imageVersion, red: job.env.imageVersion },
        };
    }
    if (!input.green)
        return { ...withHistory, class: 'unknown', reason: 'no green run of this job to compare against' };
    const fields = changed.map((c) => c.field).join(',');
    const range = input.range;
    if (!range) {
        return changed.length > 0
            ? { ...withHistory, class: 'regression-or-env', reason: `environment changed (${fields}); the sha range is not available locally` }
            : { ...withHistory, class: 'regression', reason: 'environment unchanged; the sha range is not available locally' };
    }
    const { codeFiles } = range;
    const codeChanged = range.commits > 0 && codeFiles > 0;
    if (changed.length > 0 && !codeChanged) {
        return { ...withHistory, class: 'env-change', reason: `environment changed (${fields}) and the red sha adds no code the green sha lacks` };
    }
    if (changed.length > 0)
        return { ...withHistory, class: 'regression-or-env', reason: `environment changed (${fields}) and ${range.commits} commit(s) touch ${codeFiles} code file(s)` };
    // Design §3 step 5: an unchanged environment with a non-empty sha range is a regression, whatever the files.
    if (range.commits > 0)
        return { ...withHistory, class: 'regression', reason: `environment unchanged; ${range.commits} commit(s) touch ${codeFiles} code file(s)` };
    return { ...withHistory, class: 'intermittent', reason: 'same environment and no code change since the green run' };
}
/** `ci`: the forge whose rerun intent is recorded (default GitHub). */
export function classifyRun(input, ci = { rerunIntent: githubRerunIntent }) {
    const jobs = input.jobs.map(classifyJob);
    const cls = SEVERITY.find((c) => jobs.some((j) => j.class === c)) ?? 'unknown';
    const rerun = RERUN_CLASSES.includes(cls)
        ? { runId: input.firstRed.runId, command: ci.rerunIntent(input.firstRed.runId), issued: false }
        : undefined;
    return {
        class: cls,
        signature: input.signature,
        sig8: input.sig8,
        firstRed: input.firstRed,
        ...(input.lastGreen ? { lastGreen: input.lastGreen } : {}),
        ...(input.range ? { range: input.range } : {}),
        jobs,
        ...(rerun ? { rerun } : {}),
        laneEligible: LANE_CLASSES.includes(cls),
    };
}
//# sourceMappingURL=classify.js.map