/**
 * The local forge's merge (offline forge plan §1.1): the human merges the
 * exact head into the base with git; the next `run`/`poll` fast-forwards the
 * mirror's base, and the PR then reads MERGED. The engine still never merges.
 */
import type { ForgeMerge } from '../types.js';
export declare function localMerge(root: string): ForgeMerge;
//# sourceMappingURL=merge.d.ts.map