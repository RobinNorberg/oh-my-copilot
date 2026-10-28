/**
 * `omg port drive --head <sha>`: the automated upstream port (src/port/engine.ts).
 * Exit codes: 0 done (draft PR open, a human merges), 1 a phase failed,
 * 2 usage error, 3 blocked on a human decision (the note names the brief or
 * the delta, and the next command).
 */
import { Command } from 'commander';
import { type LaneBackend } from '../../factory/run/lane.js';
import { type Exec } from '../../ship/exec.js';
export interface PortCommandDeps {
    exec?: Exec;
    /** Built only for --reconcile-lane: the paid lane's backend. */
    lanes?: () => LaneBackend;
    node?: string;
}
export declare function portCommand(deps?: PortCommandDeps): Command;
//# sourceMappingURL=port.d.ts.map