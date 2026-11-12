/**
 * `omg factory bench`: measure the factory on a fixed set of seeded issues
 * against the local forge (src/factory/bench/). `init` makes the fixture,
 * `run` drives the engine over it (--fake: scripted lanes, no cost; --live:
 * real Copilot, only with --max-requests) and scores it, `compare` diffs two
 * results files.
 */
import { Command } from 'commander';
export declare function factoryBenchCommand(): Command;
//# sourceMappingURL=factory-bench.d.ts.map