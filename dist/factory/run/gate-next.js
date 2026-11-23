/**
 * The gate -> next step table: what a human does at each awaiting-human park.
 *
 * One table for the engine and every read surface, so the sealed
 * FactoryGate.next the engine writes and what a reader shows for a state
 * written before it cannot drift. The engine composes `next` with gateNext
 * when it parks (engine.ts gate()); a reader prefers the sealed value and
 * falls back to gateNext for older states, with the same facts.
 *
 * A step is composed only from engine-held facts: the run key (a positive
 * integer, or `heal-<8 hex>`), the 40-hex head, the PR number, the
 * repository root the engine was started with, the forge kind and the fixed
 * flags below. The reason, the park detail, lane output, titles and branch
 * names never reach an argv. Completeness: __tests__/gate-next.test.ts
 * extracts every gate name the engine can park at from the source and fails
 * on one with no entry; an unknown name gets status, rerun and cancel.
 */
import { ghMergeCommand } from '../../forge/github/merge.js';
import { localMerge } from '../../forge/local/merge.js';
import { gateNextStepOk, HEAL_RUN_KEY, runKeyOf } from './state.js';
import { RELEASE_TAMPER_COMMAND } from './tamper-quarantine.js';
/** The human action a gate asks for, in the order a list of parks is read. */
export const GATE_GROUPS = ['inspect', 'broken', 'decide', 'merge', 'fix', 'limits'];
const TRUST = ['status', 'release-tamper', 'resume', 'cancel'];
const LOOK = ['status', 'resume', 'cancel'];
const RETRY = ['resume', 'status', 'cancel'];
const CANCEL_ONLY = ['status', 'cancel'];
const e = (group, steps) => Object.freeze({ group, steps });
/** Every gate the engine parks at under a fixed name (the `<kind>-failed` / `<kind>-declined` names are patterns below). */
export const GATE_TABLE = Object.freeze({
    // Inspect: something changed outside the engine, or a lane did what it must not. A tamper hold, when set, is cleared first.
    'state-tampered': e('inspect', TRUST),
    'lane-tampered': e('inspect', TRUST),
    'review-tampered': e('inspect', TRUST),
    'sandbox-escaped': e('inspect', TRUST),
    'repo-guard-changed': e('inspect', TRUST),
    'protected-paths': e('inspect', TRUST),
    'head-moved-externally': e('inspect', TRUST),
    'import-refused': e('inspect', TRUST),
    // A rerun parks again: the reason says cancel.
    'decisions-rewritten': e('inspect', CANCEL_ONLY),
    // Broken engine.
    'lane-unconfirmed': e('broken', LOOK),
    'lane-lost': e('broken', LOOK),
    'review-identity': e('broken', LOOK),
    // Decide: a human judgement the engine must not make.
    'gate-definition-changed': e('decide', ['status', 'allow-gate-change', 'cancel']),
    'gates-unsandboxed': e('decide', ['status', 'allow-unsandboxed-gates', 'cancel']),
    'secret-shaped-content': e('decide', ['status', 'resume', 'allow-secret-shapes', 'cancel']),
    'human-review': e('decide', ['status', 'resume', 'allow-unsandboxed-lanes', 'cancel']),
    'heal-approve': e('decide', ['status', 'resume', 'cancel', 'heal-close']),
    'heal-diagnosis': e('decide', ['status', 'cancel', 'heal-close']),
    'coding-agent-adopt': e('decide', LOOK),
    'coding-agent-reassigned': e('decide', CANCEL_ONLY),
    // Merge: the human merges, then reruns.
    merge: e('merge', ['merge', 'resume', 'status']),
    'merge-refused': e('merge', LOOK),
    // Fix by hand, then rerun.
    'ci-failed': e('fix', RETRY),
    'merge-conflicts': e('fix', RETRY),
    'fix-rounds-spent': e('fix', RETRY),
    'review-invalid': e('fix', RETRY),
    'needs-plan': e('fix', RETRY),
    'pr-exists': e('fix', RETRY),
    'pr-not-open': e('fix', RETRY),
    'base-changed': e('fix', RETRY),
    'missing-checks': e('fix', RETRY),
    'no-workflows': e('fix', RETRY),
    'gates-disagree': e('fix', RETRY),
    'prepare-checks': e('fix', RETRY),
    'gate-definition-unknown': e('fix', RETRY),
    gates: e('fix', RETRY),
    'sandbox-unavailable': e('fix', RETRY),
    'gate-sandbox-incompatible': e('fix', RETRY),
    'gate-container-unavailable': e('fix', RETRY),
    'gate-install-needed': e('fix', RETRY),
    'private-store': e('fix', RETRY),
    'layout-unsupported': e('fix', RETRY),
    'parallel-needs-private': e('fix', RETRY),
    'coding-agent': e('fix', RETRY),
    // Limits / retry: a cap, a timeout or a wait; a later rerun goes on.
    budget: e('limits', RETRY),
    'wall-time': e('limits', RETRY),
    'gates-timeout': e('limits', RETRY),
    'ci-flaky': e('limits', RETRY),
    'gate-no-verdict': e('limits', RETRY),
    'coding-agent-wait': e('limits', RETRY),
    'coding-agent-timeout': e('limits', RETRY),
    'coding-agent-sessions': e('limits', RETRY),
    'coding-agent-unconfirmed': e('limits', RETRY),
    'coding-agent-head-moved': e('limits', RETRY),
    'review-requested': e('limits', RETRY),
    'blocked-by': e('limits', RETRY),
});
/** The lane kinds of laneFailed's default `<kind>-failed` and the decline park `<kind>-declined`. */
const LANE_PARK = /^(?:implement|review|fix|conflict-fix|ci-fix|coding-agent)-(?:failed|declined)$/;
const LANE_PARK_ENTRY = e('fix', RETRY);
/** A name this version does not know (a newer engine's): read the state, then rerun or cancel. */
export const UNKNOWN_GATE_ENTRY = e('fix', LOOK);
/** The table entry of a gate name; `known` false is the unknown fallback. */
export function gateSteps(name) {
    const hit = Object.prototype.hasOwnProperty.call(GATE_TABLE, name) ? GATE_TABLE[name] : LANE_PARK.test(name) ? LANE_PARK_ENTRY : null;
    return hit ? { ...hit, known: true } : { ...UNKNOWN_GATE_ENTRY, known: false };
}
/** A run key a command may carry: a positive integer issue, or `heal-<8 hex>`. */
export function validRunKey(key) {
    return typeof key === 'number' ? Number.isSafeInteger(key) && key > 0 : typeof key === 'string' && HEAL_RUN_KEY.test(key);
}
const sig8Of = (key) => key.slice('heal-'.length);
/** The rerun of a parked run; a ci-heal run's `heal approve` also resumes it after any later gate. */
export const resumeArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', String(key)] : ['omg', 'factory', 'heal', 'approve', sig8Of(key)]);
export const cancelArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', 'cancel', String(key)] : ['omg', 'factory', 'heal', 'cancel', sig8Of(key)]);
/** `omg factory run status <n>`; a heal run `omg factory heal status <sig8>`. */
export const statusArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', 'status', String(key)] : ['omg', 'factory', 'heal', 'status', sig8Of(key)]);
const HEX40 = /^[0-9a-f]{40}$/;
/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps: its command reads a body file, see the PR comment). */
export function mergeArgv(f) {
    if (typeof f.pr !== 'number' || !Number.isSafeInteger(f.pr) || f.pr <= 0 || typeof f.head !== 'string' || !HEX40.test(f.head))
        return null;
    if (f.forge === 'github')
        return ghMergeCommand(f.pr, f.head);
    if (f.forge === 'local')
        return localMerge(f.root).humanMergeCommand(f.pr, f.head);
    return null;
}
const FLAGS = {
    'allow-gate-change': '--allow-gate-change',
    'allow-unsandboxed-gates': '--allow-unsandboxed-gates',
    'allow-secret-shapes': '--allow-secret-shapes',
    'allow-unsandboxed-lanes': '--allow-unsandboxed-lanes',
};
/** The labels a step may carry (FactoryGate.next[].label is one of these when this version wrote it). */
export const GATE_NEXT_LABELS = Object.freeze({
    status: 'read the run state',
    resume: 'rerun the run',
    healResume: 'approve or resume the ci-heal run',
    cancel: 'cancel the run',
    mergeLocal: 'merge the exact head into your base',
    mergeGithub: 'merge the exact head the gates checked',
    releaseTamper: 'clear the tamper hold after checking .git',
    healClose: 'close the heal signature without a fix',
    allow: (flag) => `rerun accepting it (${flag})`,
});
/**
 * The next steps of a park, in table order. A step that cannot be composed
 * from the facts is left out (a flag on a heal run, a merge without a 40-hex
 * head or on Azure DevOps, the tamper release without a hold), and so is one
 * that would not pass the state's own shape check (a root with a control
 * character), so the engine never seals a state its parser refuses. An
 * invalid key gives no step at all.
 */
export function gateNext(name, f) {
    if (!validRunKey(f.key))
        return [];
    const heal = typeof f.key === 'string';
    const out = [];
    for (const step of gateSteps(name).steps) {
        switch (step) {
            case 'status':
                out.push({ label: GATE_NEXT_LABELS.status, argv: statusArgv(f.key) });
                break;
            case 'resume':
                out.push({ label: heal ? GATE_NEXT_LABELS.healResume : GATE_NEXT_LABELS.resume, argv: resumeArgv(f.key), billed: true });
                break;
            case 'cancel':
                out.push({ label: GATE_NEXT_LABELS.cancel, argv: cancelArgv(f.key) });
                break;
            case 'merge': {
                const argv = mergeArgv(f);
                if (argv)
                    out.push({ label: f.forge === 'local' ? GATE_NEXT_LABELS.mergeLocal : GATE_NEXT_LABELS.mergeGithub, argv });
                break;
            }
            case 'release-tamper':
                if (f.tamperHold)
                    out.push({ label: GATE_NEXT_LABELS.releaseTamper, argv: RELEASE_TAMPER_COMMAND.split(' ') });
                break;
            case 'heal-close':
                if (heal)
                    out.push({ label: GATE_NEXT_LABELS.healClose, argv: ['omg', 'factory', 'heal', 'close', sig8Of(f.key)] });
                break;
            case 'allow-gate-change':
            case 'allow-unsandboxed-gates':
            case 'allow-secret-shapes':
            case 'allow-unsandboxed-lanes': {
                // The engine accepts --allow-secret-shapes only for a lane commit's findings, --allow-unsandboxed-lanes only for that human-review park.
                const applies = step === 'allow-secret-shapes' ? f.secretFindings : step === 'allow-unsandboxed-lanes' ? f.unsandboxedLanes : true;
                if (!heal && applies)
                    out.push({ label: GATE_NEXT_LABELS.allow(FLAGS[step]), argv: [...resumeArgv(f.key), FLAGS[step]], billed: true });
                break;
            }
        }
    }
    return out.filter(gateNextStepOk);
}
/**
 * A reader's next steps of a parked state that passed its seal and ledger
 * checks (the caller's job: an unverified state gives no command): the
 * sealed FactoryGate.next, or, for a state sealed before next existed, the
 * table composed from the state's own validated fields. `root` is the
 * reader's repository root; `tamperHold` whether a hold is set on it now.
 */
export function stateGateNext(s, root, tamperHold = false) {
    if (!s.gate)
        return [];
    if (s.gate.next)
        return s.gate.next;
    return gateNext(s.gate.name, {
        key: runKeyOf(s), root, forge: s.forgeKind ?? 'github', ...(s.pr !== undefined ? { pr: s.pr } : {}), ...(s.head ? { head: s.head } : {}),
        secretFindings: Boolean(s.pendingCommit?.secretFindings?.length), tamperHold,
    });
}
const SAFE_ARG = /^[A-Za-z0-9_./:@%+=,\\-]+$/;
/** One argv as a copyable line: a word with any other character is single-quoted (POSIX shells and PowerShell read it the same unless it holds a single quote, written the POSIX way). */
export function commandLine(argv) {
    return argv.map((a) => (SAFE_ARG.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}
//# sourceMappingURL=gate-next.js.map