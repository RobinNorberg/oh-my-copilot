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
import { resolveAzEntry, type AzEntry } from '../../forge/ado/az-binary.js';
import { DEFAULT_ADO_ITEM_TYPES, ForgeConfigError, resolveForgeConfig } from '../../forge/config.js';
import { createForge } from '../../forge/index.js';
import { adoGuardContext, defaultAzBinaryDeps } from '../../forge/ado/index.js';
import type { Forge, ForgeFactory, ForgeOptions, ForgeProgressConfig, IntakeSource, ResolvedForgeConfig } from '../../forge/types.js';
import { checkEnvFor, checkGuardExec } from '../../factory/check/cli.js';
import { factoryCheckPreview, type CheckEnv } from '../../factory/check/score.js';
import { factoryForgeOptions } from '../../factory/run/forge-roots.js';
import { checkAdoAuth, checkGitHubAuth, type AuthReport } from '../../factory/setup/auth.js';
import { detectSetupForge } from '../../factory/setup/detect.js';
import { SetupError, setupGuardExec, type SetupIo } from '../../factory/setup/guard.js';
import {
  adoWorkItemTypes,
  formatIntakeSpec,
  githubLabels,
  parseIntakeSpec,
  pickIntake,
  previewIntake,
  validateIntake,
  type PreviewCheck,
  type PreviewRow,
  type Prompter,
} from '../../factory/setup/intake-pick.js';
import { missingGitHubLabels, pickProgress, progressFromFlag, validateAdoProgress } from '../../factory/setup/progress-pick.js';
import { applyWrites, buildSection, parsedAfter, planWrites, type PlannedWrite, type SetupScope, type SetupSection } from '../../factory/setup/write.js';
import { redactAdoSecrets } from '../../forge/ado/redact.js';
import { redactTokens } from '../../notifications/redact.js';
import { trustedUserConfigPath } from '../../ship/config.js';
import { defaultExec, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { checkOrCreateHarborLabels } from './intake.js';
import { defaultFactoryRunDeps, validateFactoryPrerequisites } from './factory.js';

export interface FactorySetupDeps {
  /** Raw exec; the wizard wraps it in setupGuardExec, the preview's forge in checkGuardExec. */
  exec: Exec;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: () => boolean;
  /** Azure CLI entry point (az-binary.ts); `root` is an untrusted PATH root. */
  resolveAz: (root: string) => AzEntry;
  createForge: ForgeFactory;
  /** Readiness hook of the preview; default: the `omg factory check` scorer over the resolved config. */
  previewCheck?: PreviewCheck;
  userConfigPath: () => string;
  /** Interactive answers; default reads the TTY. */
  prompter?: Prompter;
}

export const defaultFactorySetupDeps: FactorySetupDeps = {
  exec: defaultExec,
  env: process.env,
  isTTY: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  resolveAz: (root) => resolveAzEntry(defaultAzBinaryDeps([root, ...factoryForgeOptions(root).untrustedRoots])),
  createForge,
  userConfigPath: () => trustedUserConfigPath(),
};

export interface FactorySetupOptions {
  forge?: string;
  org?: string;
  project?: string;
  repo?: string;
  intake?: string;
  itemTypes?: string;
  progress?: string;
  board?: string;
  trustedAuthor?: string;
  scope?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface FactorySetupOutcome {
  exitCode: number;
  forge?: { kind: string; host: string; owner: string; project?: string; name: string; url: string };
  auth?: AuthReport;
  config?: SetupSection;
  /** Files written; null on a dry run or when nothing changed. */
  written: string[] | null;
  diffs: Array<{ path: string; scope: SetupScope; diff: string }>;
  labels: { missing: string[]; created: string[] };
  prerequisites: { ok: boolean; missing: string[] };
  preview: PreviewRow[];
  previewError?: string;
  notes: string[];
  error?: string;
}

function ttyPrompter(): Prompter {
  const ask = async (q: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    async select(question, choices) {
      if (choices.length === 0) throw new SetupError(5, `${question}: nothing to choose from`);
      console.error(question);
      choices.forEach((c, i) => console.error(`  ${i + 1}) ${c}`));
      for (;;) {
        const n = Number(await ask(`Choose 1-${choices.length}: `));
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
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
export const plainText = (s: unknown): string => String(s).replace(TERMINAL_SEQUENCE, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');

const list = (raw: string | undefined): string[] => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const readConfig = (path: string): unknown => {
  try {
    return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
};

/** The wizard; never throws (a SetupError becomes its exit code). */
export async function runFactorySetup(o: FactorySetupOptions, deps: FactorySetupDeps = defaultFactorySetupDeps, cwd: string = process.cwd()): Promise<FactorySetupOutcome> {
  const outcome: FactorySetupOutcome = { exitCode: 0, written: null, diffs: [], labels: { missing: [], created: [] }, prerequisites: { ok: true, missing: [] }, preview: [], notes: [] };
  try {
    await setup(o, deps, cwd, outcome);
  } catch (error) {
    outcome.exitCode = error instanceof SetupError ? error.exitCode : 1;
    outcome.error = redactFor(outcome.forge?.kind, error instanceof Error ? error.message : String(error));
  }
  return outcome;
}

/** Adapter and tool text can carry credentials: the forge's own redactor (ADO PATs and auth headers, else GitHub tokens). */
const redactFor = (kind: string | undefined, text: string): string => (kind === 'azure-devops' ? redactAdoSecrets(text) : redactTokens(text));

/** The scorer's repository side: run state and plan files at the local origin/<base> (no fetch: the wizard stays read-only). */
function previewEnv(guarded: Exec, root: string, config: ResolvedForgeConfig): CheckEnv {
  const base = defaultFactoryRunDeps.base(root);
  const sha = guarded('git', ['rev-parse', '--verify', `refs/remotes/origin/${base}`], { cwd: root });
  const baseSha = sha.status === 0 && /^[0-9a-f]{40}$/.test(sha.stdout.trim()) ? sha.stdout.trim() : null;
  return checkEnvFor(guarded, root, config, base, baseSha);
}

async function setup(o: FactorySetupOptions, deps: FactorySetupDeps, cwd: string, out: FactorySetupOutcome): Promise<void> {
  const interactive = deps.isTTY() && !o.yes && !o.json;
  const scope = (o.scope ?? 'project') as SetupScope;
  if (scope !== 'project' && scope !== 'user') throw new SetupError(2, `--scope must be project or user, got ${JSON.stringify(o.scope)}`);
  if (!interactive) {
    const missing = [...(o.intake ? [] : ['--intake']), ...(o.yes || o.dryRun ? [] : ['--yes (or --dry-run)'])];
    if (missing.length > 0) throw new SetupError(2, `non-interactive omg factory setup needs ${missing.join(', ')}`);
  }

  // Step 1: detect (the setup guard needs the repo, so the first reads run through a git-only guard).
  const gitOnly: Exec = (cmd, args, opts) => {
    if (cmd !== 'git' || !((args[0] === 'rev-parse' && args[1] === '--show-toplevel' && args.length === 2) || (args.join(' ') === 'remote get-url origin'))) {
      throw new SetupError(1, `omg factory setup refuses ${cmd} ${args.join(' ')} before the forge is known`);
    }
    return deps.exec(cmd, args, opts);
  };
  const top = gitOnly('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.status !== 0) throw new SetupError(2, 'omg factory setup must run inside a git repository');
  const root = top.stdout.trim();
  const projectPath = getCanonicalProjectConfigPath(root);
  const userPath = deps.userConfigPath();
  const detected = detectSetupForge(gitOnly, root, { forge: o.forge, org: o.org, project: o.project, repo: o.repo }, [readConfig(userPath), readConfig(projectPath)]);
  const repo = detected.repo;
  out.forge = { kind: repo.kind, host: repo.host, owner: repo.owner, ...(repo.project ? { project: repo.project } : {}), name: repo.name, url: repo.url };
  const ado = repo.kind === 'azure-devops';
  if (!ado && (o.itemTypes || o.board || o.trustedAuthor)) throw new SetupError(2, '--item-types, --board and --trusted-author are Azure DevOps flags; this repository is on GitHub');

  // Step 2: auth.
  let az: AzEntry | undefined;
  if (ado) {
    try {
      az = deps.resolveAz(root);
    } catch (error) {
      throw new SetupError(3, `${(error as Error).message}`);
    }
  }
  const io: SetupIo = { exec: setupGuardExec(deps.exec, repo, az), cwd: root, repo, ...(az ? { az } : {}) };
  out.auth = ado ? checkAdoAuth(io, deps.env) : checkGitHubAuth(io);
  if (!out.auth.ok) throw new SetupError(3, `auth check failed: ${out.auth.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}${out.auth.fix ? `. Fix: ${out.auth.fix}` : ''}`);

  const prompter = interactive ? (deps.prompter ?? ttyPrompter()) : undefined;

  // Step 4: intake source.
  const labels = ado ? undefined : githubLabels(io);
  const source: IntakeSource = o.intake ? parseIntakeSpec(o.intake, repo.kind) : await pickIntake(io, prompter!, detected.prefill);
  const intakeCheck = validateIntake(io, source, labels);
  let itemTypes: string[] = [];
  if (ado) {
    const known = adoWorkItemTypes(io);
    const lower = new Map(known.map((t) => [t.toLowerCase(), t]));
    if (o.itemTypes) {
      itemTypes = list(o.itemTypes);
      const unknown = itemTypes.filter((t) => !lower.has(t.toLowerCase()));
      if (unknown.length > 0) throw new SetupError(5, `unknown work item type ${unknown.map((t) => JSON.stringify(t)).join(', ')} in project ${repo.project} (known: ${known.join(', ')})`);
      itemTypes = itemTypes.map((t) => lower.get(t.toLowerCase())!);
    } else {
      itemTypes = DEFAULT_ADO_ITEM_TYPES.filter((t) => lower.has(t.toLowerCase())).map((t) => lower.get(t.toLowerCase())!);
      if (detected.prefill.workItemType && lower.has(detected.prefill.workItemType.toLowerCase()) && !itemTypes.some((t) => t.toLowerCase() === detected.prefill.workItemType!.toLowerCase())) {
        itemTypes.push(lower.get(detected.prefill.workItemType.toLowerCase())!);
      }
      if (itemTypes.length === 0) throw new SetupError(5, `project ${repo.project} has none of the default work item types (${DEFAULT_ADO_ITEM_TYPES.join(', ')}); pass --item-types`);
    }
  }

  // Step 5: progress.
  let board: { team: string; board: string } | undefined;
  if (o.board) {
    const [team, name, ...rest] = o.board.split('/');
    if (!team || !name || rest.length > 0) throw new SetupError(2, '--board needs <team>/<board>');
    board = { team, board: name };
  } else if (source.type === 'board-column') board = { team: source.team, board: source.board };
  const progress: ForgeProgressConfig = o.progress !== undefined || !interactive ? progressFromFlag(o.progress, repo.kind) : await pickProgress(io, prompter!, itemTypes, board);
  if (ado) validateAdoProgress(io, progress, itemTypes, board);
  else out.labels.missing = [...new Set([...intakeCheck.missingLabels, ...missingGitHubLabels(labels!, progress, source)])];

  // Trusted authors (ADO, user config only).
  let trustedAuthors = list(o.trustedAuthor);
  if (ado && interactive && trustedAuthors.length === 0) {
    trustedAuthors = list(await prompter!.input('Trusted authors whose omg-plan: comments count (uniqueName, comma-separated; empty = none)', ''));
  }

  // Step 6: write.
  const team = source.type === 'board-column' ? source.team : board?.team ?? detected.prefill.team;
  out.config = buildSection(repo, { source, itemTypes }, progress, team);
  const planned: PlannedWrite[] = planWrites({ projectPath, userPath, section: out.config, ...(trustedAuthors.length > 0 ? { trustedAuthors } : {}) });
  out.diffs = planned.map((w) => ({ path: w.path, scope: w.scope, diff: w.diff }));
  const afterUser = parsedAfter(planned, userPath);
  const afterProject = parsedAfter(planned, projectPath);
  let resolved: ResolvedForgeConfig;
  try {
    // The project file stands in for the base layer: the engine reads it from <base> once committed.
    const loaded = resolveForgeConfig(afterUser, afterProject, afterProject, detected.originUrl);
    resolved = loaded.config;
  } catch (error) {
    if (error instanceof ForgeConfigError) throw new SetupError(error.code === 'invalid' ? 2 : 5, error.message);
    throw error;
  }
  if (scope === 'user') out.notes.push(`--scope user: the forge identity, intake and progress belong to this repository, so they go to ${projectPath}; the user config ${userPath} is shared by every repository and gets only trustedAuthors.`);
  out.notes.push(`${projectPath} is a protected path: omg factory reads forge.* and progress.* from it only on <base> once it is committed there.`);
  if (trustedAuthors.length > 0) out.notes.push(`trustedAuthors go to the user config ${userPath} only.`);

  if (!o.json) {
    for (const w of planned) {
      console.log(chalk.bold(`--- ${w.path} (${w.scope})`));
      for (const line of w.diff.split('\n')) console.log(line.startsWith('+') ? chalk.green(line) : line.startsWith('-') ? chalk.red(line) : chalk.gray(line));
    }
    if (planned.length === 0) console.log('config already up to date');
    if (out.labels.missing.length > 0) console.log(`labels to create: ${out.labels.missing.join(', ')}`);
  }

  if (!o.dryRun) {
    const ok = o.yes || (planned.length === 0 && out.labels.missing.length === 0) || (await prompter!.confirm(planned.length > 0 ? 'Write these changes?' : 'Create the missing labels?', false));
    if (!ok) throw new SetupError(2, 'cancelled: nothing written');
    // The config first: applyWrites re-checks each file, so a refused write creates no label. Label creation is
    // idempotent, so a failure after the write is fixed by running setup again.
    out.written = planned.length > 0 ? applyWrites(planned) : null;
    if (out.labels.missing.length > 0) {
      const created = checkOrCreateHarborLabels(root, (cmd, args, opts) => io.exec(cmd, args, { cwd: opts.cwd }), out.labels.missing);
      if (!created.ok) throw new SetupError(5, `${out.written ? 'config written, but ' : ''}${created.reason ?? 'cannot create labels'}; run omg factory setup again to create the labels`);
      out.labels.created = [...out.labels.missing];
    }
  }

  // `omg factory init` prerequisites (informational: the chain route table needs them, the engine does not).
  out.prerequisites = validateFactoryPrerequisites(root);

  // Step 7: preview the source's first items through the read-only guard of `omg factory check` (it allows the tracker list reads).
  try {
    // The ADO guard needs the forge repo and the az entry; GitHub needs neither.
    const guarded = checkGuardExec(deps.exec, undefined, () => (ado && az ? adoGuardContext(resolved, az) : undefined));
    const forge = deps.createForge(guarded, root, resolved, { ...factoryForgeOptions(root), ...(az ? { entry: az } : {}) } as ForgeOptions);
    // Item titles are untrusted tracker text: no terminal sequences or control characters reach the output.
    const check = deps.previewCheck ?? factoryCheckPreview(previewEnv(guarded, root, resolved));
    out.preview = previewIntake(forge, source, check).map((row) => ({ ...row, title: plainText(row.title), url: plainText(row.url), readiness: plainText(row.readiness) }));
  } catch (error) {
    out.previewError = plainText(redactFor(repo.kind, error instanceof Error ? error.message : String(error)));
  }
  out.notes.push(`intake ${formatIntakeSpec(source)}`);
}

function printOutcome(o: FactorySetupOptions, r: FactorySetupOutcome): void {
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (r.error) {
    console.error(chalk.red(`Error: ${r.error}`));
    return;
  }
  for (const c of r.auth?.checks ?? []) console.log(`${c.ok ? chalk.green('ok') : chalk.red('fail')} ${c.name}: ${c.detail}`);
  if (r.written) for (const p of r.written) console.log(chalk.green(`wrote ${p}`));
  else console.log(chalk.yellow(o.dryRun ? 'dry run: nothing written' : 'nothing written'));
  for (const l of r.labels.created) console.log(chalk.green(`created label ${l}`));
  if (!r.prerequisites.ok) console.log(chalk.gray(`omg factory init prerequisites missing (needed for the chain route table only): ${r.prerequisites.missing.join(', ')}`));
  for (const n of r.notes) console.log(chalk.gray(n));
  if (r.previewError) console.log(chalk.yellow(`preview unavailable: ${r.previewError}`));
  else if (r.preview.length === 0) console.log('preview: the source has no open items');
  else {
    console.log(chalk.bold('preview (first items of the source)'));
    for (const row of r.preview) console.log(`  #${row.id}  ${row.title}  ${chalk.gray(row.readiness)}`);
  }
}

export function factorySetupCommand(deps: FactorySetupDeps = defaultFactorySetupDeps): Command {
  return new Command('setup')
    .description('Configure the factory for this repository: forge, auth, intake source, progress mapping (writes only factory.* after a diff)')
    .option('--forge <kind>', 'github | azure-devops (default: detected from origin; can only pin it)')
    .option('--org <org>', 'Azure DevOps organization (pin)')
    .option('--project <project>', 'Azure DevOps project (pin)')
    .option('--repo <repo>', 'GitHub owner/name or Azure DevOps repository (pin)')
    .option('--intake <spec>', 'label:<name> | milestone:<title> | wiql-query:<guid> | board-column:<team>/<board>/<column> | area-tag:<area>#<tag>')
    .option('--item-types <list>', 'Azure DevOps work item types, comma-separated')
    .option('--progress <mode>', 'default | none | <file.json>')
    .option('--board <team/board>', 'Azure DevOps board the progress columns live on (default: the board-column intake board)')
    .option('--trusted-author <list>', 'Azure DevOps uniqueNames whose omg-plan: comments count (user config only), comma-separated')
    .option('--scope <scope>', 'project | user; forge identity, intake and progress always go to .copilot/omg.jsonc, the user config gets only trustedAuthors', 'project')
    .option('--dry-run', 'Show the diff and the preview; write nothing')
    .option('--yes', 'Non-interactive: take every answer from flags and confirm the write')
    .option('--json', 'JSON output (non-interactive)')
    .action(async (o: FactorySetupOptions) => {
      const result = await runFactorySetup(o, deps);
      printOutcome(o, result);
      process.exitCode = result.exitCode;
    });
}
