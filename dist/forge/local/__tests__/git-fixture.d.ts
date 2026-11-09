import type { Exec } from '../../../ship/exec.js';
import type { ResolvedForgeConfig } from '../../types.js';
export declare function git(cwd: string, ...args: string[]): string;
export interface Call {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
}
export declare function recordingExec(): {
    exec: Exec;
    calls: Call[];
};
export interface Fixture {
    tmp: string;
    root: string;
    stateDir: string;
    /** getOmcRoot(root) for a plain checkout. */
    omgRoot: string;
    mirror: string;
    config: ResolvedForgeConfig;
    write(path: string, text: string): void;
    commit(message: string): string;
    /** Push a commit to the mirror as `branch` (the engine's job in a real run). */
    push(sha: string, branch: string): void;
    cleanup(): void;
}
export declare function makeFixture(): Fixture;
//# sourceMappingURL=git-fixture.d.ts.map