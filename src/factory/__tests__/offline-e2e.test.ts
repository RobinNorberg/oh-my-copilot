/**
 * The offline (local) forge end to end (offline forge plan §5): one temp
 * repository with no origin goes through `omg factory setup --forge local`,
 * `enqueue`, `check`, `board`, the run engine (fake lanes, the REAL local
 * gate runner on a trivial node gate) up to the human merge, the human's
 * `git merge`, then `poll` (its production base sync) and the next run that
 * records the merge. The run first parks at `awaiting-human: gates` with no
 * gate configured; the human sets one and the rerun gates the same head.
 * Variant: a planted hostile `remote.omg-local.*` config.
 *
 * No network, no AI credits, and no program but git and node: every
 * child_process call in this file's module graph is recorded (the spy below),
 * and so is every command at the engine's Exec seam. Prepare's tsc and
 * inventory checks are this repository's own: they are scripted at the Exec
 * seam (the engine passes no option to turn them off), never run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { factoryPollCommand, } from '../../cli/commands/factory-poll.js';
import { pollLocalBaseSync } from '../../cli/commands/factory.js';
import { runFactorySetup, type FactorySetupDeps } from '../../cli/commands/factory-setup.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { createForge } from '../../forge/index.js';
import { localForgeLimitations, localMirrorPath, localPrStorePath, readLocalCheckRecord, readMirrorRef } from '../../forge/local/index.js';
import { defaultExec, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { runFactoryBoard, type BoardJson } from '../board/collect.js';
import { runFactoryCheck, type CheckJson, type FactoryCheckDeps } from '../check/cli.js';
import { runFactoryEnqueue, type EnqueueJson } from '../enqueue.js';
import { runFactoryPoll, type FactoryPollDeps, type PollTick } from '../poll.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../run/budget.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryEngineOptions, type FactoryRunOutcome } from '../run/engine.js';
import { factoryGuardExec } from '../run/exec.js';
import { factoryForgeOptions, loadFactoryForgeConfig } from '../run/forge-roots.js';
import { readFactoryState } from '../run/state.js';
import { commitFile, FakeLanes, FakeProcesses, review, type LaneScript } from '../run/__tests__/fake-lanes.js';

/** Every child_process call made while this file runs: the program, its argv and whether a shell was asked for. */
const { spawned, recordChildProcess } = vi.hoisted(() => {
  const spawned: Array<{ fn: string; cmd: string; args: string[]; shell: boolean }> = [];
  const recordChildProcess = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import('node:child_process');
    const record = (fn: string, cmd: unknown, rest: unknown[], alwaysShell: boolean) => {
      const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : [];
      const opts = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { shell?: unknown } | undefined;
      spawned.push({ fn, cmd: String(cmd), args, shell: alwaysShell || Boolean(opts && typeof opts === 'object' && opts.shell) });
    };
    const wrap = <K extends 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync' | 'fork'>(fn: K, alwaysShell = false) =>
      ((cmd: unknown, ...rest: unknown[]) => {
        record(fn, fn === 'fork' ? process.execPath : cmd, fn === 'fork' ? [[cmd, ...(Array.isArray(rest[0]) ? rest[0] : [])]] : rest, alwaysShell);
        return (real[fn] as (...a: unknown[]) => unknown)(cmd, ...rest);
      }) as (typeof real)[K];
    const wrapped = {
      spawn: wrap('spawn'), spawnSync: wrap('spawnSync'), execFile: wrap('execFile'), execFileSync: wrap('execFileSync'),
      exec: wrap('exec', true), execSync: wrap('execSync', true), fork: wrap('fork'),
    };
    return { ...real, ...wrapped, default: { ...real, ...wrapped } };
  };
  return { spawned, recordChildProcess };
});
vi.mock('child_process', recordChildProcess);
vi.mock('node:child_process', recordChildProcess);

const BASE = 'main';
const GATE = ['node', '-e', 'process.exit(0)'];
const SPEC = 2;
const ITEM = 3;

/** A program's base name without a Windows executable suffix. */
const program = (cmd: string): string => basename(cmd.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
const isNode = (cmd: string): boolean => cmd === process.execPath || program(cmd) === 'node';
/** The programs that must never run offline: forge CLIs, Copilot, and any shell. */
const FORBIDDEN = /^(gh|az|copilot|cmd|powershell|pwsh|sh|bash|zsh|dash)$/;

/** Prepare's own checks (ship/prepare.ts): scripted green here, because they belong to this repository, not the temp one. */
const PREPARE_SCRIPTS = new Set(['node_modules/typescript/bin/tsc', 'scripts/generate-inventory-graph.mjs']);

interface World {
  dir: string;
  home: string;
  /** The checkout as `git rev-parse --show-toplevel` spells it (what every command resolves). */
  root: string;
  ledgerDir: string;
  /** Every command at the Exec seam (all surfaces and the engine share it). */
  calls: Array<{ cmd: string; args: string[] }>;
  exec: Exec;
  out: string[];
  err: string[];
  trustedUser: unknown;
  /** Index into `spawned` when the world was made. */
  spawnMark: number;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository on `main` with one commit and no remote; OMC_HOME (forge state, mirror, PR store) under the temp dir. */
function world(gate: string[] | null): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omg-offline-e2e-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  vi.stubEnv('OMC_HOME', home);
  vi.stubEnv('OMC_STATE_DIR', '');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', BASE);
  git(repo, 'config', 'user.email', 'e2e@example.com');
  git(repo, 'config', 'user.name', 'e2e');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# offline\n');
  writeFileSync(join(repo, '.gitignore'), '.omg/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const root = git(repo, 'rev-parse', '--show-toplevel');
  const w: World = {
    dir, home, root, ledgerDir: join(dir, 'ledger'), calls: [], out: [], err: [], spawnMark: spawned.length,
    trustedUser: { ship: { base: BASE, trustedBases: [BASE] }, ...(gate ? { factory: { forge: { local: { gate } } } } : {}) },
    exec: () => ({ status: 1, stdout: '', stderr: '' }),
  };
  w.exec = (cmd, args, opts) => {
    w.calls.push({ cmd, args: [...args] });
    if (cmd === 'git') {
      // check, board and poll find the checkout from process.cwd(): answer for this repository.
      const top = args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel';
      return defaultExec(cmd, args, { ...opts, ...(top || !opts?.cwd ? { cwd: w.root } : {}) });
    }
    if (isNode(cmd) && PREPARE_SCRIPTS.has(args[0] ?? '')) return { status: 0, stdout: '', stderr: '' };
    return { status: 127, stdout: '', stderr: `unscripted: ${cmd} ${args.join(' ')}` };
  };
  return w;
}

/** `.copilot/omg.jsonc` as `omg factory` reads it (factory.ts projectConfig). */
function projectConfig(root: string): unknown {
  const path = resolveProjectConfigPath(root);
  return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
}

function checkDeps(w: World): FactoryCheckDeps {
  return {
    exec: w.exec,
    base: () => BASE,
    trustedUser: () => w.trustedUser,
    projectConfig,
    createForge,
    isTTY: () => false,
    confirm: async () => false,
    out: (line) => w.out.push(line),
    err: (line) => w.err.push(line),
  };
}

const setupDeps = (w: World): FactorySetupDeps => ({
  exec: w.exec,
  env: {},
  isTTY: () => false,
  resolveAz: () => { throw new Error('az is never resolved for the local forge'); },
  createForge,
  userConfigPath: () => join(w.home, 'user-config.jsonc'),
});

/** poll's production wiring: the real base sync (factory.ts pollLocalBaseSync) on this world's exec. */
const pollDeps = (w: World): FactoryPollDeps => ({
  ...checkDeps(w),
  healScan: () => { throw new Error('the local forge has no heal'); },
  autoStart: async () => { throw new Error('factory.intake.autoStart is off: no auto-start'); },
  onStop: () => () => undefined,
  localBaseSync: pollLocalBaseSync(w.exec, w.ledgerDir),
});

/** The last JSON document a command printed. */
function lastJson<T>(w: World): T {
  return JSON.parse(w.out.splice(0).join('\n')) as T;
}

/** `git add -A && git commit` in the checkout (the human committing on the base). */
function commitAll(w: World, message: string): void {
  git(w.root, 'add', '-A');
  git(w.root, 'commit', '-q', '-m', message);
}

/** `omg factory run <issue>` as factory.ts builds it (forge config from the trusted layers, full untrusted roots), with fake lanes. */
async function factoryRun(w: World, issue: number, scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}): Promise<{ out: FactoryRunOutcome; lanes: FakeLanes; warnings: string[] }> {
  const loaded = loadFactoryForgeConfig(factoryGuardExec(w.exec), w.root, BASE, w.trustedUser, projectConfig(w.root));
  const lanes = new FakeLanes(w.root, scripts);
  const warnings = [...loaded.warnings];
  const out = await runFactoryEngine({
    root: w.root,
    issue,
    exec: w.exec,
    lanes,
    limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
    base: BASE,
    pollMs: 5,
    owner: { pid: 4242, hostname: 'offline-e2e', isAlive: () => false },
    ledgerDir: w.ledgerDir,
    processes: new FakeProcesses(),
    forge: { config: loaded.config, options: factoryForgeOptions(w.root) },
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { out, lanes, warnings };
}

/** `omg factory setup --forge local --yes`, committed on the base, plus an open spec item #2. */
async function setUpLocalForge(w: World): Promise<void> {
  const r = await runFactorySetup({ forge: 'local', yes: true }, setupDeps(w), w.root);
  expect(r.error).toBeUndefined();
  expect(r.exitCode).toBe(0);
  writeFileSync(join(w.root, '.copilot', 'backlog', `${SPEC}-offline-spec.md`), '---\ntitle: "Offline spec"\nstate: open\n---\nThe spec.\n\n## Acceptance\n- [ ] the children ship\n');
  commitAll(w, 'factory: local forge');
}

/** The run's state files, for a failure message (a state-tampered park names the copy it moved aside). */
function stateFiles(w: World): string {
  const dir = join(w.root, '.omg', 'state', 'factory');
  if (!existsSync(dir)) return '(no .omg/state/factory)';
  return readdirSync(dir).map((n) => `--- ${n}\n${readFileSync(join(dir, n), 'utf8').slice(0, n.includes('.tampered-') ? Infinity : 4000)}`).join('\n');
}

/** No forbidden program anywhere: neither at the Exec seam nor as any child process of this test. */
function assertOffline(w: World): void {
  expect(w.calls.map((c) => program(c.cmd)).filter((p) => FORBIDDEN.test(p))).toEqual([]);
  // At the Exec seam: git, and node only for prepare's scripted checks.
  expect(w.calls.filter((c) => c.cmd !== 'git' && !(isNode(c.cmd) && PREPARE_SCRIPTS.has(c.args[0] ?? '')))).toEqual([]);
  const children = spawned.slice(w.spawnMark);
  expect(children.filter((c) => c.shell)).toEqual([]);
  expect(children.filter((c) => FORBIDDEN.test(program(c.cmd)))).toEqual([]);
  expect([...new Set(children.map((c) => (isNode(c.cmd) ? 'node' : program(c.cmd))))].filter((p) => p !== 'git' && p !== 'node')).toEqual([]);
  // Reading `remote get-url origin` is how every command finds there is none; nothing fetches, pushes or adds one.
  expect(w.calls.filter((c) => c.cmd === 'git' && c.args.includes('origin') && !(c.args.includes('get-url')))).toEqual([]);
}

describe('omg factory on the local (offline) forge, end to end', () => {
  describe('setup -> enqueue -> check -> board -> run -> human merge -> poll -> run', () => {
    let w: World;
    let stateDir: string;
    let mirror: string;
    let head: string;
    let mergeCommand: string | undefined;

    beforeAll(() => {
      w = world(null);
      stateDir = factoryForgeOptions(w.root).stateDir!;
      mirror = localMirrorPath(stateDir, w.root);
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      if (w) rmSync(w.dir, { recursive: true, force: true });
    });

    it('setup --forge local writes the local forge config and a closed sample item, with git only', async () => {
      await setUpLocalForge(w);
      const config = projectConfig(w.root) as { factory: unknown };
      expect(config.factory).toMatchObject({ forge: { kind: 'local', local: { backlogDir: '.copilot/backlog' } }, intake: { source: { type: 'local-backlog' } } });
      expect(readdirSync(join(w.root, '.copilot', 'backlog')).sort()).toEqual(['1-example.md', `${SPEC}-offline-spec.md`]);
      // Setup creates no mirror: the first run does.
      expect(existsSync(mirror)).toBe(false);
      assertOffline(w);
    });

    it('enqueue writes the ticket as an uncommitted backlog file, which check blocks as untrusted', async () => {
      const file = join(w.dir, 'tickets.json');
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, spec: SPEC, tickets: [{ key: 'greet', title: 'Add greet()', body: '## Context\nA greeting.\n', acceptance: ['`greet()` returns hi'], blockedBy: [] }] }));
      const code = await runFactoryEnqueue({ spec: String(SPEC), file, json: true }, checkDeps(w));
      const json = lastJson<EnqueueJson>(w);
      expect(code).toBe(0);
      expect(json.items.map((i) => [i.key, i.id, i.action, i.reasons[0]])).toEqual([['greet', ITEM, 'created', 'uncommitted']]);
      const written = readdirSync(join(w.root, '.copilot', 'backlog')).find((n) => n.startsWith(`${ITEM}-`));
      expect(written).toBeDefined();
      expect(git(w.root, 'status', '--porcelain')).toContain(`.copilot/backlog/${written}`);
      assertOffline(w);
    });

    it('check: once committed on the base, the item is runnable and the offline limitations are printed', async () => {
      commitAll(w, 'backlog: greet');
      const code = await runFactoryCheck({ ids: [String(ITEM)], json: true }, checkDeps(w));
      const json = lastJson<CheckJson>(w);
      expect(code).toBe(0);
      expect(json.forge).toBe('local');
      expect(json.limitations).toEqual(localForgeLimitations(BASE));
      expect(json.items.map((i) => [i.id, i.bucket])).toEqual([[ITEM, 'runnable']]);
      assertOffline(w);
    });

    it('board lists the backlog items from the local forge', async () => {
      const code = await runFactoryBoard({ json: true }, checkDeps(w));
      const json = lastJson<BoardJson>(w);
      expect(code).toBe(0);
      expect(json.limitations).toEqual(localForgeLimitations(BASE));
      const ids = json.columns.flatMap((c) => c.items.map((r) => r.id));
      expect(ids).toEqual(expect.arrayContaining([SPEC, ITEM]));
      assertOffline(w);
    });

    it('run with no gate configured drives intake -> implement -> publish to the mirror -> review -> prepare, then parks at awaiting-human: gates', async () => {
      const { out, lanes } = await factoryRun(w, ITEM, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]);
      expect(out.exitCode, `${out.message}\n${stateFiles(w)}`).toBe(EXIT_AWAITING_HUMAN);
      expect(out.gate?.name).toBe('gates');
      expect(out.gate?.reason).toMatch(/no local gate: set factory\.forge\.local\.gate/);
      expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ITEM}-implement-1`, expect.stringMatching(new RegExp(`^issue-${ITEM}-review`))]);
      const state = readFactoryState(w.root, ITEM)!;
      expect(state).toMatchObject({ forgeKind: 'local', remote: 'omg-local', repoUrl: mirror, pr: 1 });
      head = state.head!;

      // The engine-owned mirror under OMC_HOME holds the base and the pushed head; the only remote is omg-local.
      expect(mirror.startsWith(w.home)).toBe(true);
      expect(readMirrorRef(mirror, `factory/issue-${ITEM}`)).toBe(head);
      expect(readMirrorRef(mirror, BASE)).toBe(git(w.root, 'rev-parse', BASE));
      expect(git(w.root, 'remote')).toBe('omg-local');
      expect(git(w.root, 'remote', 'get-url', 'omg-local')).toBe(mirror);

      // The PR store has PR #1 open; no gate ran, so there is no check record.
      const store = JSON.parse(readFileSync(localPrStorePath(stateDir, w.root), 'utf8')) as { prs: Array<{ number: number; state: string }> };
      expect(store.prs.map((p) => [p.number, p.state])).toEqual([[1, 'OPEN']]);
      expect(readLocalCheckRecord(stateDir, w.root, head)).toBeUndefined();
      expect(spawned.slice(w.spawnMark).filter((c) => isNode(c.cmd))).toEqual([]);
      assertOffline(w);
    });

    it('once the human sets factory.forge.local.gate, the rerun runs the real gate on the same head and parks at the human merge', async () => {
      w.trustedUser = { ship: { base: BASE, trustedBases: [BASE] }, factory: { forge: { local: { gate: GATE } } } };
      const { out, lanes } = await factoryRun(w, ITEM, []);
      expect(out.exitCode, `${out.message}\n${stateFiles(w)}`).toBe(0);
      expect(out.gate?.name).toBe('merge');
      expect(lanes.started).toEqual([]);
      const state = readFactoryState(w.root, ITEM)!;
      expect(state).toMatchObject({ phase: 'merge', pr: 1, head, localGate: GATE });
      mergeCommand = out.mergeCommand;

      // The real gate ran once, as node without a shell, in the prepare checkout; its record is the one check.
      expect(readLocalCheckRecord(stateDir, w.root, head)).toMatchObject({ state: 'SUCCESS', exitCode: 0 });
      const gates = spawned.slice(w.spawnMark).filter((c) => isNode(c.cmd));
      expect(gates.map((g) => g.args.slice(-2))).toEqual([['-e', 'process.exit(0)']]);

      expect(mergeCommand).toBe(`git -C ${w.root} merge --no-ff ${head}`);
      assertOffline(w);
    });

    it('after the human merge, poll syncs the mirror base (production wiring) and reads PR #1 as merged', async () => {
      execFileSync('git', ['-C', w.root, 'merge', '--no-ff', head], { stdio: 'ignore', env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' } });
      const code = await runFactoryPoll({ once: true, json: true }, pollDeps(w));
      const tick = JSON.parse(w.out.splice(0).pop()!) as PollTick;
      expect(code, JSON.stringify(tick.errors)).toBe(0);
      expect(tick.forge).toBe('local');
      const merged = git(w.root, 'rev-parse', BASE);
      expect(tick.baseSync).toEqual({ ran: true, message: `synced ${BASE} ${merged.slice(0, 12)} to the local forge mirror` });
      expect(readMirrorRef(mirror, BASE)).toBe(merged);
      expect(tick.prs).toEqual([expect.objectContaining({ id: ITEM, pr: 1, state: 'MERGED' })]);
      assertOffline(w);
    });

    it('the next run records the merge: phase merged, PR #1 MERGED in the store', async () => {
      const { out } = await factoryRun(w, ITEM, []);
      expect(out.exitCode, `${out.message}\n${stateFiles(w)}`).toBe(0);
      expect(readFactoryState(w.root, ITEM)!.phase).toBe('merged');
      const store = JSON.parse(readFileSync(localPrStorePath(stateDir, w.root), 'utf8')) as { prs: Array<{ number: number; state: string }> };
      expect(store.prs.map((p) => [p.number, p.state])).toEqual([[1, 'MERGED']]);
      assertOffline(w);
    });

    it('check no longer offers the merged item: its merged local PR closes it', async () => {
      const code = await runFactoryCheck({ ids: [String(ITEM)], json: true }, checkDeps(w));
      const json = lastJson<CheckJson>(w);
      expect(code).toBe(0);
      expect(json.items.map((i) => [i.id, i.bucket, i.reasons[0]])).toEqual([[ITEM, 'blocked', 'closed']]);
      assertOffline(w);
    });
  });

  it('a planted hostile remote.omg-local.pushurl: run and poll exit 5 and nothing reaches the hostile repository', async () => {
    const w = world(GATE);
    try {
      await setUpLocalForge(w);
      const mirror = localMirrorPath(factoryForgeOptions(w.root).stateDir!, w.root);
      const evil = join(w.dir, 'evil.git');
      git(w.dir, 'init', '-q', '--bare', evil);
      git(w.root, 'remote', 'add', 'omg-local', mirror);
      git(w.root, 'config', 'remote.omg-local.pushurl', evil);

      const { out, lanes } = await factoryRun(w, SPEC, [commitFile('src/spec.js'), review('approve')]);
      expect(out.exitCode, out.message).toBe(5);
      expect(out.message).toMatch(/unsupported forge/);
      expect(lanes.started).toEqual([]);

      const before = process.exitCode;
      try {
        await factoryPollCommand(pollDeps(w)).parseAsync(['--once', '--json'], { from: 'user' });
        expect(process.exitCode).toBe(5);
      } finally {
        process.exitCode = before;
      }
      expect(JSON.parse(w.out.pop()!)).toMatchObject({ ok: false, error: expect.stringContaining('omg-local') });

      expect(w.calls.filter((c) => c.cmd === 'git' && c.args.includes('push'))).toEqual([]);
      expect(git(evil, 'for-each-ref', '--format=%(refname)')).toBe('');
      assertOffline(w);
    } finally {
      vi.unstubAllEnvs();
      if (w) rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
