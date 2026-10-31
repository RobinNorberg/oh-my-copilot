/**
 * ForgeCi on Azure Pipelines (ADO parity design §3.3): heal's CI history is
 * the builds of the one build definition `factory.heal.pipeline` names
 * (trusted config layers only), so `workflow`, GitHub's file name, is not
 * read here. Reads only: the heal guard runs these calls with the `read`
 * policy, and the rerun is a human step that omg prints and never issues.
 */
import type { ForgeCi } from '../types.js';
import { type AdoContext } from './invoke.js';
export declare function adoCi(ctx: AdoContext, pipeline: {
    definitionId: number;
}): ForgeCi;
//# sourceMappingURL=ci.d.ts.map