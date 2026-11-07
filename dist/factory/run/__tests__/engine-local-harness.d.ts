import type { ResolvedForgeConfig } from '../../../forge/types.js';
import { type Exec } from '../../../ship/exec.js';
import type { FactoryEngineOptions } from '../engine.js';
import type { LocalGateRunner } from '../local-gate.js';
import type { GateConfigLoader } from '../prepare.js';
import { FakeLanes, type LaneScript } from './fake-lanes.js';
export declare const LOCAL_ISSUE = 7;
export declare const BASE = "main";
export declare const BACKLOG_ITEM = "---\ntitle: Add greet()\nlabels: [factory]\n---\nAdd a greet function.\n\n## Acceptance\n- [ ] greet() returns hi\n";
export interface LocalWorld {
    dir: string;
    root: string;
    stateDir: string;
    ledgerDir: string;
    config: ResolvedForgeConfig;
    /** Every command at the exec seam, `-c k=v` pairs included. */
    raw: Array<{
        cmd: string;
        args: string[];
    }>;
    /** Commands without the leading `-c k=v` pairs (`git push omg-local ...`). */
    calls: string[];
    exec: Exec;
    /** The gate runs: argv, cwd and the HEAD of that cwd when it ran. */
    gateRuns: Array<{
        argv: readonly string[];
        cwd: string;
        head: string;
    }>;
    /** Exit status per gate run, in order (the last repeats); default 0. */
    gateStatus: number[];
    gate: LocalGateRunner;
}
/** A repository on `main` with the backlog item #7 committed, and no remote. */
export declare function localWorld(gate?: string[] | null): LocalWorld;
/** Ship's gate config without a fetch; the engine replaces requiredChecks with local-gate on the local forge. */
export declare const localTestGateConfig: GateConfigLoader;
export declare function localOpts(w: LocalWorld, lanes: FakeLanes, over?: Partial<FactoryEngineOptions>): FactoryEngineOptions;
export declare const lanesFor: (w: LocalWorld, scripts: LaneScript[]) => FakeLanes;
/** No gh, az or copilot process reached the exec seam. */
export declare const foreignCommands: (w: LocalWorld) => string[];
//# sourceMappingURL=engine-local-harness.d.ts.map