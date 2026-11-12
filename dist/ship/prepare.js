/**
 * `omg ship prepare`: the mechanical steps between an approved verdict and
 * the CI gate, in a fixed order:
 *   preflight (on the run's PR branch, containing the reviewed sha, clean,
 *   no merge / rebase / cherry-pick / revert in progress) -> remote check
 *   (the remote is the PR's repository) -> fetch (refs/remotes/origin/<base>
 *   must equal GitHub's base sha) -> merge that sha in (--no-ff, never
 *   rebase; never a ref name a local tag could shadow) -> checks
 *   (ship.prepare.checks, else the tsc / lint / targeted tests the repository
 *   has) -> inventory regeneration as the LAST commit (when the repository
 *   has the generator) -> optional plain push.
 * Every command goes through the guarded Exec, so force pushes and rebases
 * are refused before they spawn. Engine merges and commits run with
 * `--no-verify` (pre-commit / pre-merge-commit / commit-msg hooks never shape
 * them), the index must hold no staged changes at the start, and the
 * inventory commit names `-- inventory` so a file a concurrent lane stages
 * during the checks stays out of it. `omg ship merge` re-checks the content
 * of every engine commit anyway (readCommitsSinceReview).
 */
import { existsSync, lstatSync } from 'fs';
import { isAbsolute, join, posix } from 'path';
import { visibleLine } from '../forge/review-feedback.js';
import { isPlainBranchName, readBaseFile, remoteRepoMismatch } from './config.js';
import { BUILD_COMMIT_MESSAGE } from './exec.js';
import { buildCommitProblem } from './merge.js';
export const INVENTORY_DIR = 'inventory';
export const INVENTORY_SCRIPT = 'scripts/generate-inventory-graph.mjs';
export const INVENTORY_COMMIT_MESSAGE = 'chore(inventory): regenerate inventory graph baseline';
export { BUILD_COMMIT_MESSAGE };
/** The step a ship.prepare.build that fails, or changes files outside its outputs, fails. */
export const PREPARE_BUILD_STEP = 'build';
/** The step a configured check that cannot start fails: a config problem for a human, not a fix lane. */
export const PREPARE_CONFIG_STEP = 'checks-config';
/** The step a base that cannot be read fails: an engine problem, not a fix lane. */
export const PREPARE_DETECT_STEP = 'detect';
export const TSC_SCRIPT = 'node_modules/typescript/bin/tsc';
export const ESLINT_SCRIPT = 'node_modules/eslint/bin/eslint.js';
export const VITEST_SCRIPT = 'node_modules/vitest/vitest.mjs';
const ESLINT_CONFIGS = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
];
/**
 * The built-in checks prepare runs (ship.prepare.checks unset). The
 * repository markers (tsconfig.json, an eslint config, the inventory
 * generator) are read from the trusted base (`baseHas`), never the PR's
 * checkout, so a PR that deletes one cannot turn its check into a skip: a
 * marker the base has and the checkout (`exists`) lost is a failure
 * (`lost`). The tool packages under node_modules come from `exists` (the
 * checkout links the root's node_modules). A repository without this one's
 * tooling runs none of it. `npm test`-style gates are the local gate's job.
 */
export function detectPrepareChecks(baseHas, exists = baseHas) {
    const lost = {};
    const gone = (marker) => `${marker} is committed on the base but missing from the checkout; restore it (prepare never skips a check the base has)`;
    const tsc = baseHas('tsconfig.json') && exists(TSC_SCRIPT);
    if (tsc && !exists('tsconfig.json'))
        lost.tsc = gone('tsconfig.json');
    const baseEslint = exists(ESLINT_SCRIPT) ? ESLINT_CONFIGS.filter(baseHas) : [];
    if (baseEslint.length > 0 && !ESLINT_CONFIGS.some(exists))
        lost.lint = gone(baseEslint.join(', '));
    const inventory = baseHas(INVENTORY_SCRIPT);
    if (inventory && !exists(INVENTORY_SCRIPT))
        lost.inventory = gone(INVENTORY_SCRIPT);
    return { tsc, lint: baseEslint.length > 0, tests: exists(VITEST_SCRIPT), inventory, lost };
}
/**
 * Whether a repository file is committed at `commit` (readBaseFile: replace
 * refs off, any failure but "missing" throws), memoized per path.
 */
export function baseFileExists(exec, cwd, commit) {
    const seen = new Map();
    return (p) => {
        let found = seen.get(p);
        if (found === undefined) {
            found = readBaseFile(exec, cwd, commit, p) !== null;
            seen.set(p, found);
        }
        return found;
    };
}
/** What prepare runs, one line per check (`omg factory check`, from the same base detection); [] = none. */
export function describePrepareChecks(configured, baseHas, exists = baseHas) {
    const found = detectPrepareChecks(baseHas, exists);
    const out = configured
        ? configured.map((argv) => argv.join(' '))
        : [
            ...(found.tsc ? ['tsc --noEmit'] : []),
            ...(found.lint ? ['eslint on the changed src TypeScript'] : []),
            ...(found.tests ? ['vitest on the tests mapped from the diff'] : []),
        ];
    if (found.inventory)
        out.push(`${INVENTORY_SCRIPT} --verify (regenerated as the last commit)`);
    return out;
}
/**
 * L3: the built-in checks the base asks for that prepare would skip, and
 * what to run (`omg factory check`); [] with configured checks. The tool
 * packages come from your node_modules, so a checkout without one runs no
 * tsc, eslint or vitest.
 */
export function skippedPrepareChecks(configured, baseHas, exists = baseHas) {
    if (configured)
        return [];
    if (!exists('node_modules'))
        return !baseHas('package.json') ? [] : ['tsc, eslint and vitest: the base has package.json but there is no node_modules in this checkout (prepare uses yours); run npm ci (or your package manager\'s install), then check again'];
    const out = [];
    if (baseHas('tsconfig.json') && !exists(TSC_SCRIPT))
        out.push(`tsc: the base has tsconfig.json but ${TSC_SCRIPT} is not installed; run npm ci`);
    if (ESLINT_CONFIGS.some(baseHas) && !exists(ESLINT_SCRIPT))
        out.push(`eslint: the base has an eslint config but ${ESLINT_SCRIPT} is not installed; run npm ci`);
    return out;
}
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/**
 * Tests to run for a diff: changed test files, plus `X.test.ts` beside or in
 * `__tests__/` next to each changed `src/**\/X.ts`, plus the skills suite when
 * skills/ changed. Only files that exist are returned (sorted, unique).
 */
export function selectTargetedTests(changed, exists) {
    const picked = new Set();
    const add = (p) => { if (exists(p))
        picked.add(p); };
    for (const raw of changed) {
        const file = raw.replace(/\\/g, '/');
        if (TEST_FILE.test(file) && (file.startsWith('src/') || file.startsWith('tests/'))) {
            add(file);
            continue;
        }
        if (file.startsWith('skills/')) {
            add('src/__tests__/skills.test.ts');
            continue;
        }
        const m = /^(src\/(?:.*\/)?)([^/]+)\.(ts|tsx|mts)$/.exec(file);
        if (!m || file.endsWith('.d.ts'))
            continue;
        const [, dir, name] = m;
        add(`${dir}${name}.test.ts`);
        add(`${dir}__tests__/${name}.test.ts`);
    }
    return [...picked].sort();
}
/** Generator verifications to run when their inputs changed. */
export function selectGeneratorChecks(changed) {
    const touches = (prefixes) => changed.some((f) => prefixes.some((p) => f.replace(/\\/g, '/').startsWith(p)));
    const out = [];
    if (touches(['skills/', 'agents/', 'docs/CLAUDE.md']))
        out.push(['scripts/generate-prompt-projections.mjs', '--verify']);
    if (touches(['agents/']))
        out.push(['scripts/copilot/build-agents.mjs', '--verify']);
    if (touches(['hooks/']))
        out.push(['scripts/copilot/build-hooks.mjs', '--verify']);
    return out;
}
function lstatOrNull(p) {
    try {
        return lstatSync(p);
    }
    catch {
        return null;
    }
}
function lines(text) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function tail(text, n = 20) {
    return lines(text).slice(-n).join('\n');
}
/** The step prepare fails when a check gave no verdict (the OS sandbox could not run it): an engine problem, never a fix lane. */
export const PREPARE_SANDBOX_STEP = 'checks-sandbox';
/** ship's prepare: every check through `exec` / `commandExec`, synchronously. */
export function runPrepare(opts) {
    const steps = prepareSteps(opts);
    const commandExec = opts.commandExec ?? opts.exec;
    let next = steps.next();
    while (!next.done) {
        const c = next.value;
        next = steps.next((c.kind === 'configured' || c.kind === 'build' ? commandExec : opts.exec)(c.exe, c.args, { cwd: opts.cwd }));
    }
    return next.value;
}
/**
 * prepare with every check through `runCheck` (omg factory run: the OS
 * sandbox), awaited; git still runs through `exec`. A check whose result
 * carries `notStarted` stops prepare at PREPARE_SANDBOX_STEP.
 */
export async function runPrepareAsync(opts, runCheck) {
    const steps = prepareSteps(opts);
    let next = steps.next();
    while (!next.done)
        next = steps.next(await runCheck(next.value));
    return next.value;
}
function* prepareSteps(opts) {
    const { exec, cwd, base } = opts;
    const remote = opts.remote ?? 'origin';
    const node = opts.node ?? process.execPath;
    const exists = opts.exists ?? ((p) => existsSync(isAbsolute(p) ? p : join(cwd, p)));
    const upstream = `refs/remotes/${remote}/${base}`;
    const { baseSha } = opts;
    const steps = [];
    const housekeepingCommits = [];
    const git = (...args) => exec('git', args, { cwd });
    const fail = (name, detail, extra = {}) => {
        steps.push({ name, status: 'failed', detail });
        return { ok: false, steps, housekeepingCommits, blockedReason: `${name}: ${detail.split('\n')[0]}`, ...extra };
    };
    const head = () => git('rev-parse', 'HEAD').stdout.trim();
    // 1. preflight
    for (const [label, name] of [['base', base], ['branch', opts.branch]]) {
        if (!isPlainBranchName(name) || git('check-ref-format', '--branch', name).status !== 0) {
            return fail('preflight', `${label} ${JSON.stringify(name)} is not a valid branch name`);
        }
    }
    if (!/^[\w][\w.-]*$/.test(remote))
        return fail('preflight', `remote ${JSON.stringify(remote)} is not a valid remote name`);
    if (!/^[0-9a-f]{40}$/.test(opts.reviewedSha))
        return fail('preflight', `reviewed sha ${JSON.stringify(opts.reviewedSha)} is not a full commit id`);
    if (!/^[0-9a-f]{40}$/.test(baseSha))
        return fail('preflight', `GitHub's base sha ${JSON.stringify(baseSha)} is not a full commit id`);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    if (!branch || branch === 'HEAD')
        return fail('preflight', 'detached HEAD; check out the PR branch');
    if (branch === base || branch === 'main' || branch === 'master')
        return fail('preflight', `refusing to prepare on ${branch}; use the PR branch`);
    if (branch !== opts.branch)
        return fail('preflight', `checked out ${branch}, but the ship run is for ${opts.branch}; check out the PR branch`);
    if (git('merge-base', '--is-ancestor', opts.reviewedSha, 'HEAD').status !== 0) {
        return fail('preflight', `HEAD does not contain the reviewed commit ${opts.reviewedSha.slice(0, 12)}; pull the PR branch (merge, never rebase) or re-review`);
    }
    for (const [ref, what] of [['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
        if (git('rev-parse', '-q', '--verify', ref).status === 0)
            return fail('preflight', `${what} is in progress; commit or abort it first`);
    }
    for (const marker of ['rebase-merge', 'rebase-apply']) {
        const p = git('rev-parse', '--git-path', marker).stdout.trim();
        if (p && exists(isAbsolute(p) ? p : join(cwd, p)))
            return fail('preflight', 'a rebase is in progress; finish or abort it (ship never rebases)');
    }
    const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
    if (dirty)
        return fail('preflight', `working tree has uncommitted changes:\n${dirty}`);
    if (git('diff', '--cached', '--quiet').status !== 0)
        return fail('preflight', 'the index has staged changes; commit or unstage them first');
    steps.push({ name: 'preflight', status: 'ok', detail: branch });
    // 2. fetch from the PR's repository; the fetched base must be the commit GitHub reports
    if (opts.prefetchedBase) {
        if (git('cat-file', '-e', `${baseSha}^{commit}`).status !== 0)
            return fail('fetch', `the base ${baseSha} the caller fetched is not a commit in the checkout's repository`);
        steps.push({ name: 'fetch', status: 'ok', detail: `${base} = ${baseSha} (fetched by the caller)` });
    }
    else {
        const mismatch = remoteRepoMismatch(exec, cwd, remote, opts.repoUrl);
        if (mismatch)
            return fail('remote', `${mismatch}; refusing to fetch (fail closed)`);
        const fetched = git('fetch', remote, base);
        if (fetched.status !== 0)
            return fail('fetch', tail(fetched.stderr));
        const local = git('rev-parse', '--verify', upstream);
        if (local.status !== 0 || local.stdout.trim() !== baseSha) {
            return fail('fetch', `${upstream} is ${local.stdout.trim() || 'missing'}, but GitHub reports ${base} at ${baseSha}; refusing (fail closed; re-run if ${base} just moved)`);
        }
        steps.push({ name: 'fetch', status: 'ok', detail: `${upstream} = ${baseSha}` });
    }
    // 3. merge GitHub's base sha in (never rebase, never by ref name)
    if (git('merge-base', '--is-ancestor', baseSha, 'HEAD').status === 0) {
        steps.push({ name: 'merge-base', status: 'skipped', detail: `already contains ${base} ${baseSha.slice(0, 12)}` });
    }
    else {
        const merged = git('merge', '--no-ff', '--no-edit', '--no-verify', baseSha);
        if (merged.status !== 0) {
            const conflicts = lines(git('diff', '--name-only', '--diff-filter=U').stdout);
            const inventoryOnly = conflicts.length > 0 && conflicts.every((f) => f.startsWith(`${INVENTORY_DIR}/`));
            if (!inventoryOnly) {
                return fail('merge-base', conflicts.length > 0
                    ? `conflicts outside ${INVENTORY_DIR}/ need a human or a fix lane: ${conflicts.join(', ')} (resolve and commit, or git merge --abort)`
                    : tail(merged.stderr || merged.stdout), { conflicts });
            }
            // Sibling-PR inventory conflict: take the base's baseline; it is regenerated below.
            for (const args of [['checkout', '--theirs', '--', INVENTORY_DIR], ['add', '--', INVENTORY_DIR], ['commit', '--no-edit', '--no-verify']]) {
                const r = git(...args);
                if (r.status !== 0)
                    return fail('merge-base', `git ${args.join(' ')}: ${tail(r.stderr || r.stdout)}`, { conflicts });
            }
            steps.push({ name: 'merge-base', status: 'ok', detail: `merged ${base} ${baseSha.slice(0, 12)}; inventory conflict resolved with --theirs` });
        }
        else {
            steps.push({ name: 'merge-base', status: 'ok', detail: `merged ${base} ${baseSha.slice(0, 12)}` });
        }
        housekeepingCommits.push(head());
    }
    // 3b. ship.prepare.build (trusted config): rebuild the committed build output; only its declared outputs may change
    if (opts.build) {
        const build = opts.build;
        if ('missing' in build)
            return fail(PREPARE_CONFIG_STEP, `ship.prepare.build ${JSON.stringify(build.argv)}: ${build.missing}`);
        // -z, no renames: one verbatim `XY path` entry per changed or untracked (not ignored) file.
        const status = () => {
            const r = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames');
            return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
        };
        const inOutputs = (p) => build.outputs.some((o) => p === o || p.startsWith(`${o}/`));
        const shown = (paths) => paths.slice(0, 10).map((p) => visibleLine(p)).join(', ');
        // The build compiles what is in the checkout, and `git add -f` takes every file in the outputs: an untracked
        // source file, or an ignored file already in an output, would ship unreviewed. Only a clean checkout is built.
        const before = status();
        if (before === null)
            return fail(PREPARE_BUILD_STEP, 'git status failed before the build');
        if (before.length > 0) {
            return fail(PREPARE_BUILD_STEP, `the checkout has untracked or changed files, which the build could compile into its output; nothing is built (fail closed). Remove or commit them: ${shown(before.map((e) => e.slice(3)))}`);
        }
        for (const o of build.outputs) {
            // An output is a real directory (or absent until the build makes it), never a file or a link.
            const st = lstatOrNull(join(cwd, o));
            if (st && (st.isSymbolicLink() || !st.isDirectory()))
                return fail(PREPARE_BUILD_STEP, `ship.prepare.build output ${o} is not a directory`);
        }
        const preIgnored = git('ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...build.outputs);
        if (preIgnored.status !== 0)
            return fail(PREPARE_BUILD_STEP, 'git ls-files failed before the build');
        const stray = preIgnored.stdout.split('\0').filter(Boolean);
        if (stray.length > 0) {
            return fail(PREPARE_BUILD_STEP, `ignored files are already in ship.prepare.build.outputs, and git add -f would commit them; nothing is built (fail closed). Remove them: ${shown(stray)}`);
        }
        const headBefore = head();
        const r = yield { step: PREPARE_BUILD_STEP, kind: 'build', argv: build.argv, exe: build.exe, args: build.args };
        if (r.notStarted !== undefined)
            return fail(PREPARE_SANDBOX_STEP, `${PREPARE_BUILD_STEP}: ${r.notStarted}`);
        if (r.status !== 0)
            return fail(PREPARE_BUILD_STEP, tail(`${r.stdout}\n${r.stderr}`));
        if (head() !== headBefore)
            return fail(PREPARE_BUILD_STEP, 'the build moved HEAD (it made or reset a commit); the build only writes files, prepare commits them');
        const after = status();
        if (after === null)
            return fail(PREPARE_BUILD_STEP, 'git status failed after the build');
        const outside = after.filter((e) => !inOutputs(e.slice(3)));
        if (outside.length > 0) {
            // The names are the build's (the PR's code): shown, never raw.
            return fail(PREPARE_BUILD_STEP, `the build changed files outside ship.prepare.build.outputs (${build.outputs.join(', ')}), so nothing is committed (fail closed): ${outside.slice(0, 10).map((e) => visibleLine(e.slice(3))).join(', ')}`);
        }
        // An output the build never made (absent and nothing of it changed) is no pathspec: git add would refuse it.
        const outputs = build.outputs.filter((o) => exists(o) || after.some((e) => e.slice(3) === o || e.slice(3).startsWith(`${o}/`)));
        // -f: build output directories are often git-ignored (dist/) yet committed.
        const added = outputs.length > 0 ? git('add', '-f', '-A', '--', ...outputs) : undefined;
        if (added && added.status !== 0)
            return fail(PREPARE_BUILD_STEP, `git add -f -A -- ${outputs.join(' ')}: ${tail(added.stderr || added.stdout)}`);
        if (outputs.length > 0 && git('diff', '--cached', '--quiet', '--', ...outputs).status !== 0) {
            // Only the outputs: a file a concurrent lane staged meanwhile is not swept into the engine's commit.
            const committed = git('commit', '--no-verify', '-m', BUILD_COMMIT_MESSAGE, '--', ...outputs);
            if (committed.status !== 0)
                return fail(PREPARE_BUILD_STEP, tail(committed.stderr || committed.stdout));
            // Recorded only when it is what merge accepts: one parent, the pre-build HEAD, and only the outputs (no link).
            const built = head();
            const parents = git('rev-list', '--first-parent', '--parents', `${headBefore}..${built}`);
            if (parents.status !== 0 || parents.stdout.trim() !== `${built} ${headBefore}`) {
                return fail(PREPARE_BUILD_STEP, `the build commit ${built.slice(0, 12)} is not one commit on ${headBefore.slice(0, 12)}; not recorded (fail closed)`);
            }
            const problem = buildCommitProblem(exec, cwd, built, headBefore, build.outputs);
            if (problem)
                return fail(PREPARE_BUILD_STEP, `the build commit ${built.slice(0, 12)} is not housekeeping: ${visibleLine(problem)}; not recorded (fail closed)`);
            housekeepingCommits.push(built);
            steps.push({ name: PREPARE_BUILD_STEP, status: 'ok', detail: `committed ${outputs.join(', ')}` });
        }
        else {
            steps.push({ name: PREPARE_BUILD_STEP, status: 'skipped', detail: 'build output is current' });
        }
    }
    // 4. checks: the configured commands, else the built-ins the trusted base has, chosen from the diff against the base
    let found;
    try {
        found = detectPrepareChecks(opts.baseExists ?? baseFileExists(exec, cwd, baseSha), exists);
    }
    catch (error) {
        return fail(PREPARE_DETECT_STEP, `cannot read the base ${baseSha.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (opts.checks === false) {
        steps.push({ name: 'checks', status: 'skipped', detail: '--no-checks' });
    }
    else if (opts.commands) {
        const missing = opts.commands.find((c) => 'missing' in c);
        if (missing && 'missing' in missing)
            return fail(PREPARE_CONFIG_STEP, `ship.prepare.checks ${JSON.stringify(missing.argv)}: ${missing.missing}`);
        if (opts.commands.length === 0)
            steps.push({ name: 'checks', status: 'skipped', detail: 'ship.prepare.checks is empty' });
        for (const c of opts.commands) {
            if ('missing' in c)
                continue;
            const name = c.argv.join(' ').slice(0, 80);
            const r = yield { step: name, kind: 'configured', argv: c.argv, exe: c.exe, args: c.args };
            if (r.notStarted !== undefined)
                return fail(PREPARE_SANDBOX_STEP, `${name}: ${r.notStarted}`);
            if (r.status !== 0)
                return fail(name, tail(`${r.stdout}\n${r.stderr}`));
            steps.push({ name, status: 'ok' });
        }
    }
    else {
        // -z: every name verbatim (core.quotePath=false would otherwise print non-ASCII names, smart quotes included, raw and
        // a name with a newline would split); the names reach the checks only as argv words, never as shell text.
        const changed = git('diff', '--name-only', '-z', `${baseSha}...HEAD`).stdout.split('\0').filter(Boolean);
        const lintable = changed.filter((f) => /^src\/.*\.(?:ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts') && exists(f));
        const tests = selectTargetedTests(changed, exists);
        const plan = [
            ['tsc', found.tsc ? [TSC_SCRIPT, '--noEmit'] : null, 'no tsconfig.json on the base or no typescript package'],
            ['lint', !found.lint ? null : lintable.length > 0 ? [ESLINT_SCRIPT, ...lintable] : null, found.lint ? 'no changed src TypeScript' : 'no eslint package or no eslint config on the base'],
            ['tests', !found.tests ? null : tests.length > 0 ? [VITEST_SCRIPT, 'run', ...tests] : null, found.tests ? 'no targeted tests for the diff' : 'no vitest package'],
            ...selectGeneratorChecks(changed).filter((args) => exists(args[0])).map((args) => [posix.basename(args[0]), args, '']),
        ];
        for (const [name, args, skipReason] of plan) {
            const lost = found.lost[name];
            if (lost)
                return fail(name, lost);
            if (!args) {
                steps.push({ name, status: 'skipped', detail: skipReason });
                continue;
            }
            const r = yield { step: name, kind: 'built-in', argv: [node, ...args], exe: node, args };
            if (r.notStarted !== undefined)
                return fail(PREPARE_SANDBOX_STEP, `${name}: ${r.notStarted}`);
            if (r.status !== 0)
                return fail(name, tail(`${r.stdout}\n${r.stderr}`));
            // The file names are the PR's (-z keeps control characters): shown, never raw, in the detail status output prints.
            steps.push({ name, status: 'ok', detail: args.slice(1).map(visibleLine).join(' ').slice(0, 300) });
        }
    }
    // 5. inventory regeneration, always the last commit (only in a repository that has the generator)
    if (found.lost.inventory)
        return fail('inventory', found.lost.inventory);
    const inventory = (mode) => ({ step: 'inventory', kind: 'inventory', argv: [node, INVENTORY_SCRIPT, mode], exe: node, args: [INVENTORY_SCRIPT, mode] });
    const current = found.inventory ? yield inventory('--verify') : undefined;
    if (current?.notStarted !== undefined)
        return fail(PREPARE_SANDBOX_STEP, `inventory: ${current.notStarted}`);
    if (!found.inventory) {
        steps.push({ name: 'inventory', status: 'skipped', detail: `no ${INVENTORY_SCRIPT} on the base` });
    }
    else if (current.status === 0) {
        steps.push({ name: 'inventory', status: 'skipped', detail: 'baseline is current' });
    }
    else {
        const written = yield inventory('--write');
        if (written.notStarted !== undefined)
            return fail(PREPARE_SANDBOX_STEP, `inventory: ${written.notStarted}`);
        if (written.status !== 0)
            return fail('inventory', tail(written.stderr || written.stdout));
        const added = git('add', '--', INVENTORY_DIR);
        if (added.status !== 0)
            return fail('inventory', `git add -- ${INVENTORY_DIR}: ${tail(added.stderr || added.stdout)}`);
        if (git('diff', '--cached', '--quiet', '--', INVENTORY_DIR).status !== 0) {
            // Only inventory/: a file a concurrent lane staged meanwhile is not swept into the engine's commit.
            const committed = git('commit', '--no-verify', '-m', INVENTORY_COMMIT_MESSAGE, '--', INVENTORY_DIR);
            if (committed.status !== 0)
                return fail('inventory', tail(committed.stderr || committed.stdout));
            housekeepingCommits.push(head());
        }
        const verified = yield inventory('--verify');
        if (verified.notStarted !== undefined)
            return fail(PREPARE_SANDBOX_STEP, `inventory: ${verified.notStarted}`);
        if (verified.status !== 0)
            return fail('inventory', `regenerated baseline still fails --verify:\n${tail(verified.stderr || verified.stdout)}`);
        steps.push({ name: 'inventory', status: 'ok', detail: 'regenerated as the last commit' });
    }
    // 6. plain push
    if (opts.push) {
        const pushed = git('push', remote, `HEAD:refs/heads/${opts.branch}`);
        if (pushed.status !== 0)
            return fail('push', tail(pushed.stderr));
        steps.push({ name: 'push', status: 'ok', detail: `${remote} ${opts.branch}` });
    }
    return { ok: true, steps, housekeepingCommits };
}
//# sourceMappingURL=prepare.js.map