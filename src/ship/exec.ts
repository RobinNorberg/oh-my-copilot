/**
 * Command runner for `omg ship` plus the safety guard every engine command
 * passes through. The engine never runs a shell: each command is an argv
 * array, and `guardExec` refuses anything outside an allowlist of the exact
 * command shapes the engine builds before anything spawns.
 */

import { spawnSync } from 'child_process';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => ExecResult;

export class ShipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShipSafetyError';
  }
}

export const defaultExec: Exec = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? result.error.message : ''}`,
  };
};

/** A ref / path operand: never option-shaped, no whitespace, no refspec force/delete syntax. */
const OPERAND = /^[\w./@{}^~][\w./@{}^~-]*$/;
const REMOTE = /^[\w][\w.-]*$/;
const BRANCH = /^[\w.][\w./-]*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ABBREV_SHA = /^[0-9a-fA-F]{4,40}$/;
const NUMBER = /^\d+$/;
const JSON_FIELDS = /^[A-Za-z]+(?:,[A-Za-z]+)*$/;

const isOperand = (s: string | undefined): s is string => typeof s === 'string' && OPERAND.test(s) && !s.includes('..');
const isBranch = (s: string | undefined): s is string => typeof s === 'string' && BRANCH.test(s) && !s.includes('..');
const isPath = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const same = (args: string[], shape: string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);

const MERGE_STATE_REFS = new Set(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']);
const GIT_PATH_MARKERS = new Set(['rebase-merge', 'rebase-apply']);
const LOG_SAFE_FLAG = /^--(?:oneline|first-parent|no-merges|format=[\w%()<>:,. -]*|max-count=\d+|stat|name-only)$/;

/** Branches the guard never pushes to, whatever the caller asks (the run's base is added per call). */
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'dev'];

/** Allowed `git` argv (subcommand first; no global options such as -c/-C/--namespace). */
function gitAllowed(a: string[], protectedBranches: readonly string[]): boolean {
  const [sub, ...r] = a;
  switch (sub) {
    case 'rev-parse':
      return same(r, ['--show-toplevel'])
        || same(r, ['--abbrev-ref', 'HEAD'])
        || same(r, ['HEAD'])
        || (r.length === 3 && r[0] === '-q' && r[1] === '--verify' && MERGE_STATE_REFS.has(r[2]))
        || (r.length === 2 && r[0] === '--git-path' && GIT_PATH_MARKERS.has(r[1]))
        || (r.length === 2 && r[0] === '--verify' && /^[0-9a-fA-F]{4,40}\^\{commit\}$/.test(r[1]));
    case 'check-ref-format':
      return r.length === 2 && r[0] === '--branch' && isBranch(r[1]);
    case 'status':
      return same(r, ['--porcelain', '--untracked-files=no']);
    case 'fetch':
      return r.length === 2 && REMOTE.test(r[0]) && isBranch(r[1]);
    case 'merge-base':
      return r.length === 3 && r[0] === '--is-ancestor' && isOperand(r[1]) && isOperand(r[2]);
    case 'merge':
      return r.length === 3 && r[0] === '--no-ff' && r[1] === '--no-edit' && isOperand(r[2]);
    case 'diff':
      return same(r, ['--name-only', '--diff-filter=U'])
        || same(r, ['--cached', '--quiet'])
        || (r.length === 2 && r[0] === '--name-only' && /^[\w./-]+\.\.\.HEAD$/.test(r[1]) && !r[1].startsWith('-'));
    case 'checkout':
      return same(r, ['--theirs', '--', 'inventory']);
    case 'add':
      return same(r, ['--', 'inventory']);
    case 'commit':
      return same(r, ['--no-edit']) || (r.length === 2 && r[0] === '-m' && isPath(r[1]));
    case 'push': {
      const m = r.length === 2 ? /^HEAD:refs\/heads\/(.+)$/.exec(r[1]) : null;
      return Boolean(m) && REMOTE.test(r[0]) && isBranch(m![1]) && !protectedBranches.includes(m![1]);
    }
    case 'cat-file':
      return r.length === 2 && r[0] === '-e' && /^[0-9a-f]{40}\^\{commit\}$/.test(r[1]);
    case 'rev-list': {
      const m = r.length === 2 && r[0] === '--first-parent' ? /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(r[1]) : null;
      return Boolean(m);
    }
    case 'show':
      // `<remote>/<branch>:<repo path>`: the trusted config / known-flaky file on the base branch.
      if (r.length === 1 && r[0].includes(':')) {
        const m = /^([\w][\w.-]*)\/([\w.][\w./-]*):([\w.][\w.-]*(?:\/[\w.][\w.-]*)*)$/.exec(r[0]);
        return Boolean(m) && isBranch(m![2]) && !m![3].split('/').includes('..');
      }
      return r.every((x) => LOG_SAFE_FLAG.test(x) || isOperand(x) || ABBREV_SHA.test(x));
    case 'log':
      return r.every((x) => LOG_SAFE_FLAG.test(x) || isOperand(x) || ABBREV_SHA.test(x));
    default:
      return false;
  }
}

/** Allowed `gh` argv: `pr view|checks|merge` and `run view|list|rerun` in the engine's exact shapes. */
function ghAllowed(a: string[]): boolean {
  const [group, sub, ...r] = a;
  if (group === 'pr') {
    if ((sub === 'view' || sub === 'checks') && r.length === 3) return NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
    if (sub === 'diff') return r.length === 2 && NUMBER.test(r[0]) && r[1] === '--name-only';
    if (sub === 'merge') return r.length === 5 && NUMBER.test(r[0]) && r[1] === '--admin' && r[2] === '--merge' && r[3] === '--match-head-commit' && HEX40.test(r[4]);
    return false;
  }
  if (group === 'run') {
    if (sub === 'view') return r.length === 3 && r[0] === '--job' && NUMBER.test(r[1]) && r[2] === '--log';
    if (sub === 'rerun') return r.length === 2 && NUMBER.test(r[0]) && r[1] === '--failed';
    if (sub === 'list') {
      return r.length === 6 && r[0] === '--commit' && HEX40.test(r[1]) && r[2] === '--json' && JSON_FIELDS.test(r[3])
        && r[4] === '--limit' && NUMBER.test(r[5]);
    }
  }
  return false;
}

/** Repo scripts the engine runs with the node binary, and their allowed arguments. */
const NODE_SCRIPTS: Record<string, (rest: string[]) => boolean> = {
  'node_modules/typescript/bin/tsc': (r) => same(r, ['--noEmit']),
  'node_modules/eslint/bin/eslint.js': (r) => r.length > 0 && r.every(isPath),
  'node_modules/vitest/vitest.mjs': (r) => r.length > 1 && r[0] === 'run' && r.slice(1).every(isPath),
  'scripts/generate-inventory-graph.mjs': (r) => same(r, ['--verify']) || same(r, ['--write']),
  'scripts/generate-prompt-projections.mjs': (r) => same(r, ['--verify']),
  'scripts/copilot/build-agents.mjs': (r) => same(r, ['--verify']),
  'scripts/copilot/build-hooks.mjs': (r) => same(r, ['--verify']),
};

function nodeAllowed(a: string[]): boolean {
  const [script, ...rest] = a;
  const check = Object.prototype.hasOwnProperty.call(NODE_SCRIPTS, script) ? NODE_SCRIPTS[script] : undefined;
  return Boolean(check?.(rest));
}

const ALLOWED: Record<string, (args: string[], protectedBranches: readonly string[]) => boolean> = {
  git: gitAllowed,
  gh: ghAllowed,
  node: nodeAllowed,
};

/**
 * Throws ShipSafetyError unless the command is one of the shapes the engine
 * builds (allowlist, not denylist): plain `git` / `gh` / `node` binaries
 * (`.exe` allowed, `.cmd` / `.bat` shims and npm refused), the subcommand
 * first (no global options), every operand non-option-shaped. Consequently
 * rebase, pull, forced or deleting pushes, pushes to PROTECTED_BRANCHES or
 * `extraProtected` (the run's base), worktree add/remove, reset, amend,
 * squash/rebase/auto merges, `gh api`, `gh -R` and any npm command never spawn.
 */
export function assertSafeCommand(cmd: string, args: string[], extraProtected: readonly string[] = []): void {
  const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const base = file.replace(/\.exe$/, '');
  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED, base) ? ALLOWED[base] : undefined;
  if (!allowed || !args.every((x) => typeof x === 'string') || !allowed(args, [...PROTECTED_BRANCHES, ...extraProtected])) {
    throw new ShipSafetyError(`omg ship refuses \`${file} ${args.join(' ')}\`: not one of the command shapes the ship engine runs`);
  }
}

/**
 * Wrap an Exec so every call is checked by assertSafeCommand first.
 * `extraProtected` is read per call (the CLI sets it to the run's base once known).
 */
export function guardExec(exec: Exec, extraProtected: () => readonly string[] = () => []): Exec {
  return (cmd, args, opts) => {
    assertSafeCommand(cmd, args, extraProtected());
    return exec(cmd, args, opts);
  };
}
