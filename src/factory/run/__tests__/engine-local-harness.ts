/**
 * The harness of the local (offline) forge engine tests: a real repository
 * on `main` with no origin, the local forge config resolved as `omg factory
 * run` resolves it (user config `factory.forge.kind: "local"`), an
 * engine-owned forge state dir under the temp dir, fake lanes, and a fake gate
 * runner. Every command reaching the exec seam is recorded; git runs for
 * real, prepare's `node` checks pass, and anything else (gh, az, copilot)
 * fails as unscripted so a test can assert that none ran.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveForgeConfig } from '../../../forge/config.js';
import type { ResolvedForgeConfig } from '../../../forge/types.js';
import { resolveShipConfig } from '../../../ship/config.js';
import { defaultExec, type Exec } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import type { FactoryEngineOptions } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import type { LocalGateRunner } from '../local-gate.js';
import type { GateConfigLoader } from '../prepare.js';
import { FakeLanes, FakeProcesses, gitIn, type LaneScript } from './fake-lanes.js';

export const LOCAL_ISSUE = 7;
export const BASE = 'main';
export const BACKLOG_ITEM = '---\ntitle: Add greet()\nlabels: [factory]\n---\nAdd a greet function.\n\n## Acceptance\n- [ ] greet() returns hi\n';

export interface LocalWorld {
  dir: string;
  root: string;
  stateDir: string;
  ledgerDir: string;
  config: ResolvedForgeConfig;
  /** Every command at the exec seam, `-c k=v` pairs included. */
  raw: Array<{ cmd: string; args: string[] }>;
  /** Commands without the leading `-c k=v` pairs (`git push omg-local ...`). */
  calls: string[];
  exec: Exec;
  /** The gate runs: argv, cwd and the HEAD of that cwd when it ran. */
  gateRuns: Array<{ argv: readonly string[]; cwd: string; head: string }>;
  /** Exit status per gate run, in order (the last repeats); default 0. */
  gateStatus: number[];
  gate: LocalGateRunner;
}

/** A repository on `main` with the backlog item #7 committed, and no remote. */
export function localWorld(gate: string[] | null = ['node', '--test']): LocalWorld {
  const dir = mkdtempSync(join(tmpdir(), 'omg-factory-local-'));
  const root = join(dir, 'repo');
  mkdirSync(root);
  gitIn(root, 'init', '-q', '-b', BASE);
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, '.gitignore'), '.omg/\n');
  mkdirSync(join(root, '.copilot', 'backlog'), { recursive: true });
  writeFileSync(join(root, '.copilot', 'backlog', `${LOCAL_ISSUE}-add-greet.md`), BACKLOG_ITEM);
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-q', '-m', 'init');
  const stateDir = join(dir, 'forge-state');
  const user = { factory: { forge: { kind: 'local', ...(gate ? { local: { gate } } : {}) } } };
  const { config } = resolveForgeConfig(user, undefined, undefined, undefined, { root, stateDir });
  const w: LocalWorld = {
    dir, root, stateDir, ledgerDir: join(dir, 'ledger'), config, raw: [], calls: [], gateRuns: [], gateStatus: [0],
    exec: () => ({ status: 1, stdout: '', stderr: '' }),
    gate: async () => ({ status: 1, stdout: '', stderr: '', timedOut: false }),
  };
  w.exec = (cmd, rawArgs, opts) => {
    w.raw.push({ cmd, args: rawArgs });
    let args = rawArgs;
    while (cmd === 'git' && args[0] === '-c') args = args.slice(2);
    const isNode = cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd);
    w.calls.push(`${isNode ? 'node' : cmd} ${args.join(' ')}`);
    if (isNode) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'git') return defaultExec(cmd, rawArgs, opts);
    return { status: 1, stdout: '', stderr: `unscripted: ${cmd} ${args.join(' ')}` };
  };
  w.gate = async (argv, cwd) => {
    const status = w.gateStatus[Math.min(w.gateRuns.length, w.gateStatus.length - 1)];
    w.gateRuns.push({ argv, cwd, head: gitIn(cwd, 'rev-parse', 'HEAD') });
    return { status, stdout: status === 0 ? 'ok 1 - greet\n' : 'not ok 1 - greet\n', stderr: '', timedOut: false };
  };
  return w;
}

/** Ship's gate config without a fetch; the engine replaces requiredChecks with local-gate on the local forge. */
export const localTestGateConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [] },
  known: [],
});

export function localOpts(w: LocalWorld, lanes: FakeLanes, over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
  return {
    root: w.root,
    issue: LOCAL_ISSUE,
    exec: w.exec,
    lanes,
    limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
    base: BASE,
    pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
    ledgerDir: w.ledgerDir,
    processes: new FakeProcesses(),
    gateConfig: localTestGateConfig,
    forge: { config: w.config, options: { ...factoryForgeOptions(w.root), stateDir: w.stateDir } },
    localGate: w.gate,
    ...over,
  };
}

export const lanesFor = (w: LocalWorld, scripts: LaneScript[]) => new FakeLanes(w.root, scripts);

/** No gh, az or copilot process reached the exec seam. */
export const foreignCommands = (w: LocalWorld): string[] =>
  w.raw.map((c) => c.cmd).filter((cmd) => /(^|[\\/])(gh|az|copilot)(\.exe|\.cmd)?$/i.test(cmd));
