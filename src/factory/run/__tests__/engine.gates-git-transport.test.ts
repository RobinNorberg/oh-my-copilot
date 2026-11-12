/**
 * The Windows git-transport fallback: a check whose base calibration fails in
 * the OS sandbox with git's transport error, where a probe shows Git for
 * Windows' sh.exe cannot start in the sandbox (STATUS_DLL_INIT_FAILED), runs
 * in the gate container (an image with git), else plainly with a loud note;
 * factory.run.sandbox.windowsGitTransport "strict" keeps the
 * gate-sandbox-incompatible park. The engine on the local forge with fake
 * lanes, a recording fake sandbox (container requests included) and a
 * recording plain runner, on a declared win32 host.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readLocalCheckRecord } from '../../../forge/local/index.js';
import { defaultGitGateImage, resolveWindowsGitTransport } from '../../../copilot-run/sandbox.js';
import { resolveShipConfig } from '../../../ship/config.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, GIT_TRANSPORT_SANDBOX_ADVICE, MSYS_DLL_INIT_FAILED, runFactoryEngine, windowsGitTransportFailure, type FactoryEngineOptions } from '../engine.js';
import type { GateConfigLoader } from '../prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { readFactoryState } from '../state.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, review } from './fake-lanes.js';

const T = 300_000;
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const gateConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [['node', 'check.js']] } as ReturnType<GateConfigLoader>['config'],
  known: [],
});
const TRANSPORT: SandboxRunResult = { ran: true, status: 1, output: 'Error: Command failed: git push -q origin dev\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights', timedOut: false };
const PASS: SandboxRunResult = { ran: true, status: 0, output: 'ok', timedOut: false };
const MSYS_FAILS: SandboxRunResult = { ran: true, status: 0xc0000142, output: '', timedOut: false };

type Kind = 'prepare' | 'gate' | 'calibrate' | 'probe' | 'container-prepare' | 'container-gate' | 'container-calibrate';

/** A recording sandbox; `answer` gets the request's kind (a container request or the MSYS probe told apart). */
function sandbox(sh: string, answer: (kind: Kind, req: SandboxRunRequest) => SandboxRunResult) {
  const kinds: Kind[] = [];
  const reqs: SandboxRunRequest[] = [];
  const run: SandboxRunner = async (req) => {
    const kind: Kind = req.exe === sh ? 'probe' : req.container ? `container-${req.purpose as 'prepare' | 'gate' | 'calibrate'}` : req.purpose as Kind;
    kinds.push(kind);
    reqs.push(req);
    return answer(kind, req);
  };
  return { kinds, reqs, run };
}

/** A declared Windows host with a Git for Windows shell (an empty file: only the fake sandbox "starts" it). */
function win32(): { sh: string; host: FactoryEngineOptions['gitTransportHost'] } {
  const sh = join(w.dir, 'sh.exe');
  writeFileSync(sh, '');
  return { sh, host: { platform: 'win32', shell: () => sh } };
}

const opts = (lanes: ReturnType<typeof lanesFor>, over: Partial<FactoryEngineOptions>): FactoryEngineOptions => localOpts(w, lanes, { gateConfig, gateSandboxUserConfig: {}, ...over });
const plainPrepare = () => w.gateRuns.filter((r) => r.argv.includes('check.js'));

describe('Windows git-transport fallback (prepare checks)', () => {
  it('runs the check in the gate container (an image with git) after the probe shows MSYS2 cannot start; a pass counts, nothing runs plainly', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'prepare' || kind === 'calibrate' ? TRANSPORT : kind === 'probe' ? MSYS_FAILS : PASS));
    const warnings: string[] = [];
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host, warn: (m) => warnings.push(m) }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.kinds).toEqual(['prepare', 'calibrate', 'probe', 'container-prepare', 'gate']);
    const ctr = s.reqs[3];
    expect(ctr.container?.image).toBe(defaultGitGateImage());
    expect(ctr.gitView).toBeDefined();
    expect(ctr.cwd).toBe(s.reqs[0].cwd);
    expect(s.reqs[2]).toMatchObject({ argv: [sh, '-c', 'exit 0'] });
    expect(plainPrepare()).toEqual([]);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(Object.values(state.gateCalibration ?? {})).toEqual([expect.objectContaining({ ok: false, gitTransport: true })]);
    expect(state.history.some((h) => /ran in the gate container \(docker node:\d+-bookworm\): its base fails in the OS sandbox on Windows/.test(h.note ?? ''))).toBe(true);
    expect(state.history.some((h) => /prepare checks on [0-9a-f]{12} ran in the OS sandbox and in the gate container \(Windows git-transport fallback\)/.test(h.note ?? ''))).toBe(true);
    expect(warnings.join('\n')).toContain('windowsGitTransport "strict"');
  }, T);

  it('no usable container: runs the check plainly with a loud note naming the gap, and its verdict counts', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => {
      if (kind === 'prepare' || kind === 'calibrate') return TRANSPORT;
      if (kind === 'probe') return { ...MSYS_FAILS, status: MSYS_DLL_INIT_FAILED[1] };
      if (kind.startsWith('container-')) return { ran: false, reason: 'docker was not found', unavailable: true };
      return PASS;
    });
    const warnings: string[] = [];
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host, warn: (m) => warnings.push(m) }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.kinds).toEqual(['prepare', 'calibrate', 'probe', 'container-prepare', 'gate']);
    expect(plainPrepare()).toHaveLength(1);
    const text = warnings.join('\n');
    expect(text).toContain('the Windows git-transport fallback could not use the gate container: docker was not found');
    expect(text).toMatch(/the prepare check `node check\.js` on [0-9a-f]{12} ran WITHOUT any sandbox, as your user/);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.history.some((h) => /prepare checks on [0-9a-f]{12} ran in the OS sandbox and unsandboxed \(git-transport\)/.test(h.note ?? ''))).toBe(true);
  }, T);

  it('windowsGitTransport "strict" (user config) keeps the gate-sandbox-incompatible park: no probe, no container, nothing plain', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'prepare' || kind === 'calibrate' ? TRANSPORT : kind === 'probe' ? MSYS_FAILS : PASS));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host, gateSandboxUserConfig: { factory: { run: { sandbox: { windowsGitTransport: 'strict' } } } } }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(out.gate?.reason).toContain(GIT_TRANSPORT_SANDBOX_ADVICE);
    expect(s.kinds).toEqual(['prepare', 'calibrate']);
    expect(plainPrepare()).toEqual([]);
  }, T);

  it('the probe starts sh.exe in the sandbox: the cause is another one, the run parks as before', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'prepare' || kind === 'calibrate' ? TRANSPORT : PASS));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.kinds).toEqual(['prepare', 'calibrate', 'probe']);
    expect(plainPrepare()).toEqual([]);
  }, T);

  it('not Windows: the same output parks, no probe', async () => {
    w = localWorld();
    const { sh } = win32();
    const s = sandbox(sh, (kind) => (kind === 'prepare' || kind === 'calibrate' ? TRANSPORT : kind === 'probe' ? MSYS_FAILS : PASS));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: { platform: 'linux', shell: () => sh } }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.kinds).toEqual(['prepare', 'calibrate']);
    expect(Object.values(readFactoryState(w.root, LOCAL_ISSUE)!.gateCalibration ?? {})[0]).not.toHaveProperty('gitTransport');
  }, T);

  it('a check that fails in the container on the base too (the project cannot install there) runs plainly; no park, no ci-fix lane', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'probe' ? MSYS_FAILS : kind === 'gate' ? PASS : kind.startsWith('container-') ? { ran: true, status: 1, output: 'gyp ERR! getaddrinfo EAI_AGAIN nodejs.org', timedOut: false } : TRANSPORT));
    const warnings: string[] = [];
    const lanes = lanesFor(w, [greet(), review('approve')]);
    const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run, gitTransportHost: host, warn: (m) => warnings.push(m) }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.kinds).toEqual(['prepare', 'calibrate', 'probe', 'container-prepare', 'container-calibrate', 'gate']);
    expect(plainPrepare()).toHaveLength(1);
    expect(warnings.join('\n')).toContain('cannot use the gate container for the prepare check `node check.js`: it fails there on the base too');
    expect(lanes.started.map((l) => l.laneId).filter((id) => id.includes('ci-fix'))).toEqual([]);
  }, T);

  it('a check that fails in the container while the base passes there is the PR\'s failure: a ci-fix lane starts', async () => {
    w = localWorld();
    const { sh, host } = win32();
    let heads = 0;
    const s = sandbox(sh, (kind) => {
      if (kind === 'probe') return MSYS_FAILS;
      if (kind === 'container-prepare') return (heads += 1) === 1 ? { ran: true, status: 1, output: 'not ok 1 - greet', timedOut: false } : PASS;
      if (kind === 'gate' || kind === 'container-calibrate') return PASS;
      return TRANSPORT;
    });
    const lanes = lanesFor(w, [greet(), review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
    const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run, gitTransportHost: host }));
    expect(lanes.started.map((l) => l.laneId)).toContain(`issue-${LOCAL_ISSUE}-ci-fix-1`);
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.kinds.slice(0, 5)).toEqual(['prepare', 'calibrate', 'probe', 'container-prepare', 'container-calibrate']);
    expect(plainPrepare()).toEqual([]);
  }, T);
});

describe('Windows git-transport fallback (the local gate)', () => {
  it('reruns the gate in the gate container; its SUCCESS record counts', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'gate' || kind === 'calibrate' ? TRANSPORT : kind === 'probe' ? MSYS_FAILS : PASS));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.kinds).toEqual(['prepare', 'gate', 'calibrate', 'probe', 'container-gate']);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(readLocalCheckRecord(w.stateDir, w.root, state.head!)).toMatchObject({ state: 'SUCCESS', sandbox: 'enforced' });
    expect(state.history.some((h) => /local gate SUCCESS on [0-9a-f]{12} \(exit 0, Windows git-transport fallback: the gate container/.test(h.note ?? ''))).toBe(true);
  }, T);

  it('no usable container: reruns the gate plainly; the record says unsandboxed', async () => {
    w = localWorld();
    const { sh, host } = win32();
    const s = sandbox(sh, (kind) => (kind === 'gate' || kind === 'calibrate' ? TRANSPORT : kind === 'probe' ? MSYS_FAILS : kind.startsWith('container-') ? { ran: false, reason: 'the docker daemon is not running', unavailable: true } : PASS));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: host }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(w.gateRuns.filter((r) => r.argv.includes('--test'))).toHaveLength(1);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(readLocalCheckRecord(w.stateDir, w.root, state.head!)).toMatchObject({ state: 'SUCCESS', sandbox: 'unsandboxed' });
  }, T);
});

describe('detection and settings', () => {
  it('windowsGitTransportFailure: the transport error on win32 only', () => {
    expect(windowsGitTransportFailure((TRANSPORT as { output: string }).output, 'win32')).toBe(true);
    expect(windowsGitTransportFailure((TRANSPORT as { output: string }).output, 'linux')).toBe(false);
    expect(windowsGitTransportFailure('fatal: not a git repository', 'win32')).toBe(false);
    expect(windowsGitTransportFailure(undefined, 'win32')).toBe(false);
  });

  it('resolveWindowsGitTransport: user config only, "fallback" by default, an image with git unless the user names one', () => {
    expect(resolveWindowsGitTransport({ user: undefined, base: undefined }, '24.1.0')).toMatchObject({ mode: 'fallback', ignoredBase: false, container: { runtime: 'docker', image: 'node:24-bookworm' } });
    const strict = { factory: { run: { sandbox: { windowsGitTransport: 'strict', container: { runtime: 'podman', image: 'my/node-git:1' } } } } };
    expect(resolveWindowsGitTransport({ user: strict, base: undefined })).toMatchObject({ mode: 'strict', container: { runtime: 'podman', image: 'my/node-git:1' } });
    const base = { factory: { run: { sandbox: { windowsGitTransport: 'strict' } } } };
    expect(resolveWindowsGitTransport({ user: undefined, base })).toMatchObject({ mode: 'fallback', ignoredBase: true });
    expect(() => resolveWindowsGitTransport({ user: { factory: { run: { sandbox: { windowsGitTransport: 'off' } } } }, base: undefined })).toThrow(/windowsGitTransport must be "fallback" or "strict"/);
  });
});
