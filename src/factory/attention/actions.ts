/**
 * `omg factory attention`: the gate -> human action -> command table.
 *
 * One entry per gate name the engine can park at (src/factory/run/: every
 * `this.gate(...)` / `setGate(...)` call, every park object's `name` and
 * every `*_GATE` constant; __tests__/attention-actions.test.ts extracts them
 * from the source and fails on a name with no entry). Dynamic names
 * (`<kind>-failed`, `<kind>-declined`) are pattern entries over the lane
 * kinds. An unknown name lands in "Fix by hand" with the resume and status
 * commands.
 *
 * The `why` line is engine-authored text chosen by the gate name: the run's
 * free-text reason is never in it. A command is composed only from validated
 * fields: the run key (a positive integer, or `heal-<8 hex>`), a 40-hex head
 * sha, a positive PR number, the repository root and the fixed flags below.
 * Title, reason, detail, branch names and every other free text never reach
 * an argv.
 */

import { ghMergeCommand } from '../../forge/github/merge.js';
import { localMerge } from '../../forge/local/merge.js';
import type { ForgeKind } from '../../forge/types.js';
import { cancelCommand, resumeCommand } from '../run/engine.js';
import { HEAL_RUN_KEY, type FactoryRunKey } from '../run/state.js';

export const ATTENTION_GROUPS = ['inspect', 'broken', 'decide', 'merge', 'fix', 'limits'] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

export const GROUP_TITLES: Readonly<Record<AttentionGroup, string>> = Object.freeze({
  inspect: 'Inspect',
  broken: 'Broken engine',
  decide: 'Decide',
  merge: 'Merge',
  fix: 'Fix by hand',
  limits: 'Limits / retry',
});

export interface NextCommand {
  label: string;
  argv: string[];
}

/**
 * A step of the table: `resume` (`omg factory run <n>`, a heal run `omg
 * factory heal approve <sig8>`), `cancel`, `status`, a resume with one fixed
 * acceptance flag (issue runs only: `heal approve` takes none), `merge` (the
 * forge's human merge command), `release-tamper`, and for a heal signature
 * without a run state `heal-close` / `heal-run`.
 */
export type ActionStep =
  | 'resume' | 'cancel' | 'status' | 'merge'
  | 'allow-gate-change' | 'allow-unsandboxed-gates' | 'allow-secret-shapes'
  | 'heal-close' | 'heal-run';

export interface GateAction {
  group: AttentionGroup;
  /** One line, engine-authored, never the run's reason. */
  why: string;
  steps: readonly ActionStep[];
}


/** Every gate name the engine parks at with a fixed name. */
export const GATE_ACTIONS: Readonly<Record<string, GateAction>> = Object.freeze({
  // Inspect: something changed outside the engine, or a lane did what it must not.
  'state-tampered': { group: 'inspect', why: 'an engine-owned file changed outside the engine; the changed copy was moved aside and the engine\'s restored', steps: ['status', 'resume', 'cancel'] },
  'lane-tampered': { group: 'inspect', why: 'shared git state changed while a lane or prepare\'s checks ran; nothing was pushed', steps: ['status', 'resume', 'cancel'] },
  'review-tampered': { group: 'inspect', why: 'shared git state changed while a review lane ran; its verdict is discarded', steps: ['status', 'resume', 'cancel'] },
  'sandbox-escaped': { group: 'inspect', why: 'a lane ran outside its sandbox or left its worktree; nothing was committed or pushed', steps: ['status', 'resume', 'cancel'] },
  'repo-guard-changed': { group: 'inspect', why: 'your repository\'s hooks or git config changed since the last import (private layout); check the change before a rerun', steps: ['status', 'resume', 'cancel'] },
  'decisions-rewritten': { group: 'inspect', why: 'decisions.md on the PR branch no longer starts with the base version; a rerun parks again', steps: ['status', 'cancel'] },
  'protected-paths': { group: 'inspect', why: 'a lane or the prepared head changed paths the merge rule protects; nothing was pushed', steps: ['status', 'resume', 'cancel'] },
  'head-moved-externally': { group: 'inspect', why: 'the PR head or remote branch is at a commit the engine did not push', steps: ['status', 'resume', 'cancel'] },
  'import-refused': { group: 'inspect', why: 'the engine refused to import its own commit from the run\'s private repository', steps: ['status', 'resume', 'cancel'] },
  // Broken engine.
  'lane-unconfirmed': { group: 'broken', why: 'the engine could not confirm a lane\'s process stopped; stop it yourself, a rerun counts as your word', steps: ['status', 'resume', 'cancel'] },
  'lane-lost': { group: 'broken', why: 'two lanes of the same kind in a row were lost; find out why the engine died', steps: ['status', 'resume', 'cancel'] },
  'review-identity': { group: 'broken', why: 'a review job id is also a write lane\'s job (an engine invariant)', steps: ['status', 'cancel'] },
  // Decide: a human judgement the engine must not make.
  'gate-definition-changed': { group: 'decide', why: 'the change redefines the local gate; inspect the diff named in the run status, then accept it once or cancel', steps: ['status', 'allow-gate-change', 'cancel'] },
  'gates-unsandboxed': { group: 'decide', why: 'a gate would run the PR\'s code without the OS sandbox; accept only after reviewing the whole diff', steps: ['status', 'allow-unsandboxed-gates', 'cancel'] },
  'secret-shaped-content': { group: 'decide', why: 'a key or token shape was found; remove it and rerun, or accept it when it is a test fixture', steps: ['status', 'resume', 'allow-secret-shapes', 'cancel'] },
  'heal-approve': { group: 'decide', why: 'a valid CI-heal diagnosis waits for a human approval', steps: ['status', 'resume', 'cancel'] },
  'heal-diagnosis': { group: 'decide', why: 'the CI-heal diagnosis does not meet the contract; read it, nothing is implemented', steps: ['status', 'cancel'] },
  'coding-agent-adopt': { group: 'decide', why: 'the coding agent\'s pull request failed an adoption check', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-reassigned': { group: 'decide', why: 'a person re-assigned the coding agent after the factory did; check the issue, then cancel and start again', steps: ['status', 'cancel'] },
  'human-review': { group: 'decide', why: 'human review on the PR needs an answer (open threads, a change request, or an unreadable review)', steps: ['status', 'resume', 'cancel'] },
  // Merge.
  merge: { group: 'merge', why: 'review approved and gates green: merge is a human step', steps: ['merge', 'resume', 'status'] },
  'merge-refused': { group: 'merge', why: 'ship\'s merge rule refuses the head; the PR comment has the reasons', steps: ['status', 'resume', 'cancel'] },
  // Fix by hand.
  'ci-failed': { group: 'fix', why: 'a real check failure after the CI-fix round', steps: ['status', 'resume', 'cancel'] },
  'merge-conflicts': { group: 'fix', why: 'the base still conflicts after the conflict-fix rounds; merge the base into the PR branch by hand', steps: ['status', 'resume', 'cancel'] },
  'fix-rounds-spent': { group: 'fix', why: 'the changes-requested rounds are spent', steps: ['status', 'resume', 'cancel'] },
  'review-invalid': { group: 'fix', why: 'the review lane failed or broke its output contract after a fresh retry', steps: ['status', 'resume', 'cancel'] },
  'needs-plan': { group: 'fix', why: 'the item has no acceptance criteria and no trusted plan link', steps: ['status', 'resume', 'cancel'] },
  'pr-exists': { group: 'fix', why: 'an open PR already uses the run\'s branch', steps: ['status', 'resume', 'cancel'] },
  'pr-not-open': { group: 'fix', why: 'the PR was closed; reopen it or cancel', steps: ['status', 'resume', 'cancel'] },
  'base-changed': { group: 'fix', why: 'the PR was retargeted to another base', steps: ['status', 'resume', 'cancel'] },
  'missing-checks': { group: 'fix', why: 'a required check never reported for the head', steps: ['status', 'resume', 'cancel'] },
  'no-workflows': { group: 'fix', why: 'no checks and no workflow runs exist for the head', steps: ['status', 'resume', 'cancel'] },
  'gates-disagree': { group: 'fix', why: 'the merge rule\'s gate read kept disagreeing with the gates loop; check the PR\'s checks by hand', steps: ['status', 'resume', 'cancel'] },
  'prepare-checks': { group: 'fix', why: 'ship.prepare.checks changed after the run first prepared', steps: ['status', 'resume', 'cancel'] },
  'gate-definition-unknown': { group: 'fix', why: 'the local gate\'s definition cannot be pinned (wrap it in a committed script)', steps: ['status', 'resume', 'cancel'] },
  gates: { group: 'fix', why: 'the gates could not run as configured; the run status names the cause', steps: ['status', 'resume', 'cancel'] },
  'sandbox-unavailable': { group: 'fix', why: 'a lane\'s OS sandbox was not confirmed', steps: ['status', 'resume', 'cancel'] },
  'gate-sandbox-incompatible': { group: 'fix', why: 'a check fails in the sandbox on the trusted base too', steps: ['status', 'resume', 'cancel'] },
  'gate-container-unavailable': { group: 'fix', why: 'the gate could not run in a container (runtime, image or project)', steps: ['status', 'resume', 'cancel'] },
  'gate-install-needed': { group: 'fix', why: 'the gate\'s packages (npm or NuGet) must be installed or restored first', steps: ['status', 'resume', 'cancel'] },
  'private-store': { group: 'fix', why: 'the run\'s private repository could not be set up (private layout)', steps: ['status', 'resume', 'cancel'] },
  'layout-unsupported': { group: 'fix', why: 'the private layout does not run with the coding-agent implementer', steps: ['status', 'resume', 'cancel'] },
  'parallel-needs-private': { group: 'fix', why: 'a parallel run needs factory.run.layout "private"', steps: ['status', 'resume', 'cancel'] },
  'coding-agent': { group: 'fix', why: 'the coding agent is unavailable, unassigned, or its pull request cannot be used', steps: ['status', 'resume', 'cancel'] },
  // Limits / retry: a cap, a timeout or a wait; a rerun later goes on.
  budget: { group: 'limits', why: 'the run reached its AI-credit cap (factory.run.maxRunCredits)', steps: ['status', 'resume', 'cancel'] },
  'wall-time': { group: 'limits', why: 'the run passed factory.run.maxRunWallTimeMinutes', steps: ['status', 'resume', 'cancel'] },
  'gates-timeout': { group: 'limits', why: 'gates did not settle in time; a rerun waits again', steps: ['status', 'resume', 'cancel'] },
  'ci-flaky': { group: 'limits', why: 'known-flaky failures are out of rerun budget', steps: ['status', 'resume', 'cancel'] },
  'gate-no-verdict': { group: 'limits', why: 'a sandboxed check gave no verdict; rerun, and review the diff if it parks again', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-wait': { group: 'limits', why: 'the coding agent is still working; rerun later', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-timeout': { group: 'limits', why: 'the coding agent did not finish within factory.codingAgent.maxWaitMinutes', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-sessions': { group: 'limits', why: 'the coding agent\'s daily session cap is reached', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-unconfirmed': { group: 'limits', why: 'the coding agent assign may have started a session; rerun to read the issue', steps: ['status', 'resume', 'cancel'] },
  'coding-agent-head-moved': { group: 'limits', why: 'the coding agent pushed while the factory fetched its head; rerun after it stopped', steps: ['status', 'resume', 'cancel'] },
  'review-requested': { group: 'limits', why: 'requested reviewers have not reviewed yet', steps: ['status', 'resume', 'cancel'] },
  'blocked-by': { group: 'limits', why: 'the item depends on an unfinished item; rerun once it merged', steps: ['status', 'resume', 'cancel'] },
});

/** The write-lane kinds of `<kind>-failed` / `<kind>-declined` (laneFailed's default name, the decline park). */
const LANE_KINDS = ['implement', 'review', 'fix', 'conflict-fix', 'ci-fix', 'coding-agent'] as const;
const LANE_PARK = new RegExp(`^(${LANE_KINDS.join('|')})-(failed|declined)$`);

/** Pattern entries, for names the engine builds from a lane kind. */
export function patternAction(name: string): GateAction | null {
  const m = LANE_PARK.exec(name);
  if (!m) return null;
  return m[2] === 'failed'
    ? { group: 'fix', why: `a ${m[1]} lane failed after its fresh retry`, steps: ['status', 'resume', 'cancel'] }
    : { group: 'fix', why: `a ${m[1]} lane declined the work; its reason is in the run status`, steps: ['status', 'resume', 'cancel'] };
}

export const UNKNOWN_GATE_ACTION: GateAction = Object.freeze({ group: 'fix', why: 'a park this version of omg does not know; read the run status', steps: ['resume', 'status'] as const });

/** The table entry of a gate name; `known` false is the unknown fallback. */
export function gateAction(name: string): GateAction & { known: boolean } {
  const exact = Object.prototype.hasOwnProperty.call(GATE_ACTIONS, name) ? GATE_ACTIONS[name] : null;
  const hit = exact ?? patternAction(name);
  return hit ? { ...hit, known: true } : { ...UNKNOWN_GATE_ACTION, known: false };
}

const HEX40 = /^[0-9a-f]{40}$/;
const SIG8 = /^[0-9a-f]{8}$/;

/** A run key a command may carry: a positive integer issue, or `heal-<8 hex>`. */
export function validRunKey(key: unknown): key is FactoryRunKey {
  if (typeof key === 'number') return Number.isSafeInteger(key) && key > 0;
  return typeof key === 'string' && HEAL_RUN_KEY.test(key);
}

/** The engine's own command strings hold only fixed words and the validated key: split them back into argv. */
const argvOf = (line: string): string[] => line.split(' ');

export function resumeArgv(key: FactoryRunKey): string[] {
  return argvOf(resumeCommand(key));
}

export function cancelArgv(key: FactoryRunKey): string[] {
  return argvOf(cancelCommand(key));
}

/** `omg factory run status <n>`; a heal run `omg factory heal status <sig8>`. */
export function statusArgv(key: FactoryRunKey): string[] {
  return typeof key === 'number' ? ['omg', 'factory', 'run', 'status', String(key)] : ['omg', 'factory', 'heal', 'status', key.slice('heal-'.length)];
}

/** The run's merge facts, each already shape-checked by the caller or here. */
export interface MergeFacts {
  forge: ForgeKind;
  /** The repository root (`git rev-parse --show-toplevel`), as the engine derives it. */
  root: string;
  pr?: number;
  head?: string;
}

/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps, a missing or malformed field). */
export function mergeArgv(m: MergeFacts): string[] | null {
  if (typeof m.pr !== 'number' || !Number.isSafeInteger(m.pr) || m.pr <= 0 || typeof m.head !== 'string' || !HEX40.test(m.head)) return null;
  if (m.forge === 'github') return ghMergeCommand(m.pr, m.head);
  if (m.forge === 'local') return localMerge(m.root).humanMergeCommand(m.pr, m.head);
  // Azure DevOps: the engine's command reads a body file it wrote; attention writes nothing and fabricates no command.
  return null;
}

const FLAG: Partial<Record<ActionStep, string>> = {
  'allow-gate-change': '--allow-gate-change',
  'allow-unsandboxed-gates': '--allow-unsandboxed-gates',
  'allow-secret-shapes': '--allow-secret-shapes',
};

/**
 * The next commands of a row, in table order. A step that cannot be composed
 * from validated fields is left out (a flag on a heal run, a merge without a
 * 40-hex head). An invalid key gives no command at all.
 */
export function nextCommands(key: FactoryRunKey, steps: readonly ActionStep[], merge?: MergeFacts): NextCommand[] {
  if (!validRunKey(key)) return [];
  const heal = typeof key === 'string';
  const sig8 = heal ? key.slice('heal-'.length) : '';
  const out: NextCommand[] = [];
  for (const step of steps) {
    switch (step) {
      case 'resume': out.push({ label: heal ? 'approve / resume the ci-heal run' : 'rerun the run', argv: resumeArgv(key) }); break;
      case 'cancel': out.push({ label: 'cancel the run', argv: cancelArgv(key) }); break;
      case 'status': out.push({ label: 'read the run state', argv: statusArgv(key) }); break;
      case 'merge': {
        const argv = merge ? mergeArgv(merge) : null;
        if (argv) out.push({ label: merge!.forge === 'local' ? 'merge the exact head into your base' : 'merge the exact head the gates checked', argv });
        break;
      }
      case 'allow-gate-change': case 'allow-unsandboxed-gates': case 'allow-secret-shapes':
        if (!heal) out.push({ label: `rerun accepting it (${FLAG[step]})`, argv: [...resumeArgv(key), FLAG[step]!] });
        break;
      case 'heal-close': if (SIG8.test(sig8)) out.push({ label: 'close the heal run', argv: ['omg', 'factory', 'heal', 'close', sig8] }); break;
      case 'heal-run': if (SIG8.test(sig8)) out.push({ label: 'run the debugger lane again (billed)', argv: ['omg', 'factory', 'heal', 'run', sig8] }); break;
    }
  }
  return out;
}

/** Shown when a state fails its seal or ledger check: only the read-only status command. */
export const suppressedCommands = (key: FactoryRunKey): NextCommand[] => (validRunKey(key) ? [{ label: 'read the run state', argv: statusArgv(key) }] : []);

/** A poll reminder's command: the cancel where a rerun re-parks (decisions-rewritten), else the resume. */
export function reminderCommand(key: FactoryRunKey, gate: string): string {
  return gate === 'decisions-rewritten' ? cancelCommand(key) : resumeCommand(key);
}

const SAFE_ARG = /^[A-Za-z0-9_./:@%+=,\\-]+$/;

/** One argv as a copyable line: a word with any other character is single-quoted (a POSIX shell and PowerShell read it the same unless it holds a single quote, written the POSIX way). */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (SAFE_ARG.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}
