/**
 * Command runner for `omg ship` plus the safety guard every engine command
 * passes through. The engine never runs a shell: each command is an argv
 * array, and `guardExec` refuses anything outside an allowlist of the exact
 * command shapes the engine builds before anything spawns.
 */

import { spawnSync } from 'child_process';
import { isAdoCommand, runGuardedAdo, type AdoGuardContext } from '../forge/ado/guard.js';
import { childEnv, hardenWindowsExeSearch } from '../utils/windows-search.js';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /**
   * Variables added on top of the scrubbed environment (scrubShipEnv). The
   * guard permits only TRUSTED_READ_ENV, and only for git.
   */
  env?: Readonly<Record<string, string>>;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => ExecResult;

export class ShipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShipSafetyError';
  }
}

/**
 * Environment of every trusted read (base-branch config, known-flaky list,
 * changed-file list): `git replace` refs are ignored, so a lane's
 * `git replace <blob> <evil>` in the shared object store cannot swap content.
 */
export const TRUSTED_READ_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1' });

/**
 * `GIT_*` variables children keep: commit identity, credential prompting and
 * CA bundles. Every other `GIT_*` variable is dropped because it can redirect
 * or rewrite what git does: GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* /
 * GIT_CONFIG_VALUE_* / GIT_CONFIG_PARAMETERS / GIT_CONFIG_GLOBAL inject config
 * (aliases, hooksPath, sshCommand), GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
 * GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_COMMON_DIR /
 * GIT_NAMESPACE point at another repository or object store, GIT_EXEC_PATH
 * swaps git's subcommand binaries, GIT_SSH / GIT_SSH_COMMAND /
 * GIT_PROXY_COMMAND wrap the transport, GIT_REPLACE_REF_BASE re-enables
 * replacements. A custom ssh belongs in the owner's git config
 * (core.sshCommand), which still applies.
 */
const KEPT_GIT_VARS = new Set([
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
]);

/**
 * `gh` variables dropped: GH_REPO / GH_HOST would point every gh call at
 * another repository or host than the checkout's remote. GH_TOKEN /
 * GITHUB_TOKEN / GH_ENTERPRISE_TOKEN / GH_CONFIG_DIR pass through: gh needs
 * them to authenticate (token-based setups, CI), and a token only grants what
 * its account already may do.
 */
const DROPPED_GH_VARS = new Set(['GH_REPO', 'GH_HOST']);

/**
 * Azure DevOps CLI defaults dropped, the analogue of GH_REPO / GH_HOST
 * (factory forges design §6 "Env"): AZURE_DEVOPS_EXT_DEFAULTS* and
 * AZURE_DEVOPS_DEFAULTS_ORGANIZATION / _PROJECT would point az at another
 * organization or project. AZURE_DEVOPS_EXT_PAT and AZURE_CONFIG_DIR pass
 * through: az needs them to authenticate, like GH_TOKEN.
 */
const isDroppedAdoVar = (upper: string): boolean =>
  upper.startsWith('AZURE_DEVOPS_EXT_DEFAULTS') || upper === 'AZURE_DEVOPS_DEFAULTS_ORGANIZATION' || upper === 'AZURE_DEVOPS_DEFAULTS_PROJECT';

/**
 * The environment every engine child runs with: the parent's, minus the
 * variables above, plus GIT_NO_REPLACE_OBJECTS=1 (no command the engine runs,
 * a merge included, may see replaced objects). `omg release`
 * (src/release/engine.ts) runs every child under it too, node scripts
 * included; only its vitest suite keeps the caller's environment. Keys compare case-insensitively
 * (Windows environment names are). This narrows what a mis-set environment can
 * do; it is not a boundary against a process that controls the environment
 * outright (PATH can name another `git`), see the trust note in ship.ts.
 */
export function scrubShipEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !KEPT_GIT_VARS.has(upper)) continue;
    if (DROPPED_GH_VARS.has(upper) || isDroppedAdoVar(upper)) continue;
    out[key] = value;
  }
  return { ...out, ...TRUSTED_READ_ENV };
}

export const defaultExec: Exec = (cmd, args, opts) => {
  // libuv resolves a bare `git`/`gh` with this process's environment, so the
  // engine itself must turn off the cwd search (a lane worktree could hold a
  // planted git.exe); scrubShipEnv(process.env) then carries it to the child.
  hardenWindowsExeSearch();
  const result = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    env: childEnv({ ...scrubShipEnv(process.env), ...opts?.env }),
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
const isRemoteRef = (s: string): boolean => {
  const m = /^refs\/remotes\/([\w][\w.-]*)\/(.+)$/.exec(s);
  return Boolean(m) && REMOTE.test(m![1]) && isBranch(m![2]);
};
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
        || (r.length === 2 && r[0] === '--verify' && /^[0-9a-fA-F]{4,40}\^\{commit\}$/.test(r[1]))
        // The fetched base's remote-tracking ref, fully qualified (a tag or branch named `origin/dev` cannot shadow it).
        || (r.length === 2 && r[0] === '--verify' && isRemoteRef(r[1]));
    case 'check-ref-format':
      return r.length === 2 && r[0] === '--branch' && isBranch(r[1]);
    case 'status':
      return same(r, ['--porcelain', '--untracked-files=no']);
    case 'fetch':
      return r.length === 2 && REMOTE.test(r[0]) && isBranch(r[1]);
    case 'merge-base':
      return r.length === 3 && r[0] === '--is-ancestor' && isOperand(r[1]) && isOperand(r[2]);
    case 'remote':
      // The URL the base is fetched from, checked against the PR's repository.
      return (r.length === 2 && r[0] === 'get-url' && REMOTE.test(r[1]))
        // Every push URL, checked against the PR's repository too.
        || (r.length === 4 && r[0] === 'get-url' && r[1] === '--push' && r[2] === '--all' && REMOTE.test(r[3]));
    case 'merge':
      // Only GitHub's base sha, never a ref name a local tag or branch could shadow; hooks never run.
      return r.length === 4 && r[0] === '--no-ff' && r[1] === '--no-edit' && r[2] === '--no-verify' && HEX40.test(r[3]);
    case 'merge-tree':
      // The tree a housekeeping merge should have (merge re-checks its content).
      return r.length === 3 && r[0] === '--write-tree' && HEX40.test(r[1]) && HEX40.test(r[2]);
    case 'config':
      // Custom merge drivers: a housekeeping merge made with one is refused.
      return same(r, ['--get-regexp', '^merge\\..*\\.driver$']);
    case 'diff':
      return same(r, ['--name-only', '--diff-filter=U'])
        || same(r, ['--cached', '--quiet'])
        || same(r, ['--cached', '--quiet', '--', 'inventory'])
        || (r.length === 2 && r[0] === '--name-only' && /^[0-9a-f]{40}\.\.\.HEAD$/.test(r[1]))
        // The merge's changed-file list: GitHub's base and head commits, renames split into delete + add.
        || (r.length === 4 && r[0] === '--name-only' && r[1] === '--no-renames' && r[2] === '-z' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[3]))
        // A housekeeping commit's content: its parent (or the expected merge tree) against the commit.
        || (r.length === 5 && r[0] === '--name-only' && r[1] === '--no-renames' && r[2] === '-z' && HEX40.test(r[3]) && HEX40.test(r[4]));
    case 'checkout':
      return same(r, ['--theirs', '--', 'inventory']);
    case 'add':
      return same(r, ['--', 'inventory']);
    case 'commit':
      // Hooks never shape an engine commit; the inventory commit takes only inventory/ (an unrelated staged file stays out).
      return same(r, ['--no-edit', '--no-verify'])
        || (r.length === 5 && r[0] === '--no-verify' && r[1] === '-m' && isPath(r[2]) && r[3] === '--' && r[4] === 'inventory');
    case 'push': {
      const m = r.length === 2 ? /^HEAD:refs\/heads\/(.+)$/.exec(r[1]) : null;
      return Boolean(m) && REMOTE.test(r[0]) && isBranch(m![1])
        && !protectedBranches.some((b) => b.toLowerCase() === m![1].toLowerCase());
    }
    case 'cat-file':
      return r.length === 2 && r[0] === '-e' && /^[0-9a-f]{40}\^\{commit\}$/.test(r[1]);
    case 'rev-list': {
      // The commits after the reviewed sha on the head's first-parent chain, each with its parents.
      return r.length === 3 && r[0] === '--first-parent' && r[1] === '--parents' && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(r[2]);
    }
    case 'show':
      // `<base commit>:<repo path>`: the trusted config / known-flaky file at GitHub's base sha.
      if (r.length === 1 && r[0].includes(':')) {
        const m = /^[0-9a-f]{40}:([\w.][\w.-]*(?:\/[\w.][\w.-]*)*)$/.exec(r[0]);
        return Boolean(m) && !m![1].split('/').includes('..');
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
 * `env` (ExecOptions.env) may only be TRUSTED_READ_ENV on a git command.
 */
export function assertSafeCommand(cmd: string, args: string[], extraProtected: readonly string[] = [], env?: Readonly<Record<string, string>>): void {
  const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const base = file.replace(/\.exe$/, '');
  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED, base) ? ALLOWED[base] : undefined;
  if (!allowed || !args.every((x) => typeof x === 'string') || !allowed(args, [...PROTECTED_BRANCHES, ...extraProtected])) {
    throw new ShipSafetyError(`omg ship refuses \`${file} ${args.join(' ')}\`: not one of the command shapes the ship engine runs`);
  }
  if (env !== undefined && !(base === 'git' && same(Object.entries(env).flat(), Object.entries(TRUSTED_READ_ENV).flat()))) {
    throw new ShipSafetyError(`omg ship refuses \`${file} ${args.join(' ')}\` with environment ${JSON.stringify(env)}: only ${JSON.stringify(TRUSTED_READ_ENV)} on git is allowed`);
  }
}

/**
 * Wrap an Exec so every call is checked by assertSafeCommand first.
 * `extraProtected` is read per call (the CLI sets it to the run's base once known).
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts) with
 * the ship policy: reads and the build-evaluation requeue, for `ado`'s forge
 * only; without `ado` they are refused.
 */
export function guardExec(exec: Exec, extraProtected: () => readonly string[] = () => [], ado: () => AdoGuardContext | undefined = () => undefined): Exec {
  return (cmd, args, opts) => {
    if (isAdoCommand(cmd)) {
      const fail = (reason: string) => new ShipSafetyError(`omg ship refuses \`${cmd.replace(/\\/g, '/').split('/').pop()} ${args.join(' ')}\`: ${reason}`);
      return runGuardedAdo(exec, cmd, args, opts, ado(), 'ship', fail);
    }
    assertSafeCommand(cmd, args, extraProtected(), opts?.env);
    return exec(cmd, args, opts);
  };
}
