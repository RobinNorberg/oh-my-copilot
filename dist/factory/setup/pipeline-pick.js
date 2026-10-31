/**
 * The optional heal pipeline pick of `omg factory setup` on Azure DevOps
 * (ADO parity design §3.2): which build definition heal reads as CI
 * (`factory.heal.pipeline`). Only the definitions of the forge repository are
 * offered: the `repositoryId` query is the GUID that `git.repositories.GET`
 * of the forge repository answers (the setup guard binds that route to the
 * forge repo), and a definition whose own repository is not that one is
 * dropped. `--heal-pipeline <id>|none` answers non-interactively.
 */
import { plainText } from '../check/score.js';
import { adoGet, adoList, SetupError } from './guard.js';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE = 'none (no heal on Azure DevOps)';
/** The forge repository's GUID; refuses an answer that names another repository. */
export function adoRepositoryGuid(io) {
    const repo = adoGet(io, 'git.repositories.GET', { project: io.repo.project, repositoryId: io.repo.name });
    const id = repo?.id;
    if (typeof id !== 'string' || !GUID.test(id) || typeof repo?.name !== 'string' || repo.name.toLowerCase() !== io.repo.name.toLowerCase()) {
        throw new SetupError(5, `Azure DevOps git.repositories.GET did not answer repository ${io.repo.name} with its id`);
    }
    return id.toLowerCase();
}
/** The build definitions whose repository is the forge repository (Azure Repos Git). */
export function adoRepoDefinitions(io) {
    const guid = adoRepositoryGuid(io);
    const body = adoGet(io, 'build.definitions.GET', { project: io.repo.project }, { repositoryId: guid, repositoryType: 'TfsGit', includeAllProperties: 'true' });
    return adoList(body).flatMap((d) => {
        const repo = d.repository;
        const ours = typeof repo?.id === 'string' && repo.id.toLowerCase() === guid && repo.type === 'TfsGit';
        return ours && Number.isSafeInteger(d.id) && d.id > 0
            ? [{ id: d.id, name: plainText(String(d.name ?? '')), path: plainText(String(d.path ?? '')) }]
            : [];
    });
}
/** The pick: `--heal-pipeline`, else a TTY choice, else none. Undefined = write no heal pipeline. */
export async function pickHealPipeline(io, prompter, flag) {
    if (flag === 'none' || (flag === undefined && !prompter))
        return undefined;
    if (flag !== undefined && !/^[1-9]\d{0,9}$/.test(flag))
        throw new SetupError(2, `--heal-pipeline must be a build definition id or none, got ${JSON.stringify(flag)}`);
    const definitions = adoRepoDefinitions(io);
    if (flag !== undefined) {
        const found = definitions.find((d) => d.id === Number(flag));
        if (!found)
            throw new SetupError(5, `build definition ${flag} is not a pipeline of repository ${io.repo.name} (its pipelines: ${definitions.map((d) => d.id).join(', ') || 'none'})`);
        return { definitionId: found.id };
    }
    if (definitions.length === 0)
        return undefined;
    const label = (d) => `#${d.id} ${d.name}${d.path && d.path !== '\\' ? ` (${d.path})` : ''}`;
    const answer = await prompter.select('Which pipeline is CI for omg factory heal?', [NONE, ...definitions.map(label)]);
    const picked = definitions.find((d) => label(d) === answer);
    return picked ? { definitionId: picked.id } : undefined;
}
//# sourceMappingURL=pipeline-pick.js.map