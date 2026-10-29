/**
 * Step 2 of `omg factory setup` (factory forges design §4): the forge CLI is
 * logged in and can read the repository. Every call runs through the setup
 * guard. Nothing an auth command prints on stdout is kept or shown (gh and az
 * can print account data); a failure reports the exit code, the redacted
 * first stderr line and the command that fixes it.
 */
import { adoGet, runAz, safeStderr, SetupError } from './guard.js';
function report(checks, fix) {
    const ok = checks.every((c) => c.ok);
    return ok ? { ok, checks } : { ok, checks, ...(fix ? { fix } : {}) };
}
export function checkGitHubAuth(io) {
    const host = io.repo.host;
    const r = io.exec('gh', ['auth', 'status', '--hostname', host], { cwd: io.cwd });
    const check = r.status === 0
        ? { name: 'gh auth status', ok: true, detail: `logged in to ${host}` }
        : { name: 'gh auth status', ok: false, detail: `not logged in to ${host} (exit ${r.status})` };
    return report([check], `gh auth login --hostname ${host}`);
}
export function checkAdoAuth(io, env) {
    const checks = [];
    const ext = runAz(io, ['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
    if (ext.status !== 0) {
        checks.push({ name: 'az extension azure-devops', ok: false, detail: 'the azure-devops extension is not installed' });
        return report(checks, 'az extension add --name azure-devops');
    }
    checks.push({ name: 'az extension azure-devops', ok: true, detail: 'installed' });
    const pat = Object.entries(env).some(([k, v]) => k.toUpperCase() === 'AZURE_DEVOPS_EXT_PAT' && typeof v === 'string' && v.trim() !== '');
    if (pat)
        checks.push({ name: 'az login', ok: true, detail: 'AZURE_DEVOPS_EXT_PAT is set' });
    else {
        const account = runAz(io, ['account', 'show', '--output', 'json']);
        if (account.status !== 0) {
            checks.push({ name: 'az login', ok: false, detail: `no az login and no AZURE_DEVOPS_EXT_PAT (exit ${account.status})` });
            return report(checks, 'az login');
        }
        checks.push({ name: 'az login', ok: true, detail: 'az account show answers' });
    }
    const project = io.repo.project;
    const probes = [
        ['project', 'core.projects.GET', { projectId: project }],
        ['repository', 'git.repositories.GET', { project, repositoryId: io.repo.name }],
    ];
    for (const [name, route, params] of probes) {
        try {
            adoGet(io, route, params, {}, 3);
            checks.push({ name: `read ${name}`, ok: true, detail: name === 'project' ? project : io.repo.name });
        }
        catch (error) {
            checks.push({ name: `read ${name}`, ok: false, detail: error instanceof SetupError ? error.message : safeStderr(String(error)) });
            return report(checks, `az devops login --organization https://dev.azure.com/${io.repo.owner}`);
        }
    }
    return report(checks);
}
//# sourceMappingURL=auth.js.map