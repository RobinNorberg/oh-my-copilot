/**
 * Fork (psmux): private-server adapter for psmux, the native Windows tmux
 * drop-in.
 *
 * psmux honours `-L <namespace>` but ignores `-S <path>`, and reports a
 * constant `#{socket_path}` in every namespace. The fork therefore models a
 * psmux "socket" as the synthetic absolute path `~\.psmux\omg-ns\<ns>`; the
 * exec layer (src/cli/tmux-utils.ts) translates `-S <that path>` into
 * `-L <ns>` so identity capture, observation and ownership checks work
 * unchanged. psmux 3.3.8 cannot run the `if-shell` identity guard (it
 * re-tokenises the PowerShell condition), so destructive commands are
 * verified first and then run as argv inside the private namespace, where
 * only this instance ever creates servers.
 *
 * This module imports no tmux-session/tmux-utils code; exec and observe are
 * injected by the caller.
 */

import { spawnSync } from 'child_process';
import { readdir, rm } from 'fs/promises';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { win32 } from 'path';
import { resolveExecutable } from '../platform/executable-resolution.js';
import type { TmuxServerIdentity } from './types.js';

const PSMUX_REGISTRY_DIR = win32.join(homedir(), '.psmux');
export const PSMUX_NS_DIR = win32.join(PSMUX_REGISTRY_DIR, 'omg-ns');
const PSMUX_NS_NAME = /^omg-[a-z0-9-]{1,48}$/;

let psmuxDetected: boolean | undefined;

/** True when the resolved `tmux` binary is psmux (cached per process). */
export function isPsmux(): boolean {
  if (process.platform !== 'win32') return false;
  if (psmuxDetected === undefined) {
    try {
      const result = spawnSync(resolveExecutable('tmux') ?? 'tmux', ['-V'], {
        encoding: 'utf-8',
        timeout: 5_000,
        shell: false,
        windowsHide: true,
      });
      psmuxDetected = result.status === 0 && /psmux/i.test(`${result.stdout ?? ''}`);
    } catch {
      psmuxDetected = false;
    }
  }
  return psmuxDetected;
}

/** Test hook: force detection (`true`/`false`) or reset it (`undefined`). */
export function __setPsmuxDetectionForTests(value: boolean | undefined): void {
  psmuxDetected = value;
}

/** Synthetic socket path naming a fresh private psmux namespace. */
export function buildPsmuxNamespacePath(): string {
  const ns = `omg-${process.pid.toString(36)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const socketPath = win32.join(PSMUX_NS_DIR, ns);
  if (/[#|\u0000-\u001f\u007f]/.test(socketPath) || psmuxNamespaceOf(socketPath) !== ns) {
    throw new Error('psmux_namespace_path_invalid');
  }
  return socketPath;
}

/** The namespace named by a synthetic socket path, or null for any other path. */
export function psmuxNamespaceOf(socketPath: string): string | null {
  if (/[#|\u0000-\u001f\u007f]/.test(socketPath)) return null;
  if (win32.dirname(socketPath).toLowerCase() !== PSMUX_NS_DIR.toLowerCase()) return null;
  const ns = win32.basename(socketPath);
  return PSMUX_NS_NAME.test(ns) ? ns : null;
}

/**
 * Translate a `-S <socket>` tmux argv for psmux. Non-`-S` argv is returned
 * unchanged. Any `-S` path other than a synthetic namespace path throws:
 * falling back to the default namespace would let colliding pane ids resolve
 * in another server.
 */
export function translatePsmuxArgs(args: readonly string[]): { args: string[]; restore: (stdout: string) => string } {
  if (args[0] !== '-S') return { args: [...args], restore: stdout => stdout };
  const socketPath = args[1] ?? '';
  const ns = psmuxNamespaceOf(socketPath);
  if (!ns) throw new Error('psmux_socket_path_unsupported');
  let mappedTabs = false;
  const rest = args.slice(2).map((arg, index, all) => {
    let value = arg.split('#{socket_path}').join(socketPath);
    // psmux turns TAB into a space in `new-session -P -F` output; `|` cannot
    // occur in Windows paths, sanitized session names, pane ids or pids.
    const isFormat = all[index - 1] === '-F' || (all[0] === 'display-message' && value.includes('#'));
    if (isFormat && value.includes('\t')) {
      value = value.replace(/\t/g, '|');
      mappedTabs = true;
    }
    return value;
  });
  return {
    args: ['-L', ns, ...rest],
    restore: stdout => (mappedTabs ? stdout.replace(/\|/g, '\t') : stdout),
  };
}

/**
 * Strict inverse of tmux-session's `tmuxCommandString`: single-quoted tokens
 * (with `'"'"'` escapes and `##` for `#`) separated by single spaces, or one
 * bare word. Returns null for anything else.
 */
export function decodeTmuxCommandString(command: string): string[] | null {
  if (/^[a-z][a-z-]*$/.test(command)) return [command];
  const tokens: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (tokens.length > 0) {
      if (command[index] !== ' ') return null;
      index += 1;
    }
    if (command[index] !== '\'') return null;
    index += 1;
    let token = '';
    for (;;) {
      const close = command.indexOf('\'', index);
      if (close < 0) return null;
      token += command.slice(index, close);
      index = close + 1;
      if (command.startsWith('"\'"\'', index)) {
        token += '\'';
        index += 4;
        continue;
      }
      break;
    }
    tokens.push(token.replace(/##/g, '#'));
  }
  return tokens.length > 0 ? tokens : null;
}

export type PsmuxExec = (
  args: string[],
  options?: { timeout?: number; stripTmux?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export type PsmuxCommandOutcome = { outcome: 'executed' | 'not_executed' | 'unknown'; stdout: string; stderr: string };

function isPsmuxServerNotFoundError(error: unknown): boolean {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null | undefined;
  const text = [value?.stderr, value?.stdout, value?.message]
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
    .toLowerCase();
  return /no server running|failed to connect|can't connect|connection refused|server exited/.test(text);
}

/**
 * Verify the recorded server incarnation, then run the decoded argv inside
 * its private namespace. `not_executed` means nothing was sent (or psmux
 * proved the server absent); exit status alone is never proof of effect
 * beyond `executed`.
 */
export async function runPsmuxVerifiedCommand(
  identity: TmuxServerIdentity,
  nativeCommand: string,
  deps: {
    observe: (identity: TmuxServerIdentity) => Promise<'matching' | 'dead' | 'unknown'>;
    exec: PsmuxExec;
  },
): Promise<PsmuxCommandOutcome> {
  const argv = decodeTmuxCommandString(nativeCommand);
  if (!argv || !psmuxNamespaceOf(identity.socket_path)) return { outcome: 'unknown', stdout: '', stderr: '' };
  let state: 'matching' | 'dead' | 'unknown';
  try {
    state = await deps.observe(identity);
  } catch {
    state = 'unknown';
  }
  if (state !== 'matching') return { outcome: 'not_executed', stdout: '', stderr: '' };
  try {
    const result = await deps.exec(['-S', identity.socket_path, ...argv], { timeout: 5_000, stripTmux: true });
    if (result.stderr.trim()) return { outcome: 'unknown', stdout: result.stdout, stderr: result.stderr };
    return { outcome: 'executed', stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (isPsmuxServerNotFoundError(error)) {
      return { outcome: 'not_executed', stdout: '', stderr: 'tmux_server_unavailable' };
    }
    return { outcome: 'unknown', stdout: '', stderr: error instanceof Error ? error.message.slice(0, 240) : 'psmux_exec_failed' };
  }
}

/** True iff the namespace has no sessions (or psmux reports no server). */
export async function psmuxNamespaceIsEmpty(socketPath: string, exec: PsmuxExec): Promise<boolean> {
  if (!psmuxNamespaceOf(socketPath)) return false;
  try {
    const listed = await exec(['-S', socketPath, 'ls'], { timeout: 5_000, stripTmux: true });
    return listed.stdout.trim() === '';
  } catch (error) {
    return isPsmuxServerNotFoundError(error);
  }
}

/**
 * End every server of one private namespace, including psmux's
 * per-namespace warm server, and confirm the namespace is empty.
 */
export async function disposePsmuxNamespace(socketPath: string, exec: PsmuxExec): Promise<boolean> {
  if (!psmuxNamespaceOf(socketPath)) return false;
  try {
    await exec(['-S', socketPath, 'kill-server'], { timeout: 5_000, stripTmux: true });
  } catch {
    // Exit status is not evidence; the inventory below is.
  }
  if (!await psmuxNamespaceIsEmpty(socketPath, exec)) return false;
  // A session server ended by kill-window can leave its `<ns>__<session>.pid`
  // and `.sid` registry files behind. The namespace is verified empty and
  // private to this instance, so its registry entries are ours to remove.
  const ns = psmuxNamespaceOf(socketPath)!;
  try {
    for (const name of await readdir(PSMUX_REGISTRY_DIR)) {
      if (name.startsWith(`${ns}__`)) await rm(win32.join(PSMUX_REGISTRY_DIR, name), { force: true }).catch(() => undefined);
    }
  } catch {
    // Registry hygiene is best-effort; the server inventory is the proof.
  }
  return true;
}
