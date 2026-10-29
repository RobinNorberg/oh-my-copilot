/**
 * The Azure DevOps Forge adapter (factory forges design §6, PR 5). Every
 * call is `az devops invoke` through the caller's guarded Exec (see
 * guard.ts for what the guard allows); the adapter never spawns.
 * Capabilities: no heal, no Projects v2, board columns, no webhook intake
 * (design §10.9).
 */
import { realpathSync, statSync } from 'fs';
import { resolveAzEntry } from './az-binary.js';
import { adoChecks } from './checks.js';
import { adoMerge } from './merge.js';
import { ADO_RECORD_ENV, recordingAdoExec } from './record.js';
import { adoReviews } from './reviews.js';
import { adoTracker } from './tracker.js';
/** Production az-binary deps: the real PATH, fs and realpathSync.native. */
export function defaultAzBinaryDeps(untrustedRoots, env = process.env) {
    return {
        platform: process.platform,
        env,
        isFile: (p) => {
            try {
                return statSync(p).isFile();
            }
            catch {
                return false;
            }
        },
        realpath: (p) => realpathSync.native(p),
        untrustedRoots,
    };
}
/** What the ADO guard needs for a run: the forge repo and the az entry the adapter spawns. */
export function adoGuardContext(config, entry) {
    if (config.kind !== 'azure-devops' || !config.repo.project)
        throw new Error('the Azure DevOps guard needs an azure-devops forge config');
    return { repo: config.repo, entry };
}
export function createAzureDevOpsForge(exec, cwd, config, options = {}) {
    if (config.kind !== 'azure-devops' || !config.azureDevOps || !config.repo.project)
        throw new Error('createAzureDevOpsForge needs a resolved azure-devops forge config');
    const env = options.env ?? process.env;
    const entry = options.entry ?? resolveAzEntry(defaultAzBinaryDeps([cwd, ...(options.untrustedRoots ?? [])], env));
    const recordDir = env[ADO_RECORD_ENV]?.trim();
    const ctx = {
        exec: recordDir ? recordingAdoExec(exec, recordDir) : exec,
        cwd,
        entry,
        repo: config.repo,
        config: config.azureDevOps,
        intakeItemTypes: config.intake.itemTypes,
    };
    return {
        kind: 'azure-devops',
        provider: 'azure-devops',
        repo: config.repo,
        tracker: adoTracker(ctx, config.intake.source),
        reviews: adoReviews(ctx),
        checks: adoChecks(ctx),
        merge: adoMerge(ctx),
        capabilities: { heal: false, projectsV2: false, boardColumns: true, webhookIntake: false },
    };
}
//# sourceMappingURL=index.js.map