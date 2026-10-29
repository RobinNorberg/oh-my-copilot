/**
 * `omg ship` configuration: defaults, the `ship` config block, and the
 * repo's known-flaky test list.
 *
 * Trust model (see loadTrustedShipConfig): the safety keys
 * (SHIP_SAFETY_KEYS) come only from the user-level config at its default
 * location, then the `.copilot/omg.jsonc` committed on a trusted base branch
 * at the sha GitHub reports (`git show <baseRefOid>:.copilot/omg.jsonc`,
 * replace refs off), then the defaults. The working-tree project file and the
 * PR head never set them: a lane can drop an untracked file into the
 * checkout, and a PR can commit one. The legacy `.copilot/omc.jsonc` name is
 * never read from the base branch.
 */
import { existsSync, readFileSync } from 'fs';
import { userInfo } from 'os';
import { basename, join, resolve } from 'path';
import { parseJsonc } from '../utils/jsonc.js';
import { getConfigPaths, loadJsoncFile } from '../config/loader.js';
import { LEGACY_PROJECT_CONFIG_FILE, resolveProjectConfigPath } from '../config/project-config-path.js';
import { TRUSTED_READ_ENV } from './exec.js';
export const DEFAULT_SHIP_CONFIG = Object.freeze({
    base: 'dev',
    // No Committed Build Artifacts (ci.yml) and the pull_request_target
    // authorization job report but never block; the Socket Security GitHub App
    // checks are external (no workflow file) and advisory too.
    advisoryChecks: [
        'No Committed Build Artifacts',
        'Authorize generated artifacts from base trust root',
        'Socket Security: Pull Request Alerts',
        'Socket Security: Project Report',
    ],
    // Every check this repo's CI reports on a PR to dev (ci.yml, pr-check.yml,
    // upgrade-test.yml); Build, npm pack and the smoke job start late (`needs:`).
    // ci.yml and upgrade-test.yml run only for PRs to main / dev
    // (`pull_request.branches`): on a PR to another base their checks never
    // report and stay pending, so such a base needs its own requiredChecks in
    // the user config.
    requiredChecks: [
        'Lint & Type Check',
        'Test',
        'Test (Windows path suite)',
        'better-sqlite3 Node 26 (ubuntu-latest)',
        'better-sqlite3 Node 26 (windows-2022)',
        'PreCompact restore (ubuntu-latest)',
        'PreCompact restore (macos-latest)',
        'PreCompact restore (windows-2022)',
        'Multi-repo Path Gate (AST-grep) (ubuntu-latest)',
        'Multi-repo Path Gate (AST-grep) (windows-2022)',
        'Version Consistency Check',
        'Build',
        'npm pack + install test',
        'Copilot smoke (tier 2)',
        'Base Branch Check',
        'Size Check',
        'Draft PR Check',
        'omg update + session-start hook',
    ],
    knownFlakyFile: '.github/known-flaky-tests.json',
    maxFixRounds: 2,
    allowAdminMerge: false,
    autoRerunFlaky: true,
    pollIntervalSeconds: 30,
    // Below the 10-minute cap of background watchers; the caller loops on exit 8.
    watchTimeoutMinutes: 9,
    trustedBases: ['dev', 'main', 'master'],
});
function isStringArray(value) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
/**
 * Syntactic branch-name check (no git): word characters, `.`, `/`, `-`, never
 * a leading `-` (it would parse as an option). Callers that spawn git also run
 * `git check-ref-format --branch`.
 */
export function isPlainBranchName(value) {
    return typeof value === 'string' && /^[\w.][\w./-]*$/.test(value) && !value.includes('..');
}
/** Repo-relative forward-slash path: plain segments, no `..`, not absolute or option-shaped. */
export function isRepoPath(value) {
    return typeof value === 'string' && /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/.test(value) && !value.split('/').includes('..');
}
function nonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
/** Merge a config block over the defaults; ill-typed fields are rejected, not ignored. */
export function resolveShipConfig(input) {
    const config = {
        ...DEFAULT_SHIP_CONFIG,
        advisoryChecks: [...DEFAULT_SHIP_CONFIG.advisoryChecks],
        requiredChecks: [...DEFAULT_SHIP_CONFIG.requiredChecks],
        trustedBases: [...DEFAULT_SHIP_CONFIG.trustedBases],
    };
    if (input === undefined || input === null)
        return config;
    if (typeof input !== 'object' || Array.isArray(input))
        throw new Error('ship config must be an object');
    const raw = input;
    const bad = (key, want) => {
        throw new Error(`ship.${key} must be ${want}`);
    };
    if (raw.base !== undefined)
        config.base = isPlainBranchName(raw.base) ? raw.base : bad('base', 'a branch name');
    if (raw.advisoryChecks !== undefined)
        config.advisoryChecks = isStringArray(raw.advisoryChecks) ? raw.advisoryChecks : bad('advisoryChecks', 'a string array');
    if (raw.requiredChecks !== undefined)
        config.requiredChecks = isStringArray(raw.requiredChecks) ? raw.requiredChecks : bad('requiredChecks', 'a string array');
    if (raw.knownFlakyFile !== undefined)
        config.knownFlakyFile = isRepoPath(raw.knownFlakyFile) ? raw.knownFlakyFile : bad('knownFlakyFile', 'a repo-relative path (read from the base branch)');
    if (raw.maxFixRounds !== undefined)
        config.maxFixRounds = Number.isInteger(raw.maxFixRounds) && nonNegative(raw.maxFixRounds) ? raw.maxFixRounds : bad('maxFixRounds', 'a non-negative integer');
    if (raw.allowAdminMerge !== undefined)
        config.allowAdminMerge = typeof raw.allowAdminMerge === 'boolean' ? raw.allowAdminMerge : bad('allowAdminMerge', 'a boolean');
    if (raw.autoRerunFlaky !== undefined)
        config.autoRerunFlaky = typeof raw.autoRerunFlaky === 'boolean' ? raw.autoRerunFlaky : bad('autoRerunFlaky', 'a boolean');
    if (raw.pollIntervalSeconds !== undefined)
        config.pollIntervalSeconds = nonNegative(raw.pollIntervalSeconds) && raw.pollIntervalSeconds > 0 ? raw.pollIntervalSeconds : bad('pollIntervalSeconds', 'a positive number');
    if (raw.watchTimeoutMinutes !== undefined)
        config.watchTimeoutMinutes = nonNegative(raw.watchTimeoutMinutes) ? raw.watchTimeoutMinutes : bad('watchTimeoutMinutes', 'a non-negative number');
    if (raw.trustedBases !== undefined) {
        config.trustedBases = Array.isArray(raw.trustedBases) && raw.trustedBases.every(isPlainBranchName) ? raw.trustedBases : bad('trustedBases', 'an array of branch names');
    }
    return config;
}
/** Parse a known-flaky list (`{ "tests": [...] }`); malformed content throws. */
export function parseKnownFlaky(content, file) {
    const parsed = JSON.parse(content);
    const tests = parsed?.tests;
    if (!Array.isArray(tests))
        throw new Error(`${file}: expected { "tests": [...] }`);
    return tests.map((entry, i) => {
        const e = entry;
        if (typeof e?.file !== 'string' || !e.file)
            throw new Error(`${file}: tests[${i}].file must be a string`);
        if (typeof e.title !== 'string' || !e.title)
            throw new Error(`${file}: tests[${i}].title must be a non-empty string`);
        return { file: e.file.replace(/\\/g, '/'), title: e.title, note: typeof e.note === 'string' ? e.note : undefined };
    });
}
/** Ship keys a lane or PR could use to merge a red PR; never read from the working tree or the PR head. */
export const SHIP_SAFETY_KEYS = ['allowAdminMerge', 'advisoryChecks', 'requiredChecks', 'knownFlakyFile'];
/** Keys only the user config (default location) sets: ignored in the base-branch and working-tree files. */
export const SHIP_USER_ONLY_KEYS = ['trustedBases'];
/** Project config path inside the repo, read from the base branch for the safety keys. */
export const BASE_CONFIG_PATH = '.copilot/omg.jsonc';
function shipBlock(config, source) {
    const ship = config?.ship;
    if (ship === undefined || ship === null)
        return {};
    if (typeof ship !== 'object' || Array.isArray(ship))
        throw new Error(`${source}: ship config must be an object`);
    return ship;
}
const FULL_SHA = /^[0-9a-f]{40}$/;
const MISSING_PATH = /does not exist in|exists on disk, but not in/;
/**
 * `git show <commit>:<path>` with replace refs off; null when the file does
 * not exist at that commit. Any other failure throws (fail closed).
 */
export function readBaseFile(exec, cwd, commit, path) {
    // git reports "path does not exist" for an unknown commit too; check the commit first.
    if (exec('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, env: TRUSTED_READ_ENV }).status !== 0) {
        throw new Error(`base commit ${commit.slice(0, 12)} is not in the local object store (fetch it first)`);
    }
    const shown = exec('git', ['show', `${commit}:${path}`], { cwd, env: TRUSTED_READ_ENV });
    if (shown.status === 0)
        return shown.stdout;
    if (MISSING_PATH.test(shown.stderr))
        return null;
    throw new Error(`git show ${commit.slice(0, 12)}:${path} failed (exit ${shown.status}): ${shown.stderr.trim()}`);
}
/**
 * An Azure DevOps repository URL (design §8.3), already trimmed and
 * lowercased: `[https://][user@]dev.azure.com/<org>/<project>/_git/<repo>`,
 * `[ssh://]git@ssh.dev.azure.com[:/]v3/<org>/<project>/<repo>`, and the
 * legacy `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`
 * and `<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>`.
 */
const ADO_URLS = [
    /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/(?<org>[^/]+)\/(?<project>[^/]+)\/_git\/(?<repo>[^/]+)$/,
    /^(?:ssh:\/\/)?[^@/:]+@ssh\.dev\.azure\.com(?::|(?::\d+)?\/)v3\/(?<org>[^/]+)\/(?<project>[^/]+)\/(?<repo>[^/]+)$/,
    /^https?:\/\/(?:[^@/]+@)?(?<org>[^./@]+)\.visualstudio\.com\/(?:defaultcollection\/)?(?<project>[^/]+)\/_git\/(?<repo>[^/]+)$/,
    /^(?:ssh:\/\/)?[^@/:]+@vs-ssh\.visualstudio\.com(?::|(?::\d+)?\/)v3\/(?<org>[^/]+)\/(?<project>[^/]+)\/(?<repo>[^/]+)$/,
];
/** `%20` and friends decoded; a malformed escape keeps the raw segment. */
const decodeSegment = (s) => {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
};
/**
 * Comparable identity of a repository URL: `ado:<org>/<project>/<repo>` for
 * an Azure DevOps URL (every form in ADO_URLS, escapes decoded),
 * `gh:<host>/<owner>/<repo>` for any other https / ssh / scp-style URL
 * (case-insensitive, `.git` and a trailing `/` dropped), `path:<url>` for
 * anything else (a local path), so a local path can never equal a hosted
 * repository.
 */
export function repoIdentity(url) {
    const s = url.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
    for (const re of ADO_URLS) {
        const g = re.exec(s)?.groups;
        if (g)
            return `ado:${[g.org, g.project, g.repo].map(decodeSegment).join('/')}`;
    }
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(s)
        ?? /^(?:[^@/:]+@)?([^/:]{2,}):([^/]+)\/([^/]+)$/.exec(s);
    return m ? `gh:${m[1]}/${m[2]}/${m[3]}` : `path:${s}`;
}
/**
 * Null when `git remote get-url <remote>` (insteadOf rewrites applied, so the
 * URL fetch really uses) names the PR's repository (`repoUrl`, from
 * `gh pr view --json url` without `/pull/<n>`); otherwise why not. Checked
 * before every fetch of the base, so a lane that points the remote at another
 * repository is refused instead of fetched from. Every push URL
 * (`git remote get-url --push --all`: each `pushurl`, else the URL, with
 * pushInsteadOf applied) must name it too, so a planted `pushurl` cannot
 * redirect a push.
 */
export function remoteRepoMismatch(exec, cwd, remote, repoUrl) {
    if (!repoUrl)
        return 'GitHub reported no repository url for the PR';
    const got = exec('git', ['remote', 'get-url', remote], { cwd, env: TRUSTED_READ_ENV });
    if (got.status !== 0)
        return `git remote get-url ${remote} failed: ${got.stderr.trim().split('\n')[0]}`;
    const url = got.stdout.trim();
    if (repoIdentity(url) !== repoIdentity(repoUrl))
        return `remote ${remote} points at ${url}, but the PR is in ${repoUrl}`;
    const push = exec('git', ['remote', 'get-url', '--push', '--all', remote], { cwd, env: TRUSTED_READ_ENV });
    if (push.status !== 0)
        return `git remote get-url --push --all ${remote} failed: ${push.stderr.trim().split('\n')[0]}`;
    const pushUrls = push.stdout.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
    if (pushUrls.length === 0)
        return `git remote get-url --push --all ${remote} printed no push URL`;
    const foreign = pushUrls.find((u) => repoIdentity(u) !== repoIdentity(repoUrl));
    return foreign ? `remote ${remote} pushes to ${foreign}, but the PR is in ${repoUrl}` : null;
}
/**
 * The repository URL of a PR URL (`https://github.com/o/r/pull/12` ->
 * `https://github.com/o/r`; Azure DevOps
 * `https://dev.azure.com/o/p/_git/r/pullrequest/12` -> `.../_git/r`, the
 * legacy `<org>.visualstudio.com` form too); undefined when it is not one.
 */
export function prRepoUrl(prUrl) {
    if (typeof prUrl !== 'string')
        return undefined;
    if (/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(prUrl))
        return prUrl.replace(/\/pull\/\d+$/, '');
    const m = /^(https:\/\/[^/\s]+(?:\/[^/\s]+)+)\/pullrequest\/\d+$/i.exec(prUrl);
    return m && repoIdentity(m[1]).startsWith('ado:') ? m[1] : undefined;
}
/**
 * The user config's default location, derived from the account's home
 * directory as the OS reports it (`os.userInfo()`: passwd / the Windows
 * profile, not HOME / USERPROFILE / APPDATA / XDG_CONFIG_HOME, which a lane
 * can set): `<home>/AppData/Roaming/claude-omc/config.jsonc` on Windows,
 * `<home>/.config/claude-omc/config.jsonc` elsewhere, the layout the normal
 * loader (getConfigPaths) uses when those variables are unset.
 */
export function trustedUserConfigPath(home = userInfo().homedir) {
    const configDir = process.platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, '.config');
    return join(configDir, 'claude-omc', 'config.jsonc');
}
function samePath(a, b) {
    const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    return norm(a) === norm(b);
}
/**
 * The user-config layers for loadTrustedShipConfig: `user` is the file the
 * normal loader reads (env-selected), `trustedUser` the file at the default
 * location (trustedUserConfigPath). When the two differ, the safety keys come
 * only from `trustedUser`. No resolvable home directory = no trusted user layer.
 */
export function userConfigLayers(envPath = getConfigPaths().user, trustedPath) {
    let defaultPath = trustedPath;
    if (defaultPath === undefined) {
        try {
            defaultPath = trustedUserConfigPath();
        }
        catch {
            defaultPath = null;
        }
    }
    const user = loadJsoncFile(envPath);
    if (defaultPath && samePath(envPath, defaultPath))
        return { user, trustedUser: user };
    return { user, trustedUser: defaultPath ? loadJsoncFile(defaultPath) : null };
}
/**
 * Resolve the ship config for a run. Precedence:
 * - safety keys (SHIP_SAFETY_KEYS): the user config at its default location,
 *   then the trusted base's committed `.copilot/omg.jsonc`, then the
 *   defaults. A safety key in the working-tree project file that differs from
 *   the base branch, or in an env-selected user config that differs from the
 *   default location's, is ignored with a warning.
 * - trustedBases (SHIP_USER_ONLY_KEYS): the user config at its default location only.
 * - other keys: defaults < base-branch file < user config < working-tree
 *   project file (the usual project-over-user order).
 * The remote must point at the PR's repository (remoteRepoMismatch), the
 * base is fetched and `refs/remotes/<remote>/<base>` must equal GitHub's
 * base sha; the files are then read at that sha with replace refs off. A base
 * outside trustedBases is never read. When the base cannot be verified the
 * base layer is empty with a warning (defaults are the strict setting), or,
 * with `strict`, the load throws.
 */
export function loadTrustedShipConfig(input) {
    const { exec, root, base } = input;
    const remote = input.remote ?? 'origin';
    const warn = input.warn ?? ((m) => console.error(m));
    if (!isPlainBranchName(base))
        throw new Error(`base ${JSON.stringify(base)} is not a branch name`);
    if (!/^[\w][\w.-]*$/.test(remote))
        throw new Error(`remote ${JSON.stringify(remote)} is not a remote name`);
    const userShip = { ...shipBlock(input.user, 'user config') };
    const trustedUserShip = input.trustedUser === undefined
        ? shipBlock(input.user, 'user config')
        : shipBlock(input.trustedUser, 'user config (default location)');
    const userOnly = new Set([...SHIP_SAFETY_KEYS, ...SHIP_USER_ONLY_KEYS]);
    for (const key of Object.keys(userShip)) {
        if (!userOnly.has(key))
            continue;
        if (JSON.stringify(userShip[key]) !== JSON.stringify(trustedUserShip[key])) {
            warn(`omg ship: ignoring ship.${key} from the user config selected by APPDATA / XDG_CONFIG_HOME; safety keys come only from ${trustedUserConfigPathOrDefault()}`);
        }
        delete userShip[key];
    }
    const trustedBases = resolveShipConfig({ trustedBases: trustedUserShip.trustedBases }).trustedBases;
    // Verify the base against GitHub before reading anything committed on it.
    const ref = `refs/remotes/${remote}/${base}`;
    const unverified = (reason) => {
        if (input.strict)
            throw new Error(`omg ship: ${reason}; refusing (fail closed)`);
        warn(`omg ship: ${reason}; the base branch's committed config is not read (defaults apply)`);
        return undefined;
    };
    let commit;
    if (!input.baseSha || !FULL_SHA.test(input.baseSha)) {
        commit = unverified(`GitHub reported no base sha for ${base}`);
    }
    else {
        const mismatch = remoteRepoMismatch(exec, root, remote, input.repoUrl);
        const fetched = mismatch ? null : exec('git', ['fetch', remote, base], { cwd: root, env: TRUSTED_READ_ENV });
        const local = fetched?.status === 0 ? exec('git', ['rev-parse', '--verify', ref], { cwd: root, env: TRUSTED_READ_ENV }) : null;
        if (mismatch)
            commit = unverified(mismatch);
        else if (!local)
            commit = unverified(`git fetch ${remote} ${base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
        else if (local.status !== 0 || local.stdout.trim() !== input.baseSha) {
            commit = unverified(`${ref} is ${local.stdout.trim() || 'missing'}, but GitHub reports ${base} at ${input.baseSha}`);
        }
        else
            commit = input.baseSha;
    }
    const trusted = trustedBases.includes(base);
    if (!trusted)
        warn(`omg ship: base ${base} is not in ship.trustedBases (${trustedBases.join(', ')}); its committed config is not read and merge never admin-merges into it`);
    let baseShip = {};
    if (trusted && commit) {
        const source = `${commit.slice(0, 12)}:${BASE_CONFIG_PATH}`;
        const text = readBaseFile(exec, root, commit, BASE_CONFIG_PATH);
        let parsed;
        try {
            parsed = text && text.trim() ? parseJsonc(text) : undefined;
        }
        catch (error) {
            throw new Error(`${base} ${source} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`);
        }
        baseShip = { ...shipBlock(parsed, `${base} ${source}`) };
    }
    let project = input.project;
    let legacyProject = false;
    if (project === undefined) {
        const path = resolveProjectConfigPath(root);
        legacyProject = basename(path) === LEGACY_PROJECT_CONFIG_FILE;
        project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
    }
    const projectShip = { ...shipBlock(project, 'project config') };
    const ignored = [];
    for (const key of SHIP_USER_ONLY_KEYS) {
        for (const [layer, source] of [[baseShip, `${base}:${BASE_CONFIG_PATH}`], [projectShip, 'the working-tree project config']]) {
            if (layer[key] === undefined)
                continue;
            warn(`omg ship: ignoring ship.${key} from ${source}; it is read only from the user config`);
            delete layer[key];
        }
    }
    for (const key of Object.keys(projectShip)) {
        if (!userOnly.has(key))
            continue;
        if (JSON.stringify(projectShip[key]) !== JSON.stringify(baseShip[key]))
            ignored.push(key);
        delete projectShip[key];
    }
    if (ignored.length > 0 && legacyProject) {
        // One line, not one per key: the legacy name is simply not a trusted source.
        warn(`omg ship: .copilot/${LEGACY_PROJECT_CONFIG_FILE} (legacy name) is not read from the base branch; its ship safety keys (${ignored.join(', ')}) are ignored. Rename it to ${BASE_CONFIG_PATH} and commit it to ${base}.`);
    }
    else {
        for (const key of ignored) {
            warn(`omg ship: ignoring ship.${key} from the working-tree project config; safety keys come only from the user config or ${base}:${BASE_CONFIG_PATH}`);
        }
    }
    const merged = { ...baseShip, ...userShip, ...projectShip };
    for (const key of SHIP_SAFETY_KEYS) {
        const value = trustedUserShip[key] !== undefined ? trustedUserShip[key] : baseShip[key];
        if (value === undefined)
            delete merged[key];
        else
            merged[key] = value;
    }
    merged.trustedBases = trustedBases;
    return { ...resolveShipConfig(merged), trustedBaseCommit: trusted ? commit : undefined };
}
function trustedUserConfigPathOrDefault() {
    try {
        return trustedUserConfigPath();
    }
    catch {
        return 'the default user config location';
    }
}
/**
 * Merge-rule paths beyond PROTECTED_PATHS for a guard outside a ship run
 * (copilot_run): a non-default ship.knownFlakyFile from the user config at its
 * default location and from the working-tree project config under `root`.
 * Protection only widens here, so the untrusted project file may add a path
 * but never drop one; the base branch is not read (no fetch). An unreadable
 * layer adds nothing.
 */
export function configuredProtectedPaths(root) {
    const paths = new Set();
    const layers = [
        [() => userConfigLayers().trustedUser, 'user config (default location)'],
        [() => {
                const path = resolveProjectConfigPath(root);
                return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
            }, 'project config'],
    ];
    for (const [read, source] of layers) {
        try {
            const file = shipBlock(read(), source).knownFlakyFile;
            if (isRepoPath(file) && file !== DEFAULT_SHIP_CONFIG.knownFlakyFile)
                paths.add(file);
        }
        catch { /* unreadable: the defaults still apply */ }
    }
    return [...paths];
}
/**
 * The known-flaky list committed at the verified base commit (never the PR
 * head; LoadedShipConfig.trustedBaseCommit). No commit or no file = empty.
 */
export function loadBaseKnownFlaky(exec, root, commit, file) {
    if (commit === undefined)
        return [];
    if (!FULL_SHA.test(commit))
        throw new Error(`base commit ${JSON.stringify(commit)} is not a full sha`);
    if (!isRepoPath(file))
        throw new Error(`knownFlakyFile ${JSON.stringify(file)} is not a repo-relative path`);
    const text = readBaseFile(exec, root, commit, file);
    return text && text.trim() ? parseKnownFlaky(text, `${commit.slice(0, 12)}:${file}`) : [];
}
//# sourceMappingURL=config.js.map