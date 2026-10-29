/**
 * The fixture world the ADO adapter tests share: org contoso, project Web,
 * repository web-app, PR 17 at head 1111…, work item 42. The adapter runs
 * through the real factory guard (src/factory/run/exec.ts) over the fixture
 * Exec, so every call a test makes was also allowed by the guard, and each
 * write's body is the guard's validated copy.
 */
import type { ForgeRepo, IntakeSource, ResolvedForgeConfig } from '../../types.js';
import { type AzEntry } from '../az-binary.js';
import type { AdoGuardContext } from '../guard.js';
import { type AdoFixture } from './fixtures.js';
export declare const HEAD = "1111111111111111111111111111111111111111";
export declare const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export declare const MERGE_COMMIT = "3333333333333333333333333333333333333333";
export declare const POSIX_ENTRY: AzEntry;
export declare const WINDOWS_ENTRY: AzEntry;
export declare const REPO: ForgeRepo;
export declare function adoConfig(source?: IntakeSource): ResolvedForgeConfig;
/** The fixtures with `name`'s stdout replaced (a scenario variant, synthetic by construction). */
export declare function variant(fixtures: readonly AdoFixture[], name: string, edit: (stdout: any) => unknown): AdoFixture[];
export interface Call {
    cmd: string;
    args: string[];
    /** The --in-file JSON az received (the guard's copy), if any. */
    body?: unknown;
    inFile?: string;
}
/** A forge over the fixtures, behind the factory guard; `calls` records what reached the fixture Exec. */
export declare function adoWorld(o?: {
    fixtures?: readonly AdoFixture[];
    entry?: AzEntry;
    source?: IntakeSource;
}): {
    forge: import("../../types.js").Forge;
    calls: Call[];
    guard: AdoGuardContext;
    routes: () => string[];
};
//# sourceMappingURL=world.d.ts.map