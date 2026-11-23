import type { FactoryRunOutcome } from '../engine.js';
import { type FactoryRunKey } from '../state.js';
/** The fixed steps of a run key, as argv. */
export declare function steps(key: FactoryRunKey): {
    status: string[];
    resume: string[];
    cancel: string[];
    close: string[];
    release: string[];
    flag: (f: string) => string[];
};
/**
 * The argv list of the park `out` stopped at, after checking that the state
 * file seals the same gate.next and, at the merge gate, that the merge step is
 * the outcome's merge command.
 */
export declare function sealedNext(root: string, key: FactoryRunKey, out: FactoryRunOutcome): string[][];
//# sourceMappingURL=gate-next-expect.d.ts.map