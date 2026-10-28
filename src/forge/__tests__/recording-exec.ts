/**
 * Recording seams for the gh argv-parity baseline (factory forges design §A.6):
 * every external command a code path issues is kept as one line,
 * `<cmd> <argv as JSON>` plus the options that reach the child (cwd, the env
 * keys added on top of the scrubbed environment, stdin). Temporary directories
 * are replaced by placeholders so the lines are stable across machines.
 */
import type { Exec, ExecOptions } from '../../ship/exec.js';

/** Placeholder name -> the directory it stands for, e.g. `{ '<root>': h.root }`. */
export type Placeholders = Readonly<Record<string, string>>;

/** A value naming a placeholder directory gets the placeholder and `/` separators; any other value is kept as is. */
export function normalize(value: string, places: Placeholders): string {
  for (const [name, dir] of Object.entries(places)) {
    if (value.includes(dir)) return value.split(dir).join(name).replace(/\\/g, '/');
  }
  return value;
}

export interface CallOpts {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  input?: string;
}

/** One recorded call as a single line. */
export function callLine(cmd: string, args: readonly string[], opts: CallOpts | undefined, places: Placeholders = {}): string {
  const parts = [`${cmd} ${JSON.stringify(args.map((a) => normalize(a, places)))}`];
  if (opts?.cwd !== undefined) parts.push(`cwd=${normalize(opts.cwd, places)}`);
  if (opts?.env !== undefined) parts.push(`env=${Object.keys(opts.env).sort().join(',')}`);
  if (opts?.input !== undefined) parts.push(`stdin=${JSON.stringify(opts.input)}`);
  return parts.join(' ');
}

/**
 * Wrap `inner` so every call is recorded before it runs. `only` limits the
 * record to those commands (the forge move touches gh; git and node stay put).
 */
export function recordingExec(inner: Exec, places: Placeholders = {}, only?: readonly string[]): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = (cmd, args, opts?: ExecOptions) => {
    if (!only || only.includes(cmd)) calls.push(callLine(cmd, args, opts, places));
    return inner(cmd, args, opts);
  };
  return { exec, calls };
}
