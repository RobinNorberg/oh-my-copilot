/**
 * Offline factory dogfood round 2 on the local forge engine (F37-F42): fake
 * lanes, a real repository with no origin, the engine-owned bare mirror
 * under a temp forge state dir. No gh, az or copilot runs, and no AI credits.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMirrorRef } from '../../../forge/local/index.js';
import { createForge } from '../../../forge/index.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { cleanFactoryRun } from '../clean.js';
import { runFactoryEngine, EXIT_AWAITING_HUMAN } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { ledgerFilePath } from '../ledger.js';
import { resetFactoryRun } from '../reset.js';
import { factoryStatePath, readFactoryState, requestFactoryCancel } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const BRANCH = `factory/issue-${LOCAL_ISSUE}`;
/** Tests that drive the engine several times (each run is a real repository, mirror and prepare checkout). */
const MULTI_RUN_MS = 300_000;
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };
const forgeWith = (gate: string[]) => ({ config: { ...w.config, local: { ...w.config.local!, gate } }, options: { ...factoryForgeOptions(w.root), stateDir: w.stateDir } });
const prStore = () => JSON.parse(readFileSync(join(w.config.repo.url.slice(0, -'.git'.length), 'prs.json'), 'utf8')) as { prs: Array<{ number: number; state: string; closedReason?: string; closedHead?: string }> };
const notStarted = async () => ({ status: 127, stdout: '', stderr: '', timedOut: false, startError: 'the local gate executable pnpm is not on PATH' });

/** Commit package.json on the base, so the lanes branch from it. */
function basePackage(scripts: Record<string, string>): string {
  const text = `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts }, null, 2)}\n`;
  writeFileSync(join(w.root, 'package.json'), text);
  gitIn(w.root, 'add', 'package.json');
  gitIn(w.root, 'commit', '-q', '-m', 'package.json');
  return text;
}

describe('F37: a sealed gate that never started does not bind the run', () => {
  it('a rerun after the unstartable-gate park adopts the fixed trusted gate and reaches the merge gate', async () => {
    w = localWorld(['pnpm', 'test']);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { localGate: notStarted }));
    expect(out.gate?.name, out.message).toBe('gates');
    expect(out.gate?.reason).toMatch(/the local gate could not start/);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.localGate).toEqual(['pnpm', 'test']);

    const again = await runFactoryEngine(localOpts(w, lanesFor(w, []), { forge: forgeWith(['npm', 'test']) }));
    expect(again.exitCode, again.message).toBe(0);
    expect(again.gate?.name).toBe('merge');
    expect(w.gateRuns.map((r) => r.argv)).toEqual([['npm', 'test']]);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.localGate).toEqual(['npm', 'test']);
    expect(state.history.some((h) => h.note === 'local gate re-sealed as npm test: the recorded pnpm test never started')).toBe(true);
  }, MULTI_RUN_MS);
});

describe('F38: cancel closes the local PR; clean + reset make the item runnable again', () => {
  it('cancel -> local PR CLOSED (cancelled) -> clean -> reset keeps the branch aside -> a new run opens a new PR', async () => {
    w = localWorld();
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(first.gate?.name, first.message).toBe('merge');
    const oldHead = readFactoryState(w.root, LOCAL_ISSUE)!.head!;

    requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    const cancelled = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
    expect(cancelled.phase, cancelled.message).toBe('cancelled');
    expect(prStore().prs.find((p) => p.number === 1)).toMatchObject({ state: 'CLOSED', closedReason: 'cancelled', closedHead: oldHead });
    const comments = readFileSync(join(w.root, '.omg', 'factory', 'local', 'prs', '1', 'comments.md'), 'utf8');
    expect(comments).toMatch(/The local PR is closed \(cancelled\).*omg factory run reset 7/);

    const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
    const resetOpts = { root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER };
    // The worktrees go first.
    expect(() => resetFactoryRun(resetOpts)).toThrow(/still has worktrees .*omg factory run clean 7 first/);
    const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
    expect(cleaned.kept, JSON.stringify(cleaned.kept)).toEqual([]);

    const reset = resetFactoryRun({ ...resetOpts, now: '2026-11-08T10:00:00.000Z' });
    expect(reset.closedPr).toBeUndefined(); // the cancel already closed it
    expect(reset.keptBranch).toBe('factory/cancelled/issue-7-2026-11-08t10-00-00-000z');
    expect(readMirrorRef(w.config.repo.url, reset.keptBranch!)).toBe(oldHead);
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
    expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
    expect(existsSync(reset.stateMovedTo)).toBe(true);

    const rerun = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(rerun.exitCode, rerun.message).toBe(0);
    expect(rerun.gate?.name).toBe('merge');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.pr).toBe(2);
    expect(prStore().prs.map((p) => [p.number, p.state])).toEqual([[1, 'CLOSED'], [2, 'OPEN']]);
  }, MULTI_RUN_MS);

  it('a reset rerun after one that stopped midway finishes, reusing the kept branch at the same sha', async () => {
    w = localWorld();
    await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    const oldHead = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    expect((await runFactoryEngine(localOpts(w, lanesFor(w, [])))).phase).toBe('cancelled');
    cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });

    // The first reset kept the branch and moved the ledger aside, then stopped before moving the state.
    const earlier = `factory/cancelled/issue-${LOCAL_ISSUE}-2026-11-08t09-00-00-000z`;
    gitIn(w.root, 'push', '-q', w.config.repo.url, `${oldHead}:refs/heads/${earlier}`);
    const ledger = ledgerFilePath(w.ledgerDir, w.root, LOCAL_ISSUE);
    renameSync(ledger, `${ledger}.reset-2026-11-08T09-00-00-000Z`);

    // A run in between refuses and points at the reset that finishes it.
    const refused = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toMatch(new RegExp(`Run omg factory run reset ${LOCAL_ISSUE} to finish a reset`));

    const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
    const reset = resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER, now: '2026-11-08T10:00:00.000Z' });
    expect(reset.keptBranch).toBe(earlier);
    expect(readMirrorRef(w.config.repo.url, 'factory/cancelled/issue-7-2026-11-08t10-00-00-000z')).toBeUndefined();
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
    expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();

    // A state the engine never wrote (no ledger, no matching aside) is still refused.
    writeFileSync(factoryStatePath(w.root, LOCAL_ISSUE), readFileSync(reset.stateMovedTo, 'utf8'));
    rmSync(`${ledger}.reset-2026-11-08T09-00-00-000Z`);
    expect(() => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER }))
      .toThrow(/is not the engine's last write/);
  }, MULTI_RUN_MS);

  it('reset refuses a run that is not cancelled', async () => {
    w = localWorld();
    await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
    expect(() => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER }))
      .toThrow(/is merge \(awaiting-human: merge\); reset starts over a cancelled run only/);
  });
});

describe('F41: a lane may not redefine the local gate', () => {
  it('a lane that adds the gate\'s lint script parks at gate-definition-changed (nothing pushed); --allow-gate-change records it and goes on', async () => {
    w = localWorld(['npm', 'run', 'lint']);
    const base = basePackage({ test: 'node --test' });
    const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)])));
    expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('gate-definition-changed');
    expect(out.gate?.reason).toMatch(/redefines the local gate "npm run lint" \(package\.json scripts prelint\/lint\/postlint, \.npmrc, \.yarnrc, \.yarnrc\.yml, \.pnpmfile\.cjs differ from main\).*--allow-gate-change/);
    expect(out.state?.gate?.definition).toMatch(/^[0-9a-f]{64}$/);
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();

    // A plain rerun parks again; the explicit flag accepts this definition.
    const plain = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
    expect(plain.gate?.name).toBe('gate-definition-changed');
    const parkedOn = plain.state!.gate!.definition!;
    const allowed = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), { allowGateChange: true }));
    expect(allowed.exitCode, allowed.message).toBe(0);
    expect(allowed.gate?.name).toBe('merge');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    // The hash of the accepted definition, never the definition text.
    expect(state.gateChangeApproved).toBe(parkedOn);
    expect(state.history.some((h) => /gate definition change in [0-9a-f]{12} accepted \(--allow-gate-change\): package\.json/.test(h.note))).toBe(true);
  }, MULTI_RUN_MS);

  it('--allow-gate-change without a gate-definition-changed park is ignored with a warning and approves nothing in advance', async () => {
    w = localWorld(['npm', 'run', 'lint']);
    const base = basePackage({ test: 'node --test' });
    const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
    const warnings: string[] = [];
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)]), { allowGateChange: true, warn: (m) => warnings.push(m) }));
    expect(out.gate?.name, out.message).toBe('gate-definition-changed');
    expect(warnings.some((m) => /--allow-gate-change is ignored: the run for .* is not parked at awaiting-human: gate-definition-changed/.test(m))).toBe(true);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gateChangeApproved).toBeUndefined();
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();
  }, MULTI_RUN_MS);

  it('the flag accepts the parked change once: a second change by a later fix lane in the same run parks again', async () => {
    w = localWorld(['npm', 'run', 'lint']);
    const base = basePackage({ test: 'node --test' });
    const withLint = base.replace('"test": "node --test"', '"test": "node --test",\n    "lint": "exit 0"');
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', withLint)])));
    expect(out.gate?.name, out.message).toBe('gate-definition-changed');
    const first = out.state!.gate!.definition!;

    const finding = { severity: 'major', file: 'package.json', line: 1, summary: 'lint must check something' };
    const again = await runFactoryEngine(localOpts(w, lanesFor(w, [
      review('request-changes', [finding]),
      commitFile('package.json', withLint.replace('"lint": "exit 0"', '"lint": "node -e 0"')),
    ]), { allowGateChange: true }));
    expect(again.exitCode, again.message).toBe(EXIT_AWAITING_HUMAN);
    expect(again.gate?.name).toBe('gate-definition-changed');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.gateChangeApproved).toBe(first);
    expect(state.gate!.definition).toMatch(/^[0-9a-f]{64}$/);
    expect(state.gate!.definition).not.toBe(first);
    // The accepted head was published; the fix lane's head was not.
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBe(state.head);
    expect(state.pendingHead).not.toBe(state.head);
  }, MULTI_RUN_MS);

  it('an npm-style gate whose script cannot be told from its argv parks at gate-definition-unknown before any lane', async () => {
    w = localWorld(['npm', '--workspace', 'app', 'test']);
    const lanes = lanesFor(w, [greet()]);
    const out = await runFactoryEngine(localOpts(w, lanes));
    expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('gate-definition-unknown');
    expect(out.gate?.reason).toMatch(/selects workspace packages \(--workspace\).*no further lane was started/);
    expect(lanes.started).toEqual([]);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.lanes).toEqual([]);
    expect(readMirrorRef(w.config.repo.url, BRANCH)).toBeUndefined();

    // A rerun with the gate still unresolved parks again, still before any lane.
    const again = await runFactoryEngine(localOpts(w, lanes));
    expect(again.gate?.name).toBe('gate-definition-unknown');
    expect(lanes.started).toEqual([]);
  });

  it('--dry-run reports a requested cancel and a cancelled run before the unknown gate', async () => {
    w = localWorld(['npm', '--workspace', 'app', 'test']);
    const lanes = lanesFor(w, []);
    const parked = await runFactoryEngine(localOpts(w, lanes));
    expect(parked.gate?.name).toBe('gate-definition-unknown');

    requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    const asked = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
    expect(asked.message).toMatch(/a cancel is requested/);
    expect(asked.plan).toMatchObject({ next: 'cancelled' });

    const done = await runFactoryEngine(localOpts(w, lanes));
    expect(done.phase).toBe('cancelled');
    const after = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
    expect(after.message).toBe('dry run: the run is cancelled; nothing would run');
    expect(after.plan).toMatchObject({ next: 'cancelled' });
    expect(lanes.started).toEqual([]);
  });

  it('--dry-run reports the gate-definition-unknown park', async () => {
    w = localWorld(['yarn', 'workspace', 'app', 'test']);
    const lanes = lanesFor(w, []);
    const out = await runFactoryEngine(localOpts(w, lanes, { dryRun: true }));
    expect(out.exitCode, out.message).toBe(0);
    expect(out.message).toMatch(/runs yarn workspace, not a package.json script.*awaiting-human: gate-definition-unknown before any lane/);
    expect(out.plan).toMatchObject({ next: 'awaiting-human', reason: 'gate-definition-unknown' });
    expect(lanes.started).toEqual([]);
    expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
  });

  it('an unrelated package.json change does not park', async () => {
    w = localWorld(['npm', 'run', 'lint']);
    const base = basePackage({ lint: 'node --check index.js' });
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('package.json', base.replace('"1.0.0"', '"1.1.0"')), review('approve')])));
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
  });
});

describe('F42: a fetch that moves no branch is not tampering', () => {
  it('the PR branch fetched into refs/remotes/omg-local during review keeps the verdict', async () => {
    w = localWorld();
    const fetchPr = review('approve', [], ({ root, baseSha }) => gitIn(root, 'update-ref', `refs/remotes/omg-local/${BRANCH}`, baseSha));
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), fetchPr])));
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
  });

  it('a tracking ref at another sha still discards the verdict, and the message does not blame the lane alone', async () => {
    w = localWorld();
    const moved = review('approve', [], ({ root }) => gitIn(root, 'update-ref', `refs/remotes/omg-local/${BRANCH}`, gitIn(root, 'rev-parse', 'HEAD')));
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), moved])));
    expect(out.gate?.name, out.message).toBe('review-tampered');
    expect(out.gate?.reason).toMatch(/shared git state changed while review lane .* ran \(by the lane or anyone else working in this repository\)/);
  });
});

describe('F39 + F40: --dry-run applies the pr-exists gate and probes the gate executable', () => {
  it('reports pr-exists for an open local PR on the branch', async () => {
    w = localWorld();
    await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    const path = factoryStatePath(w.root, LOCAL_ISSUE);
    renameSync(path, `${path}.aside`);
    const dry = await runFactoryEngine(localOpts(w, lanesFor(w, []), { dryRun: true }));
    expect(dry.message).toBe(`dry run: open PR #1 already uses ${BRANCH}; the run would stop at awaiting-human: pr-exists`);
    expect(dry.plan).toMatchObject({ next: 'awaiting-human', reason: 'pr-exists' });
  }, MULTI_RUN_MS);

  it('reports a gate whose executable cannot start, without spawning it', async () => {
    w = localWorld(['omg-no-such-gate-exe-f40', 'test']);
    const dry = await runFactoryEngine(localOpts(w, lanesFor(w, []), { dryRun: true }));
    expect(dry.message).toMatch(/the run would start an implement lane .*; but the local gate cannot start \(the local gate executable omg-no-such-gate-exe-f40 .*not on PATH.*\), so after review the run would park at awaiting-human: gates$/);
    expect(dry.plan?.gateProblem).toMatch(/omg-no-such-gate-exe-f40/);
    expect(w.gateRuns).toEqual([]);
  });
});
