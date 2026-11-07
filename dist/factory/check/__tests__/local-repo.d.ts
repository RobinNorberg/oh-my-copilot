/**
 * A real git repository with no origin for the local (offline) forge tests of
 * setup, check, board and enqueue: the backlog is real files, git runs for
 * real, and every spawn is recorded so a test can assert no gh, az or
 * copilot ran. OMC_HOME is pointed at a temp dir, so the forge stateDir and
 * the mirror path never touch the real ~/.omg.
 */
import { type Exec } from '../../../ship/exec.js';
import type { FactoryCheckDeps } from '../cli.js';
export interface LocalRepo {
    root: string;
    home: string;
    calls: Array<{
        cmd: string;
        args: string[];
    }>;
    exec: Exec;
    out: string[];
    err: string[];
}
/** `git init -b main` with one commit; no origin. */
export declare function localRepo(): LocalRepo;
export declare function writeFile(repo: LocalRepo, path: string, text: string): void;
export declare function commitAll(repo: LocalRepo, message?: string): void;
/** The project config of a local-forge repository (what `setup --forge local` writes). */
export declare const LOCAL_PROJECT_CONFIG: {
    factory: {
        forge: {
            kind: string;
        };
        intake: {
            source: {
                type: string;
            };
        };
    };
};
export declare function backlogItem(title: string, state?: 'open' | 'closed', extra?: string): string;
export declare function checkDeps(repo: LocalRepo, project?: unknown): FactoryCheckDeps;
/** Every spawned program, by base name: the offline surfaces run git only. */
export declare function programs(repo: LocalRepo): string[];
/** Delete a working-tree file (it stays in the last commit). */
export declare function removeFile(repo: LocalRepo, path: string): void;
//# sourceMappingURL=local-repo.d.ts.map