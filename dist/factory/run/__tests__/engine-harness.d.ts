import { type ShipState } from '../../../ship/state.js';
import { type FactoryRunLimits } from '../budget.js';
import { type FactoryEngineOptions } from '../engine.js';
import { EngineLedger } from '../ledger.js';
import { type FactoryRunState } from '../state.js';
import { FakeLanes, FakeProcesses, type Harness, type LaneScript } from './fake-lanes.js';
export declare let h: Harness;
export declare let procs: FakeProcesses;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function useEngineHarness(): void;
export declare const limits: (over?: Partial<FactoryRunLimits>) => FactoryRunLimits;
export declare function opts(lanes: FakeLanes, over?: Partial<FactoryEngineOptions>): FactoryEngineOptions;
export declare const ledger: () => EngineLedger;
/** The Copilot child the crashed lane recorded (crashDuringLane). */
export declare const DEAD_CHILD: {
    pid: number;
    identity: string;
};
/**
 * The engine crashed while an implement lane (job cr-dead) ran; it had
 * recorded the lane's baseline first and, by default, the lane's child.
 */
export declare function crashDuringLane(withBaseline?: boolean, child?: {
    pid: number;
    identity: string | null;
} | null): void;
/** A state write the engine made (a crash simulated in the state): recorded in the engine ledger like the engine's own. */
export declare function asEngine(mutate: (s: FactoryRunState) => FactoryRunState): void;
/** A ship write the engine made. */
export declare function shipAsEngine(mutate: (s: ShipState) => ShipState): void;
export declare const run: (scripts: LaneScript[], over?: Partial<FactoryEngineOptions>, polls?: number[]) => {
    lanes: FakeLanes;
    done: Promise<import("../engine.js").FactoryRunOutcome>;
};
//# sourceMappingURL=engine-harness.d.ts.map