/**
 * Opt-in auto-merge by trust tier (night-4 goal 4). Merge stays a human step
 * by default (merge-policy.ts); a repository whose USER config turns on
 * `factory.merge.auto` lets the engine (trusted) merge a low-risk PR itself.
 *
 * Config, user config at its default location only (userConfigLayers
 * `trustedUser`), keyed by repository: the run's repository URL (GitHub; same
 * repoIdentity) or, on the local forge, the repository root path.
 *
 *   "factory": { "merge": { "auto": {
 *     "https://github.com/o/r": { "enabled": true, "tiers": ["docs", "tests"] },
 *     "C:/Code/my-repo": { "enabled": true, "tiers": ["small"], "maxChangedLines": 40, "maxFiles": 3 }
 *   } } }
 *
 * A committed `factory.merge` (the base's `.copilot/omg.jsonc`) is ignored with
 * a notice: lanes can write committed config, so it must never widen trust.
 *
 * Everything here is pure (no git, no spawn): the engine reads the diff, the
 * labels and the human review and hands them in; autoMergeVerdict says
 * whether every condition holds and lists each condition's evidence.
 */
import { normalize, resolve } from 'path';
import { repoIdentity, sameRepo } from '../../ship/config.js';
import { PROTECTED_PATHS, protectedChanges } from '../../ship/merge.js';
import { CI_TREE_PATHS, LANE_PROTECTED_PATHS } from './lane-commit.js';
export const AUTO_MERGE_TIERS = ['docs', 'tests', 'small'];
/** A label on the issue or PR that keeps the merge human. */
export const MANUAL_MERGE_LABEL = 'factory:manual-merge';
export const DEFAULT_SMALL_MAX_CHANGED_LINES = 80;
export const DEFAULT_SMALL_MAX_FILES = 10;
const MAX_CAP = 100_000;
const GLOB_KEYS = ['docsDenied', 'securityCritical'];
const MAX_GLOBS = 200;
/**
 * The repository's `factory.merge.auto` entry from the trusted user config.
 * `config` undefined = off (no entry, or `enabled` false); `error` = a
 * malformed value (auto-merge stays off and the engine says why).
 */
export function resolveAutoMergeConfig(user, repo) {
    const auto = user?.factory?.merge?.auto;
    if (auto === undefined || auto === null)
        return {};
    if (typeof auto !== 'object' || Array.isArray(auto))
        return { error: 'factory.merge.auto must be an object keyed by repository' };
    const samePath = (a, b) => {
        const norm = (p) => normalize(resolve(p)).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
    };
    const matches = Object.keys(auto).filter((key) => {
        if (repo.local)
            return /^(?:[A-Za-z]:[\\/]|\/)/.test(key) && samePath(key, repo.root);
        return repo.url !== undefined && !repoIdentity(key).startsWith('path:') && sameRepo(key, repo.url);
    });
    if (matches.length === 0)
        return {};
    if (matches.length > 1)
        return { error: `factory.merge.auto has ${matches.length} entries for this repository (${matches.join(', ')}); keep one` };
    const key = matches[0];
    const v = auto[key];
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return { key, error: `factory.merge.auto["${key}"] must be an object` };
    const o = v;
    const unknownKeys = Object.keys(o).filter((k) => !['enabled', 'tiers', 'maxChangedLines', 'maxFiles', ...GLOB_KEYS].includes(k));
    if (unknownKeys.length > 0)
        return { key, error: `factory.merge.auto["${key}"] has unknown keys: ${unknownKeys.join(', ')}` };
    if (typeof o.enabled !== 'boolean')
        return { key, error: `factory.merge.auto["${key}"].enabled must be a boolean` };
    if (!Array.isArray(o.tiers) || o.tiers.length === 0 || !o.tiers.every((t) => AUTO_MERGE_TIERS.includes(t))) {
        return { key, error: `factory.merge.auto["${key}"].tiers must be a non-empty list of ${AUTO_MERGE_TIERS.map((t) => `"${t}"`).join(', ')}` };
    }
    const cap = (name) => {
        const n = o[name];
        if (n === undefined)
            return undefined;
        return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CAP ? n : `factory.merge.auto["${key}"].${name} must be an integer from 1 to ${MAX_CAP}`;
    };
    const lines = cap('maxChangedLines');
    const files = cap('maxFiles');
    if (typeof lines === 'string')
        return { key, error: lines };
    if (typeof files === 'string')
        return { key, error: files };
    const globs = {};
    for (const name of GLOB_KEYS) {
        const g = o[name];
        if (g === undefined)
            continue;
        if (!Array.isArray(g) || g.length > MAX_GLOBS || !g.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 500 && !/[\0\r\n]/.test(x))) {
            return { key, error: `factory.merge.auto["${key}"].${name} must be a list of at most ${MAX_GLOBS} path globs` };
        }
        globs[name] = [...g];
    }
    if (!o.enabled)
        return { key };
    return {
        key,
        config: {
            enabled: true,
            tiers: [...new Set(o.tiers)],
            ...(lines !== undefined ? { maxChangedLines: lines } : {}),
            ...(files !== undefined ? { maxFiles: files } : {}),
            ...globs,
        },
    };
}
/** A committed config (the base's `.copilot/omg.jsonc`) that sets `factory.merge`: the engine ignores it and says so. */
export function committedMergeConfig(base) {
    const merge = base?.factory?.merge;
    return merge !== undefined;
}
/**
 * `git diff --raw -z --no-renames --no-abbrev` and `git diff --numstat -z
 * --no-renames` of the same range, joined by path; null when either is
 * malformed or they disagree (the caller fails closed).
 */
export function parseChangedEntries(rawZ, numstatZ) {
    const raw = rawZ.split('\0');
    const modes = new Map();
    for (let i = 0; i < raw.length; i++) {
        const head = raw[i];
        if (head === '')
            continue;
        const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([ADMT])$/.exec(head);
        const path = raw[i + 1];
        if (!m || path === undefined || path === '' || modes.has(path))
            return null;
        modes.set(path, { status: m[3], oldMode: m[1], newMode: m[2] });
        i++;
    }
    const out = [];
    for (const rec of numstatZ.split('\0')) {
        if (rec === '')
            continue;
        const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
        if (!m)
            return null;
        const mode = modes.get(m[3]);
        if (!mode || out.some((e) => e.path === m[3]))
            return null;
        out.push({ path: m[3], ...mode, added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
    }
    // A mode-only change has a raw line and a 0/0 numstat line; any raw path missing from numstat is a disagreement.
    return out.length === modes.size ? out : null;
}
const fold = (s) => s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toUpperCase().toLowerCase().normalize('NFKC');
/** The path's folded segments (trailing dots and spaces dropped, `.` segments dropped), as Windows would open them. */
const segments = (path) => fold(path.replace(/\\/g, '/').trim()).split('/').map((s) => s.replace(/[. ]+$/, '')).filter((s) => s.length > 0);
/**
 * Directories whose files steer agents, editors, hooks, CI or the factory:
 * a path with any such segment, anywhere, never auto-merges. The prompt
 * directories (skills, agents, commands, templates, prompts, instructions)
 * and the agent dot-directories hold text that agent sessions run as
 * instructions, so they are code even when they are Markdown.
 */
const DENIED_DIRS = new Set([
    '.github', '.copilot', '.omg', '.omc', '.claude', '.vscode', '.husky', '.devcontainer', '.circleci', '.buildkite', '.woodpecker',
    '.azure-pipelines', '.azuredevops', '.pipelines', '.gitlab', '.idea', '.cargo', '.yarn', 'node_modules',
    'skills', 'agents', 'commands', 'templates', 'prompts', 'instructions',
    '.cursor', '.gemini', '.codex', '.agents', '.windsurf', '.roo', '.continue', '.kiro', '.clinerules', '.aider', '.vitepress', '.docusaurus',
    '.githooks', 'githooks', '__mocks__',
]);
/** Root-anchored directories that usually hold git hooks (core.hooksPath); the configured core.hooksPath is added by the engine. */
const HOOK_DIRS = ['hooks/', 'scripts/hooks/', 'tools/hooks/', 'git-hooks/', '.config/'];
/** File names (folded) that are package manifests, lockfiles, tool or agent config: denied in every directory. */
const DENIED_NAMES = new Set([
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb',
    '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.nvmrc', '.node-version', '.tool-versions',
    'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock', 'uv.lock',
    'setup.py', 'setup.cfg', 'tox.ini', 'noxfile.py', 'conftest.py', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml',
    'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat',
    'directory.packages.props', 'directory.build.props', 'directory.build.targets', 'nuget.config', 'packages.lock.json', 'global.json',
    'jsconfig.json', '.babelrc', '.editorconfig', '.gitattributes', '.gitmodules', '.gitignore', '.mailmap',
    'dockerfile', 'compose.yaml', 'compose.yml', 'makefile', 'justfile', 'taskfile.yml', 'codeowners', 'cmakelists.txt', 'constraints.txt',
    'agents.md', 'agent.md', 'claude.md', 'gemini.md', 'copilot-instructions.md', 'skill.md', 'omg.jsonc', 'omc.jsonc', 'config.jsonc', '.mcp.json',
    '.cursorrules', '.windsurfrules', '.clinerules', '.roorules', '.goosehints', '.aider.conf.yml',
    'renovate.json', 'dependabot.yml', 'lefthook.yml', '.pre-commit-config.yaml', 'jenkinsfile',
    '.gitlab-ci.yml', '.travis.yml', 'appveyor.yml', '.appveyor.yml', '.drone.yml', 'bitbucket-pipelines.yml', '.woodpecker.yml',
    'azure-pipelines.yml', 'azure-pipelines.yaml',
]);
/** File-name patterns (folded) of the same kinds: requirements files, project files, tool configs, env files, agent prompt files. */
const DENIED_NAME_PATTERNS = [
    /^requirements.*\.(?:txt|in)$/, /\.(?:csproj|fsproj|vbproj|sln|props|targets)$/, /^tsconfig.*\.json$/,
    /^\.eslintrc/, /^eslint\.config\./, /^\.prettierrc/, /^prettier\.config\./, /^\.stylelintrc/,
    /(?:^|\.)config\.[cm]?[jt]sx?$/, /^vitest\.(?:workspace|projects)\./, /^\.env(?:\..*)?$/, /^docker-compose.*\.ya?ml$/, /^\.?dockerfile\./,
    /\.(?:prompt|instructions|chatmode|agent)\.md$/, /\.mdc$/,
];
/** A changed-path spelling of a configured path: `/` separators, no leading `./` or `/` (the protected-path rules are root-relative). */
const rootRelative = (p) => p.replace(/\\/g, '/').trim().replace(/^(?:\.\/|\/)+/, '');
/** A user glob as a test on a folded path: `**` any depth, `*` and `?` inside one segment, a trailing `/` a whole directory; a glob without `/` matches the file name at any depth. */
export function globMatcher(glob) {
    let g = rootRelative(fold(glob));
    if (g.endsWith('/'))
        g += '**';
    const anyDepth = !g.includes('/');
    const body = g.split('/').map((seg) => (seg === '**' ? '\u0000' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
        .replace(/\u0000\//g, '(?:[^/]+/)*').replace(/\/\u0000/g, '(?:/[^/]+)*').replace(/\u0000/g, '.*');
    const re = new RegExp(`^${anyDepth ? '(?:[^/]+/)*' : ''}${body}$`);
    return (path) => re.test(segments(path).join('/'));
}
/**
 * The changed paths no tier may auto-merge: the factory's and ship's
 * protected paths, every CI definition, the usual git hook directories,
 * `extra` (the configured protected paths, known-flaky file and core.hooksPath,
 * root-relative), `globs` (the user's securityCritical list), the denied
 * directories anywhere in the path, manifests, lockfiles, config and agent
 * prompt files by name, and any path Windows could resolve elsewhere
 * (protectedChanges' raw `:`/`~`/`..` rule).
 */
export function deniedPaths(paths, extra = [], globs = []) {
    const anchored = new Set(protectedChanges(paths, [...LANE_PROTECTED_PATHS, ...CI_TREE_PATHS, ...PROTECTED_PATHS, '.omg/', '.omc/', ...HOOK_DIRS, ...extra.map(rootRelative).filter(Boolean)]));
    const user = globs.map(globMatcher);
    return paths.filter((p) => {
        if (anchored.has(p))
            return true;
        const segs = segments(p);
        if (segs.length === 0)
            return true;
        if (segs.slice(0, -1).some((s) => DENIED_DIRS.has(s)))
            return true;
        if (user.some((m) => m(p)))
            return true;
        const name = segs[segs.length - 1];
        return DENIED_DIRS.has(name) || DENIED_NAMES.has(name) || DENIED_NAME_PATTERNS.some((r) => r.test(name));
    });
}
/** docs: Markdown or reStructuredText anywhere, plain text under the root `docs/`. Never .mdx, HTML, scripts, site code or images. */
export function isDocsPath(path) {
    const segs = segments(path);
    if (segs.length === 0)
        return false;
    const name = segs[segs.length - 1];
    return /\.(?:md|rst)$/.test(name) || (segs[0] === 'docs' && segs.length > 1 && name.endsWith('.txt'));
}
const TEST_NAME = [/\.(?:test|spec)\.[cm]?[jt]sx?$/, /_test\.go$/, /^test_[^/]+\.py$/, /_test\.py$/, /(?:^|_)(?:test|spec)\.rb$/];
/** Test directories at the repository root; `__tests__` and `__snapshots__` count at any depth. */
const ROOT_TEST_DIRS = new Set(['__tests__', '__snapshots__', 'test', 'tests', 'spec']);
const ANY_DEPTH_TEST_DIRS = new Set(['__tests__', '__snapshots__']);
const TEST_DIR_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|snap|json|txt|md)$/;
/** Test-tier files that run outside the PR's own test run (setup, teardown, benchmarks): the tests tier never takes them. */
const TEST_RUNNER_CODE = /setup|teardown|bench/;
/** tests: a test file by name, or a source / snapshot / fixture-data file under a root test directory or any `__tests__`. */
export function isTestPath(path) {
    const segs = segments(path);
    if (segs.length === 0)
        return false;
    const name = segs[segs.length - 1];
    if (TEST_NAME.some((r) => r.test(name)))
        return true;
    const dirs = segs.slice(0, -1);
    return (ROOT_TEST_DIRS.has(dirs[0] ?? '') || dirs.some((s) => ANY_DEPTH_TEST_DIRS.has(s))) && TEST_DIR_FILE.test(name);
}
/** Anything that looks like a test, more widely than isTestPath (a deletion of one needs a human). */
const looksLikeTest = (path) => isTestPath(path) || segments(path).some((s) => /(?:^|[._-])(?:tests?|specs?)(?:$|[._-])|__tests__/.test(s));
/** Only a plain, non-executable file may change (added, modified or deleted): no symlink, gitlink or mode flip. */
const plainMode = (mode) => mode === '100644' || mode === '000000';
/** Root-anchored source trees the small tier never touches by default: the factory, ship, the Copilot runner and the forge adapters. */
export const SMALL_TIER_DENIED = ['src/factory/', 'src/ship/', 'src/copilot-run/', 'src/forge/'];
/** Whether a changed path is one of the base test config's setup files (written with or without an extension). */
const setupMatcher = (paths) => {
    const want = new Set(paths.map((p) => segments(rootRelative(p.replace(/^<rootdir>\//i, ''))).join('/')).filter(Boolean));
    return (path) => {
        const f = segments(path).join('/');
        return want.has(f) || want.has(f.replace(/\.[^./]+$/, ''));
    };
};
/**
 * The first enabled tier (docs, tests, small, in that order) every changed
 * file fits, after the checks every tier shares: at least one change, plain
 * file modes, no binary, no denied path (built-in, configured, the user's
 * securityCritical globs, the base test config's setup files), no deleted
 * test, and the caps.
 */
export function classifyChanges(entries, config, opts = {}) {
    if (entries === null)
        return { reasons: ['the changed files could not be read (git diff --raw/--numstat base...head); auto-merge fails closed'], evidence: [] };
    if (entries.length === 0)
        return { reasons: ['the PR changes no file'], evidence: [] };
    const reasons = [];
    const list = (ps) => `${ps.slice(0, 5).join(', ')}${ps.length > 5 ? `, and ${ps.length - 5} more` : ''}`;
    const odd = entries.filter((e) => !plainMode(e.oldMode) || !plainMode(e.newMode) || (e.oldMode === '000000' && e.newMode === '000000'));
    if (odd.length > 0)
        reasons.push(`non-plain file modes (symlink, gitlink, executable or mode change): ${list(odd.map((e) => `${e.path} ${e.oldMode}->${e.newMode}`))}`);
    const binary = entries.filter((e) => e.added === null || e.deleted === null);
    if (binary.length > 0)
        reasons.push(`binary changes: ${list(binary.map((e) => e.path))}`);
    const denied = deniedPaths(entries.map((e) => e.path), opts.extraDenied ?? [], config.securityCritical ?? []);
    if (denied.length > 0)
        reasons.push(`touches paths that always need a human (CI, config, manifests, lockfiles, hooks, agent prompts, factory or security-critical files): ${list(denied)}`);
    const isSetup = setupMatcher(opts.testSetup?.paths ?? []);
    const setup = entries.filter((e) => isSetup(e.path));
    if (setup.length > 0)
        reasons.push(`touches files the base test config runs around every test run (setupFiles, globalSetup): ${list(setup.map((e) => e.path))}`);
    const deletedTests = entries.filter((e) => e.status === 'D' && looksLikeTest(e.path));
    if (deletedTests.length > 0)
        reasons.push(`deletes test files (a deleted test needs a human): ${list(deletedTests.map((e) => e.path))}`);
    const lines = entries.reduce((n, e) => n + (e.added ?? 0) + (e.deleted ?? 0), 0);
    const files = entries.length;
    const evidence = [`${files} file(s), ${lines} changed line(s), plain file modes, no binary, no denied path, no deleted test`];
    if (reasons.length > 0)
        return { reasons, evidence: [] };
    const docsDenied = (config.docsDenied ?? []).map(globMatcher);
    const misses = [];
    for (const tier of AUTO_MERGE_TIERS) {
        if (!config.tiers.includes(tier))
            continue;
        const maxLines = config.maxChangedLines ?? (tier === 'small' ? DEFAULT_SMALL_MAX_CHANGED_LINES : undefined);
        const maxFiles = config.maxFiles ?? (tier === 'small' ? DEFAULT_SMALL_MAX_FILES : undefined);
        if (tier !== 'docs' && opts.testSetup?.problem) {
            misses.push(`${tier}: ${opts.testSetup.problem}`);
            continue;
        }
        const outside = tier === 'docs' ? entries.filter((e) => !isDocsPath(e.path) || docsDenied.some((m) => m(e.path)))
            : tier === 'tests' ? entries.filter((e) => !isTestPath(e.path) || e.status === 'D' || segments(e.path).some((s) => TEST_RUNNER_CODE.test(s)))
                : entries.filter((e) => protectedChanges([e.path], SMALL_TIER_DENIED).length > 0);
        if (outside.length > 0) {
            const what = tier === 'docs' ? 'docs' : tier === 'tests' ? 'test files (setup, teardown, benchmarks and deletions are not)' : `small-tier files (never under ${SMALL_TIER_DENIED.join(', ')})`;
            misses.push(`${tier}: ${list(outside.map((e) => e.path))} ${outside.length === 1 ? 'is' : 'are'} not ${what}`);
            continue;
        }
        if (maxLines !== undefined && lines > maxLines) {
            misses.push(`${tier}: ${lines} changed lines > maxChangedLines ${maxLines}`);
            continue;
        }
        if (maxFiles !== undefined && files > maxFiles) {
            misses.push(`${tier}: ${files} files > maxFiles ${maxFiles}`);
            continue;
        }
        return { tier, reasons: [], evidence: [...evidence, `every file fits tier ${tier}${maxLines !== undefined ? ` (lines ${lines}/${maxLines}` : ''}${maxFiles !== undefined ? `${maxLines !== undefined ? ', ' : ' ('}files ${files}/${maxFiles}` : ''}${maxLines !== undefined || maxFiles !== undefined ? ')' : ''}`] };
    }
    return { reasons: [`no enabled tier fits (${misses.join('; ')})`], evidence: [] };
}
/** Root config files whose setupFiles / globalSetup the engine reads at the BASE commit (never the head). */
export const TEST_CONFIG_NAME = /^(?:(?:vitest|vite|jest)(?:\.[\w-]+)*\.config\.(?:[cm]?[jt]s|json)|vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)|package\.json)$/i;
const SETUP_KEYS = /(?<![\w$])["']?(setupFiles|setupFilesAfterEnv|globalSetup|globalTeardown)["']?\s*:\s*/g;
const STRING = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/y;
/**
 * The setup files the base's root test configs name (vitest / vite / jest
 * configs and package.json's `jest`), read as text: each setupFiles,
 * setupFilesAfterEnv, globalSetup or globalTeardown value must be a string
 * literal or an array of them. Anything else (a variable, a call, a template
 * with `${}`) is a `problem`, and the engine then keeps the tests and small
 * tiers off: it cannot know which file runs.
 */
export function baseTestSetup(files) {
    const paths = [];
    for (const { path, text } of files) {
        if (/^package\.json$/i.test(path)) {
            let jest;
            try {
                jest = JSON.parse(text).jest;
            }
            catch {
                return { paths, problem: 'the base package.json could not be parsed' };
            }
            if (jest === undefined)
                continue;
            if (!jest || typeof jest !== 'object')
                return { paths, problem: 'the base package.json "jest" is not an object' };
            for (const k of ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown']) {
                const v = jest[k];
                if (v === undefined)
                    continue;
                const vs = Array.isArray(v) ? v : [v];
                if (!vs.every((x) => typeof x === 'string'))
                    return { paths, problem: `the base package.json jest.${k} is not a string list` };
                paths.push(...vs);
            }
            continue;
        }
        for (const m of text.matchAll(SETUP_KEYS)) {
            let i = m.index + m[0].length;
            const literal = () => {
                STRING.lastIndex = i;
                const s = STRING.exec(text);
                if (!s || (s[1] === '`' && s[2].includes('${')))
                    return undefined;
                i = STRING.lastIndex;
                return s[2];
            };
            const skip = () => { while (i < text.length && /[\s,]/.test(text[i]))
                i++; };
            if (text[i] === '[') {
                i++;
                for (skip(); text[i] !== ']'; skip()) {
                    const s = literal();
                    if (s === undefined)
                        return { paths, problem: `${path}: ${m[1]} is not a list of string literals, so its files are unknown` };
                    paths.push(s);
                }
            }
            else {
                const s = literal();
                if (s === undefined)
                    return { paths, problem: `${path}: ${m[1]} is not a string literal, so its file is unknown` };
                paths.push(s);
            }
        }
    }
    return { paths };
}
/**
 * The parks a run may have had and still auto-merge: waits and ordinary
 * failures a later round fixed. Any other `awaiting-human:` park in the run's
 * history (tamper, secrets, sandbox, protected paths, a park added later)
 * keeps the merge human: an allowlist, so a new park fails closed.
 */
export const BENIGN_PARKS = new Set([
    'merge', 'merge-conflicts', 'human-review', 'budget', 'wall-time', 'needs-plan', 'blocked-by',
    'ci-failed', 'ci-flaky', 'gates', 'gates-timeout', 'fix-rounds-spent', 'base-changed', 'prepare-checks',
]);
const PARK_NOTE = /^awaiting-human: ([^:\s]+):/;
/** Every auto-merge condition on the exact head; all must hold. */
export function autoMergeVerdict(i) {
    const reasons = [];
    const evidence = [];
    const at = i.head.slice(0, 12);
    const check = (ok, good, bad) => (ok ? evidence.push(good) : reasons.push(bad));
    check(i.run.forgeKind !== 'azure-devops', `forge ${i.run.forgeKind}`, 'Azure DevOps PRs always merge by a human (no head-pinned engine merge there)');
    check(!i.run.ciHeal, 'issue run', 'ci-heal runs always merge by a human');
    check(i.decision.ok && i.decision.reasons.length === 0, 'ship\'s merge rule allows this head with no reason', `ship's merge rule has reasons: ${i.decision.reasons.join('; ')}`);
    const v = i.verdict;
    check(!!v && v.verdict === 'approve' && v.sha === i.head, `factory review approved ${at}${v ? ` (${v.reviewer})` : ''}`, `the factory review did not approve this exact head (latest: ${v ? `${v.verdict} at ${v.sha.slice(0, 12)}` : 'none'})`);
    // Only a check that ran and succeeded counts: SKIPPED, NEUTRAL and known-flaky failures pass the gate but never auto-merge.
    const checks = i.decision.checks ?? [];
    const required = i.requiredChecks ?? [];
    const succeeded = required.length > 0 ? checks.filter((c) => required.includes(c)) : checks;
    check(!i.decision.noChecks && succeeded.length > 0, `CI green at ${at}: ${succeeded.slice(0, 8).join(', ')}${succeeded.length > 8 ? ', ...' : ''} succeeded${required.length > 0 ? ' (required)' : ''}`, required.length > 0 ? `no required check (${required.slice(0, 8).join(', ')}) succeeded on this head (skipped or neutral checks do not count)` : 'no CI check succeeded on this head (skipped, neutral or no checks never auto-merge)');
    check(i.human !== undefined, 'human review read: no open thread or change request', 'factory.review.human is "off", so human review threads are not read');
    if (i.human)
        check(i.human.commentOnly === 0, 'no comment-only human review at this head', `${i.human.commentOnly} comment-only human review(s) at this head`);
    check(i.labels !== null && !i.labels.some((l) => l.toLowerCase() === MANUAL_MERGE_LABEL), `no ${MANUAL_MERGE_LABEL} label`, i.labels === null ? 'the issue or PR labels could not be read' : `the issue or PR carries ${MANUAL_MERGE_LABEL}`);
    const flagged = i.run.history.map((h) => PARK_NOTE.exec(h.note)?.[1] ?? (/^awaiting-human:/.test(h.note) ? '(unparsed park)' : undefined)).filter((n) => !!n && !BENIGN_PARKS.has(n));
    const tamper = i.run.history.some((h) => /tamper|quarantin/i.test(h.note));
    const acks = [
        ...(i.run.unsandboxedAck ? ['--allow-unsandboxed-lanes'] : []),
        ...(i.run.unsandboxedGatesAck ? ['--allow-unsandboxed-gates'] : []),
        ...(i.run.gateChangeApproved ? ['--allow-gate-change'] : []),
        ...(i.run.secretAck && i.run.secretAck.length > 0 ? ['--allow-secret-shapes'] : []),
        ...(i.run.history.some((h) => /--allow-[a-z-]+/.test(h.note)) ? ['an --allow-* flag (run history)'] : []),
    ];
    check(flagged.length === 0 && !tamper, 'no secret-scan, tamper or sandbox park in this run', `this run parked at ${[...new Set(flagged)].join(', ') || 'a tamper or quarantine hold'}`);
    check(acks.length === 0, 'no --allow-* acknowledgement in this run', `this run used ${[...new Set(acks)].join(', ')}`);
    if (i.changes.tier)
        evidence.push(...i.changes.evidence);
    else
        reasons.push(...i.changes.reasons);
    return reasons.length === 0 ? { ok: true, tier: i.changes.tier, reasons, evidence } : { ok: false, reasons, evidence };
}
/** The PR comment after the engine merged: the tier and every condition's evidence. */
export function autoMergeComment(label, tier, head, evidence, by) {
    return [
        `Factory run for ${label}: auto-merged by tier ${tier} at ${head.slice(0, 12)} (${by}).`,
        '',
        'Every auto-merge condition held on this exact head:',
        '',
        ...evidence.map((e) => `- ${e}`),
        '',
        `factory.merge.auto in your user config turns this on per repository; add the ${MANUAL_MERGE_LABEL} label to keep a PR's merge human.`,
        '',
    ].join('\n');
}
//# sourceMappingURL=auto-merge.js.map