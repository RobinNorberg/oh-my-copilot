/**
 * The optional heal pipeline pick of `omg factory setup` on Azure DevOps
 * (ADO parity design §3.2): which build definition heal reads as CI
 * (`factory.heal.pipeline`). Only the definitions of the forge repository are
 * offered: the `repositoryId` query is the GUID that `git.repositories.GET`
 * of the forge repository answers (the setup guard binds that route to the
 * forge repo), and a definition whose own repository is not that one is
 * dropped. `--heal-pipeline <id>|none` answers non-interactively.
 */
import { type SetupIo } from './guard.js';
import type { Prompter } from './intake-pick.js';
export interface PipelineDefinition {
    id: number;
    name: string;
    path: string;
}
/** The forge repository's GUID; refuses an answer that names another repository. */
export declare function adoRepositoryGuid(io: SetupIo): string;
/** The build definitions whose repository is the forge repository (Azure Repos Git). */
export declare function adoRepoDefinitions(io: SetupIo): PipelineDefinition[];
/** The pick: `--heal-pipeline`, else a TTY choice, else none. Undefined = write no heal pipeline. */
export declare function pickHealPipeline(io: SetupIo, prompter: Prompter | undefined, flag: string | undefined): Promise<{
    definitionId: number;
} | undefined>;
//# sourceMappingURL=pipeline-pick.d.ts.map