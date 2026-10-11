/**
 * Command runner for `omg ship` plus the safety guard every engine command
 * passes through. The engine never runs a shell: each command is an argv
 * array, and `guardExec` refuses history rewrites before anything spawns.
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

const PUSH_FORCE_FLAGS = new Set(['-f', '--force', '--mirror', '--delete', '-d', '--prune']);

function gitSubcommand(args: string[]): { sub: string | undefined; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') { i += 2; continue; }
    if (arg.startsWith('-')) { i += 1; continue; }
    return { sub: arg, rest: args.slice(i + 1) };
  }
  return { sub: undefined, rest: [] };
}

/**
 * Throws ShipSafetyError when a command would rewrite or discard history,
 * touch worktrees, or merge a PR any way other than a merge commit.
 * Rules: no rebase, no pull (pull.rebase can rebase), no forced/deleting
 * push, no worktree add/remove/prune, no reset --hard, no commit --amend,
 * `gh pr merge` only with --merge (a squash discards the inventory anchor).
 */
export function assertSafeCommand(cmd: string, args: string[]): void {
  const base = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
  const refuse = (why: string): never => {
    throw new ShipSafetyError(`omg ship refuses \`${base} ${args.join(' ')}\`: ${why}`);
  };
  if (base === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'rebase') refuse('never rebase; merge the base branch in instead');
    if (sub === 'pull') refuse('use fetch + merge (pull may rebase via pull.rebase)');
    if (sub === 'filter-branch' || sub === 'replace') refuse('history rewrite');
    if (sub === 'worktree' && rest[0] !== 'list') refuse('git worktree add/remove is forbidden (node_modules junction hazard)');
    if (sub === 'reset' && rest.includes('--hard')) refuse('reset --hard discards work');
    if (sub === 'commit' && rest.includes('--amend')) refuse('never amend; add a new commit');
    if (sub === 'push') {
      for (const arg of rest) {
        if (PUSH_FORCE_FLAGS.has(arg) || arg.startsWith('--force')) refuse('never force-push or delete remote refs');
        if (!arg.startsWith('-') && (arg.startsWith('+') || arg.startsWith(':') || arg.includes(':+'))) {
          refuse('forced or deleting refspec');
        }
      }
    }
  }
  if (base === 'gh') {
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (!args.includes('--merge')) refuse('PRs merge with --merge only');
      if (args.includes('--squash') || args.includes('--rebase') || args.includes('-s') || args.includes('-r')) {
        refuse('squash/rebase merges rewrite history');
      }
    }
  }
  if (base === 'npm' || base === 'npm.cmd') {
    if (args[0] === 'ci') refuse('npm ci wipes junctioned node_modules in worktrees');
  }
}

/** Wrap an Exec so every call is checked by assertSafeCommand first. */
export function guardExec(exec: Exec): Exec {
  return (cmd, args, opts) => {
    assertSafeCommand(cmd, args);
    return exec(cmd, args, opts);
  };
}
