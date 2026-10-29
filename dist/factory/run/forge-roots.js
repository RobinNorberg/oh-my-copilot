/**
 * The ForgeOptions the factory hands createForge (critic amendments §A.13):
 * every root a lane or job can write, so the Azure CLI entry is never
 * resolved from one, and an engine-owned state directory outside them for
 * files a human later reads (the ADO merge body).
 *
 * - the repository checkout;
 * - its omg root (`.omg`, or OMC_STATE_DIR's project dir): the lane
 *   worktrees under `team/<team>/worktrees/` (factory-run, copilot-run) and
 *   the copilot_run job dirs under `state/copilot-run/`;
 * - the team job root (OMC_JOBS_DIR, else the global `team-jobs`).
 *
 * Also the factory's forge config load (factory forges design §3) and the
 * origin's forge kind for the GitHub-only commands.
 */
import { join, resolve } from 'path';
import { detectForgeRepo, resolveForgeConfig } from '../../forge/config.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { BASE_CONFIG_PATH, readBaseFile, resolveTrustedBases } from '../../ship/config.js';
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { getGlobalOmcStatePath } from '../../utils/paths.js';
export function factoryForgeOptions(repoRoot, env = process.env) {
    const omcRoot = getOmcRoot(repoRoot);
    return {
        untrustedRoots: [
            resolve(repoRoot),
            omcRoot,
            join(omcRoot, 'team'),
            join(omcRoot, 'state', 'copilot-run'),
            env.OMC_JOBS_DIR || getGlobalOmcStatePath('team-jobs'),
        ],
        stateDir: getGlobalOmcStatePath('forge'),
    };
}
const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
/**
 * Throws unless `options` names every root factoryForgeOptions lists for
 * `repoRoot` (critic amendments §A.14): `{ untrustedRoots: [] }` or any
 * partial list is refused, so no caller can resolve az from, or write the
 * merge body under, a root a lane writes.
 */
export function assertFactoryForgeOptions(repoRoot, options, env = process.env) {
    const given = new Set(options.untrustedRoots.map(norm));
    const missing = factoryForgeOptions(repoRoot, env).untrustedRoots.filter((r) => !given.has(norm(r)));
    if (missing.length > 0)
        throw new Error(`the forge options must list every untrusted root (factoryForgeOptions); missing: ${missing.join(', ')}`);
}
/** `git remote get-url origin`, or null. */
function originUrl(exec, root) {
    const got = exec('git', ['remote', 'get-url', 'origin'], { cwd: root, env: TRUSTED_READ_ENV });
    return got.status === 0 && got.stdout.trim() ? got.stdout.trim() : null;
}
/**
 * The forge config of a factory run: the user config at its default
 * location, `.copilot/omg.jsonc` committed on `origin/<base>` after a fetch
 * (absent: that layer is empty), the working-tree project config, and the
 * origin remote, through resolveForgeConfig's trust layering. The fetch
 * overwrites the tracking ref with the remote's, so a ref a lane moved
 * between runs is not read. Identity keys can only pin the origin's forge;
 * progress keys only narrow what the az guard lets the engine write.
 * `base` comes from the working tree, so a base outside ship.trustedBases
 * (resolveTrustedBases, as ship reads it) is neither fetched nor read: that
 * layer is empty, with a warning.
 */
export function loadFactoryForgeConfig(exec, root, base, trustedUser, project) {
    const url = originUrl(exec, root);
    if (!url)
        throw new Error('omg factory run needs an origin remote');
    const trustedBases = resolveTrustedBases(trustedUser);
    if (!trustedBases.includes(base)) {
        const loaded = resolveForgeConfig(trustedUser, undefined, project, url);
        const warning = `omg factory: base ${base} is not in ship.trustedBases (${trustedBases.join(', ')}); its committed ${BASE_CONFIG_PATH} is not read`;
        return { ...loaded, warnings: [warning, ...loaded.warnings] };
    }
    const fetched = exec('git', ['fetch', 'origin', base], { cwd: root, env: TRUSTED_READ_ENV });
    if (fetched.status !== 0)
        throw new Error(`git fetch origin ${base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
    const sha = exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${base}`], { cwd: root, env: TRUSTED_READ_ENV }).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`origin/${base} did not resolve to a commit`);
    const text = readBaseFile(exec, root, sha, BASE_CONFIG_PATH);
    const baseLayer = text && text.trim() ? parseJsonc(text) : undefined;
    return resolveForgeConfig(trustedUser, baseLayer, project, url);
}
/**
 * The forge kind the origin remote names; github when there is no origin or
 * it cannot be parsed (today's behaviour). For the GitHub-only commands
 * (`omg factory listen`, `omg factory heal`), which refuse Azure DevOps.
 */
export function originForgeKind(exec, root) {
    const url = originUrl(exec, root);
    if (!url)
        return 'github';
    try {
        return detectForgeRepo(url).kind;
    }
    catch {
        return 'github';
    }
}
//# sourceMappingURL=forge-roots.js.map