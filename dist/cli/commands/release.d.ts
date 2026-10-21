/**
 * `omg release <version>`: the maintainer-only release pipeline as ordered,
 * resumable phases (src/release/engine.ts). `--dry-run` prints the plan and
 * runs nothing; without `--from` a run resumes at the first phase not yet ok.
 *
 * Exit codes: 0 ok, 1 a phase failed or is blocked, 2 usage error.
 */
import { Command } from 'commander';
import { type ReleaseDeps, type ReleaseExec } from '../../release/engine.js';
export interface ReleaseCommandDeps extends Partial<ReleaseDeps> {
    exec?: ReleaseExec;
}
export declare function releaseCommand(overrides?: ReleaseCommandDeps): Command;
//# sourceMappingURL=release.d.ts.map