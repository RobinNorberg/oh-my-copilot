/**
 * `omg factory setup` (factory forges design §4, critic amendments §A.5,
 * §A.7, §A.11): detect the forge, check auth, pick the intake source and the
 * progress mapping, write the `factory` subtree of the config after a diff,
 * then preview the source's first items. Interactive on a TTY; `--yes`,
 * `--json` or no TTY is non-interactive and takes every answer from flags.
 *
 * Exit codes: 0 written or dry run, 2 usage, 3 auth or extension missing,
 * 5 incompatible (unsupported forge, mismatch, unknown query, state
 * validation failed). `--dry-run` writes nothing and creates no label.
 *
 * `--scope user` writes no forge identity, intake or progress to the user
 * config (one file for every repository): those always go to the project
 * file, and the user config gets only trustedAuthors (see write.ts).
 *
 * Reuse (§A.7): label creation calls `checkOrCreateHarborLabels` (intake.ts)
 * with the factory labels, and the `omg factory init` prerequisites come from
 * `validateFactoryPrerequisites` (factory.ts); both are called, not copied.
 */
import chalk from 'chalk';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline/promises';
import { getCanonicalProjectConfigPath } from '../../config/project-config-path.js';
import { resolveAzEntry } from '../../forge/ado/az-binary.js';
import { DEFAULT_ADO_ITEM_TYPES, ForgeConfigError, resolveForgeConfig } from '../../forge/config.js';
import { createForge } from '../../forge/index.js';
import { localForgeLimitations } from '../../forge/local/index.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { adoGuardContext, defaultAzBinaryDeps } from '../../forge/ado/index.js';
import { checkEnvFor, checkGuardExec, factoryErrorLine } from '../../factory/check/cli.js';
import { factoryCheckPreview } from '../../factory/check/score.js';
import { factoryForgeOptions } from '../../factory/run/forge-roots.js';
import { checkAdoAuth, checkGitHubAuth } from '../../factory/setup/auth.js';
import { detectSetupForge } from '../../factory/setup/detect.js';
import { SetupError, setupGuardExec } from '../../factory/setup/guard.js';
import { adoWorkItemTypes, formatIntakeSpec, githubLabels, parseIntakeSpec, pickIntake, previewIntake, validateIntake, } from '../../factory/setup/intake-pick.js';
import { DEFAULT_HEARTBEAT_CRON, parseHeartbeatMode, planHeartbeat, validateOmgVersionOverride } from '../../factory/setup/workflows.js';
import { getRuntimePackageVersion, isRuntimePackageLocal } from '../../lib/version.js';
import { pickHealPipeline } from '../../factory/setup/pipeline-pick.js';
import { missingGitHubLabels, pickProgress, progressFromFlag, validateAdoProgress } from '../../factory/setup/progress-pick.js';
import { applyWrites, buildSection, parsedAfter, planBacklogSample, planWrites } from '../../factory/setup/write.js';
import { redactAdoSecrets } from '../../forge/ado/redact.js';
import { redactTokens } from '../../notifications/redact.js';
import { isPlainBranchName, resolveShipConfig, trustedUserConfigPath } from '../../ship/config.js';
import { defaultExec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { checkOrCreateHarborLabels } from './intake.js';
import { defaultFactoryRunDeps, validateFactoryPrerequisites } from './factory.js';
export const defaultFactorySetupDeps = {
    exec: defaultExec,
    env: process.env,
    isTTY: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
    resolveAz: (root) => resolveAzEntry(defaultAzBinaryDeps([root, ...factoryForgeOptions(root).untrustedRoots])),
    createForge,
    userConfigPath: () => trustedUserConfigPath(),
};
function ttyPrompter() {
    const ask = async (q) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
            return (await rl.question(q)).trim();
        }
        finally {
            rl.close();
        }
    };
    return {
        async select(question, choices) {
            if (choices.length === 0)
                throw new SetupError(5, `${question}: nothing to choose from`);
            console.error(question);
            choices.forEach((c, i) => console.error(`  ${i + 1}) ${c}`));
            for (;;) {
                const n = Number(await ask(`Choose 1-${choices.length}: `));
                if (Number.isInteger(n) && n >= 1 && n <= choices.length)
                    return choices[n - 1];
            }
        },
        async input(question, defaultValue) {
            const answer = await ask(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `);
            return answer || defaultValue || '';
        },
        async confirm(question, defaultYes = false) {
            const answer = await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
            return answer === '' ? defaultYes : /^y(?:es)?$/i.test(answer);
        },
    };
}
// CSI and other ESC sequences, OSC strings (to BEL or ST, or the end), and the 8-bit CSI.
const TERMINAL_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[ -~]?/g;
/** Untrusted text without terminal sequences and control or format characters. */
export const plainText = (s) => String(s).replace(TERMINAL_SEQUENCE, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
const list = (raw) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const readConfig = (path) => {
    try {
        return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
    }
    catch {
        return undefined;
    }
};
/** The wizard; never throws (a SetupError becomes its exit code). */
export async function runFactorySetup(o, deps = defaultFactorySetupDeps, cwd = process.cwd()) {
    const outcome = { exitCode: 0, written: null, diffs: [], labels: { missing: [], created: [] }, prerequisites: { ok: true, missing: [] }, preview: [], notes: [], limitations: [] };
    try {
        await setup(o, deps, cwd, outcome);
    }
    catch (error) {
        outcome.exitCode = error instanceof SetupError ? error.exitCode : 1;
        outcome.error = redactFor(outcome.forge?.kind, error instanceof Error ? error.message : String(error));
    }
    return outcome;
}
/** Adapter and tool text can carry credentials: the forge's own redactor (ADO PATs and auth headers, else GitHub tokens). */
const redactFor = (kind, text) => (kind === 'azure-devops' ? redactAdoSecrets(text) : redactTokens(text));
/**
 * F20: the local forge's base. A ship.base in the project or user config
 * wins (written: false); else `dev` when that branch exists, else the
 * current branch (an unborn one is init.defaultBranch), and setup writes it
 * as ship.base. Null on a detached HEAD with no dev. A ship.base that is set
 * but not a plain branch name is a usage error naming it (exit 2): setup
 * never replaces a value the human wrote.
 */
export function detectLocalBase(exec, root, configs) {
    for (const { path, config } of configs) {
        const ship = config?.ship;
        if (ship === null || typeof ship !== 'object' || !('base' in ship))
            continue;
        const base = ship.base;
        if (!isPlainBranchName(base))
            throw new SetupError(2, `ship.base ${JSON.stringify(base)} in ${path} is not a plain branch name: set it to the branch you merge into (or remove it to let setup detect one)`);
        return { base, write: false };
    }
    if (exec('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/dev'], { cwd: root }).status === 0)
        return { base: 'dev', write: true };
    const head = exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
    const current = head.stdout.trim();
    return head.status === 0 && isPlainBranchName(current) ? { base: current, write: true } : null;
}
/** The scorer's repository side: run state and plan files at the local origin/<base> (no fetch: the wizard stays read-only). */
function previewEnv(guarded, root, config, base) {
    // The local forge's base is the local branch (no origin to read).
    const ref = config.kind === 'local' ? `refs/heads/${base}` : `refs/remotes/origin/${base}`;
    const sha = guarded('git', ['rev-parse', '--verify', ref], { cwd: root });
    const baseSha = sha.status === 0 && /^[0-9a-f]{40}$/.test(sha.stdout.trim()) ? sha.stdout.trim() : null;
    return { check: checkEnvFor(guarded, root, config, base, baseSha), baseSha };
}
async function setup(o, deps, cwd, out) {
    const interactive = deps.isTTY() && !o.yes && !o.json;
    const scope = (o.scope ?? 'project');
    if (scope !== 'project' && scope !== 'user')
        throw new SetupError(2, `--scope must be project or user, got ${JSON.stringify(o.scope)}`);
    // Step 1: detect, before the flags are checked (F10: a repository with no usable forge says so first,
    // with the --forge local hint). The setup guard needs the repo, so the first reads run through a git-only guard.
    const gitOnly = (cmd, args, opts) => {
        if (cmd !== 'git' || !((args[0] === 'rev-parse' && args[1] === '--show-toplevel' && args.length === 2) || (args.join(' ') === 'remote get-url origin'))) {
            throw new SetupError(1, `omg factory setup refuses ${cmd} ${args.join(' ')} before the forge is known`);
        }
        return deps.exec(cmd, args, opts);
    };
    const top = gitOnly('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (top.status !== 0)
        throw new SetupError(2, 'omg factory setup must run inside a git repository');
    const root = top.stdout.trim();
    const projectPath = getCanonicalProjectConfigPath(root);
    const userPath = deps.userConfigPath();
    const stateDir = factoryForgeOptions(root).stateDir;
    const detected = detectSetupForge(gitOnly, root, { forge: o.forge, org: o.org, project: o.project, repo: o.repo }, [readConfig(userPath), readConfig(projectPath)], stateDir);
    const repo = detected.repo;
    out.forge = { kind: repo.kind, host: repo.host, owner: repo.owner, ...(repo.project ? { project: repo.project } : {}), name: repo.name, url: repo.url };
    const ado = repo.kind === 'azure-devops';
    const local = repo.kind === 'local';
    if (o.workflows) {
        await setupWorkflows(o, deps, root, repo.kind, interactive, out);
        return;
    }
    if (o.mode !== undefined || o.cron !== undefined || o.force || o.omgVersion !== undefined)
        throw new SetupError(2, '--mode, --cron, --omg-version and --force belong to --workflows');
    if (!interactive) {
        // The local forge's source defaults to its backlog directory.
        const missing = [...(o.intake || local ? [] : ['--intake']), ...(o.yes || o.dryRun ? [] : ['--yes (or --dry-run)'])];
        if (missing.length > 0)
            throw new SetupError(2, `non-interactive omg factory setup needs ${missing.join(', ')}`);
    }
    if (!ado && (o.itemTypes || o.board || o.trustedAuthor || o.healPipeline)) {
        throw new SetupError(2, `--item-types, --board, --trusted-author and --heal-pipeline are Azure DevOps flags; this repository is on ${local ? 'the local forge' : 'GitHub'}`);
    }
    // Step 2: auth.
    let az;
    if (ado) {
        try {
            az = deps.resolveAz(root);
        }
        catch (error) {
            throw new SetupError(3, `${error.message}`);
        }
    }
    const io = { exec: setupGuardExec(deps.exec, repo, az), cwd: root, repo, ...(az ? { az } : {}) };
    out.auth = local
        ? { ok: true, checks: [{ name: 'local forge', ok: true, detail: 'offline: no server, so no auth' }] }
        : ado ? checkAdoAuth(io, deps.env) : checkGitHubAuth(io);
    if (!out.auth.ok)
        throw new SetupError(3, `auth check failed: ${out.auth.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}${out.auth.fix ? `. Fix: ${out.auth.fix}` : ''}`);
    const prompter = interactive ? (deps.prompter ?? ttyPrompter()) : undefined;
    // Step 4: intake source.
    const labels = ado || local ? undefined : githubLabels(io);
    const source = o.intake
        ? parseIntakeSpec(o.intake, repo.kind)
        : local && !interactive ? { type: 'local-backlog' } : await pickIntake(io, prompter, detected.prefill);
    const intakeCheck = validateIntake(io, source, labels);
    let itemTypes = [];
    if (ado) {
        const known = adoWorkItemTypes(io);
        const lower = new Map(known.map((t) => [t.toLowerCase(), t]));
        if (o.itemTypes) {
            itemTypes = list(o.itemTypes);
            const unknown = itemTypes.filter((t) => !lower.has(t.toLowerCase()));
            if (unknown.length > 0)
                throw new SetupError(5, `unknown work item type ${unknown.map((t) => JSON.stringify(t)).join(', ')} in project ${repo.project} (known: ${known.join(', ')})`);
            itemTypes = itemTypes.map((t) => lower.get(t.toLowerCase()));
        }
        else {
            itemTypes = DEFAULT_ADO_ITEM_TYPES.filter((t) => lower.has(t.toLowerCase())).map((t) => lower.get(t.toLowerCase()));
            if (detected.prefill.workItemType && lower.has(detected.prefill.workItemType.toLowerCase()) && !itemTypes.some((t) => t.toLowerCase() === detected.prefill.workItemType.toLowerCase())) {
                itemTypes.push(lower.get(detected.prefill.workItemType.toLowerCase()));
            }
            if (itemTypes.length === 0)
                throw new SetupError(5, `project ${repo.project} has none of the default work item types (${DEFAULT_ADO_ITEM_TYPES.join(', ')}); pass --item-types`);
        }
    }
    // Step 5: progress.
    let board;
    if (o.board) {
        const [team, name, ...rest] = o.board.split('/');
        if (!team || !name || rest.length > 0)
            throw new SetupError(2, '--board needs <team>/<board>');
        board = { team, board: name };
    }
    else if (source.type === 'board-column')
        board = { team: source.team, board: source.board };
    // The local forge records the stage itself (no mapping to pick).
    const progress = o.progress !== undefined || !interactive || local ? progressFromFlag(o.progress, repo.kind) : await pickProgress(io, prompter, itemTypes, board);
    if (ado)
        validateAdoProgress(io, progress, itemTypes, board);
    else if (!local)
        out.labels.missing = [...new Set([...intakeCheck.missingLabels, ...missingGitHubLabels(labels, progress, source)])];
    // Trusted authors (ADO, user config only).
    let trustedAuthors = list(o.trustedAuthor);
    if (ado && interactive && trustedAuthors.length === 0) {
        trustedAuthors = list(await prompter.input('Trusted authors whose omg-plan: comments count (uniqueName, comma-separated; empty = none)', ''));
    }
    // Step 6: write.
    const team = source.type === 'board-column' ? source.team : board?.team ?? detected.prefill.team;
    // The heal pipeline (optional): only a build definition of the forge repository; it goes to the project file, which is read from <base>.
    const healPipeline = ado ? await pickHealPipeline(io, prompter, o.healPipeline) : undefined;
    // F20: the base the notes name; on the local forge detected and, when no config names it, written as ship.base.
    const localBase = local ? detectLocalBase(io.exec, root, [{ path: projectPath, config: readConfig(projectPath) }, { path: userPath, config: readConfig(userPath) }]) : null;
    const base = localBase?.base ?? defaultFactoryRunDeps.base(root);
    if (local && !localBase)
        out.notes.push(`no base branch detected (detached HEAD and no dev branch): set ship.base in ${projectPath} to the branch you merge into`);
    out.config = {
        ...buildSection(repo, { source, itemTypes }, progress, team),
        ...(healPipeline ? { heal: { pipeline: healPipeline } } : {}),
        ...(localBase?.write ? { ship: { base: localBase.base } } : {}),
    };
    const planned = planWrites({ projectPath, userPath, section: out.config, ...(trustedAuthors.length > 0 ? { trustedAuthors } : {}) });
    const afterUser = parsedAfter(planned, userPath);
    const afterProject = parsedAfter(planned, projectPath);
    let resolved;
    try {
        // The project file stands in for the base layer: the engine reads it from <base> once committed.
        const loaded = resolveForgeConfig(afterUser, afterProject, afterProject, detected.originUrl, { root, stateDir });
        resolved = loaded.config;
    }
    catch (error) {
        if (error instanceof ForgeConfigError)
            throw new SetupError(error.code === 'invalid' ? 2 : 5, error.message);
        throw error;
    }
    if (resolved.kind === 'local' && resolved.local) {
        // The backlog directory with one sample item (closed), when it has no item yet.
        const sample = planBacklogSample(root, resolved.local.backlogDir);
        if (sample)
            planned.push(sample);
        out.limitations = localForgeLimitations(base);
        if (localBase?.write)
            out.notes.push(`base branch ${base} (ship.base, detected: ${base === 'dev' ? 'the dev branch exists' : 'the current branch'}); change ship.base in ${projectPath} if you merge into another branch`);
        const userTrusted = readConfig(userPath)?.ship?.trustedBases;
        const trustedBases = Array.isArray(userTrusted) ? userTrusted : resolveShipConfig({}).trustedBases;
        if (localBase && !trustedBases.includes(base))
            out.notes.push(`${base} is not in ship.trustedBases: add it there in the user config ${userPath}, or the committed ${projectPath} on ${base} is not read`);
        if (!resolved.local.gate)
            out.notes.push(`no local gate: set factory.forge.local.gate (an argv such as ["npm","test"]) in the user config or in .copilot/omg.jsonc committed on ${base}; until then gates park at awaiting-human: gates`);
        if (detected.originUrl)
            out.notes.push(`factory.forge.kind "local" overrides the origin remote only from the user config or from ${projectPath} committed on ${base} (CI and remote review are off)`);
        out.notes.push(`commit ${resolved.local.backlogDir}/ items on ${base}: omg factory run reads backlog items at the base commit only`);
    }
    out.diffs = planned.map((w) => ({ path: w.path, scope: w.scope, diff: w.diff }));
    if (scope === 'user')
        out.notes.push(`--scope user: the forge identity, intake and progress belong to this repository, so they go to ${projectPath}; the user config ${userPath} is shared by every repository and gets only trustedAuthors.`);
    out.notes.push(`${projectPath} is a protected path: omg factory reads forge.* and progress.* from it only on ${base} once it is committed there.`);
    if (trustedAuthors.length > 0)
        out.notes.push(`trustedAuthors go to the user config ${userPath} only.`);
    if (healPipeline)
        out.notes.push(`factory.heal.pipeline (build definition ${healPipeline.definitionId}) counts once ${projectPath} is committed on ${base}; omg factory heal ignores it in the working tree.`);
    if (!o.json) {
        for (const w of planned) {
            console.log(chalk.bold(`--- ${w.path} (${w.scope})`));
            for (const line of w.diff.split('\n'))
                console.log(line.startsWith('+') ? chalk.green(line) : line.startsWith('-') ? chalk.red(line) : chalk.gray(line));
        }
        if (planned.length === 0)
            console.log('config already up to date');
        if (out.labels.missing.length > 0)
            console.log(`labels to create: ${out.labels.missing.join(', ')}`);
    }
    if (!o.dryRun) {
        const ok = o.yes || (planned.length === 0 && out.labels.missing.length === 0) || (await prompter.confirm(planned.length > 0 ? 'Write these changes?' : 'Create the missing labels?', false));
        if (!ok)
            throw new SetupError(2, 'cancelled: nothing written');
        // The config first: applyWrites re-checks each file, so a refused write creates no label. Label creation is
        // idempotent, so a failure after the write is fixed by running setup again.
        out.written = planned.length > 0 ? applyWrites(planned) : null;
        if (out.labels.missing.length > 0) {
            const created = checkOrCreateHarborLabels(root, (cmd, args, opts) => io.exec(cmd, args, { cwd: opts.cwd }), out.labels.missing);
            if (!created.ok)
                throw new SetupError(5, `${out.written ? 'config written, but ' : ''}${created.reason ?? 'cannot create labels'}; run omg factory setup again to create the labels`);
            out.labels.created = [...out.labels.missing];
        }
    }
    // `omg factory init` prerequisites (informational: the chain route table needs them, the engine does not).
    out.prerequisites = validateFactoryPrerequisites(root);
    // Step 7: preview the source's first items through the read-only guard of `omg factory check` (it allows the tracker list reads).
    try {
        // The ADO guard needs the forge repo and the az entry; GitHub needs neither.
        const guarded = checkGuardExec(deps.exec, undefined, () => (ado && az ? adoGuardContext(resolved, az) : undefined));
        // The ADO adapter reads `entry` (its options extend ForgeOptions); GitHub ignores it.
        const env = previewEnv(guarded, root, resolved, base);
        // The local forge reads the working tree too (the sample item is not committed yet); its base is the local branch.
        const localOptions = local ? { local: { omgRoot: getOmcRoot(root), workingTree: true, base, baseSha: () => env.baseSha ?? undefined } } : {};
        const options = { ...factoryForgeOptions(root), ...localOptions, ...(az ? { entry: az } : {}) };
        const forge = deps.createForge(guarded, root, resolved, options);
        // Item titles are untrusted tracker text: no terminal sequences or control characters reach the output.
        const check = deps.previewCheck ?? factoryCheckPreview(env.check);
        out.preview = previewIntake(forge, source, check).map((row) => ({ ...row, title: plainText(row.title), url: plainText(row.url), readiness: plainText(row.readiness) }));
    }
    catch (error) {
        out.previewError = plainText(redactFor(repo.kind, error instanceof Error ? error.message : String(error)));
    }
    out.notes.push(`intake ${formatIntakeSpec(source)}`);
}
/**
 * --workflows: plans and writes the one heartbeat file. No auth, no forge reads and no config edit: the
 * generated file only runs `omg factory check` (and `triage --apply` in triage mode) in CI.
 */
async function setupWorkflows(o, deps, root, kind, interactive, out) {
    const mode = parseHeartbeatMode(o.mode);
    if (kind === 'local') {
        out.notes.push('--workflows is not applicable to the local (offline) forge: there is no CI to schedule. Run omg factory check and omg factory poll from your own scheduler if you want a heartbeat.');
        return;
    }
    const version = o.omgVersion === undefined ? getRuntimePackageVersion() : validateOmgVersionOverride(o.omgVersion);
    // Azure DevOps schedules only the default branch (the one omg ships to).
    const plan = planHeartbeat(root, kind, { mode, cron: o.cron ?? DEFAULT_HEARTBEAT_CRON, version, branch: kind === 'azure-devops' ? defaultFactoryRunDeps.base(root) : undefined, force: Boolean(o.force) });
    for (const w of plan.warnings)
        out.notes.push(`warning: ${w}`);
    if (o.omgVersion === undefined && isRuntimePackageLocal()) {
        out.notes.push(`warning: this omg runs from a git checkout or an unreleased build; the file installs oh-my-copilot@${version} from npm, so that version must be published or the install step fails (pass --omg-version <x.y.z> to pin a published one)`);
    }
    const planned = plan.write ? [plan.write] : [];
    out.diffs = planned.map((w) => ({ path: w.path, scope: w.scope, diff: w.diff }));
    if (plan.action === 'unchanged')
        out.notes.push(`${plan.relPath} is already up to date`);
    if (!o.json) {
        for (const w of planned) {
            console.log(chalk.bold(`--- ${w.path} (${plan.action})`));
            for (const line of w.diff.split('\n'))
                console.log(line.startsWith('+') ? chalk.green(line) : line.startsWith('-') ? chalk.red(line) : chalk.gray(line));
        }
    }
    if (o.dryRun) {
        if (planned.length > 0)
            out.notes.push(`would write ${plan.relPath}`);
        return;
    }
    if (planned.length > 0) {
        if (!o.yes) {
            if (!interactive)
                throw new SetupError(2, 'non-interactive omg factory setup --workflows needs --yes (or --dry-run)');
            if (!(await (deps.prompter ?? ttyPrompter()).confirm(`Write ${plan.relPath}?`, false)))
                throw new SetupError(2, 'cancelled: nothing written');
        }
        out.written = applyWrites(planned);
    }
    out.notes.push(`heartbeat mode ${mode}: ${mode === 'triage' ? 'issues: write (opt-in)' : 'read-only permissions'}; commit ${plan.relPath} on the default branch, scheduled workflows run only there. Remove it by deleting the file.`);
}
function printOutcome(o, r) {
    if (o.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
    }
    if (r.error) {
        console.error(chalk.red(factoryErrorLine(r.error)));
        return;
    }
    for (const c of r.auth?.checks ?? [])
        console.log(`${c.ok ? chalk.green('ok') : chalk.red('fail')} ${c.name}: ${c.detail}`);
    if (r.written)
        for (const p of r.written)
            console.log(chalk.green(`wrote ${p}`));
    else
        console.log(chalk.yellow(o.dryRun ? 'dry run: nothing written' : 'nothing written'));
    for (const l of r.labels.created)
        console.log(chalk.green(`created label ${l}`));
    // F22: informational only, and not part of the offline flow, so the local forge does not print it (--json keeps it).
    if (!r.prerequisites.ok && r.forge?.kind !== 'local') {
        console.log(chalk.gray(`note: omg factory run does not need these; only omg factory init (the chain route table) reads them: ${r.prerequisites.missing.join(', ')}`));
    }
    for (const n of r.notes)
        console.log(chalk.gray(n));
    for (const l of r.limitations)
        console.log(chalk.gray(l));
    if (r.previewError)
        console.log(chalk.yellow(`preview unavailable: ${r.previewError}`));
    else if (r.preview.length === 0)
        console.log('preview: the source has no open items');
    else {
        console.log(chalk.bold('preview (first items of the source)'));
        for (const row of r.preview)
            console.log(`  #${row.id}  ${row.title}  ${chalk.gray(row.readiness)}`);
    }
}
export function factorySetupCommand(deps = defaultFactorySetupDeps) {
    return new Command('setup')
        .description('Configure the factory for this repository: forge, auth, intake source, progress mapping (writes only factory.* after a diff)')
        .option('--forge <kind>', 'github | azure-devops | local (default: detected from origin; github and azure-devops can only pin it; local is the offline forge and needs no origin)')
        .option('--org <org>', 'Azure DevOps organization (pin)')
        .option('--project <project>', 'Azure DevOps project (pin)')
        .option('--repo <repo>', 'GitHub owner/name or Azure DevOps repository (pin)')
        .option('--intake <spec>', 'label:<name> | milestone:<title> | wiql-query:<guid> | board-column:<team>/<board>/<column> | area-tag:<area>#<tag> | local-backlog[:<label>] (default with --forge local)')
        .option('--item-types <list>', 'Azure DevOps work item types, comma-separated')
        .option('--progress <mode>', 'default | none | <file.json>')
        .option('--board <team/board>', 'Azure DevOps board the progress columns live on (default: the board-column intake board)')
        .option('--trusted-author <list>', 'Azure DevOps uniqueNames whose omg-plan: comments count (user config only), comma-separated')
        .option('--heal-pipeline <id>', 'Azure DevOps build definition omg factory heal reads as CI (a pipeline of this repository), or none')
        .option('--scope <scope>', 'project | user; forge identity, intake and progress always go to .copilot/omg.jsonc, the user config gets only trustedAuthors', 'project')
        .option('--workflows', 'Write the cloud heartbeat (.github/workflows/omg-factory-heartbeat.yml, or an Azure Pipelines file on ADO) instead of running the wizard')
        .option('--mode <mode>', 'with --workflows: read-only (default) | triage (adds issues: write for omg factory triage --apply)')
        .option('--cron <expr>', 'with --workflows: schedule cron expression (default every 2 hours)')
        .option('--omg-version <x.y.z>', 'with --workflows: the published omg version the file installs (default: the version of this build)')
        .option('--force', 'with --workflows: replace a heartbeat file this command did not write')
        .option('--dry-run', 'Show the diff and the preview; write nothing')
        .option('--yes', 'Non-interactive: take every answer from flags and confirm the write')
        .option('--json', 'JSON output (non-interactive)')
        .action(async (o) => {
        const result = await runFactorySetup(o, deps);
        printOutcome(o, result);
        process.exitCode = result.exitCode;
    });
}
//# sourceMappingURL=factory-setup.js.map