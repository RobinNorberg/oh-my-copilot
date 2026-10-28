/**
 * The `omg port drive` command guard. Upstream text reaches the reconcile
 * lane, the lane shares the common git dir, so every host git command the
 * engine runs is (1) one of the shapes the engine builds and (2) hardened:
 *
 * - `core.hooksPath` = an engine-owned empty directory, `core.fsmonitor=false`
 *   (factory hardenedGitExec);
 * - `--no-pager`, and `--no-ext-diff --no-textconv` on diff/show/log;
 * - every filter driver the config defines is blanked (`clean`, `smudge`,
 *   `process` empty, `required=false`), so a checkout, add or status never
 *   runs a filter command (git-lfs included).
 *
 * Pushes are only `git push <remote> HEAD:refs/heads/port/upstream-<sha9>`,
 * plain; no reset, stash, clean, worktree, rebase or merge shape exists here.
 * The tamper check (review-guard.ts snapshotRepo / compareSnapshots) is the
 * other half: it parks the run when the lane changed config, hooks or refs.
 */
import { ShipSafetyError, type Exec } from '../ship/exec.js';
export declare const PORT_BRANCH: RegExp;
export declare class PortSafetyError extends ShipSafetyError {
    constructor(message: string);
}
/** `-c` pairs that blank every filter driver the effective config defines. */
export declare function filterNeutralizers(exec: Exec, cwd: string | undefined): string[];
/**
 * Wrap an Exec: refuse shapes the port engine never builds, then run git
 * hardened. `node` (repo scripts) passes through; `gh` is only the draft PR.
 */
export declare function portGuardExec(exec: Exec, hooksDir: string): Exec;
/** Env for repo scripts whose own git must not run hooks or fsmonitor (the drift script, the inventory generator). */
export declare function hardenedScriptEnv(hooksDir: string): Record<string, string>;
//# sourceMappingURL=guard.d.ts.map