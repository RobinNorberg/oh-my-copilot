/**
 * The private layout end to end (item 2 B1b): `factory.run.layout:
 * "private"` on the local forge with fake lanes. Lanes, the prepare checkout
 * and the local gate work in the engine's private repository under the work
 * root; the user's repository only gets the imported commits by sha and the
 * engine's push from it. Real git in temp dirs; no gh, az or copilot.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readMirrorRef } from '../../../forge/local/index.js';
import { loadTrustedShipConfig, resolveShipConfig } from '../../../ship/config.js';
import type { Exec } from '../../../ship/exec.js';
import { cleanFactoryRun } from '../clean.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { GATE_INSTALL_GATE, REPO_GUARD_GATE } from '../private-run.js';
import type { SandboxRunRequest } from '../sandbox-exec.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { readTamperHold } from '../tamper-quarantine.js';
import { commitFile, ENFORCED_SANDBOX, FakeLanes, FakeProcesses, gitIn, review, type LaneScript } from './fake-lanes.js';
import { BASE, foreignCommands, lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

const T = 600_000;
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');

/** The local world plus a lockfile on the base, your node_modules (with a marker) and the private layout in the user config. */
function privateWorld(): { w: LocalWorld; work: string; user: { factory: { run: Record<string, unknown> } } } {
  const world = localWorld();
  writeFileSync(join(world.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  appendFileSync(join(world.root, '.gitignore'), 'node_modules/\n');
  gitIn(world.root, 'add', 'package-lock.json', '.gitignore');
  gitIn(world.root, 'commit', '-q', '-m', 'lockfile');
  mkdirSync(join(world.root, 'node_modules'), { recursive: true });
  writeFileSync(join(world.root, 'node_modules', 'marker.txt'), 'yours\n');
  const work = join(world.dir, 'fw');
  return { w: world, work, user: { factory: { run: { layout: 'private', workDir: work } } } };
}

/** Every file under the user's .git (objects/ included) with its content hash: what the run may change is asserted against it. */
function gitListing(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(join(root, '.git'), p).replace(/\\/g, '/');
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(join(root, '.git'));
  return out;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
}

/** The git config text without its `[remote "omg-local"]` section (the local forge's own remote). */
function withoutLocalRemote(config: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) skip = /^\s*\[remote "omg-local"\]\s*$/.test(line);
    if (!skip) out.push(line);
  }
  return out.join('\n').trimEnd();
}

const opts = (env: { w: LocalWorld; user: unknown }, scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}) => localOpts(env.w, lanesFor(env.w, scripts), { runUserConfig: env.user, secretScanUserConfig: null, ...over });

/** The file a private-layout quarantine saved (folder `<at>-private-issue-<n>` under the ledger's quarantine dir), by its path in the git dir. */
function privateQuarantined(ledgerDir: string, rel: string): string | undefined {
  const top = join(ledgerDir, 'quarantine');
  if (!existsSync(top)) return undefined;
  for (const key of readdirSync(top)) {
    for (const run of readdirSync(join(top, key)).filter((n) => n.endsWith(`-private-issue-${LOCAL_ISSUE}`))) {
      const p = join(top, key, run, ...rel.split('/'));
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

describe('factory run with factory.run.layout "private"', () => {
  it('implement -> review -> prepare -> local gate -> merge park: lanes, prepare and the gate work under the work root; the user repository only gets the imported commit and the push', async () => {
    const env = privateWorld();
    w = env.w;
    const before = gitListing(w.root);
    const beforeConfig = readFileSync(join(w.root, '.git', 'config'), 'utf8');
    const lanes = lanesFor(w, [greet(), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { runUserConfig: env.user }));

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(s.layout).toBe(2);
    expect(s.privateDir!.startsWith(env.work)).toBe(true);
    expect(s.history.some((h) => h.note.startsWith('private layout: the run\'s private repository is '))).toBe(true);
    // The pushed head is the engine's commit, imported: the mirror has it, and the user's object store holds it.
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBe(s.head);
    expect(gitIn(w.root, 'cat-file', '-t', s.head!)).toBe('commit');
    // Every lane worktree and job dir, and the prepare/gate checkout, under the run dir; none under the checkout.
    for (const start of lanes.started) {
      expect(start.worktree?.path.startsWith(join(s.privateDir!, 'w'))).toBe(true);
      expect(start.jobRoot).toBe(join(s.privateDir!, 'jobs'));
      expect(start.deniedPaths).toContain(join(s.privateDir!, '..', 'seed.git'));
    }
    expect(w.gateRuns.map((r) => r.cwd)).toEqual([join(s.privateDir!, 'w', 'prep')]);
    expect(existsSync(join(w.root, '.omg', 'team'))).toBe(false);
    // The prepare checkout links your node_modules (the lockfile is the base's).
    expect(lstatSync(join(s.privateDir!, 'w', 'prep', 'node_modules')).isSymbolicLink()).toBe(true);

    // The user's .git: only the local forge's own remote, its tracking refs and fetch bookkeeping changed; no worktree, branch or import ref.
    // The engine's push names the mirror path, yet git on the Linux CI runner moved the omg-local tracking ref of the pushed
    // branch (Windows git does not): it may exist, and then only at the pushed head.
    const pushedTracking = `refs/remotes/omg-local/factory/issue-${LOCAL_ISSUE}`;
    const after = gitListing(w.root);
    const changed = changedPaths(before, after);
    expect(changed.filter((p) => !/^(config|FETCH_HEAD|(logs\/)?refs\/remotes\/omg-local\/(main|factory\/issue-\d+)|objects\/.*)$/.test(p))).toEqual([]);
    // review-483 L6: of the config only the local forge's `[remote "omg-local"]` section changed.
    expect(withoutLocalRemote(readFileSync(join(w.root, '.git', 'config'), 'utf8'))).toBe(withoutLocalRemote(beforeConfig));
    // objects/: only new loose objects and packs (the imported commit and what the mirror sync fetched); none changed or gone,
    // and no alternates, http-alternates or other info file.
    const objects = changed.filter((p) => p.startsWith('objects/'));
    expect(objects.filter((p) => before.has(p))).toEqual([]);
    expect(objects.filter((p) => !/^objects\/([0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]{40}\.(pack|idx|rev|keep))$/.test(p))).toEqual([]);
    const refs = gitIn(w.root, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((l) => l !== '');
    for (const line of refs.filter((l) => l.startsWith(`${pushedTracking} `))) expect(line).toBe(`${pushedTracking} ${s.head}`);
    expect(refs.map((l) => l.split(' ')[0]).filter((r) => r !== pushedTracking)).toEqual([`refs/heads/${BASE}`, `refs/remotes/omg-local/${BASE}`]);
    expect(gitIn(w.root, 'status', '--porcelain')).toBe('');
    expect(foreignCommands(w)).toEqual([]);
    expect(out.mergeCommand).toBe(`git -C ${w.root} merge --no-ff --no-edit ${s.head}`);
  }, T);

  it('a hook planted in the private repository by a lane never runs: the lane parks at lane-tampered (control: plain git runs it)', async () => {
    const env = privateWorld();
    w = env.w;
    const userGit = gitListing(w.root);
    const marker = join(w.dir, 'hook-ran');
    const plant: LaneScript = (ctx) => {
      const hooks = join(ctx.input.worktree!.commonGitDir, 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
      return greet()(ctx);
    };
    const out = await runFactoryEngine(opts(env, [plant]));
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/config, hooks or info changed since the engine wrote them/);
    expect(existsSync(marker)).toBe(false);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    // #484's quarantine acted on the PRIVATE git dir (the hook moved out, under the run's name), with no hold on your checkout.
    const hooks = join(s.privateDir!, 'repo', '.git', 'hooks');
    expect(existsSync(join(hooks, 'reference-transaction'))).toBe(false);
    const saved = privateQuarantined(w.ledgerDir, 'hooks/reference-transaction');
    expect(saved).toBeDefined();
    expect(out.gate?.reason).toMatch(/never your repository, so no hold was set on your checkout/);
    expect(readTamperHold(w.ledgerDir, w.root)).toBeNull();
    // Your .git: nothing but the engine's own base fetch (the local forge's remote, its tracking ref, objects) changed.
    expect(changedPaths(userGit, gitListing(w.root)).filter((p) => !/^(config|FETCH_HEAD|(logs\/)?refs\/remotes\/omg-local\/main|objects\/.*)$/.test(p))).toEqual([]);
    // Control: the quarantined hook put back, plain git in the private repository runs it.
    writeFileSync(join(hooks, 'reference-transaction'), readFileSync(saved!), { mode: 0o755 });
    gitIn(join(s.privateDir!, 'repo'), 'update-ref', 'refs/control', s.baseSha!);
    expect(existsSync(marker)).toBe(true);
  }, T);

  it('a change to your repository\'s hooks during the run parks before the import naming the hook, check it before rerunning (review-483b L-b); a rerun continues', async () => {
    const env = privateWorld();
    w = env.w;
    const plant: LaneScript = (ctx) => {
      // You (or anything with your rights) add a hook while the lane runs.
      writeFileSync(join(w.root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      return greet()(ctx);
    };
    const first = await runFactoryEngine(opts(env, [plant]));
    expect(first.gate?.name, first.message).toBe(REPO_GUARD_GATE);
    expect(first.gate?.reason).toContain(`your repository's hooks dir: ${join(w.root, '.git', 'hooks')} changed during the run`);
    expect(first.gate?.reason).toMatch(/can run code on your next git command, so check it before rerunning.*rerun omg factory run 7/);
    expect(first.gate?.reason).not.toMatch(/rerunning .* continues/);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();

    const second = await runFactoryEngine(opts(env, [review('approve')]));
    expect(second.gate?.name, second.message).toBe('merge');
  }, T);

  it('a lockfile the PR changes parks at gate-install-needed by default; "sandboxed" runs npm ci --ignore-scripts in the OS sandbox with the registry', async () => {
    const env = privateWorld();
    w = env.w;
    const bump = commitFile('package-lock.json', '{"lockfileVersion":3,"x":1}\n');
    const first = await runFactoryEngine(opts(env, [bump, review('approve')]));
    expect(first.gate?.name, first.message).toBe(GATE_INSTALL_GATE);
    expect(first.gate?.reason).toMatch(/the PR changes package-lock\.json, so the prepare checkout .* cannot use your node_modules.*factory\.run\.gateInstall "sandboxed"/);

    const installs: SandboxRunRequest[] = [];
    const runner = async (req: SandboxRunRequest) => {
      if (req.purpose === 'install') { installs.push(req); return { ran: true as const, status: 0, output: 'added 0 packages', timedOut: false }; }
      if (req.purpose === 'gate') { const r = await w.gate(req.argv, req.cwd, req.timeoutMs); return { ran: true as const, status: r.status, output: r.stdout, timedOut: false }; }
      return { ran: true as const, status: 0, output: '', timedOut: false };
    };
    const second = await runFactoryEngine(opts({ w, user: { factory: { run: { ...env.user.factory.run, gateInstall: 'sandboxed' } } } }, [], { gateSandbox: runner }));
    expect(second.gate?.name, second.message).toBe('merge');
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ network: 'registry', cwd: join(s.privateDir!, 'w', 'prep'), commonGitDir: join(s.privateDir!, 'repo', '.git') });
    expect(installs[0].argv).toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(existsSync(join(s.privateDir!, 'w', 'prep', 'node_modules'))).toBe(false);
  }, T);

  it('a failed prepare check after a base merge: the merge is imported first, then the ci-fix lane\'s commit on it', async () => {
    const env = privateWorld();
    w = env.w;
    // The base moves while the implement lane runs: prepare merges it (a private merge commit).
    const moveBase: LaneScript = (ctx) => {
      writeFileSync(join(w.root, 'other.txt'), 'base moved\n');
      gitIn(w.root, 'add', 'other.txt');
      gitIn(w.root, 'commit', '-q', '-m', 'base moves');
      return greet()(ctx);
    };
    let checks = 0;
    const exec: Exec = (cmd, args, o) => {
      // The configured prepare check fails once (the attested test sandbox runs it through the exec seam).
      if (/check\.mjs$/.test(args[0] ?? '') && checks++ === 0) return { status: 1, stdout: 'not ok\n', stderr: '' };
      return w.exec(cmd, args, o);
    };
    const gateConfig = () => ({ config: { ...localTestConfig(), prepareChecks: [[process.execPath, 'check.mjs']] }, known: [] });
    const lanes = lanesFor(w, [moveBase, review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
    const o = localOpts(w, lanes, { runUserConfig: env.user, gateConfig });
    const out = await runFactoryEngine({ ...o, exec, gateSandbox: attested(exec) });
    expect(out.gate?.name, out.message).toBe('merge');
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    const ciFix = s.lanes.find((l) => l.kind === 'ci-fix')!;
    // The ci-fix lane started at prepare's merge, which is in the user repository with both its parents.
    const parents = gitIn(w.root, 'rev-list', '--parents', '-n', '1', ciFix.startSha).split(' ');
    expect(parents).toHaveLength(3);
    expect(gitIn(w.root, 'rev-list', '--parents', '-n', '1', ciFix.endSha!).split(' ')[1]).toBe(ciFix.startSha);
    expect(gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/omg-import/')).toBe('');
  }, T);

  it('settles a lost lane against the private snapshot, and resumes after an engine crash at the publish push and in the local gate', async () => {
    const env = privateWorld();
    w = env.w;
    const crashes = ['push', 'gate'];
    let pushes = 0;
    const exec: Exec = (cmd, args, o) => {
      const plain = args.filter((_, i) => !(args[i] === '-c' || args[i - 1] === '-c'));
      // The publish push of the run's branch (not the mirror's base sync), inside the import section.
      if (crashes[0] === 'push' && plain[0] === 'push' && plain.some((a) => a.includes(':refs/heads/factory/')) && pushes++ === 0) { crashes.shift(); throw new Error('engine crash at the push'); }
      return w.exec(cmd, args, o);
    };
    let gateCalls = 0;
    const gate: typeof w.gate = async (argv, cwd, ms) => {
      if (crashes[0] === 'gate' && gateCalls++ === 0) { crashes.shift(); throw new Error('engine crash in the gate'); }
      return w.gate(argv, cwd, ms);
    };
    const base = { runUserConfig: env.user, exec, localGate: gate };
    // The first implement lane is lost (its job vanished); its child is gone, so it settles and a fresh lane runs.
    // One `running` poll first records its child's pid (dead in FakeProcesses), so the loss can be settled.
    const one = await runFactoryEngine(localOpts(w, new FakeLanes(w.root, [() => ({ lost: true }), greet()], [1]), base));
    expect(one.exitCode, one.message).toBe(1);
    expect(one.message).toMatch(/engine crash at the push/);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.lanes.map((l) => l.status)).toEqual(['lost', 'completed']);
    expect(gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/omg-import/')).toBe('');
    const two = await runFactoryEngine(localOpts(w, lanesFor(w, [review('approve')]), base));
    expect(two.exitCode, two.message).toBe(1);
    expect(two.message).toMatch(/engine crash in the gate/);
    const three = await runFactoryEngine(localOpts(w, lanesFor(w, []), base));
    expect(three.gate?.name, three.message).toBe('merge');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.layout).toBe(2);
  }, T);

  it('a dry run says the private layout would be used; the shared layout\'s dry run is unchanged', async () => {
    const env = privateWorld();
    w = env.w;
    const dry = await runFactoryEngine(opts(env, [], { dryRun: true }));
    expect(dry.message).toMatch(/would start an implement lane capped at \d+ AI credits, in the private layout \(factory\.run\.layout "private" from the user config/);
    const shared = await runFactoryEngine(opts({ w, user: null }, [], { dryRun: true }));
    expect(shared.message).not.toMatch(/layout/);
  }, T);

  it('clean after cancel removes the run dir and never empties your node_modules (the junction target)', async () => {
    const env = privateWorld();
    w = env.w;
    const out = await runFactoryEngine(opts(env, [greet(), review('approve')]));
    expect(out.gate?.name, out.message).toBe('merge');
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    const cancelled = await runFactoryEngine(opts(env, []));
    expect(cancelled.phase, cancelled.message).toBe('cancelled');
    // review-483 M5: a work root that does not put the run dir where the state says refuses; nothing is removed.
    const elsewhere = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: { factory: { run: { workDir: join(w.dir, 'fw-other') } } } });
    expect(elsewhere.removed).toEqual([]);
    expect(elsewhere.kept.map((k) => k.reason).join('\n')).toMatch(/the run's recorded private dir .* is not .*fw-other.*, so nothing was resumed or removed/);
    expect(existsSync(s.privateDir!)).toBe(true);
    // B2: a live engine of the run holds <run>/run.lock: clean keeps the dir (an unreadable lock counts as held too).
    const lock = join(s.privateDir!, 'run.lock');
    writeFileSync(lock, JSON.stringify({ pid: 4999, hostname: 'h', startedAt: '2026-11-11T00:00:00.000Z', run: '7' }));
    const held = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: env.user, localGateStateDir: w.stateDir, owner: { pid: 1, hostname: 'h', isAlive: (p) => p === 4999 } });
    expect(held.removed).toEqual([]);
    expect(held.kept.map((k) => k.reason).join('\n')).toMatch(/run_live: the run's engine holds .*run\.lock \(7, pid 4999 .*omg factory run cancel 7 stops it/);
    writeFileSync(lock, '{bad');
    const unreadable = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: env.user, localGateStateDir: w.stateDir });
    expect(unreadable.kept.map((k) => k.reason).join('\n')).toMatch(/run_live: the owner file .*run\.lock is unreadable, so it counts as held/);
    unlinkSync(lock);
    // review-483 I.4: a prepare check's recorded process that still runs keeps the run dir (the proof before removal).
    const probed: string[] = [];
    const busy = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: env.user, localGateStateDir: w.stateDir, liveGateProcs: (d) => { probed.push(d); return d.startsWith(w.dir) && d.includes('prepare-procs') ? [4242] : []; } });
    expect(busy.removed).toEqual([]);
    expect(busy.kept.map((k) => k.reason).join('\n')).toMatch(/gate_may_run: .*pid 4242/);
    expect(probed[0]).toBe(join(s.privateDir!, 'gates', 'prepare-procs'));
    // Review-483b L-a: the local gate's records (under the forge state dir, outside the run dir) are checked too.
    expect(probed[1].startsWith(w.stateDir) && probed[1].endsWith('gate-procs')).toBe(true);
    const gateBusy = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: env.user, localGateStateDir: w.stateDir, liveGateProcs: (d) => (d === probed[1] ? [4243] : []) });
    expect(gateBusy.kept.map((k) => k.reason).join('\n')).toMatch(/gate_may_run: process\(es\) a prepare check or the local gate started .*pid 4243/);
    expect(existsSync(s.privateDir!)).toBe(true);
    const result = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, claimRepo: null, ledgerDir: w.ledgerDir, runUserConfig: env.user, localGateStateDir: w.stateDir, seed: true });
    expect(result.removed).toContain(s.privateDir);
    expect(result.removed).toContain(join(s.privateDir!, '..', 'seed.git'));
    expect(existsSync(s.privateDir!)).toBe(false);
    expect(readFileSync(join(w.root, 'node_modules', 'marker.txt'), 'utf8')).toBe('yours\n');
  }, T);
});

describe('your repository around untrusted code that ran without the enforced sandbox (review-483 M3)', () => {
  const DETECT_ONLY = { ...ENFORCED_SANDBOX, mode: 'detect-only' } as typeof ENFORCED_SANDBOX;

  it('a detect-only lane that makes a ref in your repository parks at lane-tampered; a detect-only lane that leaves it alone runs on', async () => {
    let env = privateWorld();
    w = env.w;
    const sneaky: LaneScript = (ctx) => {
      gitIn(w.root, 'update-ref', 'refs/heads/sneaky', gitIn(w.root, 'rev-parse', 'HEAD'));
      return { ...greet()(ctx), sandbox: DETECT_ONLY };
    };
    const out = await runFactoryEngine(opts(env, [sneaky]));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: ref refs\/heads\/sneaky was created/);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();

    rmSync(w.dir, { recursive: true, force: true });
    env = privateWorld();
    w = env.w;
    const clean: LaneScript = (ctx) => ({ ...greet()(ctx), sandbox: DETECT_ONLY });
    const ok = await runFactoryEngine(opts(env, [clean, review('approve')]));
    expect(ok.gate?.name, ok.message).toBe('merge');
  }, T);

  it('an unsandboxed local gate that changes your repository\'s git state parks at lane-tampered and its verdict is not used', async () => {
    const env = privateWorld();
    w = env.w;
    const gate: typeof w.gate = async (argv, cwd, ms) => {
      gitIn(w.root, 'config', 'alias.st', 'status');
      return w.gate(argv, cwd, ms);
    };
    const out = await runFactoryEngine(opts(env, [greet(), review('approve')], { localGate: gate, gateSandboxUserConfig: { factory: { run: { sandbox: { gates: 'unsandboxed' } } } } }));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/^the local gate \(the PR's own code\) ran without the OS sandbox and changed your repository's git state, so its verdict is not used; .*your repository: the common git config changed/);
  }, T);
});

describe('the lane worktree the engine commits in (review-483 L7)', () => {
  it('a backend that names another worktree than the one the engine made parks at lane-tampered; nothing is committed in it', async () => {
    const env = privateWorld();
    w = env.w;
    const headBefore = gitIn(w.root, 'rev-parse', 'HEAD');
    const other: LaneScript = (ctx) => ({ ...greet()(ctx), reportWorktree: w.root });
    const out = await runFactoryEngine(opts(env, [other]));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/implement lane .* reports the worktree .*, not .*w[\\/]1 the engine made for it; nothing was committed or pushed/);
    expect(gitIn(w.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(gitIn(w.root, 'status', '--porcelain')).toBe('');
  }, T);
});

describe('the prepare checkout\'s node_modules link (review-483 M4)', () => {
  it('a prepare check that re-points the node_modules junction: the next check is not handed to the sandbox and the run parks at lane-tampered; your node_modules is untouched', async () => {
    const env = privateWorld();
    w = env.w;
    const elsewhere = join(w.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const ran: string[] = [];
    const exec: Exec = (cmd, args, o) => {
      if (/check[12]\.mjs$/.test(args[0] ?? '')) {
        ran.push(args[0]);
        if (args[0] === 'check1.mjs') {
          // The PR's code in the read-write checkout points the link elsewhere (temp dirs only).
          const link = join(o!.cwd!, 'node_modules');
          try { unlinkSync(link); } catch { rmdirSync(link); }
          symlinkSync(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return { status: 0, stdout: 'ok\n', stderr: '' };
      }
      return w.exec(cmd, args, o);
    };
    const gateConfig = () => ({ config: { ...localTestConfig(), prepareChecks: [[process.execPath, 'check1.mjs'], [process.execPath, 'check2.mjs']] }, known: [] });
    const o = localOpts(w, lanesFor(w, [greet(), review('approve')]), { runUserConfig: env.user, gateConfig });
    const out = await runFactoryEngine({ ...o, exec, gateSandbox: attested(exec) });
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/did not run: .*node_modules resolves to .*elsewhere, not your node_modules \(the only link the engine makes there\)/);
    expect(ran).toEqual(['check1.mjs']);
    expect(readFileSync(join(w.root, 'node_modules', 'marker.txt'), 'utf8')).toBe('yours\n');
  }, T);
});

describe('factory.run.layout from the base-committed .copilot/omg.jsonc (review-483 MEDIUM-1)', () => {
  /** The local world with `content` committed as the base's .copilot/omg.jsonc. */
  function baseConfigWorld(content: string): LocalWorld {
    const world = localWorld();
    mkdirSync(join(world.root, '.copilot'), { recursive: true });
    writeFileSync(join(world.root, '.copilot', 'omg.jsonc'), content);
    gitIn(world.root, 'add', '.copilot/omg.jsonc');
    gitIn(world.root, 'commit', '-q', '-m', 'base config');
    return world;
  }
  const baseConfigReads = () => w.raw.filter((c) => c.args.some((a) => a.endsWith(':.copilot/omg.jsonc'))).length;

  it('a shared run with a base omg.jsonc syntax error runs its lane as before; the strict gate-config load parks on the file later', async () => {
    w = baseConfigWorld('{ "factory": { "run": { "layout": ');
    // The working-tree copy is valid (the project config layer would park on it first: protected paths).
    writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), '{}\n');
    // Ship's strict loader as the engine's local default, without the developer's own user config.
    const gateConfig: FactoryEngineOptions['gateConfig'] = (i) => ({
      config: loadTrustedShipConfig({ exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, remote: 'omg-local', user: null, trustedUser: null, warn: i.warn }),
      known: [],
    });
    const lanes = lanesFor(w, [greet(), review('approve')]);
    const out = await runFactoryEngine(localOpts(w, lanes, { runUserConfig: null, gateConfig }));
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(s.layout).toBeUndefined();
    expect(s.history.some((h) => /factory\.run\.layout could not be read/.test(h.note))).toBe(false);
    expect(s.lanes.map((l) => l.kind), JSON.stringify(out.gate)).toEqual(['implement', 'review']);
    expect(lanes.started[0].worktree).toBeUndefined();
    // As on dev: the prepare step's strict load fails on the file (a step error the rerun resumes), after the lanes ran.
    expect(out.exitCode, out.message).toBe(1);
    expect(out.gate).toBeUndefined();
    expect(out.message).toMatch(/factory run step prepare failed: the trusted ship config could not be loaded: main [0-9a-f]{12}:\.copilot\/omg\.jsonc is not valid JSONC/);
  }, T);

  it('an untrusted base (not in ship.trustedBases) is never read: its "private" is ignored and the run is shared; a trusted one is read', async () => {
    w = baseConfigWorld('{ "factory": { "run": { "layout": "private" } } }\n');
    const untrusted = lanesFor(w, [greet()]);
    await runFactoryEngine(localOpts(w, untrusted, { runUserConfig: { ship: { trustedBases: ['dev'] } } }));
    expect(baseConfigReads()).toBe(0);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.layout).toBeUndefined();
    expect(untrusted.started[0].worktree).toBeUndefined();

    // Control: the same base in a new world, trusted (the defaults name main), is read and makes the run private.
    rmSync(w.dir, { recursive: true, force: true });
    w = baseConfigWorld('{ "factory": { "run": { "layout": "private" } } }\n');
    const work = join(w.dir, 'fw');
    const trusted = lanesFor(w, [greet()]);
    await runFactoryEngine(localOpts(w, trusted, { runUserConfig: { factory: { run: { workDir: work } } } }));
    expect(baseConfigReads()).toBeGreaterThan(0);
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(s.layout).toBe(2);
    expect(trusted.started[0].worktree?.path.startsWith(work)).toBe(true);
  }, T);

  it('factory.run.secretScan.allowPaths committed on an untrusted base are not used: the park says why and names the ways out; on a trusted base they apply', async () => {
    const token = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
    const content = '{ "factory": { "run": { "secretScan": { "allowPaths": ["test/fixtures/**"] } } } }\n';
    const fixture = commitFile('test/fixtures/tok.txt', `${token}\n`);
    w = baseConfigWorld(content);
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [fixture]), { runUserConfig: { ship: { trustedBases: ['dev'] } }, secretScanUserConfig: null }));
    expect(out.gate?.name, out.message).toBe('secret-shaped-content');
    expect(baseConfigReads()).toBe(0);
    expect(out.gate?.reason).toContain(`The factory.run.secretScan.allowPaths committed in .copilot/omg.jsonc were not used, because base ${BASE} is not in ship.trustedBases: rerun with --allow-secret-shapes for this head, or set allowPaths in your user config (or add ${BASE} to ship.trustedBases there).`);

    // Control: the same base, trusted by the defaults (dev, main, master): the committed allowPaths skip the fixture.
    rmSync(w.dir, { recursive: true, force: true });
    w = baseConfigWorld(content);
    const ok = await runFactoryEngine(localOpts(w, lanesFor(w, [fixture, review('approve')]), { runUserConfig: null, secretScanUserConfig: null }));
    expect(ok.gate?.name, ok.message).not.toBe('secret-shaped-content');
    expect(baseConfigReads()).toBeGreaterThan(0);
  }, T);
});

/** Ship's defaults with the one required check the local forge replaces (as engine-local-harness localTestGateConfig). */
function localTestConfig() {
  return { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [] };
}

function attested(exec: Exec) {
  return async (req: SandboxRunRequest) => {
    if (req.purpose === 'gate') { const r = await w.gate(req.argv, req.cwd, req.timeoutMs); return { ran: true as const, status: r.status, output: r.stdout, timedOut: false }; }
    if (req.purpose !== 'prepare') return { ran: true as const, status: 0, output: '', timedOut: false };
    const r = exec(req.exe, [...req.args], { cwd: req.cwd });
    return { ran: true as const, status: r.status, output: `${r.stdout}${r.stderr}`, timedOut: false };
  };
}

describe('#484 with the private layout (merge of #484 into #483)', () => {
  // A fake token of the github-token shape, built so this source file never holds one.
  const TOKEN = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');

  it('a private-layout lane commit goes through the process-tree proof and the secret scan on the private worktree: a hit parks; --allow-secret-shapes commits and imports it', async () => {
    const env = privateWorld();
    w = env.w;
    const procs = new FakeProcesses();
    const leaky = commitFile('src/config.js', `export const token = '${TOKEN}';\n`);
    const first = await runFactoryEngine(opts(env, [leaky], { processes: procs }));
    expect(first.gate?.name, first.message).toBe('secret-shaped-content');
    expect(first.gate?.reason).toContain('src/config.js (github-token)');
    const s = readFactoryState(w.root, LOCAL_ISSUE)!;
    // The proof and the commit ran on the engine's own lane worktree in the private repository.
    expect(s.pendingCommit?.worktree.startsWith(join(s.privateDir!, 'w'))).toBe(true);
    expect(s.pendingCommit?.branch).toBeNull();
    expect(procs.trees.length).toBeGreaterThan(0);
    for (const t of procs.trees) expect(t!.startsWith(join(s.privateDir!, 'w'))).toBe(true);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();
    expect(JSON.stringify(s)).not.toContain(TOKEN.slice(4));

    const ok = await runFactoryEngine(opts(env, [review('approve')], { allowSecretShapes: true, processes: procs }));
    expect(ok.gate?.name, ok.message).toBe('merge');
    const done = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(done.lanes.filter((l) => l.kind === 'implement')).toHaveLength(1);
    expect(gitIn(w.root, 'show', `${done.head}:src/config.js`)).toContain('export const token');
    expect(done.history.map((x) => x.note).join('\n')).toMatch(/secret-shaped content accepted for lane .* src\/config\.js \(github-token\)/);
  }, T);

  it('a detect-only lane that plants a hook in YOUR repository is caught by the full snapshot: #484\'s quarantine moves it out and holds your checkout', async () => {
    const env = privateWorld();
    w = env.w;
    const DETECT_ONLY = { ...ENFORCED_SANDBOX, mode: 'detect-only' } as typeof ENFORCED_SANDBOX;
    const hook = join(w.root, '.git', 'hooks', 'post-checkout');
    const plant: LaneScript = (ctx) => {
      writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { ...greet()(ctx), sandbox: DETECT_ONLY };
    };
    const out = await runFactoryEngine(opts(env, [plant]));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: the hooks\/ directory changed/);
    expect(out.gate?.reason).toMatch(/New factory runs in this checkout are held until omg factory run release --tamper/);
    expect(existsSync(hook)).toBe(false);
    const hold = readTamperHold(w.ledgerDir, w.root);
    expect(hold && hold !== 'unreadable' ? hold.held : undefined).toBe(true);
    expect(hold && hold !== 'unreadable' ? hold.moved : []).toContain('hooks/post-checkout');
    // Nothing was quarantined from the private repository (it did not change).
    expect(privateQuarantined(w.ledgerDir, 'hooks/post-checkout')).toBeUndefined();
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBeFalsy();
  }, T);

  it('review-483b L-c: a cancel during a detect-only lane that changed YOUR repository goes through laneTampered (quarantine and hold), then the run is cancelled', async () => {
    const env = privateWorld();
    w = env.w;
    const DETECT_ONLY = { ...ENFORCED_SANDBOX, mode: 'detect-only' } as typeof ENFORCED_SANDBOX;
    const hook = join(w.root, '.git', 'hooks', 'post-checkout');
    const lanes = new FakeLanes(w.root, [greet()], [50]);
    // While the lane runs it plants a hook in your repository; you cancel the run.
    lanes.onRunningPoll = () => {
      if (existsSync(hook)) return;
      writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    };
    const cancel = lanes.cancel.bind(lanes);
    lanes.cancel = async (id) => { const c = await cancel(id); return { ...c, result: { ...c.result, sandbox: DETECT_ONLY } }; };
    const out = await runFactoryEngine(opts(env, [], { lanes }));
    expect(out.phase, out.message).toBe('cancelled');
    expect(existsSync(hook)).toBe(false);
    const hold = readTamperHold(w.ledgerDir, w.root);
    expect(hold && hold !== 'unreadable' ? hold.held : undefined).toBe(true);
    expect(hold && hold !== 'unreadable' ? hold.moved : []).toContain('hooks/post-checkout');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.history.some((h) => /your repository: the hooks\/ directory changed/.test(h.note))).toBe(true);
  }, T);
});
