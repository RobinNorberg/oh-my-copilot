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
import type { TmuxServerIdentity } from './types.js';
export declare const PSMUX_NS_DIR: string;
/** True when the resolved `tmux` binary is psmux (cached per process). */
export declare function isPsmux(): boolean;
/** Test hook: force detection (`true`/`false`) or reset it (`undefined`). */
export declare function __setPsmuxDetectionForTests(value: boolean | undefined): void;
/** Synthetic socket path naming a fresh private psmux namespace. */
export declare function buildPsmuxNamespacePath(): string;
/** The namespace named by a synthetic socket path, or null for any other path. */
export declare function psmuxNamespaceOf(socketPath: string): string | null;
/**
 * Translate a `-S <socket>` tmux argv for psmux. Non-`-S` argv is returned
 * unchanged. Any `-S` path other than a synthetic namespace path throws:
 * falling back to the default namespace would let colliding pane ids resolve
 * in another server.
 */
export declare function translatePsmuxArgs(args: readonly string[]): {
    args: string[];
    restore: (stdout: string) => string;
};
/**
 * Strict inverse of tmux-session's `tmuxCommandString`: single-quoted tokens
 * (with `'"'"'` escapes and `##` for `#`) separated by single spaces, or one
 * bare word. Returns null for anything else.
 */
export declare function decodeTmuxCommandString(command: string): string[] | null;
export type PsmuxExec = (args: string[], options?: {
    timeout?: number;
    stripTmux?: boolean;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type PsmuxCommandOutcome = {
    outcome: 'executed' | 'not_executed' | 'unknown';
    stdout: string;
    stderr: string;
};
/**
 * Verify the recorded server incarnation, then run the decoded argv inside
 * its private namespace. `not_executed` means nothing was sent (or psmux
 * proved the server absent); exit status alone is never proof of effect
 * beyond `executed`.
 */
export declare function runPsmuxVerifiedCommand(identity: TmuxServerIdentity, nativeCommand: string, deps: {
    observe: (identity: TmuxServerIdentity) => Promise<'matching' | 'dead' | 'unknown'>;
    exec: PsmuxExec;
}): Promise<PsmuxCommandOutcome>;
/** True iff the namespace has no sessions (or psmux reports no server). */
export declare function psmuxNamespaceIsEmpty(socketPath: string, exec: PsmuxExec): Promise<boolean>;
/**
 * End every server of one private namespace, including psmux's
 * per-namespace warm server, and confirm the namespace is empty.
 */
export declare function disposePsmuxNamespace(socketPath: string, exec: PsmuxExec): Promise<boolean>;
//# sourceMappingURL=psmux-adapter.d.ts.map