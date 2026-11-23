/**
 * The gate -> human action -> next step table, and the printed form of a
 * command: one module for the engine and every read surface.
 *
 * The engine composes FactoryGate.next with gateNext when it parks
 * (engine.ts park()) and seals it in the run state; a reader (`run status`,
 * `omg factory attention`) prefers that sealed value from a state that
 * passed its seal and ledger checks, and composes the same steps here for a
 * state sealed before the field existed (stateGateNext), so the two cannot
 * drift.
 *
 * One entry per gate name the engine can park at (src/factory/run/: every
 * gate, setGate and park call of the engine, every park
 * object's `name` and every `*_GATE` constant); the completeness tests
 * (__tests__/gate-next.test.ts, attention/__tests__/attention-actions.test.ts)
 * extract them from the source and fail on a name with no entry. Dynamic
 * names (`<kind>-failed`, `<kind>-declined`) are pattern entries over the
 * lane kinds; an unknown name gets the resume and status commands.
 *
 * The `why` line is engine-authored text chosen by the gate name: the run's
 * free-text reason is never in it. A command is composed only from engine
 * facts or validated fields: the run key (a positive integer, or
 * `heal-<8 hex>`), a 40-hex head, a positive PR number, the repository root,
 * the forge kind and the fixed flags below. Title, reason, detail, lane
 * output, branch names and every other free text never reach an argv.
 */
import { ghMergeCommand } from '../../forge/github/merge.js';
import { localMerge } from '../../forge/local/merge.js';
import { plainText } from '../check/score.js';
import { gateNextStepOk, HEAL_RUN_KEY, runKeyOf } from './state.js';
import { RELEASE_TAMPER_COMMAND } from './tamper-quarantine.js';
/** The human action a gate asks for, in the order a list of parks is read. */
export const GATE_GROUPS = ['inspect', 'broken', 'decide', 'merge', 'fix', 'limits'];
/** A trust park: read the state, clear a tamper hold when one is set, then rerun or cancel. */
const TRUST = ['status', 'release-tamper', 'resume', 'cancel'];
const LOOK = ['status', 'resume', 'cancel'];
const e = (group, why, steps = LOOK) => Object.freeze({ group, why, steps });
/** Every gate name the engine parks at with a fixed name. */
export const GATE_TABLE = Object.freeze({
    // Inspect: something changed outside the engine, or a lane did what it must not.
    'state-tampered': e('inspect', 'an engine-owned file changed outside the engine; the changed copy was moved aside and the engine\'s restored', TRUST),
    'lane-tampered': e('inspect', 'shared git state changed while a lane or prepare\'s checks ran; nothing was pushed', TRUST),
    'review-tampered': e('inspect', 'shared git state changed while a review lane ran; its verdict is discarded', TRUST),
    'sandbox-escaped': e('inspect', 'a lane ran outside its sandbox or left its worktree; nothing was committed or pushed', TRUST),
    'repo-guard-changed': e('inspect', 'your repository\'s hooks or git config changed since the last import (private layout); check the change before a rerun', TRUST),
    'decisions-rewritten': e('inspect', 'decisions.md on the PR branch no longer starts with the base version; a rerun parks again', ['status', 'cancel']),
    'protected-paths': e('inspect', 'a lane or the prepared head changed paths the merge rule protects; nothing was pushed', TRUST),
    'head-moved-externally': e('inspect', 'the PR head or remote branch is at a commit the engine did not push', TRUST),
    'import-refused': e('inspect', 'the engine refused to import its own commit from the run\'s private repository', TRUST),
    // Broken engine.
    'lane-unconfirmed': e('broken', 'the engine could not confirm a lane\'s process stopped; stop it yourself, a rerun counts as your word'),
    'lane-lost': e('broken', 'two lanes of the same kind in a row were lost; find out why the engine died'),
    'review-identity': e('broken', 'a review job id is also a write lane\'s job (an engine invariant)', ['status', 'cancel']),
    // Decide: a human judgement the engine must not make.
    'gate-definition-changed': e('decide', 'the change redefines the local gate; inspect the diff named in the run status, then accept it once or cancel', ['status', 'allow-gate-change', 'cancel']),
    'gates-unsandboxed': e('decide', 'a gate would run the PR\'s code without the OS sandbox; accept only after reviewing the whole diff', ['status', 'allow-unsandboxed-gates', 'cancel']),
    'secret-shaped-content': e('decide', 'a key or token shape was found; remove it and rerun, or accept it when it is a test fixture', ['status', 'resume', 'allow-secret-shapes', 'cancel']),
    'heal-approve': e('decide', 'a valid CI-heal diagnosis waits for a human approval', ['status', 'resume', 'cancel', 'heal-close']),
    'heal-diagnosis': e('decide', 'the CI-heal diagnosis does not meet the contract; read it, nothing is implemented', ['status', 'cancel', 'heal-close']),
    'coding-agent-adopt': e('decide', 'the coding agent\'s pull request failed an adoption check'),
    'coding-agent-reassigned': e('decide', 'a person re-assigned the coding agent after the factory did; check the issue, then cancel and start again', ['status', 'cancel']),
    'human-review': e('decide', 'human review on the PR needs an answer (open threads, a change request, or an unreadable review)', ['status', 'resume', 'allow-unsandboxed-lanes', 'cancel']),
    // Merge.
    merge: e('merge', 'review approved and gates green: merge is a human step', ['merge', 'resume', 'status']),
    'merge-refused': e('merge', 'ship\'s merge rule refuses the head; the PR comment has the reasons'),
    // Fix by hand.
    'ci-failed': e('fix', 'a real check failure after the CI-fix round'),
    'merge-conflicts': e('fix', 'the base still conflicts after the conflict-fix rounds; merge the base into the PR branch by hand'),
    'fix-rounds-spent': e('fix', 'the changes-requested rounds are spent'),
    'review-invalid': e('fix', 'the review lane failed or broke its output contract after a fresh retry'),
    'needs-plan': e('fix', 'the item has no acceptance criteria and no trusted plan link'),
    'pr-exists': e('fix', 'an open PR already uses the run\'s branch'),
    'pr-not-open': e('fix', 'the PR was closed; reopen it or cancel'),
    'base-changed': e('fix', 'the PR was retargeted to another base'),
    'missing-checks': e('fix', 'a required check never reported for the head'),
    'no-workflows': e('fix', 'no checks and no workflow runs exist for the head'),
    'gates-disagree': e('fix', 'the merge rule\'s gate read kept disagreeing with the gates loop; check the PR\'s checks by hand'),
    'prepare-checks': e('fix', 'ship.prepare.checks changed after the run first prepared'),
    'gate-definition-unknown': e('fix', 'the local gate\'s definition cannot be pinned (wrap it in a committed script)'),
    gates: e('fix', 'the gates could not run as configured; the run status names the cause'),
    'sandbox-unavailable': e('fix', 'a lane\'s OS sandbox was not confirmed'),
    'gate-sandbox-incompatible': e('fix', 'a check fails in the sandbox on the trusted base too'),
    'gate-container-unavailable': e('fix', 'the gate could not run in a container (runtime, image or project)'),
    'gate-install-needed': e('fix', 'the gate\'s packages (npm or NuGet) must be installed or restored first'),
    'private-store': e('fix', 'the run\'s private repository could not be set up (private layout)'),
    'layout-unsupported': e('fix', 'the private layout does not run with the coding-agent implementer'),
    'parallel-needs-private': e('fix', 'a parallel run needs factory.run.layout "private"'),
    'coding-agent': e('fix', 'the coding agent is unavailable, unassigned, or its pull request cannot be used'),
    // Limits / retry: a cap, a timeout or a wait; a rerun later goes on.
    budget: e('limits', 'the run reached its AI-credit cap (factory.run.maxRunCredits)'),
    'wall-time': e('limits', 'the run passed factory.run.maxRunWallTimeMinutes'),
    'gates-timeout': e('limits', 'gates did not settle in time; a rerun waits again'),
    'ci-flaky': e('limits', 'known-flaky failures are out of rerun budget'),
    'gate-no-verdict': e('limits', 'a sandboxed check gave no verdict; rerun, and review the diff if it parks again'),
    'coding-agent-wait': e('limits', 'the coding agent is still working; rerun later'),
    'coding-agent-timeout': e('limits', 'the coding agent did not finish within factory.codingAgent.maxWaitMinutes'),
    'coding-agent-sessions': e('limits', 'the coding agent\'s daily session cap is reached'),
    'coding-agent-unconfirmed': e('limits', 'the coding agent assign may have started a session; rerun to read the issue'),
    'coding-agent-head-moved': e('limits', 'the coding agent pushed while the factory fetched its head; rerun after it stopped'),
    'review-requested': e('limits', 'requested reviewers have not reviewed yet'),
    'blocked-by': e('limits', 'the item depends on an unfinished item; rerun once it merged'),
});
/** The write-lane kinds of `<kind>-failed` / `<kind>-declined` (laneFailed's default name, the decline park). */
const LANE_KINDS = ['implement', 'review', 'fix', 'conflict-fix', 'ci-fix', 'coding-agent'];
const LANE_PARK = new RegExp(`^(${LANE_KINDS.join('|')})-(failed|declined)$`);
/** Pattern entries, for names the engine builds from a lane kind. */
export function patternEntry(name) {
    const m = LANE_PARK.exec(name);
    if (!m)
        return null;
    return m[2] === 'failed'
        ? { group: 'fix', why: `the ${m[1]} lane failed after its fresh retry`, steps: LOOK }
        : { group: 'fix', why: `the ${m[1]} lane declined the work; its reason is in the run status`, steps: LOOK };
}
/** A name this version does not know (a newer engine's). */
export const UNKNOWN_GATE_ENTRY = Object.freeze({ group: 'fix', why: 'a park this version of omg does not know; read the run status', steps: ['resume', 'status'] });
/** The table entry of a gate name; `known` false is the unknown fallback. */
export function gateSteps(name) {
    const exact = Object.prototype.hasOwnProperty.call(GATE_TABLE, name) ? GATE_TABLE[name] : null;
    const hit = exact ?? patternEntry(name);
    return hit ? { ...hit, known: true } : { ...UNKNOWN_GATE_ENTRY, known: false };
}
const HEX40 = /^[0-9a-f]{40}$/;
const SIG8 = /^[0-9a-f]{8}$/;
/** A run key a command may carry: a positive integer issue, or `heal-<8 hex>`. */
export function validRunKey(key) {
    if (typeof key === 'number')
        return Number.isSafeInteger(key) && key > 0;
    return typeof key === 'string' && HEAL_RUN_KEY.test(key);
}
const sig8Of = (key) => key.slice('heal-'.length);
/** The rerun of a parked run; a ci-heal run's `heal approve` also resumes it after any later gate. */
export const resumeArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', String(key)] : ['omg', 'factory', 'heal', 'approve', sig8Of(key)]);
export const cancelArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', 'cancel', String(key)] : ['omg', 'factory', 'heal', 'cancel', sig8Of(key)]);
/** `omg factory run status <n>`; a heal run `omg factory heal status <sig8>`. */
export const statusArgv = (key) => (typeof key === 'number' ? ['omg', 'factory', 'run', 'status', String(key)] : ['omg', 'factory', 'heal', 'status', sig8Of(key)]);
/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps, a missing or malformed field). */
export function mergeArgv(m) {
    if (typeof m.pr !== 'number' || !Number.isSafeInteger(m.pr) || m.pr <= 0 || typeof m.head !== 'string' || !HEX40.test(m.head))
        return null;
    if (m.forge === 'github')
        return ghMergeCommand(m.pr, m.head);
    if (m.forge === 'local')
        return localMerge(m.root).humanMergeCommand(m.pr, m.head);
    // Azure DevOps: the engine's command reads a body file it wrote (see the PR comment); nothing is made up here.
    return null;
}
const FLAG = {
    'allow-gate-change': '--allow-gate-change',
    'allow-unsandboxed-gates': '--allow-unsandboxed-gates',
    'allow-secret-shapes': '--allow-secret-shapes',
    'allow-unsandboxed-lanes': '--allow-unsandboxed-lanes',
};
/**
 * The commands of a step list, in order. A step that cannot be composed
 * from validated fields is left out (a flag on a heal run, a merge without a
 * 40-hex head or on Azure DevOps, a heal step on an issue run). An invalid
 * key gives no command at all.
 */
export function nextCommands(key, steps, merge) {
    if (!validRunKey(key))
        return [];
    const heal = typeof key === 'string';
    const sig8 = heal ? sig8Of(key) : '';
    const out = [];
    for (const step of steps) {
        switch (step) {
            // A resume can start lanes (billed); `heal approve` starts the ci-heal run's lanes.
            case 'resume':
                out.push({ label: heal ? 'approve / resume the ci-heal run' : 'rerun the run', argv: resumeArgv(key), billed: true });
                break;
            case 'cancel':
                out.push({ label: 'cancel the run', argv: cancelArgv(key), billed: false });
                break;
            case 'status':
                out.push({ label: 'read the run state', argv: statusArgv(key), billed: false });
                break;
            case 'merge': {
                const argv = merge ? mergeArgv(merge) : null;
                if (argv)
                    out.push({ label: merge.forge === 'local' ? 'merge the exact head into your base' : 'merge the exact head the gates checked', argv, billed: false });
                break;
            }
            case 'release-tamper':
                out.push({ label: 'clear the tamper hold after checking .git', argv: RELEASE_TAMPER_COMMAND.split(' '), billed: false });
                break;
            case 'allow-gate-change':
            case 'allow-unsandboxed-gates':
            case 'allow-secret-shapes':
            case 'allow-unsandboxed-lanes':
                if (!heal)
                    out.push({ label: `rerun accepting it (${FLAG[step]})`, argv: [...resumeArgv(key), FLAG[step]], billed: true });
                break;
            case 'heal-close':
                if (SIG8.test(sig8))
                    out.push({ label: 'close the heal run', argv: ['omg', 'factory', 'heal', 'close', sig8], billed: false });
                break;
            case 'heal-run':
                if (SIG8.test(sig8))
                    out.push({ label: 'run the debugger lane again', argv: ['omg', 'factory', 'heal', 'run', sig8], billed: true });
                break;
        }
    }
    return out;
}
/** A gate's steps with the conditional ones its facts do not call for left out. */
export function gateStepsFor(name, f) {
    return gateSteps(name).steps.filter((s) => (s === 'allow-secret-shapes' ? f.secretFindings === true : s === 'allow-unsandboxed-lanes' ? f.unsandboxedLanes === true : s === 'release-tamper' ? f.tamperHold === true : true));
}
/**
 * A park's next commands from its facts, in table order, without any a state
 * parser would refuse (a root with a control character), so the engine never
 * seals a state its parser rejects and a reader's fallback matches.
 */
export function gateCommands(name, f) {
    return nextCommands(f.key, gateStepsFor(name, f), f).filter((n) => gateNextStepOk(toStep(n)));
}
/** The stored form of a command (FactoryGate.next): `billed` only when true. */
const toStep = (n) => ({ label: n.label, argv: n.argv, ...(n.billed ? { billed: true } : {}) });
/** The commands of a sealed FactoryGate.next. */
export const fromSealed = (next) => next.map((n) => ({ label: n.label, argv: [...n.argv], billed: n.billed === true }));
/** What the engine seals in FactoryGate.next when it parks at `name`. */
export function gateNext(name, f) {
    return gateCommands(name, f).map(toStep);
}
/** The facts of a parked state as a reader has them (no unsandboxed-lanes flag: only the engine's call site knows it). */
export function stateFacts(s, root, tamperHold = false) {
    return {
        key: runKeyOf(s), root, forge: s.forgeKind ?? 'github', ...(s.pr !== undefined ? { pr: s.pr } : {}), ...(s.head ? { head: s.head } : {}),
        secretFindings: Boolean(s.pendingCommit?.secretFindings?.length), tamperHold,
    };
}
/**
 * A reader's next commands of a parked state that passed its seal and
 * ledger checks (the caller's job: an unverified state gives no command):
 * the sealed FactoryGate.next, or, for a state sealed before next existed,
 * the table composed from the state's own validated fields. `root` is the
 * reader's repository root; `tamperHold` whether a hold is set on it now.
 */
export function stateGateNext(s, root, tamperHold = false) {
    if (!s.gate)
        return [];
    if (s.gate.next)
        return fromSealed(s.gate.next);
    return gateCommands(s.gate.name, stateFacts(s, root, tamperHold));
}
/** A word printed bare in a POSIX shell (no backslash: it escapes there). */
const BARE_POSIX = /^[A-Za-z0-9_./:@%+=,-]+$/;
/** A word printed bare on Windows: no `%` (cmd expands it), `,` (a PowerShell array) or `@` (splatting). */
const BARE_WIN = /^[A-Za-z0-9_./:\\+=-]+$/;
/**
 * Letters, digits, space and `/ : . _ -`: double-quoted, such a word reads
 * the same in PowerShell, cmd.exe and a POSIX shell (no `"`, `$`, backtick,
 * `%`, `!`, `^`, `&`, `|`, `<`, `>`, `;`, `'` or backslash inside).
 */
const DOUBLE_QUOTABLE = /^[\p{L}\p{N} /:._-]+$/u;
/** A word with a character a terminal shows as blank, nothing or a control (what score.ts plainText replaces): never printed inside a command. */
const unprintable = (word) => plainText(word) !== word;
const bare = (word, platform) => (platform === 'win32' ? BARE_WIN : BARE_POSIX).test(word);
/** The word prints bare or double-quoted the same in every shell family. */
const portable = (word, platform) => !unprintable(word) && (bare(word, platform) || DOUBLE_QUOTABLE.test(word));
/**
 * One word for the shell family of `platform`: bare when safe, double quotes
 * for the portable set, else the shell's own single quotes (POSIX `'\''`;
 * on Windows PowerShell's `''` doubling, which cmd.exe does not read, so
 * commandText withholds a root that needs it).
 */
function quoteWord(word, platform) {
    if (bare(word, platform))
        return word;
    if (DOUBLE_QUOTABLE.test(word) && !unprintable(word))
        return `"${word}"`;
    return platform === 'win32' ? `'${word.replace(/'/g, "''")}'` : `'${word.replace(/'/g, "'\\''")}'`;
}
/** One argv as a copyable line for the shell family of `platform` (default: this host's). */
export function commandLine(argv, platform = process.platform) {
    return argv.map((a) => quoteWord(a, platform)).join(' ');
}
/**
 * What a human is shown for a command (the stored argv stays exact). The
 * repository root is the one free-form word a command holds (`git -C
 * <root> ...`): when it is outside the portable set on Windows (cmd.exe
 * ignores single quotes), or holds a character a terminal cannot show
 * anywhere, the `-C <root>` form is withheld and the command is to be run in
 * the repository root (`inRoot`). `--json` keeps the exact argv either way.
 */
export function commandText(argv, platform = process.platform) {
    if (argv[0] === 'git' && argv[1] === '-C' && argv.length > 3) {
        const root = argv[2];
        if (!portable(root, platform) && (platform === 'win32' || unprintable(root)))
            return { line: commandLine(['git', ...argv.slice(3)], platform), inRoot: true };
    }
    return { line: commandLine(argv, platform), inRoot: false };
}
/**
 * A repository root as one copyable word for the shell family of `platform`
 * (the rule commandText applies to `git -C <root>`), or null when it cannot
 * be shown safely there: the caller then names the repository in prose and
 * prints no path inside a command.
 */
export function rootWord(root, platform = process.platform) {
    if (!portable(root, platform) && (platform === 'win32' || unprintable(root)))
        return null;
    return quoteWord(root, platform);
}
/** commandText as one phrase: the line, or "in the repository root: <line>". */
export function humanCommand(argv, platform = process.platform) {
    const t = commandText(argv, platform);
    return t.inRoot ? `in the repository root: ${t.line}` : t.line;
}
//# sourceMappingURL=gate-next.js.map