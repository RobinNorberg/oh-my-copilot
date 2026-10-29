/**
 * The GitHub forge (factory forges design §2, PR 2): every gh call the ship,
 * factory and heal code make, built on the caller's already-guarded Exec.
 * The call sites use the per-file gh functions directly where they need
 * their exact legacy results; this object is the Forge interface over them.
 */
import type { ForgeFactory } from '../types.js';
export declare const createGitHubForge: ForgeFactory;
//# sourceMappingURL=index.d.ts.map