/**
 * `omg release <version>`: the release as ordered, individually re-runnable
 * phases with gates, so a release is a script run and an agent is needed only
 * to triage a failure.
 *
 *   preflight  clean tree (release prose may be uncommitted), on release/v<v>
 *              containing origin/dev, version above dev's and npm's latest,
 *              gh authenticated, no .git/index.lock, tag not on origin
 *   bump       refuse without the CHANGELOG / release-body prose, then
 *              npm version + every version stamp + prompt projections
 *   build      npm run build, git add -f dist bridge, orphan + untracked
 *              checks, import / --version / MCP start probes
 *   gates      tsc, projections, copilot generators, multi-repo path gate
 *   commit     release commit, then the inventory regenerated LAST
 *   suite      optional vitest suite (targeted, or full against a baseline),
 *              run on the committed tree: some tests (npm pack, committed
 *              docs/CLAUDE.md, inventory drift) read committed state and
 *              always fail on the uncommitted release tree. The level (and
 *              the baseline) is recorded in the state and a later run never
 *              lowers it; a suite that ran below the recorded level runs again.
 *              New failing full-suite titles are rerun alone (triage): real
 *              fails, mixed blocks, load-flaky passes with a warning and
 *              known-flaky candidates (never applied by the engine)
 *   smoke      live Tier 2 smoke, only with --live-smoke; after the suite so
 *              a red suite costs no AI credits. A green smoke is reused while
 *              HEAD's smoke inputs hash the same (lastSmoke; --force-smoke runs)
 *   pr         push, PR to dev, CI gate (ship merge rule), admin merge
 *   promote    PR dev -> main, same gate, merge
 *   tag        annotated v<v> on main's merge commit, verified, pushed (--yes)
 *   verify     tag run green, npm version / latest / provenance, GitHub Release
 *
 * State: `<state root>/release/<version>.json` records each phase result,
 * the release branch and commit, and the PR merge commits; a run without
 * --from resumes at the first phase not yet ok. Before skipping a phase (a
 * resume or --from) its recorded postconditions are re-checked, and a state
 * recorded on another branch or an unrelated HEAD is refused unless --from
 * preflight (tag / verify after the main merge need no release checkout).
 * Running a phase voids the records of every later phase, and skipping past
 * commit needs a clean working tree (HEAD is what pr pushes).
 * Every external command goes through one injectable runner (ReleaseExec).
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { loadBaseKnownFlaky, prRepoUrl } from '../ship/config.js';
import { scrubShipEnv } from '../ship/exec.js';
import { parseFailingTests, TRANSIENT_GH_ERROR, watchGates } from '../ship/gates.js';
import { classifyTriage, compareVersions, escapeRe, failingTitlesFromVitestJson, findDistOrphans, flakyCandidates, newFailures, parseBaselineTitles, releaseProseProblems, remoteTagTarget, SMOKE_INPUTS, smokeInputHash, smokeProblems, splitFailingTitle, stampVersion, tagTargetProblem, testPassedInReport, TRIAGE_CAP, VERSION_STAMPS, } from './checks.js';
import { parseCopilotVersion, resolveCopilotBinary } from '../smoke/copilot-binary.js';
export const PHASES = ['preflight', 'bump', 'build', 'gates', 'commit', 'suite', 'smoke', 'pr', 'promote', 'tag', 'verify'];
export function isPhaseId(value) {
    return PHASES.includes(value);
}
const SUITE_RANK = { none: 0, targeted: 1, full: 2 };
/** A usage error (bad flag combination); the CLI exits 2 on it. */
export class UsageError extends Error {
}
/** Files the release prose lives in; uncommitted edits to them are folded into the release commit. */
export const PROSE_FILES = ['CHANGELOG.md', '.github/release-body.md', 'README.md', 'docs/REFERENCE.md', 'docs/MIGRATION.md'];
/** npm through a shell only on Windows (npm.cmd), and only with shell-inert arguments. */
const SHELL_SAFE_ARG = /^[\w@./:=-]+$/;
export const defaultReleaseExec = (cmd, args, opts) => {
    const shell = process.platform === 'win32' && cmd === 'npm';
    if (shell && !args.every((a) => SHELL_SAFE_ARG.test(a))) {
        return { status: 1, stdout: '', stderr: `refusing to pass ${JSON.stringify(args)} to npm through cmd.exe` };
    }
    // Every child runs under the ship scrub (GIT_NO_REPLACE_OBJECTS=1, redirecting GIT_* / GH_* dropped),
    // node scripts included: they call git too. The vitest suite runs without GIT_NO_REPLACE_OBJECTS, as in CI,
    // but still without the redirecting GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE).
    const base = scrubShipEnv(process.env);
    if (opts?.suiteEnv)
        delete base.GIT_NO_REPLACE_OBJECTS;
    // One command string through the shell (the arguments were checked inert above).
    const result = spawnSync(shell ? ['npm', ...args].join(' ') : cmd, shell ? [] : args, {
        cwd: opts?.cwd,
        env: { ...base, ...opts?.env },
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 512 * 1024 * 1024,
        shell,
        timeout: opts?.timeoutMs,
    });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: `${result.stderr ?? ''}${result.error ? result.error.message : ''}`,
    };
};
class PhaseStop extends Error {
    outcome;
    constructor(outcome) {
        super(outcome.note);
        this.outcome = outcome;
    }
}
/**
 * Not a result yet: a CI wait ran out of the --timeout window, or GitHub
 * answered with a transient error. `outcome` is what a run without --drive
 * records (blocked / fail, unchanged); under --drive the run ends pending.
 */
export class PendingError extends Error {
    outcome;
    constructor(outcome) {
        super(outcome.note);
        this.outcome = outcome;
    }
}
const fail = (note, details) => {
    throw new PhaseStop({ status: 'fail', note, details });
};
const blocked = (note, details) => {
    throw new PhaseStop({ status: 'blocked', note, details });
};
/** A CI wait past the --timeout: blocked without --drive, pending (resumed) with it. */
const pendingWait = (note) => {
    throw new PendingError({ status: 'blocked', note });
};
export function releaseStatePath(stateRoot, version) {
    return join(stateRoot, 'release', `${version}.json`);
}
/** Known-flaky candidates of the full-suite triage; the owner approves them into .github/known-flaky-tests.json by hand. */
export function flakyCandidatesPath(stateRoot, version) {
    return join(stateRoot, 'release', `${version}-flaky-candidates.json`);
}
export function readReleaseState(stateRoot, version) {
    const path = releaseStatePath(stateRoot, version);
    if (!existsSync(path))
        return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1 || parsed.release !== version || typeof parsed.phases !== 'object') {
        throw new Error(`${path} is not a release state for ${version}`);
    }
    for (const key of ['suite', 'suiteRan']) {
        const level = parsed[key];
        if (level !== undefined && !Object.hasOwn(SUITE_RANK, level)) {
            throw new Error(`${path}: ${key} is ${JSON.stringify(level)}, expected none, targeted or full (fix or delete the state file)`);
        }
    }
    return { ...parsed, reruns: parsed.reruns ?? {} };
}
function tail(text, lines = 30) {
    return text.trim().split(/\r?\n/).slice(-lines);
}
const FULL_SHA = /^[0-9a-f]{40}$/;
/** Polls for a rerun's new attempt to appear before giving up (bounded even when the clock does not move). */
const RERUN_START_POLLS = 40;
/** Rounds of land()'s wait / merge loop before giving up (bounded even when the clock does not move). */
const LAND_ROUNDS = 500;
/** After a push GitHub moves the PR's headRefOid asynchronously: poll every 5 s, up to 3 min. */
const HEAD_SYNC_POLL_MS = 5_000;
const HEAD_SYNC_POLLS = 36;
/** `gh pr merge` retries on a transient GitHub error (5xx, GraphQL "Something went wrong"), with this backoff. */
const MERGE_RETRY_BACKOFF_MS = [10_000, 30_000];
/** Steps each phase runs, as printed by --dry-run. */
export function phasePlan(id, v, opts) {
    const branch = `release/v${v}`;
    switch (id) {
        case 'preflight':
            return [
                `git status --porcelain is empty apart from ${PROSE_FILES.join(', ')}`,
                `HEAD is ${branch}; git fetch origin dev; origin/dev is an ancestor of HEAD`,
                `${v} > package.json version on origin/dev and > npm dist-tags.latest`,
                'gh auth status; no .git/index.lock (holder reported, never deleted)',
                `tag v${v} absent on origin (git ls-remote --tags origin)`,
            ];
        case 'bump':
            return [
                `refuse unless CHANGELOG.md has "## [${v}]" and "# oh-my-copilot v${v}", and .github/release-body.md mentions ${v}`,
                `npm version ${v} --no-git-tag-version --ignore-scripts --allow-same-version`,
                `stamp ${v}: ${VERSION_STAMPS.map((s) => s.file).join(', ')}`,
                'node scripts/generate-prompt-projections.mjs',
            ];
        case 'build':
            return [
                'npm run build',
                'git add -f dist bridge',
                `tracked dist .js/.d.ts/.map without a src source -> ${opts.fixOrphans ? 'git rm (--fix-orphans)' : 'fail (pass --fix-orphans to remove)'}`,
                'git ls-files --others dist bridge is empty',
                `probes: import dist/index.js; dist/cli/index.js --version == ${v}; bridge/cli.cjs --version == ${v}; dist/mcp/standalone-server.js starts and exits`,
            ];
        case 'gates':
            return [
                'tsc --noEmit',
                'eslint src (0 errors; warnings allowed, same scope as CI Lint)',
                'generate-prompt-projections.mjs --verify; copilot build-hooks.mjs / build-agents.mjs --verify',
                'node scripts/ci/check-multirepo-paths.mjs',
            ];
        case 'smoke': {
            const run = 'OMC_LIVE_SMOKE=2 node bridge/cli.cjs smoke copilot --tier 2 --json (two prompts, about 0.6 AI credits); every check must pass';
            const reuse = `except: the last green smoke is reused (no run) while sha256 of HEAD's ${SMOKE_INPUTS.join(', ')} ids is unchanged (--force-smoke always runs)`;
            if (opts.forceSmoke)
                return [`${run} (--force-smoke: never reused)`];
            return opts.liveSmoke ? [run, reuse] : ['SKIPPED: live Tier 2 smoke not requested (pass --live-smoke; two prompts, about 0.6 AI credits)', reuse];
        }
        case 'commit':
            return [
                `git add -f dist bridge; git add -A; git commit -m "chore(release): v${v}"`,
                'node scripts/generate-inventory-graph.mjs --write; commit inventory/ if changed; --verify',
                'git status --porcelain is empty',
            ];
        case 'suite':
            return [
                opts.suite === 'full'
                    ? `vitest run --reporter=json (on the committed tree); titles not in ${opts.baseline ?? '(no baseline: any failure fails)'} (at most ${TRIAGE_CAP}) rerun alone ${opts.triageRuns ?? 3}x: fail every rerun = real (fail), pass some = mixed (blocked), pass every rerun = load-flaky (warning; known-flaky candidates written, never committed)`
                    : opts.suite === 'targeted' ? 'vitest related --run <src files changed since the last v* tag> (on the committed tree)' : 'suite: none (pass --suite targeted|full)',
            ];
        case 'pr':
            return [
                `git push origin HEAD:refs/heads/${branch} until the PR is merged (plain, never forced; a refused push blocks)`,
                `gh pr create --base dev --head ${branch} (an open one is reused; a merged one when its merge contains HEAD, or the dev tip once a follow-up PR into dev carried HEAD; else blocks)`,
                'wait for CI under the ship merge rule (ship.advisoryChecks never block); one rerun of failed jobs, awaited until its new attempt starts',
                'gh pr merge --admin --merge --match-head-commit <head> when the PR head is local HEAD, ship.allowAdminMerge and dev is a trusted base, else print it',
            ];
        case 'promote':
            return [
                'require the release PR merged into dev (gh pr view); use the dev merge recorded by pr',
                'gh pr create --base main --head dev (reused when one is open)',
                'same CI gate and merge as pr, merged only when the PR head contains the dev merge; the main merge must contain it too; record it',
            ];
        case 'tag':
            return [
                `the main merge commit contains the dev merge and its package.json is ${v}`,
                `confirm (${opts.yes ? '--yes given' : 'interactive; --yes skips'})`,
                `git tag -a v${v} -m v${v} <main merge sha>; v${v}^{} must equal it and be an annotated tag`,
                `git push origin refs/tags/v${v}; git ls-remote confirms the peeled sha`,
            ];
        case 'verify':
            return [
                `find the ci.yml push run of v${v} on the main merge commit; wait; one rerun of failed jobs unless ${v} is already on npm, failing test titles printed`,
                `npm view oh-my-copilot@${v} version dist-tags.latest dist.attestations`,
                `gh release view v${v}: published, not a draft; the Copilot smoke (tier 2) job succeeded`,
            ];
    }
}
class Release {
    deps;
    opts;
    state;
    v;
    deadline;
    pkgName = 'oh-my-copilot';
    constructor(deps, opts, existing) {
        this.deps = deps;
        this.opts = opts;
        this.v = opts.version;
        const at = new Date(deps.now()).toISOString();
        this.state = existing ?? { version: 1, release: this.v, createdAt: at, updatedAt: at, phases: {}, reruns: {} };
        this.deadline = deps.now() + (opts.timeoutMinutes ?? 60) * 60_000;
    }
    get current() {
        return this.state;
    }
    save(patch) {
        this.state = { ...this.state, ...patch, updatedAt: new Date(this.deps.now()).toISOString() };
        const path = releaseStatePath(this.deps.stateRoot, this.v);
        mkdirSync(join(this.deps.stateRoot, 'release'), { recursive: true });
        atomicWriteJsonSync(path, this.state);
    }
    run(cmd, args, opts) {
        return this.deps.exec(cmd, args, { cwd: this.deps.root, ...opts });
    }
    /** Run and require exit 0; the phase fails with the output tail otherwise. */
    must(cmd, args, what, opts) {
        const r = this.run(cmd, args, opts);
        if (r.status !== 0) {
            const outcome = { status: 'fail', note: `${what ?? `${cmd} ${args.join(' ')}`} failed (exit ${r.status})`, details: tail(`${r.stdout}\n${r.stderr}`) };
            // A gh call that changes state (create, merge, rerun) may have taken effect despite the error: never pending without a check by the caller.
            const mutating = cmd === 'gh' && /^(pr (create|merge)|run rerun)$/.test(args.slice(0, 2).join(' '));
            if (cmd === 'gh' && !mutating && TRANSIENT_GH_ERROR.test(`${r.stdout}\n${r.stderr}`))
                throw new PendingError(outcome);
            throw new PhaseStop(outcome);
        }
        return r.stdout;
    }
    git(...args) {
        return this.must('git', args).trim();
    }
    script(script, ...args) {
        this.deps.log(`  node ${[script, ...args].join(' ')}`);
        this.must(this.deps.node, [script, ...args], `node ${[script, ...args].join(' ')}`);
    }
    file(rel) {
        const path = join(this.deps.root, rel);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }
    readPkgName() {
        const pkg = this.file('package.json');
        if (pkg)
            this.pkgName = JSON.parse(pkg).name ?? this.pkgName;
    }
    async phase(id) {
        this.readPkgName();
        try {
            switch (id) {
                case 'preflight': return this.preflight();
                case 'bump': return this.bump();
                case 'build': return this.build();
                case 'gates': return this.gates();
                case 'suite': return this.suite();
                case 'smoke': return this.smoke();
                case 'commit': return this.commit();
                case 'pr': return await this.pr();
                case 'promote': return await this.promote();
                case 'tag': return await this.tag();
                case 'verify': return await this.verify();
            }
        }
        catch (error) {
            if (error instanceof PhaseStop)
                return error.outcome;
            if (error instanceof PendingError) {
                if (this.opts.drive)
                    throw error;
                return error.outcome;
            }
            const note = error instanceof Error ? error.message : String(error);
            // A gate read that hit a GitHub 5xx (GhChecksError) is retried under --drive.
            if (this.opts.drive && TRANSIENT_GH_ERROR.test(note))
                throw new PendingError({ status: 'fail', note });
            return { status: 'fail', note };
        }
    }
    preflight() {
        const v = this.v;
        const problems = [];
        // Untrimmed: the first line's leading status column is significant.
        // A staged rename reads "orig -> path": clean only when both sides are prose files.
        const dirty = this.must('git', ['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
            .map((l) => l.slice(3))
            .filter((entry) => !entry.split(' -> ').every((p) => PROSE_FILES.includes(p.replace(/^"|"$/g, ''))));
        if (dirty.length > 0)
            problems.push(`working tree is not clean: ${dirty.join(', ')}`);
        const branch = this.git('rev-parse', '--abbrev-ref', 'HEAD');
        if (branch !== `release/v${v}`)
            problems.push(`HEAD is ${branch}, expected release/v${v} (git checkout -b release/v${v} origin/dev)`);
        this.must('git', ['fetch', 'origin', 'dev']);
        if (this.run('git', ['merge-base', '--is-ancestor', 'refs/remotes/origin/dev', 'HEAD']).status !== 0) {
            problems.push('HEAD does not contain origin/dev (git merge origin/dev; never rebase)');
        }
        const devPkg = this.run('git', ['show', 'refs/remotes/origin/dev:package.json']);
        const devVersion = devPkg.status === 0 ? JSON.parse(devPkg.stdout).version : undefined;
        if (!devVersion)
            problems.push('could not read package.json on origin/dev');
        else if (compareVersions(v, devVersion) <= 0)
            problems.push(`${v} is not above origin/dev's version ${devVersion}`);
        const latest = this.run('npm', ['view', this.pkgName, 'dist-tags.latest']);
        if (latest.status === 0) {
            const published = latest.stdout.trim();
            if (published && compareVersions(v, published) <= 0)
                problems.push(`${v} is not above npm latest ${published}`);
        }
        else if (!/E404/.test(latest.stderr))
            problems.push(`npm view ${this.pkgName} failed: ${tail(latest.stderr, 1).join('')}`);
        if (this.run('gh', ['auth', 'status']).status !== 0)
            problems.push('gh is not authenticated (gh auth login)');
        const lockRel = this.git('rev-parse', '--git-path', 'index.lock');
        const lock = isAbsolute(lockRel) ? lockRel : join(this.deps.root, lockRel);
        if (existsSync(lock)) {
            problems.push(`${lock} exists; another git process may hold it (not deleted; remove it only when no git process runs): ${this.gitProcesses()}`);
        }
        const remoteTag = this.run('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${v}`]);
        if (remoteTag.status !== 0)
            problems.push(`git ls-remote --tags origin failed: ${tail(remoteTag.stderr, 1).join('')}`);
        else if (remoteTag.stdout.trim())
            problems.push(`tag v${v} already exists on origin`);
        if (problems.length > 0)
            fail(`${problems.length} preflight problem(s)`, problems);
        // A fresh start never reuses the PRs, merges or tag run of an earlier attempt.
        this.save({ branch, headSha: undefined, suiteSha: undefined, suiteRan: undefined, suiteTriage: undefined, devPr: undefined, devMergeSha: undefined, mainPr: undefined, mainMergeSha: undefined, tagRunId: undefined });
        return { status: 'ok', note: `on release/v${v} over origin/dev ${devVersion}` };
    }
    gitProcesses() {
        const r = process.platform === 'win32'
            ? this.run('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'])
            : this.run('ps', ['-eo', 'pid,args']);
        const lines = r.stdout.split(/\r?\n/).filter((l) => /git(?:\.exe)?\b/i.test(l) && !/INFO:/.test(l));
        return lines.length > 0 ? lines.slice(0, 5).join(' | ') : 'no running git process found';
    }
    bump() {
        const v = this.v;
        const prose = releaseProseProblems(v, this.file('CHANGELOG.md'), this.file('.github/release-body.md'));
        if (prose.length > 0)
            fail('release prose is missing (write it, then re-run)', prose);
        const pkg = JSON.parse(this.file('package.json') ?? '{}');
        if (pkg.version !== v)
            this.must('npm', ['version', v, '--no-git-tag-version', '--ignore-scripts', '--allow-same-version']);
        const missing = [];
        for (const stamp of VERSION_STAMPS) {
            const content = this.file(stamp.file);
            const next = content === null ? null : stampVersion(content, stamp, v);
            if (next === null)
                missing.push(`${stamp.file}: no version stamp`);
            else if (next !== content)
                writeFileSync(join(this.deps.root, stamp.file), next);
        }
        if (missing.length > 0)
            fail('version stamps missing', missing);
        this.script('scripts/generate-prompt-projections.mjs');
        return { status: 'ok', note: `version ${v} stamped in package.json and ${VERSION_STAMPS.length} files` };
    }
    build() {
        const v = this.v;
        this.deps.log('  npm run build');
        this.must('npm', ['run', 'build'], 'npm run build');
        this.git('add', '-f', 'dist', 'bridge');
        const tracked = this.git('ls-files', 'dist').split(/\r?\n/).filter(Boolean);
        const orphans = findDistOrphans(tracked, (p) => existsSync(join(this.deps.root, p)));
        if (orphans.length > 0) {
            if (!this.opts.fixOrphans)
                fail(`${orphans.length} dist file(s) without a src source (re-run with --fix-orphans to remove them)`, orphans);
            for (let i = 0; i < orphans.length; i += 100)
                this.git('rm', '-q', '--', ...orphans.slice(i, i + 100));
        }
        const untracked = this.git('ls-files', '--others', 'dist', 'bridge');
        if (untracked)
            fail('untracked files under dist/ or bridge/ after git add -f', untracked.split(/\r?\n/));
        const probes = [];
        const importProbe = this.run(this.deps.node, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(join(this.deps.root, 'dist', 'index.js')).href]);
        if (importProbe.status !== 0)
            probes.push(`import dist/index.js failed: ${tail(importProbe.stderr, 3).join(' ')}`);
        for (const entry of ['dist/cli/index.js', 'bridge/cli.cjs']) {
            const r = this.run(this.deps.node, [entry, '--version']);
            if (r.status !== 0 || r.stdout.trim() !== v)
                probes.push(`${entry} --version printed ${JSON.stringify(r.stdout.trim())} (exit ${r.status}), expected ${v}`);
        }
        // stdin is closed at once: the server must start, see EOF and exit 0.
        const mcp = this.run(this.deps.node, ['dist/mcp/standalone-server.js'], { timeoutMs: 30_000 });
        if (mcp.status !== 0)
            probes.push(`dist/mcp/standalone-server.js did not start and exit cleanly (exit ${mcp.status}): ${tail(mcp.stderr, 3).join(' ')}`);
        if (probes.length > 0)
            fail('build probes failed', probes);
        return { status: 'ok', note: `built and staged${orphans.length > 0 ? `; removed ${orphans.length} orphan(s)` : ''}` };
    }
    /** eslint src; a failure keeps the first error lines as well as the summary at the end. */
    eslint() {
        const args = ['node_modules/eslint/bin/eslint.js', 'src'];
        this.deps.log(`  node ${args.join(' ')}`);
        const r = this.run(this.deps.node, args);
        if (r.status === 0)
            return;
        const lines = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/);
        const errors = lines.filter((l) => /^\s+\d+:\d+\s+error\b/.test(l)).slice(0, 20);
        fail(`node ${args.join(' ')} failed (exit ${r.status})`, [...errors, ...(errors.length > 0 ? ['...'] : []), ...lines.slice(-5)]);
    }
    gates() {
        this.script('node_modules/typescript/bin/tsc', '--noEmit');
        this.eslint();
        this.script('scripts/generate-prompt-projections.mjs', '--verify');
        this.script('scripts/copilot/build-hooks.mjs', '--verify');
        this.script('scripts/copilot/build-agents.mjs', '--verify');
        this.script('scripts/ci/check-multirepo-paths.mjs');
        return { status: 'ok', note: 'gates green' };
    }
    /** After the commit phase: tests of committed state (pack, committed docs, inventory drift) need the release commits. */
    suite() {
        const suite = this.opts.suite ?? 'none';
        const head = this.git('rev-parse', 'HEAD');
        this.save({ suiteSha: head, suiteRan: suite });
        if (suite === 'targeted') {
            const tag = this.run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']);
            if (tag.status !== 0)
                fail('no v* tag reachable from HEAD for --suite targeted', tail(tag.stderr, 2));
            const changed = this.git('diff', '--name-only', `${tag.stdout.trim()}...HEAD`, '--', 'src')
                .split(/\r?\n/).filter((f) => /\.(?:ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts') && existsSync(join(this.deps.root, f)));
            if (changed.length === 0)
                return { status: 'ok', note: `suite: no src changes since ${tag.stdout.trim()} for the targeted suite` };
            const args = ['node_modules/vitest/vitest.mjs', 'related', '--run', '--exclude', 'tests/perf/**', ...changed];
            this.deps.log(`  node ${args.join(' ')}`);
            this.must(this.deps.node, args, `node ${args.join(' ')}`, { suiteEnv: true });
            this.requireClean('targeted suite');
            return { status: 'ok', note: `targeted suite over ${changed.length} changed src file(s)` };
        }
        if (suite === 'full') {
            const out = join(this.deps.stateRoot, 'release', `${this.v}-vitest.json`);
            mkdirSync(join(this.deps.stateRoot, 'release'), { recursive: true });
            // A report (or candidate list) left by an earlier run must not pass for this one.
            rmSync(out, { force: true });
            rmSync(flakyCandidatesPath(this.deps.stateRoot, this.v), { force: true });
            this.deps.log(`  node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=${out}`);
            const r = this.run(this.deps.node, ['node_modules/vitest/vitest.mjs', 'run', '--exclude', 'tests/perf/**', '--reporter=json', `--outputFile=${out}`], { suiteEnv: true });
            if (!existsSync(out))
                fail(`vitest wrote no JSON report (exit ${r.status})`, tail(r.stderr));
            const failing = failingTitlesFromVitestJson(readFileSync(out, 'utf8'));
            const baseline = this.opts.baseline ? parseBaselineTitles(readFileSync(this.opts.baseline, 'utf8')) : [];
            const fresh = newFailures(failing, baseline);
            if (fresh.length > TRIAGE_CAP)
                fail(`${fresh.length} failing test(s) not in the baseline, more than the ${TRIAGE_CAP} triaged in isolation (report: ${out})`, fresh);
            if (fresh.length === 0) {
                this.requireClean('full suite');
                return { status: 'ok', note: `full suite: ${failing.length} failing, all in the baseline` };
            }
            const triage = this.triage(fresh, head);
            const lines = triage.map((t) => `${t.class}: ${t.title} (passed ${t.passes}/${t.runs} isolated reruns)`);
            const real = triage.filter((t) => t.class === 'real').length;
            const mixed = triage.filter((t) => t.class === 'mixed').length;
            const candidates = flakyCandidates(this.v, triage);
            const candidatesPath = flakyCandidatesPath(this.deps.stateRoot, this.v);
            if (candidates.length > 0) {
                atomicWriteJsonSync(candidatesPath, {
                    $comment: `Known-flaky candidates of the v${this.v} release suite (omg release triage). Never applied automatically: the owner copies approved entries (file, title, note) into .github/known-flaky-tests.json.`,
                    release: this.v,
                    sha: head,
                    tests: candidates,
                });
            }
            if (real > 0)
                fail(`${real} failing test(s) not in the baseline also fail every isolated rerun (report: ${out})`, lines);
            if (mixed > 0) {
                blocked(`${mixed} failing test(s) not in the baseline failed some isolated reruns (mixed, may be a real race: blocks); fix them, then --from suite (evidence: ${candidatesPath})`, lines);
            }
            this.requireClean('full suite');
            const note = `full suite: ${failing.length} failing; ${fresh.length} not in the baseline are load-flaky (passed every isolated rerun); ${candidates.length} known-flaky candidate(s) await owner approval: ${candidatesPath}`;
            this.deps.log(`  !! WARNING ${note}`);
            return { status: 'ok', note, details: lines };
        }
        this.deps.log('  !! SKIPPED the vitest suite (--suite none). The runbook requires --suite full before the PR: re-run with --from suite --suite full --baseline <report>.');
        return { status: 'skipped', note: 'vitest suite not run (--suite none)' };
    }
    /**
     * Each new failing full-suite title alone, `triageRuns` times, sequentially
     * with the suite env: passing every isolated run means it failed only under
     * the suite's load. Saved after each title, so a re-run on the same HEAD
     * does not repeat finished titles.
     */
    triage(titles, head) {
        const runs = this.opts.triageRuns ?? 3;
        const timeoutMs = (this.opts.triageTimeoutMinutes ?? 5) * 60_000;
        const prior = this.state.suiteTriage?.sha === head ? this.state.suiteTriage.results : [];
        const out = join(this.deps.stateRoot, 'release', `${this.v}-triage.json`);
        const results = [];
        for (const [i, title] of titles.entries()) {
            const { file, name } = splitFailingTitle(title);
            let result = prior.find((r) => r.title === title && r.runs === (name === null ? 0 : runs));
            if (!result) {
                let passes = 0;
                for (let n = 0; name !== null && n < runs; n++) {
                    rmSync(out, { force: true });
                    // One --testNamePattern=<pattern> argument: a title starting with "-" is never read as a flag.
                    const args = ['node_modules/vitest/vitest.mjs', 'run', file, `--testNamePattern=${escapeRe(name)}`, '--reporter=json', `--outputFile=${out}`];
                    this.deps.log(`  node ${args.slice(0, 3).join(' ')} ${JSON.stringify(args[3])} --reporter=json (isolated rerun ${n + 1}/${runs})`);
                    const r = this.run(this.deps.node, args, { suiteEnv: true, timeoutMs });
                    // A pass is exit 0 AND the report saying the test passed; a timeout or crash exits non-zero.
                    if (r.status === 0 && existsSync(out) && testPassedInReport(readFileSync(out, 'utf8'), file, name))
                        passes++;
                }
                result = { title, file, runs: name === null ? 0 : runs, passes, class: classifyTriage(runs, passes, name === null) };
            }
            results.push(result);
            this.save({ suiteTriage: { sha: head, results: [...results, ...prior.filter((p) => !results.some((r) => r.title === p.title))] } });
            this.deps.progress({ phase: 'suite', status: 'heartbeat', note: `triage ${i + 1}/${titles.length}: ${result.class}, passed ${result.passes}/${result.runs} isolated reruns: ${title}` });
        }
        rmSync(out, { force: true });
        return results;
    }
    /** sha256 of HEAD's object ids for SMOKE_INPUTS: the committed tree, since smoke runs after commit. */
    smokeInputs() {
        return smokeInputHash(SMOKE_INPUTS.map((p) => {
            const r = this.run('git', ['rev-parse', '-q', '--verify', `HEAD:${p}`]);
            return [p, r.status === 0 ? r.stdout.trim() : null];
        }));
    }
    /** The installed Copilot CLI version, found as the smoke finds the binary; 'unknown' when absent. */
    copilotVersion() {
        const { bin } = resolveCopilotBinary(undefined, process.env);
        if (!bin)
            return 'unknown';
        const v = parseCopilotVersion(this.run(bin, ['--version']).stdout);
        return v ? `v${v}` : 'unknown';
    }
    smoke() {
        const head = this.git('rev-parse', 'HEAD');
        const inputHash = this.smokeInputs();
        const last = this.state.lastSmoke;
        if (!this.opts.forceSmoke && last?.inputHash === inputHash) {
            const note = `reused the green Tier 2 smoke of ${last.headSha.slice(0, 12)} run at ${last.at} (inputs identical, hash ${inputHash.slice(0, 12)}, Copilot CLI ${this.copilotVersion()}; --force-smoke re-runs it)`;
            this.deps.log(`  ${note}`);
            return { status: 'ok', note, details: [`input hash ${inputHash}`, `original smoke: ${last.at} on ${last.headSha}`] };
        }
        if (!this.opts.liveSmoke && !this.opts.forceSmoke) {
            const why = last ? ` (the smoke inputs changed since the green smoke of ${last.headSha.slice(0, 12)})` : '';
            this.deps.log(`  !! SKIPPED the live Tier 2 smoke${why}. The runbook requires it green before tagging: re-run with --from smoke --live-smoke (two prompts, about 0.6 AI credits).`);
            return { status: 'skipped', note: `live Tier 2 smoke not run (pass --live-smoke)${why}` };
        }
        this.deps.log('  OMC_LIVE_SMOKE=2 node bridge/cli.cjs smoke copilot --tier 2 --json');
        const r = this.run(this.deps.node, ['bridge/cli.cjs', 'smoke', 'copilot', '--tier', '2', '--json'], { env: { OMC_LIVE_SMOKE: '2' } });
        const problems = smokeProblems(r.stdout);
        if (r.status !== 0 && problems.length === 0)
            problems.push(`smoke exited ${r.status}${r.status === 2 ? ' (copilot binary or SDK missing: not a pass)' : ''}`);
        if (problems.length > 0) {
            // A red smoke on these inputs: an earlier green one must not be reused for them.
            if (last)
                this.save({ lastSmoke: undefined });
            fail('Tier 2 smoke is not green', problems);
        }
        this.requireClean('live smoke');
        this.save({ lastSmoke: { inputHash, headSha: head, at: new Date(this.deps.now()).toISOString() } });
        return { status: 'ok', note: `Tier 2 smoke green (input hash ${inputHash.slice(0, 12)})` };
    }
    /** Files a suite or smoke run leaves behind would be swept into the release commit by a later --from build / gates. */
    requireClean(what) {
        const left = this.git('status', '--porcelain');
        if (left)
            fail(`the ${what} left files in the working tree; remove them (they must not reach the release commit), then re-run`, left.split(/\r?\n/));
    }
    staged(paths = []) {
        return this.run('git', ['diff', '--cached', '--quiet', ...(paths.length ? ['--', ...paths] : [])]).status !== 0;
    }
    commit() {
        const v = this.v;
        this.git('add', '-f', 'dist', 'bridge');
        this.git('add', '-A');
        const notes = [];
        if (this.staged()) {
            this.git('commit', '-m', `chore(release): v${v}`);
            notes.push('release commit');
        }
        this.script('scripts/generate-inventory-graph.mjs', '--write');
        this.git('add', '-A', '--', 'inventory');
        if (this.staged(['inventory'])) {
            this.git('commit', '-m', `chore(release): regenerate inventory for v${v}`, '--', 'inventory');
            notes.push('inventory commit');
        }
        this.script('scripts/generate-inventory-graph.mjs', '--verify');
        const left = this.git('status', '--porcelain');
        if (left)
            fail('working tree is not clean after the release commits', left.split(/\r?\n/));
        const head = this.git('rev-parse', 'HEAD');
        this.save({ headSha: head });
        return { status: 'ok', note: notes.length > 0 ? `${notes.join(' + ')} at ${head.slice(0, 12)}` : 'nothing new to commit' };
    }
    /** Exit 1 is "no"; any other non-zero exit (missing object, bad ref) is a git error, never a yes. */
    isAncestor(ancestor, descendant) {
        const r = this.run('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
        if (r.status === 0)
            return true;
        if (r.status === 1)
            return false;
        return fail(`git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${r.status}): ${r.stderr.trim() || '(no stderr)'}`);
    }
    viewPr(pr) {
        return JSON.parse(this.must('gh', ['pr', 'view', String(pr), '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefOid,url,mergeCommit']));
    }
    /** The merge commit of a merged PR, else null. */
    mergedSha(pr) {
        const view = this.viewPr(pr);
        const sha = view.state === 'MERGED' ? view.mergeCommit?.oid : undefined;
        return sha && FULL_SHA.test(sha) ? sha : null;
    }
    /** Why the phases before `start` may not be skipped (empty = they may): the state's checkout, then each phase's postconditions. */
    skipProblems(start) {
        const problems = [];
        // Once main is merged, tag / verify no longer need the release checkout: the merge and tag checks carry them.
        const released = !!this.state.mainMergeSha && PHASES.indexOf(start) >= PHASES.indexOf('tag');
        const checks = [['state', () => (released ? null : this.provenanceProblem())]];
        // Past commit, HEAD is the release: uncommitted changes (a rebuilt dist, a src edit) would be left out of what pr pushes.
        if (!released && PHASES.indexOf(start) > PHASES.indexOf('commit')) {
            checks.push(['tree', () => {
                    const left = this.git('status', '--porcelain');
                    return left ? `uncommitted changes are not in the release commit (${left.split(/\r?\n/).join(', ')}); commit them and re-run --from build, or remove them` : null;
                }]);
        }
        checks.push(...PHASES.slice(0, PHASES.indexOf(start)).map((id) => [id, () => this.postconditionProblem(id, released)]));
        for (const [what, check] of checks) {
            try {
                const problem = check();
                if (problem)
                    problems.push(`${what}: ${problem}`);
            }
            catch (error) {
                // A transient GitHub error while re-checking is no verdict on the phase: the drive loop retries.
                if (error instanceof PendingError && this.opts.drive)
                    throw error;
                problems.push(`${what}: ${error instanceof PhaseStop || error instanceof PendingError ? error.outcome.note : error instanceof Error ? error.message : String(error)}`);
            }
        }
        return problems;
    }
    /** Why the recorded state does not belong to this checkout (null = it does). */
    provenanceProblem() {
        const { branch, headSha } = this.state;
        if (branch) {
            const current = this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
            if (current !== branch)
                return `HEAD is ${current || '(unknown)'}, but this release state was recorded on ${branch}`;
        }
        if (headSha && !this.isAncestor(headSha, 'HEAD'))
            return `HEAD does not descend from the recorded release commit ${headSha.slice(0, 12)}`;
        return null;
    }
    /**
     * Why a phase may not be skipped (null = its recorded result still holds):
     * it must have passed, and the facts later phases build on are re-checked
     * cheaply (read-only git / gh).
     */
    postconditionProblem(id, released = false) {
        const s = this.state;
        const status = s.phases[id]?.status;
        if (status !== 'ok' && status !== 'skipped')
            return `has not passed (run it: --from ${id})`;
        switch (id) {
            case 'bump': {
                // Once main is merged, the tag phase checks the version at the main merge instead.
                if (released)
                    return null;
                const version = JSON.parse(this.file('package.json') ?? '{}').version;
                return version === this.v ? null : `package.json version is ${version ?? 'missing'}, not ${this.v} (--from bump)`;
            }
            case 'commit': {
                if (!s.headSha || !FULL_SHA.test(s.headSha))
                    return 'no release commit recorded (--from commit)';
                if (released)
                    return null;
                const head = this.git('rev-parse', 'HEAD');
                if (head === s.headSha)
                    return null;
                // Always back through build: src, scripts, templates, package.json and the build config all feed dist/ and bridge/.
                return `HEAD ${head.slice(0, 12)} is not the recorded release commit ${s.headSha.slice(0, 12)}; new local commits must go back through the build, the gates and the suite (--from build)`;
            }
            case 'suite': {
                if (released)
                    return null;
                if (!s.suiteSha || s.suiteSha !== s.headSha)
                    return 'the suite did not run on the recorded release commit (--from suite)';
                const ran = s.suiteRan ?? 'none';
                const required = this.opts.suite ?? 'none';
                return SUITE_RANK[ran] < SUITE_RANK[required] ? `the suite ran at --suite ${ran}, below the --suite ${required} this release requires (--from suite --suite ${required})` : null;
            }
            case 'smoke':
                return this.opts.liveSmoke && status === 'skipped' ? 'the live smoke was skipped (--from smoke --live-smoke)' : null;
            case 'pr': {
                if (s.devPr === undefined || !s.devMergeSha)
                    return 'no merged release PR into dev recorded (--from pr)';
                const sha = this.mergedSha(s.devPr);
                if (!sha)
                    return `PR #${s.devPr} is not merged, not at the recorded ${s.devMergeSha.slice(0, 12)} (--from pr)`;
                if (!s.headSha)
                    return 'no release commit recorded (--from commit)';
                this.must('git', ['fetch', 'origin', 'dev']);
                // The recorded dev merge is the PR's merge, or the dev commit of a follow-up PR that contains it (see land).
                if (sha !== s.devMergeSha && !this.isAncestor(sha, s.devMergeSha))
                    return `PR #${s.devPr} is merged at ${sha.slice(0, 12)}, which the recorded dev merge ${s.devMergeSha.slice(0, 12)} does not contain (--from pr)`;
                return this.isAncestor(s.headSha, s.devMergeSha) ? null : `the dev merge ${s.devMergeSha.slice(0, 12)} does not contain the release commit ${s.headSha.slice(0, 12)} (--from pr)`;
            }
            case 'promote': {
                if (s.mainPr === undefined || !s.mainMergeSha || !s.devMergeSha)
                    return 'no main merge commit recorded (--from promote)';
                const sha = this.mergedSha(s.mainPr);
                if (sha !== s.mainMergeSha)
                    return `PR #${s.mainPr} is ${sha ? `merged at ${sha.slice(0, 12)}` : 'not merged'}, not at the recorded ${s.mainMergeSha.slice(0, 12)} (--from promote)`;
                this.must('git', ['fetch', 'origin', 'dev', 'main']);
                return this.isAncestor(s.devMergeSha, s.mainMergeSha) ? null : `the main merge ${s.mainMergeSha.slice(0, 12)} does not contain the dev merge ${s.devMergeSha.slice(0, 12)}`;
            }
            case 'tag': {
                const remote = remoteTagTarget(this.git('ls-remote', '--tags', 'origin', `refs/tags/v${this.v}`, `refs/tags/v${this.v}^{}`), `v${this.v}`);
                return remote?.annotated && remote.commit === s.mainMergeSha ? null : `v${this.v} on origin does not peel to the main merge commit (--from tag)`;
            }
            default:
                return null;
        }
    }
    findPr(head, base, states) {
        const out = this.must('gh', ['pr', 'list', '--head', head, '--base', base, '--state', states, '--json', 'number,state,headRefOid,mergeCommit', '--limit', '10']);
        const prs = JSON.parse(out || '[]');
        const open = prs.find((p) => p.state === 'OPEN');
        if (open)
            return open.number;
        const merged = prs.filter((p) => p.state === 'MERGED' && FULL_SHA.test(p.mergeCommit?.oid ?? ''));
        if (merged.length === 0)
            return undefined;
        this.must('git', ['fetch', 'origin', base]);
        // Reused as is when its merge contains HEAD; any other merged PR is returned too, so land() blocks on it
        // (or accepts a follow-up merge into the base) instead of opening a second release PR.
        return (merged.find((p) => this.isAncestor('HEAD', p.mergeCommit.oid)) ?? merged[0]).number;
    }
    createPr(base, head, title) {
        const r = this.run('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '.github/release-body.md']);
        if (r.status !== 0) {
            const output = `${r.stdout}\n${r.stderr}`;
            const outcome = { status: 'fail', note: `gh pr create failed (exit ${r.status})`, details: tail(output) };
            if (!TRANSIENT_GH_ERROR.test(output))
                throw new PhaseStop(outcome);
            // The failed call may have created the PR: reuse an open one, else retry next round.
            const open = this.findPr(head, base, 'open');
            if (open !== undefined)
                return open;
            throw new PendingError(outcome);
        }
        const out = r.stdout;
        const m = /\/pull\/(\d+)/.exec(out);
        if (!m)
            fail(`gh pr create printed no PR url: ${out.trim()}`);
        return Number(m[1]);
    }
    async pr() {
        const smoke = this.state.phases.smoke?.status;
        if (smoke !== 'ok' && !this.opts.allowSkippedSmoke) {
            blocked(`the live smoke ${smoke === 'skipped' ? 'was skipped' : 'has not passed'}; run it (--from smoke --live-smoke, two prompts, about 0.6 AI credits), or pass --allow-skipped-smoke to release without it`);
        }
        const branch = `release/v${this.v}`;
        // Pushed on every run until merged, so commits added after a failure reach the PR.
        if (this.state.devPr === undefined || this.viewPr(this.state.devPr).state !== 'MERGED') {
            const push = this.run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
            if (push.status !== 0) {
                blocked(`git push origin HEAD:refs/heads/${branch} was refused; never force: git fetch origin ${branch} && git merge origin/${branch}, then re-run omg release ${this.v} --from pr`, tail(push.stderr, 5));
            }
            if (this.state.devPr === undefined) {
                const pr = this.findPr(branch, 'dev', 'all') ?? this.createPr('dev', branch, `chore(release): v${this.v}`);
                this.save({ devPr: pr });
            }
        }
        const sha = await this.land(this.state.devPr, 'dev', 'pr', this.git('rev-parse', 'HEAD'));
        this.save({ devMergeSha: sha });
        return { status: 'ok', note: `PR #${this.state.devPr} merged into dev at ${sha.slice(0, 12)}` };
    }
    async promote() {
        const devPr = this.state.devPr;
        if (devPr === undefined)
            fail('no release PR into dev recorded; run the pr phase first');
        if (!this.mergedSha(devPr))
            fail(`release PR #${devPr} is not merged into dev; re-run omg release ${this.v} --from pr`);
        // Recorded by the pr phase: the release PR's merge, or the follow-up dev commit that contains it and HEAD.
        const devMerge = this.state.devMergeSha;
        if (!devMerge || !FULL_SHA.test(devMerge))
            fail(`no dev merge commit recorded; re-run omg release ${this.v} --from pr`);
        if (this.state.mainPr === undefined) {
            const pr = this.findPr('dev', 'main', 'open') ?? this.createPr('main', 'dev', `Release v${this.v}`);
            this.save({ mainPr: pr });
        }
        const sha = await this.land(this.state.mainPr, 'main', 'promote', undefined, devMerge);
        this.must('git', ['fetch', 'origin', 'dev', 'main']);
        if (!this.isAncestor(devMerge, sha))
            fail(`PR #${this.state.mainPr} merged into main at ${sha.slice(0, 12)}, which does not contain the dev merge ${devMerge.slice(0, 12)}`);
        this.save({ mainMergeSha: sha });
        return { status: 'ok', note: `PR #${this.state.mainPr} merged into main at ${sha.slice(0, 12)}` };
    }
    rerunBudget = {
        count: (id) => this.state.reruns[id] ?? 0,
        record: (id) => this.save({ reruns: { ...this.state.reruns, [id]: (this.state.reruns[id] ?? 0) + 1 } }),
    };
    runAttempt(runId) {
        return JSON.parse(this.must('gh', ['run', 'view', runId, '--json', 'attempt']) || '{}').attempt ?? 0;
    }
    /**
     * Rerun each failed run once (budget spent first) and wait until its new
     * attempt exists: right after `gh run rerun` the run still reads as the old
     * failed attempt. True when any rerun was issued.
     */
    async rerunOnce(runIds, phase, pollMs) {
        const ready = runIds.filter((id) => this.rerunBudget.count(id) < 1);
        for (const id of ready) {
            const before = this.runAttempt(id);
            this.rerunBudget.record(id);
            this.deps.log(`  gh run rerun ${id} --failed (the one automatic rerun)`);
            const rr = this.run('gh', ['run', 'rerun', id, '--failed']);
            // A transient error after the rerun took effect (a new attempt exists) is no failure.
            if (rr.status !== 0 && !(TRANSIENT_GH_ERROR.test(`${rr.stdout}\n${rr.stderr}`) && this.runAttempt(id) > before)) {
                throw new PhaseStop({ status: 'fail', note: `gh run rerun ${id} --failed failed (exit ${rr.status})`, details: tail(`${rr.stdout}\n${rr.stderr}`) });
            }
            for (let polls = 0; this.runAttempt(id) <= before; polls++) {
                const note = `run ${id} was rerun but attempt ${before + 1} has not started; re-run omg release ${this.v} --from ${phase}`;
                if (polls >= RERUN_START_POLLS)
                    blocked(note);
                if (this.deps.now() >= this.deadline)
                    pendingWait(note);
                await this.deps.sleep(pollMs);
            }
        }
        return ready.length > 0;
    }
    failingTestsOfJob(jobId) {
        const log = this.run('gh', ['run', 'view', '--job', jobId, '--log']);
        return log.status === 0 ? parseFailingTests(log.stdout).map((t) => (t.title ? `${t.file} > ${t.title}` : t.file)) : [];
    }
    gateDetails(report) {
        const details = report.failed.map((name) => `failed: ${name}`);
        for (const check of report.checks) {
            if (check.class !== 'failed' || !check.jobId)
                continue;
            for (const t of this.failingTestsOfJob(check.jobId))
                details.push(`  ${check.name}: ${t}`);
        }
        return details;
    }
    /**
     * Wait for the PR's checks under the ship merge rule (advisoryChecks never
     * block; config from loadShipConfig: user config + the base's committed
     * config), rerun failed runs once, then admin-merge when the owner allows
     * it; with `expectedHead`, only when the PR head is that commit (an
     * already-merged PR only when its merge, or the base tip after a follow-up
     * PR, contains it), with
     * `requireAncestor`, only when the PR head contains that commit. Returns
     * the merge commit sha.
     */
    async land(pr, base, phase, expectedHead, requireAncestor) {
        for (let round = 0;; round++) {
            if (round >= LAND_ROUNDS)
                blocked(`PR #${pr} is still not merged after ${LAND_ROUNDS} rounds of waiting and merging; check it on GitHub, then re-run omg release ${this.v} --from ${phase}`);
            const view = this.viewPr(pr);
            if (view.state === 'MERGED') {
                const sha = view.mergeCommit?.oid;
                if (!sha || !FULL_SHA.test(sha))
                    fail(`PR #${pr} is merged but gh reported no merge commit`);
                if (expectedHead) {
                    this.must('git', ['fetch', 'origin', base]);
                    if (!this.isAncestor(expectedHead, sha)) {
                        // Follow-up rule: once a later PR into the base carried the missing commits, the base tip,
                        // which contains both the release merge and HEAD, stands in for the release merge.
                        const tip = `refs/remotes/origin/${base}`;
                        if (this.isAncestor(expectedHead, tip) && this.isAncestor(sha, tip))
                            return this.git('rev-parse', tip);
                        blocked(`The release PR #${pr} is merged at ${sha.slice(0, 12)} without commit(s) up to ${expectedHead.slice(0, 12)}. Open a follow-up PR into ${base} for the extra commits and re-run omg release ${this.v} --from ${phase} after it merges (the release then proceeds from the ${base} commit that contains HEAD).`);
                    }
                }
                return sha;
            }
            if (view.state !== 'OPEN')
                fail(`PR #${pr} is ${view.state}`);
            if (view.baseRefName !== base)
                fail(`PR #${pr} targets ${view.baseRefName}, expected ${base}`);
            if (view.isDraft)
                fail(`PR #${pr} is a draft`);
            // Right after a push the view can still name the previous head, whose checks and runs are stale.
            if (expectedHead ? view.headRefOid !== expectedHead : requireAncestor && !this.headContains(requireAncestor, base, view.headRefOid)) {
                await this.awaitHead(pr, expectedHead, requireAncestor, base, phase);
                continue;
            }
            const config = this.deps.loadShipConfig({ exec: this.deps.exec, root: this.deps.root, base, baseSha: view.baseRefOid, repoUrl: prRepoUrl(view.url) });
            const remainingMin = Math.max(0, (this.deadline - this.deps.now()) / 60_000);
            if (remainingMin <= 0)
                pendingWait(`PR #${pr}: CI still pending at the --timeout; re-run omg release ${this.v} --from ${phase}`);
            const { report, timedOut } = await watchGates({
                exec: this.deps.exec,
                pr,
                config: { ...config, watchTimeoutMinutes: Math.min(config.watchTimeoutMinutes || remainingMin, remainingMin) },
                known: loadBaseKnownFlaky(this.deps.exec, this.deps.root, config.trustedBaseCommit, config.knownFlakyFile),
                cwd: this.deps.root,
                headSha: view.headRefOid,
                watch: true,
                reruns: this.rerunBudget,
                sleep: this.deps.sleep,
                now: this.deps.now,
                onReport: (r) => this.deps.progress({ phase, status: 'heartbeat', note: `PR #${pr} gates ${r.verdict}: ${r.pending.length} pending, ${r.failed.length} failed` }),
                retryTransient: this.opts.drive,
                onTransient: (message) => this.deps.progress({ phase, status: 'heartbeat', note: `PR #${pr}: transient GitHub error, retrying (${message.slice(0, 120)})` }),
            });
            if (report.verdict === 'green') {
                const command = ['pr', 'merge', String(pr), '--admin', '--merge', '--match-head-commit', view.headRefOid];
                if (!config.allowAdminMerge || !config.trustedBases.includes(base)) {
                    blocked(`PR #${pr} is green; ship.allowAdminMerge is off or ${base} is not a trusted base, so run the merge yourself, then re-run omg release ${this.v} --from ${phase}`, [`gh ${command.join(' ')}`]);
                }
                await this.merge(pr, command);
                continue;
            }
            if (report.verdict === 'pending' || timedOut)
                continue;
            // Never rerun or fail on a verdict read for a head the PR has since left.
            if (this.viewPr(pr).headRefOid !== view.headRefOid)
                continue;
            // failed, or flaky out of budget: one rerun per run whose jobs have all finished.
            const failedRuns = [...new Set(report.checks.filter((c) => c.class === 'failed' && c.runId).map((c) => c.runId))];
            const finished = failedRuns.filter((id) => !report.checks.some((c) => c.runId === id && c.class === 'pending'));
            if (finished.length < failedRuns.length) {
                await this.deps.sleep(config.pollIntervalSeconds * 1000);
                continue;
            }
            if (await this.rerunOnce(finished, phase, config.pollIntervalSeconds * 1000))
                continue;
            fail(`PR #${pr}: CI failed after the one automatic rerun`, this.gateDetails(report));
        }
    }
    /** Whether the PR head contains `commit` (after fetching dev and the base). */
    headContains(commit, base, head) {
        this.must('git', ['fetch', 'origin', 'dev', base]);
        return this.isAncestor(commit, head);
    }
    /**
     * Poll until the PR head is `expected`, or contains `ancestor` when no exact
     * head is given (GitHub lags a push); blocked after HEAD_SYNC_POLLS polls or the --timeout.
     */
    async awaitHead(pr, expected, ancestor, base, phase) {
        for (let polls = 0;; polls++) {
            const view = this.viewPr(pr);
            if (view.state !== 'OPEN')
                return;
            if (expected ? view.headRefOid === expected : this.headContains(ancestor, base, view.headRefOid))
                return;
            const note = expected
                ? `PR #${pr} head is ${view.headRefOid.slice(0, 12)}, not local HEAD ${expected.slice(0, 12)}; push or merge until they match, then re-run omg release ${this.v} --from ${phase}`
                : `PR #${pr} head ${view.headRefOid.slice(0, 12)} does not contain ${ancestor.slice(0, 12)}; update the PR, then re-run omg release ${this.v} --from ${phase}`;
            // Three minutes of a head that does not move is a real mismatch, whatever --timeout is left: the limit is
            // independent of the deadline, or a short --timeout would make every round pending and never block.
            if (polls >= HEAD_SYNC_POLLS)
                blocked(note);
            await this.deps.sleep(HEAD_SYNC_POLL_MS);
        }
    }
    /**
     * `gh pr merge`, retried up to twice with backoff on a transient GitHub error
     * only (5xx, GraphQL "Something went wrong"); a policy or conflict refusal
     * fails at once. A retry first checks whether the failed call merged anyway.
     */
    async merge(pr, command) {
        for (let attempt = 0;; attempt++) {
            this.deps.log(`  gh ${command.join(' ')}`);
            const r = this.run('gh', command);
            if (r.status === 0)
                return;
            const output = `${r.stdout}\n${r.stderr}`;
            const transient = TRANSIENT_GH_ERROR.test(output);
            if (attempt >= MERGE_RETRY_BACKOFF_MS.length || !transient) {
                const outcome = { status: 'fail', note: `gh ${command.join(' ')} failed (exit ${r.status})`, details: tail(output) };
                // Out of retries on a transient error: under --drive the next round re-views the PR (merged anyway?) and retries.
                throw transient ? new PendingError(outcome) : new PhaseStop(outcome);
            }
            this.deps.log(`  transient GitHub error; retrying gh pr merge in ${MERGE_RETRY_BACKOFF_MS[attempt] / 1000} s`);
            await this.deps.sleep(MERGE_RETRY_BACKOFF_MS[attempt]);
            if (this.viewPr(pr).state === 'MERGED')
                return;
        }
    }
    async tag() {
        const v = this.v;
        const tag = `v${v}`;
        const sha = this.state.mainMergeSha;
        if (!sha || !FULL_SHA.test(sha))
            fail('no main merge commit recorded; run the promote phase first');
        const remote = remoteTagTarget(this.git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`), tag);
        if (remote) {
            if (remote.annotated && remote.commit === sha)
                return { status: 'ok', note: `${tag} already on origin at ${sha.slice(0, 12)}` };
            fail(`${tag} exists on origin at ${remote.commit.slice(0, 12)}${remote.annotated ? '' : ' (lightweight)'}, not the main merge commit ${sha.slice(0, 12)}`);
        }
        const devMerge = this.state.devMergeSha;
        if (!devMerge || !FULL_SHA.test(devMerge))
            fail('no dev merge commit recorded; run the pr phase first');
        this.must('git', ['fetch', 'origin', 'dev', 'main']);
        if (!this.isAncestor(sha, 'refs/remotes/origin/main'))
            fail(`${sha.slice(0, 12)} is not on origin/main`);
        if (!this.isAncestor(devMerge, sha))
            fail(`the main merge ${sha.slice(0, 12)} does not contain the dev merge ${devMerge.slice(0, 12)}`);
        const pkg = this.run('git', ['show', `${sha}:package.json`]);
        let tagged;
        try {
            tagged = JSON.parse(pkg.stdout).version;
        }
        catch {
            tagged = undefined;
        }
        if (pkg.status !== 0 || tagged !== v)
            fail(`package.json on the main merge ${sha.slice(0, 12)} is ${tagged ?? 'unreadable'}, not ${v}`);
        const local = this.run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
        if (local.status === 0) {
            const problem = tagTargetProblem(tag, this.git('cat-file', '-t', `refs/tags/${tag}`), this.git('rev-parse', `refs/tags/${tag}^{}`), sha);
            if (problem)
                fail(`a local ${tag} already exists and ${problem} (an upstream tag fetched by name?); delete it yourself (git tag -d ${tag}) and re-run`);
        }
        const smoke = this.state.phases.smoke?.status;
        const warn = smoke === 'ok' ? '' : ` WARNING: the live Tier 2 smoke ${smoke === 'skipped' ? 'was skipped' : 'has not passed'}.`;
        const action = local.status === 0 ? 'Push the existing local' : 'Create and push';
        if (this.opts.yes && smoke !== 'ok')
            this.deps.log(`  !!${warn}`);
        // A drive never prompts (it may run detached, with nobody at the terminal) and never implies --yes.
        if (!this.opts.yes && this.opts.drive) {
            blocked(`${tag} needs confirmation: re-run omg release ${v} --from tag in a terminal to confirm, or with --yes${warn}`);
        }
        if (!this.opts.yes && !(await this.deps.confirm(`${action} annotated tag ${tag} on main ${sha.slice(0, 12)}? This publishes ${this.pkgName}@${v} to npm.${warn}`))) {
            blocked(`${tag} not pushed: the confirmation was declined or there is no interactive terminal (pass --yes to confirm without a prompt)`);
        }
        if (local.status !== 0) {
            this.git('tag', '-a', tag, '-m', tag, sha);
            const problem = tagTargetProblem(tag, this.git('cat-file', '-t', `refs/tags/${tag}`), this.git('rev-parse', `refs/tags/${tag}^{}`), sha);
            if (problem)
                fail(problem);
        }
        this.git('push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
        const pushed = remoteTagTarget(this.git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`), tag);
        if (!pushed?.annotated || pushed.commit !== sha)
            fail(`origin's ${tag} does not peel to ${sha.slice(0, 12)} after the push`);
        return { status: 'ok', note: `${tag} pushed on ${sha.slice(0, 12)}` };
    }
    async verify() {
        const v = this.v;
        const tag = `v${v}`;
        const sha = this.state.mainMergeSha;
        if (!sha || !FULL_SHA.test(sha))
            fail('no main merge commit recorded; run the promote phase first');
        let run;
        for (;;) {
            const runs = JSON.parse(this.must('gh', ['run', 'list', '--workflow', 'ci.yml', '--event', 'push', '--commit', sha, '--json', 'databaseId,headBranch,headSha,event,status,conclusion', '--limit', '50']) || '[]');
            run = runs.filter((r) => r.headBranch === tag && r.headSha === sha && (r.event ?? 'push') === 'push').sort((a, b) => b.databaseId - a.databaseId)[0];
            if (run)
                this.save({ tagRunId: run.databaseId });
            if (run?.status === 'completed') {
                if (run.conclusion === 'success')
                    break;
                const jobs = JSON.parse(this.must('gh', ['run', 'view', String(run.databaseId), '--json', 'jobs'])).jobs ?? [];
                const failedJobs = jobs.filter((j) => j.conclusion && !['success', 'skipped'].includes(j.conclusion));
                const details = () => failedJobs.flatMap((j) => [`failed job: ${j.name}`, ...this.failingTestsOfJob(String(j.databaseId)).map((t) => `  ${t}`)]);
                // Rerunning a run that already published would republish over the version and fail (runbook: Release Recovery).
                if (this.run('npm', ['view', `${this.pkgName}@${v}`, 'version']).stdout.trim() === v) {
                    const names = failedJobs.map((j) => j.name).join(', ') || '(no job reported)';
                    const rel = this.run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft']);
                    const published = rel.status === 0 && (() => {
                        try {
                            const r = JSON.parse(rel.stdout);
                            return r.tagName === tag && !r.isDraft;
                        }
                        catch {
                            return false;
                        }
                    })();
                    if (published) {
                        fail(`tag run ${run.databaseId} ${run.conclusion}: failed job(s) ${names}; ${this.pkgName}@${v} is on npm and GitHub Release ${tag} is published, so no Release Recovery and no rerun`, [
                            `triage the failed job(s) below; confirm provenance with npm view ${this.pkgName}@${v} version dist-tags dist.attestations`,
                            ...details(),
                        ]);
                    }
                    fail(`tag run ${run.databaseId} ${run.conclusion}, but ${this.pkgName}@${v} is already on npm: not rerun`, [
                        `npm view ${this.pkgName}@${v} version dist-tags dist.attestations: if live with provenance, do NOT rerun the run`,
                        `create the GitHub Release with the Release Recovery workflow (release.yml, workflow_dispatch: tag=${tag} sha=${sha}) or gh release create ${tag} --title ${tag} --notes-file .github/release-body.md`,
                        `then re-run omg release ${v} --from verify`,
                        ...details(),
                    ]);
                }
                if (await this.rerunOnce([String(run.databaseId)], 'verify', 30_000))
                    continue;
                fail(`tag run ${run.databaseId} ${run.conclusion} after the one automatic rerun`, details());
            }
            if (this.deps.now() >= this.deadline)
                pendingWait(`tag run for ${tag} ${run ? `still ${run.status}` : 'not found yet'}; re-run omg release ${v} --from verify`);
            this.deps.progress({ phase: 'verify', status: 'heartbeat', note: run ? `tag run ${run.databaseId} ${run.status}` : `waiting for the ${tag} tag run` });
            await this.deps.sleep(30_000);
        }
        const runId = run.databaseId;
        const problems = [];
        const jobs = JSON.parse(this.must('gh', ['run', 'view', String(runId), '--json', 'jobs'])).jobs ?? [];
        const smokeJob = jobs.find((j) => j.name === 'Copilot smoke (tier 2)');
        if (smokeJob?.conclusion !== 'success')
            problems.push(`Copilot smoke (tier 2) job: ${smokeJob?.conclusion ?? 'not in the tag run'}`);
        const npm = this.run('npm', ['view', `${this.pkgName}@${v}`, 'version', 'dist-tags.latest', 'dist.attestations', '--json']);
        let info = {};
        try {
            info = JSON.parse(npm.stdout || '{}');
        }
        catch {
            info = {};
        }
        if (npm.status !== 0 || info.version !== v)
            problems.push(`npm has no ${this.pkgName}@${v} yet (registry propagation can take ~30 min; re-run --from verify)`);
        if (info['dist-tags.latest'] !== v)
            problems.push(`npm dist-tags.latest is ${JSON.stringify(info['dist-tags.latest'])}, not ${v}`);
        if (!info['dist.attestations'])
            problems.push('npm reports no dist.attestations (SLSA provenance)');
        const rel = this.run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft']);
        const relInfo = rel.status === 0 ? JSON.parse(rel.stdout) : null;
        if (!relInfo || relInfo.tagName !== tag)
            problems.push(`gh release view ${tag} found no release`);
        else if (relInfo.isDraft)
            problems.push(`GitHub Release ${tag} is a draft`);
        if (problems.length > 0)
            fail(`tag run ${runId} is green, but the release is incomplete`, problems);
        return { status: 'ok', note: `${this.pkgName}@${v} is latest with provenance; GitHub Release ${tag} published` };
    }
}
/** First phase to run: --from, else the first phase not yet ok / skipped in the state (runRelease re-checks the skipped ones). */
export function resumePoint(state, from) {
    if (from)
        return from;
    for (const id of PHASES) {
        const s = state?.phases[id]?.status;
        if (s !== 'ok' && s !== 'skipped')
            return id;
    }
    return null;
}
export async function runRelease(deps, requested) {
    const v = requested.version;
    const statePath = releaseStatePath(deps.stateRoot, v);
    const existing = readReleaseState(deps.stateRoot, v);
    const start = resumePoint(existing, requested.from);
    // The suite level is per release, not per run: a resume without --suite keeps the recorded one, a lower one is
    // refused (a forgotten flag must not let pr pass on no suite); --from preflight starts over with this run's.
    const recorded = start === 'preflight' ? undefined : existing?.suite;
    if (requested.suite && recorded && SUITE_RANK[requested.suite] < SUITE_RANK[recorded]) {
        const note = `--suite ${requested.suite} is below the --suite ${recorded} recorded for ${v}; pass --suite ${recorded} (or omit --suite), or start over with --from preflight`;
        deps.log(`[${start ?? 'verify'}] blocked: ${note}`);
        return { ok: false, version: v, dryRun: Boolean(requested.dryRun), statePath, phases: [{ id: start ?? 'verify', status: 'blocked', note }] };
    }
    // The baseline is recorded like the level, so a resume that re-runs the full suite reuses it.
    const baseline = requested.baseline ? resolve(requested.baseline) : start === 'preflight' ? undefined : existing?.baseline;
    const opts = { ...requested, suite: requested.suite ?? recorded ?? 'none', baseline };
    if (requested.baseline && opts.suite !== 'full')
        throw new UsageError(`--baseline needs --suite full (this release's suite is ${opts.suite})`);
    const last = PHASES.indexOf(opts.to ?? 'verify');
    if (start !== null && opts.suite === 'full' && opts.baseline && PHASES.indexOf(start) <= PHASES.indexOf('suite') && last >= PHASES.indexOf('suite') && !existsSync(opts.baseline)) {
        throw new UsageError(`baseline report not found: ${opts.baseline} (pass --baseline again)`);
    }
    if (opts.from && PHASES.indexOf(opts.from) > last)
        throw new UsageError(`--from ${opts.from} comes after --to ${opts.to}`);
    // A resume point past --to means the selected range is already done.
    const selected = start === null ? [] : PHASES.slice(PHASES.indexOf(start), last + 1);
    if (opts.dryRun) {
        return { ok: true, version: v, dryRun: true, statePath, phases: selected.map((id) => ({ id, status: 'planned', note: '', steps: phasePlan(id, v, opts) })) };
    }
    const release = new Release(deps, opts, existing);
    const results = [];
    if (selected.length === 0) {
        deps.log(`release ${v}: every selected phase is already ok (state ${statePath}); pass --from <phase> to re-run one`);
        return { ok: true, version: v, dryRun: false, statePath, phases: [] };
    }
    /** Drive mode: no record for the waiting phase (nor any later one), so a resume without --from starts there. */
    const pendingResult = (id, error) => {
        const kept = Object.fromEntries(Object.entries(release.current.phases).filter(([p]) => PHASES.indexOf(p) < PHASES.indexOf(id)));
        release.save({ phases: kept });
        const note = `pending: ${error.outcome.note}`;
        deps.progress({ phase: id, status: 'heartbeat', note });
        deps.log(`[${id}] ${note}`);
        return { ok: false, version: v, dryRun: false, statePath, phases: results, pending: { phase: id, note: error.outcome.note } };
    };
    // Skipping a phase (resume or --from) needs its recorded result to still hold; --from preflight starts over.
    let skip;
    try {
        skip = selected[0] === 'preflight' ? [] : release.skipProblems(selected[0]);
    }
    catch (error) {
        if (error instanceof PendingError)
            return pendingResult(selected[0], error);
        throw error;
    }
    if (skip.length > 0) {
        const note = `cannot start at ${selected[0]}: ${skip[0]}${skip.length > 1 ? ` (+${skip.length - 1} more)` : ''}; fix it, or re-run the phase with --from (--from preflight starts over)`;
        deps.progress({ phase: selected[0], status: 'blocked', note });
        deps.log(`[${selected[0]}] blocked: ${note}`);
        for (const d of skip)
            deps.log(`    ${d}`);
        return { ok: false, version: v, dryRun: false, statePath, phases: [{ id: selected[0], status: 'blocked', note, details: skip }] };
    }
    if (release.current.suite !== opts.suite || release.current.baseline !== opts.baseline)
        release.save({ suite: opts.suite, baseline: opts.baseline });
    for (const id of selected) {
        deps.log(`[${id}] ${phasePlan(id, v, opts)[0]}`);
        deps.progress({ phase: id, status: 'start' });
        let outcome;
        try {
            outcome = await release.phase(id);
        }
        catch (error) {
            if (error instanceof PendingError)
                return pendingResult(id, error);
            throw error;
        }
        const record = { ...outcome, at: new Date(deps.now()).toISOString() };
        // A re-run phase voids every later record: they were built on its previous result.
        const kept = Object.fromEntries(Object.entries(release.current.phases).filter(([p]) => PHASES.indexOf(p) < PHASES.indexOf(id)));
        release.save({ phases: { ...kept, [id]: record } });
        results.push({ id, ...outcome });
        deps.progress({ phase: id, status: outcome.status === 'skipped' ? 'ok' : outcome.status, note: outcome.note });
        deps.log(`[${id}] ${outcome.status}: ${outcome.note}`);
        for (const d of outcome.details ?? [])
            deps.log(`    ${d}`);
        if (outcome.status === 'fail' || outcome.status === 'blocked') {
            return { ok: false, version: v, dryRun: false, statePath, phases: results };
        }
    }
    const triage = release.current.suiteTriage;
    const flaky = triage && triage.sha === release.current.suiteSha ? triage.results.filter((t) => t.class === 'load-flaky').length : 0;
    const awaiting = flaky > 0 ? `; ${flaky} known-flaky candidate(s) await owner approval (omg release ${v} --flaky-candidates)` : '';
    deps.progress({ phase: 'release', status: 'done', note: `${v}: ${selected[0]}..${selected[selected.length - 1]} ok${awaiting}` });
    return { ok: true, version: v, dryRun: false, statePath, phases: results };
}
//# sourceMappingURL=engine.js.map