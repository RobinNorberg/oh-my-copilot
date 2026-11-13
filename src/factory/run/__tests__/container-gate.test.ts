/**
 * container-gate.ts with an injected fake runtime: the argv of every
 * runtime call (no credential mount or env, network none in the run phase,
 * labels, names, cleanup scope), the verdict mapping, the install plan, and
 * the guarded copy back of a prepare check's writes. No container runs.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultGateImage, resolveGateIsolation, type GateContainerSettings } from '../../../copilot-run/sandbox.js';
import {
  applyCopyBack, checkoutCopyProblem, cleanRunContainers, copyScript, linkTargetProblem, lockfileCachePolicy, NPM_FETCH_ENV, sizeBytes, containerArgv, containerRunLabel, defaultContainerExec, inspectGateImageId, installPlan, mountArg, readTar, runContainerGate,
  safeRelPath, type ContainerExec, type ContainerExecOptions, type ContainerExecResult,
} from '../container-gate.js';
import type { SandboxRunRequest } from '../sandbox-exec.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-container-gate-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings = (over: Partial<GateContainerSettings> = {}): GateContainerSettings => ({ ...resolveGateIsolation({ user: { factory: { run: { sandbox: { isolation: 'container' } } } }, base: undefined }).container!, ...over });
const ok = (over: Partial<ContainerExecResult> = {}): ContainerExecResult => ({ status: 0, tail: '', overflow: false, timedOut: false, ...over });
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

/** A fake runtime: `answer` per call (by the first argv words), every call recorded. */
function fake(answer: (args: readonly string[], o: ContainerExecOptions) => ContainerExecResult | Promise<ContainerExecResult> = () => ok(), inspectAnswered = false) {
  const calls: Array<{ bin: string; args: string[]; o: ContainerExecOptions }> = [];
  const exec: ContainerExec = async (bin, args, o) => {
    calls.push({ bin, args: [...args], o });
    // No cache volume yet unless a test answers the inspect itself.
    if (args[0] === 'volume' && args[1] === 'inspect' && !inspectAnswered) return ok({ status: 1, tail: 'no such volume' });
    const r = await answer(args, o);
    // A present image reports its id unless the test answers the inspect itself (an empty answer is "present").
    return args[0] === 'image' && args[1] === 'inspect' && r.status === 0 && r.tail === '' ? { ...r, tail: `${IMAGE_ID}\n` } : r;
  };
  const runs = () => calls.filter((c) => c.args[0] === 'run');
  const step = (suffix: string) => runs().find((c) => c.args[c.args.indexOf('--name') + 1].endsWith(suffix));
  return { calls, exec, runs, step };
}

const LABEL = 'abc123-issue-7';
const request = (over: Partial<SandboxRunRequest> = {}): SandboxRunRequest => ({ purpose: 'gate', argv: ['npm', 'test'], exe: 'npm', args: ['test'], cwd: dir, commonGitDir: join(dir, '.git'), timeoutMs: 60_000, ...over });
const npmProject = () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', devDependencies: { vitest: '1.0.0' } }));
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
};
const nameOf = (args: string[]) => args[args.indexOf('--name') + 1];
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

/** A ustar/pax tar of `entries` (what `tar --format=posix -cf -` prints). */
function tarOf(entries: Array<{ path: string; type?: '0' | '2' | '1' | '5'; data?: string; link?: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, mode: number, link = '') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write(link.slice(0, 100), 157);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    if (e.path.length > 100) {
      const rec = (body: string) => { let len = body.length + 3; while (`${len} ${body}\n`.length !== len) len = `${len} ${body}\n`.length; return `${len} ${body}\n`; };
      const pax = Buffer.from(rec(`path=${e.path}`));
      blocks.push(header('PaxHeader', pax.length, 'x', 0o644), pad(pax));
    }
    const type = e.type ?? '0';
    blocks.push(header(e.path, type === '0' ? data.length : 0, type, e.mode ?? 0o644, e.link));
    if (type === '0') blocks.push(pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('resolveGateIsolation (user config only)', () => {
  it('defaults to copilot; container gets the host Node major image and sane limits', () => {
    expect(resolveGateIsolation({ user: undefined, base: undefined })).toEqual({ isolation: 'copilot', ignoredBase: [] });
    const r = resolveGateIsolation({ user: { factory: { run: { sandbox: { isolation: 'container' } } } }, base: undefined }, '22.4.1');
    expect(r.container).toEqual({ runtime: 'docker', image: 'node:22-bookworm-slim', memory: '4g', cpus: 2, pidsLimit: 1024, installTimeoutMinutes: 15, diskLimit: '10g' });
    expect(defaultGateImage('25.1.0')).toBe('node:25-bookworm-slim');
  });

  it('a committed value is never applied, only named for the notice', () => {
    const base = { factory: { run: { sandbox: { isolation: 'container', container: { image: 'evil/x', runtime: 'podman' } } } } };
    expect(resolveGateIsolation({ user: undefined, base })).toEqual({ isolation: 'copilot', ignoredBase: ['factory.run.sandbox.isolation', 'factory.run.sandbox.container'] });
    const both = resolveGateIsolation({ user: { factory: { run: { sandbox: { isolation: 'container', container: { image: 'node@sha256:abc' } } } } }, base });
    expect(both.container?.image).toBe('node@sha256:abc');
    expect(both.container?.runtime).toBe('docker');
  });

  it('rejects malformed user values, an option-shaped image and unknown keys', () => {
    const user = (sandbox: unknown) => ({ user: { factory: { run: { sandbox } } }, base: undefined });
    expect(() => resolveGateIsolation(user({ isolation: 'wsl' }))).toThrow(/isolation must be "copilot" or "container"/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { image: '--privileged' } }))).toThrow(/container\.image/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { image: 'a b' } }))).toThrow(/container\.image/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { mounts: ['/'] } }))).toThrow(/got mounts/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { runtime: 'nerdctl' } }))).toThrow(/runtime/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { pidsLimit: 1 } }))).toThrow(/pidsLimit/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { memory: '4 g' } }))).toThrow(/memory/);
    expect(() => resolveGateIsolation(user({ isolation: 'container', container: { diskLimit: '10t' } }))).toThrow(/diskLimit/);
    expect(resolveGateIsolation(user({ isolation: 'container', container: { diskLimit: '800m' } })).container?.diskLimit).toBe('800m');
  });
});

describe('runContainerGate argv', () => {
  it('copy (read-only bind, no network), install (network, no credential), run (network none): hardened, labelled, cleaned up', async () => {
    npmProject();
    const f = fake((args) => (args[0] === 'run' && nameOf([...args]).endsWith('-1234abcd') ? ok({ tail: 'tests passed' }) : ok()));
    const env = { ...process.env };
    process.env.GH_TOKEN = ['gho', 'x'.repeat(36)].join('_');
    let r;
    try {
      r = await runContainerGate(request(), settings(), LABEL, { exec: f.exec, id: () => '1234abcd', log: () => undefined });
    } finally {
      process.env = env;
    }
    expect(r).toEqual({ ran: true, status: 0, output: 'tests passed', timedOut: false, imageId: IMAGE_ID });
    const name = `omg-gate-${LABEL}-1234abcd`;
    expect(f.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'version --format', 'image inspect', 'volume create', 'volume inspect', 'volume create', 'run --name',
      'network create', 'run --name', 'network rm', 'run --name', 'run --name',
      'rm -f', 'rm -f', 'rm -f', 'rm -f', 'volume rm',
    ]);
    expect(f.calls.every((c) => c.bin === 'docker')).toBe(true);
    expect(f.calls[2].args).toEqual(['volume', 'create', '--label', `omg.run=${LABEL}`, '--label', 'omg.gate=1', name]);
    expect(f.calls[4].args).toEqual(['volume', 'create', '--label', 'omg.gate=1', '--label', 'omg.cache=npm', expect.stringMatching(/^omg-gate-cache-[0-9a-f]{16}$/)]);
    // Our own bridge for npm, labelled, inter-container traffic off; removed right after npm ci.
    expect(f.calls[6].args).toEqual(['network', 'create', '--label', `omg.run=${LABEL}`, '--label', 'omg.gate=1', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', `${name}-net`]);
    expect(f.calls[8].args).toEqual(['network', 'rm', `${name}-net`]);
    expect(f.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args[2])).toEqual([`${name}-copy`, `${name}-install`, `${name}-scripts`, name]);
    expect(f.calls.at(-1)!.args).toEqual(['volume', 'rm', '-f', name]);
    expect(f.runs().map((c) => nameOf(c.args))).toEqual([`${name}-copy`, `${name}-install`, `${name}-scripts`, name]);
    for (const c of f.runs()) {
      const a = c.args;
      for (const flag of ['--rm', '--init', '--read-only']) expect(a).toContain(flag);
      expect(values(a, '--cap-drop')).toEqual(['ALL']);
      expect(values(a, '--security-opt')).toEqual(['no-new-privileges']);
      expect(values(a, '--pids-limit')).toEqual(['1024']);
      expect(values(a, '--memory')).toEqual(['4g']);
      expect(values(a, '--pull')).toEqual(['never']);
      expect(values(a, '--label')).toEqual([`omg.run=${LABEL}`, 'omg.gate=1']);
      // No -v, no socket, no privileged, no host env passthrough, no credential anywhere.
      expect(a).not.toContain('-v');
      expect(a).not.toContain('--privileged');
      expect(a.join(' ')).not.toMatch(/docker\.sock|\.ssh|\.gitconfig|SSH_AUTH|GH_TOKEN|GITHUB_TOKEN|gho_/);
      // .npmrc is named only by the fixed copy/scripts text (held aside, put back), never mounted or passed.
      expect([...values(a, '--mount'), ...values(a, '-e')].join(' ')).not.toMatch(/\.npmrc/);
      expect(values(a, '--log-driver')).toEqual(['none']);
      expect(values(a, '-e').map((e) => e.split('=')[0]).filter((k) => !['PATH', 'HOME', 'CI', 'npm_config_update_notifier', 'npm_config_fund', 'npm_config_audit', 'npm_config_cache', ...Object.keys(NPM_FETCH_ENV)].includes(k))).toEqual([]);
      expect(values(a, '--env')).toEqual([]);
      // The container ends itself after its time even when the runtime's kill does not get through (M1).
      expect(a.slice(a.indexOf(IMAGE_ID) + 1, a.indexOf(IMAGE_ID) + 4)).toEqual(['timeout', '-s', 'KILL']);
    }
    // The only host path mounted is the checkout, read-only, in the copy step (no PR code runs there).
    const binds = f.runs().flatMap((c) => values(c.args, '--mount').filter((m) => m.includes('type=bind')));
    expect(binds).toEqual([`type=bind,source=${dir},target=/in,readonly`]);
    const copy = f.step('-copy')!.args;
    expect(values(copy, '--network')).toEqual(['none']);
    expect(copy.slice(-3, -1)).toEqual(['sh', '-c']);
    expect(copy.at(-1)).not.toContain(dir);
    // review-499b N2: the checkout's .npmrc is held outside the project while npm fetches.
    expect(copy.at(-1)).toBe(copyScript(true));
    expect(copy.at(-1)).toMatch(/; if \[ -e \/work\/src\/\.npmrc \] \|\| \[ -L \/work\/src\/\.npmrc \]; then mv \/work\/src\/\.npmrc \/work\/npmrc\.held; fi$/);
    // npm itself: network (our bridge), the shared cache, no install script (H1/H2).
    const install = f.step('-install')!.args;
    expect(values(install, '--network')).toEqual([`${name}-net`]);
    expect(values(install, '--user')).toEqual(['1000:1000']);
    expect(install.slice(-3)).toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(values(install, '--mount').filter((m) => m.includes('target=/cache'))).toHaveLength(1);
    expect(values(install, '-e')).toContain('npm_config_cache=/cache/npm');
    expect(values(install, '-e')).toEqual(expect.arrayContaining(['npm_config_registry=https://registry.npmjs.org/', 'npm_config_proxy=null', 'npm_config_https_proxy=null', 'npm_config_strict_ssl=true', 'npm_config_replace_registry_host=npmjs']));
    // The install scripts (the PR's code): no network, no shared cache.
    const scripts = f.step('-scripts')!.args;
    expect(values(scripts, '--network')).toEqual(['none']);
    expect(values(scripts, '--mount').some((m) => m.includes('cache'))).toBe(false);
    expect(values(scripts, '-e')).toContain('npm_config_cache=/work/home/.npm');
    expect(scripts.slice(-2)[0]).toBe('-c');
    expect(scripts.at(-1)).toBe('set -e; if [ -e /work/npmrc.held ] || [ -L /work/npmrc.held ]; then rm -rf /work/src/.npmrc; mv /work/npmrc.held /work/src/.npmrc; fi; npm rebuild --foreground-scripts; for s in preinstall install postinstall prepublish preprepare prepare postprepare; do npm run --if-present --ignore-scripts "$s"; done');
    const run = f.step('-1234abcd')!.args;
    expect(values(run, '--network')).toEqual(['none']);
    expect(values(run, '--user')).toEqual(['1000:1000']);
    expect(values(run, '--mount').some((m) => m.includes('cache'))).toBe(false);
    expect(run.slice(-7)).toEqual([IMAGE_ID, 'timeout', '-s', 'KILL', '90s', 'npm', 'test']);
    expect(values(run, '-w')).toEqual(['/work/src']);
  });

  it('a git view is bound read-only for the copy step only and copied in as the copy\'s .git', async () => {
    const f = fake();
    const view = join(dir, 'view-git');
    const r = await runContainerGate(request({ argv: ['node', '--test'], exe: process.execPath, args: ['--test'], gitView: view }), settings(), LABEL, { exec: f.exec, id: () => 'eeeeeeee' });
    expect(r.ran).toBe(true);
    const binds = f.runs().map((c) => values(c.args, '--mount').filter((m) => m.includes('type=bind')));
    expect(binds).toEqual([[`type=bind,source=${dir},target=/in,readonly`, `type=bind,source=${view},target=/in-git,readonly`], []]);
    const script = f.step('-copy')!.args.at(-1)!;
    expect(script).toBe(copyScript(false, true));
    expect(script).not.toContain(view);
    expect(script).toContain('tar -C /in --exclude=.git --exclude=node_modules -cf /work/in.tar .');
    expect(script).toContain('mkdir /work/src/.git; tar -C /in-git -cf /work/git.tar .; tar -C /work/src/.git -xf /work/git.tar; rm -f /work/git.tar; chown -R 1000:1000 /work');
    // Without a view: no second bind and no .git in the copy (as before).
    expect(copyScript(false)).not.toContain('/in-git');
  });

  it('no package.json: no install, no cache volume; podman is called as podman', async () => {
    const f = fake();
    const r = await runContainerGate(request({ argv: ['node', '--test'], exe: process.execPath, args: ['--test'] }), settings({ runtime: 'podman' }), LABEL, { exec: f.exec, id: () => 'ffffffff' });
    expect(r.ran).toBe(true);
    expect(f.calls.every((c) => c.bin === 'podman')).toBe(true);
    expect(f.runs().map((c) => nameOf(c.args))).toEqual([`omg-gate-${LABEL}-ffffffff-copy`, `omg-gate-${LABEL}-ffffffff`]);
    expect(f.calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'create')).toHaveLength(1);
    expect(f.runs()[1].args.slice(-2)).toEqual(['node', '--test']);
    // No install: no network is made.
    expect(f.calls.some((c) => c.args[0] === 'network')).toBe(false);
  });

  it('a missing runtime, a daemon that does not answer, or a failed pull is unavailable; nothing runs', async () => {
    const missing = fake(() => ok({ status: null, spawnError: 'spawn docker ENOENT' }));
    expect(await runContainerGate(request(), settings(), LABEL, { exec: missing.exec })).toMatchObject({ ran: false, unavailable: true, reason: expect.stringContaining('isolation "copilot"') });
    expect(missing.calls).toHaveLength(1);
    const down = fake(() => ok({ status: 1, tail: 'Cannot connect to the Docker daemon' }));
    expect(await runContainerGate(request(), settings(), LABEL, { exec: down.exec })).toMatchObject({ ran: false, unavailable: true, reason: expect.stringContaining('Cannot connect to the Docker daemon') });
    expect(down.runs()).toEqual([]);
    const logs: string[] = [];
    const nopull = fake((args) => (args[0] === 'image' || args[0] === 'pull' ? ok({ status: 1, tail: 'manifest unknown' }) : ok()));
    expect(await runContainerGate(request(), settings(), LABEL, { exec: nopull.exec, log: (l) => logs.push(l) })).toMatchObject({ ran: false, unavailable: true });
    // The pull was announced before it started, never silent.
    expect(logs).toEqual([expect.stringContaining(`pulling the gate image ${settings().image}`)]);
    expect(nopull.runs()).toEqual([]);
  });

  it('a yarn or pnpm project, or dependencies without a lockfile, is unavailable before any container', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    const f = fake();
    expect(await runContainerGate(request(), settings(), LABEL, { exec: f.exec })).toMatchObject({ ran: false, unavailable: true, reason: expect.stringContaining('yarn.lock') });
    expect(f.runs()).toEqual([]);
    expect(installPlan(dir)).toMatchObject({ kind: 'unsupported' });
    rmSync(join(dir, 'yarn.lock'));
    expect(installPlan(dir)).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('no package-lock.json') });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(installPlan(dir)).toEqual({ kind: 'none' });
  });

  it('maps exit codes: failure, timeout (kills only our container), runtime error 125 and a signal give no verdict', async () => {
    const main = (args: readonly string[]) => args[0] === 'run' && nameOf([...args]) === `omg-gate-${LABEL}-00000001`;
    const at = async (result: ContainerExecResult) => {
      const f = fake((args, o) => {
        if (!main(args)) return ok();
        if (result.timedOut) void o.onTimeout?.();
        return result;
      });
      return { r: await runContainerGate(request(), settings(), LABEL, { exec: f.exec, id: () => '00000001' }), f };
    };
    expect((await at(ok({ status: 1, tail: 'FAIL greet' }))).r).toEqual({ ran: true, status: 1, output: 'FAIL greet', timedOut: false, imageId: IMAGE_ID });
    const t = await at(ok({ status: 137, timedOut: true, tail: 'running' }));
    expect(t.r).toMatchObject({ ran: true, status: 124, timedOut: true });
    expect(t.f.calls.filter((c) => c.args[0] === 'kill').map((c) => c.args)).toEqual([['kill', `omg-gate-${LABEL}-00000001`]]);
    // After the kill, and again in the cleanup: rm -f of our own container by name, never anything else.
    expect(t.f.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args)).toEqual([['rm', '-f', `omg-gate-${LABEL}-00000001`], ['rm', '-f', `omg-gate-${LABEL}-00000001-copy`], ['rm', '-f', `omg-gate-${LABEL}-00000001`]]);
    expect((await at(ok({ status: 125, tail: 'docker: Error response from daemon' }))).r).toMatchObject({ ran: false, started: true });
    expect((await at(ok({ status: null }))).r).toMatchObject({ ran: false, started: true });
  });

  it('an install failure is the command\'s failure (calibrated on the base like any other); a copy failure gives no verdict', async () => {
    npmProject();
    const inst = fake((args) => (args[0] === 'run' && nameOf([...args]).endsWith('-install') ? ok({ status: 1, tail: 'npm ERR! git dep needs ssh' }) : ok()));
    const r = await runContainerGate(request(), settings(), LABEL, { exec: inst.exec });
    expect(r).toMatchObject({ ran: true, status: 1, timedOut: false });
    expect(r.ran && r.output).toContain('the dependency install (npm ci) in the gate container failed (exit 1)');
    expect(inst.runs()).toHaveLength(2);
    const scr = fake((args) => (args[0] === 'run' && nameOf([...args]).endsWith('-scripts') ? ok({ status: 1, tail: 'postinstall: getaddrinfo EAI_AGAIN' }) : ok()));
    const rs = await runContainerGate(request(), settings(), LABEL, { exec: scr.exec });
    expect(rs).toMatchObject({ ran: true, status: 1 });
    expect(rs.ran && rs.output).toContain("the install scripts (npm rebuild and the root's install scripts, no network)");
    expect(scr.runs()).toHaveLength(3);
    const copy = fake((args) => (args[0] === 'run' ? ok({ status: 2 }) : ok()));
    expect(await runContainerGate(request(), settings(), LABEL, { exec: copy.exec })).toMatchObject({ ran: false, started: true });
    // The volume is removed even then.
    expect(copy.calls.at(-1)!.args.slice(0, 2)).toEqual(['volume', 'rm']);
  });

  it('redacts token-shaped output and keeps a bounded tail', async () => {
    const token = ['ghp', 'A'.repeat(36)].join('_');
    const f = fake((args) => (args[0] === 'run' && !nameOf([...args]).endsWith('-copy') ? ok({ status: 1, tail: `${'y'.repeat(20_000)}\nleaked ${token}\n` }) : ok()));
    const r = await runContainerGate(request(), settings(), LABEL, { exec: f.exec });
    expect(r.ran && r.output).not.toContain(token);
    expect(r.ran && r.output.length).toBeLessThanOrEqual(8_000);
  });

  it('purpose install needs no container: the gate container installs per command', async () => {
    const f = fake();
    expect(await runContainerGate(request({ purpose: 'install' }), settings(), LABEL, { exec: f.exec })).toMatchObject({ ran: true, status: 0 });
    expect(f.calls).toEqual([]);
  });

  it('a prepare check that passed: its writes come back from the read-only export, guarded', async () => {
    writeFileSync(join(dir, 'keep.txt'), 'same\n');
    writeFileSync(join(dir, 'gone.txt'), 'old\n');
    const tar = tarOf([{ path: './', type: '5' }, { path: './keep.txt', data: 'same\n' }, { path: './gen/', type: '5' }, { path: './gen/out.json', data: '{}\n' }]);
    const f = fake((args, o) => (args[0] === 'run' && nameOf([...args]).endsWith('-export') ? ok({ stdout: o.full !== undefined ? tar : undefined }) : ok()));
    const r = await runContainerGate(request({ purpose: 'prepare', argv: ['node', 'fmt.js'], exe: process.execPath, args: ['fmt.js'] }), settings(), LABEL, { exec: f.exec, platform: 'linux' });
    expect(r).toMatchObject({ ran: true, status: 0 });
    const exp = f.step('-export')!.args;
    expect(values(exp, '--network')).toEqual(['none']);
    expect(values(exp, '--mount')[0]).toMatch(/,readonly$/);
    expect(readFileSync(join(dir, 'gen', 'out.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
    // A failing prepare check is not copied back.
    const failing = fake((args) => (args[0] === 'run' && !/-(copy|install)$/.test(nameOf([...args])) ? ok({ status: 1 }) : ok()));
    await runContainerGate(request({ purpose: 'prepare' }), settings(), LABEL, { exec: failing.exec });
    expect(failing.step('-export')).toBeUndefined();
  });
});

describe('copy back', () => {
  it('reads pax long names', () => {
    const long = `${'d'.repeat(80)}/${'f'.repeat(80)}.txt`;
    expect(readTar(tarOf([{ path: long, data: 'x' }]))).toEqual([{ path: long, type: 'file', mode: 0o644, data: Buffer.from('x') }]);
    expect(() => readTar(Buffer.alloc(100))).toThrow();
  });

  it('refuses links, hardlinks, .. and absolute paths, and writes nothing then', () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const cases = [
      [{ path: './new-link', type: '2' as const, link: '/home/node/.ssh/id_rsa' }],
      [{ path: './hard', type: '1' as const, link: 'a.txt' }],
      [{ path: '../escape.txt', data: 'x' }],
      [{ path: '/etc/passwd', data: 'x' }],
      [{ path: './.git/config', data: '[core]' }],
    ];
    for (const entries of cases) {
      const problem = applyCopyBack(dir, tarOf([{ path: './written.txt', data: 'w' }, { path: './a.txt', data: 'a\n' }, ...entries]), 'linux');
      expect(problem, JSON.stringify(entries)).not.toBeNull();
      expect(existsSync(join(dir, 'written.txt'))).toBe(false);
    }
  });

  it('never writes through a host link (a junction or symlink to outside the checkout)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omg-outside-'));
    try {
      symlinkSync(outside, join(dir, 'linked'), 'junction');
      const problem = applyCopyBack(dir, tarOf([{ path: './linked/', type: '5' }, { path: './linked/planted.txt', data: 'p' }]), process.platform);
      expect(problem).not.toBeNull();
      expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
    } finally {
      unlinkSync(join(dir, 'linked'));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('safeRelPath drops ./ and rejects Windows-reserved names on win32 only', () => {
    expect(safeRelPath('./a/b.txt', 'linux')).toBe('a/b.txt');
    expect(safeRelPath('./', 'linux')).toBe('');
    expect(safeRelPath('a/con.txt', 'win32')).toBeNull();
    expect(safeRelPath('a/b:c', 'win32')).toBeNull();
    expect(safeRelPath('a/b:c', 'linux')).toBe('a/b:c');
    expect(safeRelPath('a\\b', 'linux')).toBeNull();
    expect(safeRelPath('x/node_modules/y', 'linux')).toBeNull();
  });
});

describe('review-499 hardening', () => {
  const linkOrSkip = (target: string, path: string): boolean => {
    try { symlinkSync(target, path, 'junction'); return true; } catch { return false; }
  };

  it('C1: Node_Modules, NODE_M~1, .GIT and Unicode look-alikes are refused where names fold; nothing is written', () => {
    for (const p of ['src/Node_Modules/vitest/vitest.mjs', 'NODE_MODULES/x', '.GIT/config', 'a/.Git', 'node_module\u017f/x']) {
      expect(safeRelPath(p, 'win32'), p).toBeNull();
      expect(safeRelPath(p, 'darwin'), p).toBeNull();
    }
    expect(safeRelPath('NODE_M~1/vitest/vitest.mjs', 'win32')).toBeNull();
    expect(safeRelPath('GIT~1/config', 'win32')).toBeNull();
    expect(safeRelPath('n\u200bode_modules/x', 'darwin')).toBeNull();
    // Linux names do not fold: Node_Modules is just a directory there.
    expect(safeRelPath('src/Node_Modules/x', 'linux')).toBe('src/Node_Modules/x');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    for (const path of ['./src/Node_Modules/vitest/vitest.mjs', './NODE_M~1/vitest/vitest.mjs', './.GIT']) {
      expect(applyCopyBack(dir, tarOf([{ path: './written.txt', data: 'w' }, { path: './a.txt', data: 'a\n' }, { path, data: 'pwn' }]), 'win32'), path).not.toBeNull();
      expect(existsSync(join(dir, 'written.txt'))).toBe(false);
    }
  });

  it('C1: a write through a node_modules junction the engine left (any case) never reaches your node_modules', () => {
    const userModules = mkdtempSync(join(tmpdir(), 'omg-user-nm-'));
    mkdirSync(join(userModules, 'vitest'));
    writeFileSync(join(userModules, 'vitest', 'vitest.mjs'), 'real\n');
    try {
      if (!linkOrSkip(userModules, join(dir, 'node_modules'))) return;
      // Probed on the disk itself, whatever the platform argument says: case on a folding file system, links always.
      const diskFolds = existsSync(join(dir, 'Node_Modules'));
      for (const platform of ['win32', 'linux'] as const) {
        const problem = applyCopyBack(dir, tarOf([{ path: './Node_Modules/vitest/vitest.mjs', data: 'pwn' }]), platform);
        if (platform === 'linux' && !diskFolds) {
          // A case-sensitive disk: Node_Modules was a new real dir, never the junction.
          expect(problem).toBeNull();
          rmSync(join(dir, 'Node_Modules'), { recursive: true, force: true });
        } else expect(problem, platform).not.toBeNull();
        expect(readFileSync(join(userModules, 'vitest', 'vitest.mjs'), 'utf8')).toBe('real\n');
      }
    } finally {
      try { unlinkSync(join(dir, 'node_modules')); } catch { /* not made */ }
      rmSync(userModules, { recursive: true, force: true });
    }
  });

  it('C1: DOCS/evil through a committed docs link is refused on the disk itself', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omg-outside-'));
    try {
      if (!linkOrSkip(outside, join(dir, 'docs'))) return;
      const diskFolds = existsSync(join(dir, 'DOCS'));
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const problem = applyCopyBack(dir, tarOf([{ path: './docs', type: '2', link: outside }, { path: './DOCS/evil', data: 'p' }]), platform);
        // A case-sensitive disk told "linux": DOCS is a new real dir next to the docs link, never through it.
        if (platform === 'linux' && !diskFolds) {
          expect(problem).toBeNull();
          expect(readFileSync(join(dir, 'DOCS', 'evil'), 'utf8')).toBe('p');
        } else expect(problem, platform).not.toBeNull();
        expect(existsSync(join(outside, 'evil'))).toBe(false);
      }
      // And the scan before the copy refuses the checkout: a link that points outside it.
      expect(checkoutCopyProblem(dir)).toMatch(/absolute target|points outside/);
    } finally {
      unlinkSync(join(dir, 'docs'));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('C1: two entries that are one file on a folding host are refused', () => {
    expect(applyCopyBack(dir, tarOf([{ path: './README.md', data: 'a' }, { path: './readme.md', data: 'b' }]), 'win32')).toMatch(/same file/);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });

  it('M3: a file with more than one hard link is never written through, and the checkout is refused before the copy', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omg-outside-'));
    try {
      writeFileSync(join(outside, 'npmrc'), 'token\n');
      linkSync(join(outside, 'npmrc'), join(dir, 'cfg'));
      expect(checkoutCopyProblem(dir)).toMatch(/hard link/);
      expect(applyCopyBack(dir, tarOf([{ path: './cfg', data: 'overwritten\n' }]), process.platform)).not.toBeNull();
      expect(readFileSync(join(outside, 'npmrc'), 'utf8')).toBe('token\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the scan: a plain checkout, an inside link and the excluded names pass', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    mkdirSync(join(dir, '.git'));
    const outside = mkdtempSync(join(tmpdir(), 'omg-outside-'));
    try {
      expect(checkoutCopyProblem(dir)).toBeNull();
      if (linkOrSkip(outside, join(dir, 'node_modules'))) expect(checkoutCopyProblem(dir)).toBeNull();
      // A relative link inside passes; a junction (always an absolute target) does not, even to inside (review-499b N5).
      let rel = false;
      try { symlinkSync('src', join(dir, 'src-rel'), 'dir'); rel = true; } catch { /* no symlink privilege on this host */ }
      if (rel) expect(checkoutCopyProblem(dir)).toBeNull();
      if (linkOrSkip(join(dir, 'src'), join(dir, 'src-link'))) expect(checkoutCopyProblem(dir)).toBe('the checkout has a link with an absolute target');
    } finally {
      for (const l of ['node_modules', 'src-link', 'src-rel']) try { unlinkSync(join(dir, l)); } catch { /* not made */ }
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a checkout the scan refuses never reaches a container', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'omg-outside-'));
    try {
      if (!linkOrSkip(outside, join(dir, 'Node_Modules2'))) return;
      const f = fake();
      expect(await runContainerGate(request(), settings(), LABEL, { exec: f.exec })).toMatchObject({ ran: false, started: true, reason: expect.stringMatching(/absolute target|points outside/) });
      expect(f.runs()).toEqual([]);
      expect(f.calls.some((c) => c.args[0] === 'volume')).toBe(false);
    } finally {
      unlinkSync(join(dir, 'Node_Modules2'));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('L1: a copied-back file replaces the old one by rename, leaving no temp file', () => {
    writeFileSync(join(dir, 'a.txt'), 'old\n');
    expect(applyCopyBack(dir, tarOf([{ path: './a.txt', data: 'new\n' }]), process.platform)).toBeNull();
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new\n');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('H2: the shared cache only for registry packages with an integrity; else a fresh cache, or unavailable', async () => {
    const reg = (name: string, extra: Record<string, unknown> = {}) => ({ version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: 'sha512-x', ...extra });
    expect(lockfileCachePolicy({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': reg('a'), 'packages/w': { version: '1.0.0' }, 'node_modules/w': { resolved: 'packages/w', link: true } } })).toBe('shared');
    expect(lockfileCachePolicy({ lockfileVersion: 3, packages: { 'node_modules/a': reg('a', { integrity: undefined }) } })).toBe('private');
    expect(lockfileCachePolicy({ lockfileVersion: 3, packages: { 'node_modules/a': reg('a', { resolved: 'git+ssh://git@github.com/x/a.git#abc' }) } })).toMatchObject({ refuse: expect.any(String) });
    expect(lockfileCachePolicy({ lockfileVersion: 3, packages: { 'node_modules/a': reg('a', { resolved: 'https://evil.example/a.tgz' }) } })).toMatchObject({ refuse: expect.any(String) });
    expect(lockfileCachePolicy({ lockfileVersion: 1, dependencies: { a: { version: 'github:x/a', integrity: 'sha512-x' } } })).toMatchObject({ refuse: expect.any(String) });
    expect(lockfileCachePolicy({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-x', dependencies: { b: { version: '1.0.0' } } } } })).toBe('private');

    // A lockfile entry without an integrity: no shared cache volume anywhere; npm caches inside the command's own volume.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { a: '1' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': reg('a', { integrity: undefined }) } }));
    const f = fake();
    expect(await runContainerGate(request(), settings(), LABEL, { exec: f.exec })).toMatchObject({ ran: true });
    expect(f.calls.some((c) => c.args.some((a) => a.includes('omg-gate-cache-')))).toBe(false);
    expect(values(f.step('-install')!.args, '-e')).toContain('npm_config_cache=/work/home/.npm');
    // One resolved from git: unavailable before any container.
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': reg('a', { resolved: 'git+https://github.com/x/a.git' }) } }));
    const g = fake();
    expect(await runContainerGate(request(), settings(), LABEL, { exec: g.exec })).toMatchObject({ ran: false, unavailable: true, reason: expect.stringContaining('npm registry') });
    expect(g.runs()).toEqual([]);
  });

  it('H1/H2: no step that runs the PR\'s code has network or the shared cache', async () => {
    npmProject();
    const f = fake();
    await runContainerGate(request({ purpose: 'prepare' }), settings(), LABEL, { exec: f.exec, id: () => 'cafe0001', platform: 'linux' });
    const name = `omg-gate-${LABEL}-cafe0001`;
    // Only the copy (no PR code) and npm ci --ignore-scripts see the cache; only npm ci has a network.
    for (const c of f.runs()) {
      const n = nameOf(c.args);
      const cached = values(c.args, '--mount').some((m) => m.includes('omg-gate-cache-'));
      expect(cached, n).toBe(n === `${name}-copy` || n === `${name}-install`);
      expect(values(c.args, '--network'), n).toEqual([n === `${name}-install` ? `${name}-net` : 'none']);
    }
    expect(f.calls.find((c) => c.args[0] === 'run' && nameOf(c.args) === `${name}-install`)!.args).toContain('--ignore-scripts');
  });

  it('L4: an existing cache volume must carry our labels on the local driver with no options', async () => {
    npmProject();
    const inspect = (tail: string) => fake((args) => (args[0] === 'volume' && args[1] === 'inspect' ? ok({ tail }) : ok()), true);
    const good = inspect('local|{"omg.cache":"npm","omg.gate":"1"}|{}\n');
    expect(await runContainerGate(request(), settings(), LABEL, { exec: good.exec })).toMatchObject({ ran: true });
    expect(good.calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'create')).toHaveLength(1);
    for (const tail of ['local|{"omg.cache":"npm"}|{}', 'local|{"omg.cache":"npm","omg.gate":"1"}|{"type":"none","o":"bind","device":"/Users/x"}', 'nfs|{"omg.cache":"npm","omg.gate":"1"}|null', 'garbage']) {
      const bad = inspect(tail);
      expect(await runContainerGate(request(), settings(), LABEL, { exec: bad.exec }), tail).toMatchObject({ ran: false, unavailable: true });
      expect(bad.runs(), tail).toEqual([]);
      // Our own work volume is still removed; the foreign one never is.
      expect(bad.calls.filter((c) => c.args[1] === 'rm').map((c) => c.args.at(-1))).toEqual([expect.stringMatching(/^omg-gate-abc123-issue-7-[0-9a-f]{8}$/)]);
    }
  });

  it('M2: the disk watchdog kills only the step\'s own container when the work volume is over the limit', async () => {
    const name = `omg-gate-${LABEL}-d15c0001`;
    let release: (() => void) | undefined;
    const f = fake((args) => {
      if (args[0] === 'run' && nameOf([...args]) === `${name}-du-1`) return ok({ tail: `${2 * 1024 * 1024}\t/work\n` });
      if (args[0] === 'run' && nameOf([...args]) === name) return new Promise((done) => { release = () => done(ok({ status: 137 })); });
      if (args[0] === 'kill') release?.();
      return ok();
    });
    const r = await runContainerGate(request(), settings({ diskLimit: '1g' }), LABEL, { exec: f.exec, id: () => 'd15c0001', diskWatchMs: 5 });
    expect(r).toMatchObject({ ran: true, status: 1, timedOut: false });
    expect(r.ran && r.output).toContain('diskLimit (1g)');
    expect(f.calls.filter((c) => c.args[0] === 'kill').map((c) => c.args)).toEqual([['kill', name]]);
    const du = f.step('-du-1')!.args;
    expect(values(du, '--mount')[0]).toMatch(/,readonly$/);
    expect(values(du, '--network')).toEqual(['none']);
    expect(values(du, '--cap-add')).toEqual(['DAC_READ_SEARCH']);
    expect(values(du, '--log-driver')).toEqual(['none']);
    expect(sizeBytes('10g')).toBe(10 * 1024 ** 3);
  });

  /** A run step that ends only when it is killed, and the du answers in order (the last repeats). */
  const watchdog = async (duAnswers: ContainerExecResult[]) => {
    const name = `omg-gate-${LABEL}-d15c0002`;
    let release: (() => void) | undefined;
    let n = 0;
    const f = fake((args) => {
      if (args[0] === 'run' && nameOf([...args]).startsWith(`${name}-du-`)) return duAnswers[Math.min(n++, duAnswers.length - 1)];
      if (args[0] === 'run' && nameOf([...args]) === name) return new Promise((done) => { release = () => done(ok({ status: 137 })); });
      if (args[0] === 'kill') release?.();
      return ok();
    });
    const r = await runContainerGate(request(), settings({ diskLimit: '1g' }), LABEL, { exec: f.exec, id: () => 'd15c0002', diskWatchMs: 5 });
    return { r, f, name };
  };

  it('N1: du that exits 1 (entries vanished mid-walk) still counts its total: over the limit is killed', async () => {
    const { r, f, name } = await watchdog([ok({ status: 1, tail: `du: cannot access '/work/src/t/x1': No such file or directory\n${2 * 1024 * 1024}\t/work\n` })]);
    expect(r).toMatchObject({ ran: true, status: 1, timedOut: false });
    expect(r.ran && r.output).toContain('used more than factory.run.sandbox.container.diskLimit (1g)');
    expect(f.calls.filter((c) => c.args[0] === 'kill').map((c) => c.args)).toEqual([['kill', name]]);
  });

  it('N1: two checks in a row without a total kill the step (fail-closed); every du has its own name', async () => {
    const { r, f, name } = await watchdog([ok({ status: 137, tail: '' }), ok({ status: 125, tail: 'Conflict. The container name is already in use' })]);
    expect(r).toMatchObject({ ran: true, status: 1, timedOut: false });
    expect(r.ran && r.output).toContain('could not be measured twice in a row');
    expect(f.calls.filter((c) => c.args[0] === 'kill').map((c) => c.args)).toEqual([['kill', name]]);
    const duNames = f.runs().map((c) => nameOf(c.args)).filter((n) => n.includes('-du-'));
    expect(duNames).toEqual([`${name}-du-1`, `${name}-du-2`]);
    // A du that did not end normally is removed by its own name right away.
    expect(f.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args[2])).toEqual(expect.arrayContaining([`${name}-du-1`, `${name}-du-2`]));
  });

  it('N1: one miss between totals under the limit does not kill', async () => {
    const under = ok({ tail: `1024\t/work\n` });
    const name = `omg-gate-${LABEL}-d15c0003`;
    let n = 0;
    const answers = [under, ok({ status: 137 }), under, ok({ status: 137 }), under];
    const f = fake(async (args) => {
      if (args[0] === 'run' && nameOf([...args]).startsWith(`${name}-du-`)) return answers[Math.min(n++, answers.length - 1)];
      if (args[0] === 'run' && nameOf([...args]) === name) {
        while (n < answers.length) await new Promise((t) => setTimeout(t, 2));
        return ok({ tail: 'done' });
      }
      return ok();
    });
    const r = await runContainerGate(request(), settings({ diskLimit: '1g' }), LABEL, { exec: f.exec, id: () => 'd15c0003', diskWatchMs: 1 });
    expect(r).toMatchObject({ ran: true, status: 0, output: 'done' });
    expect(f.calls.some((c) => c.args[0] === 'kill')).toBe(false);
  });

  it('N4: every container runs the inspected image id, not the tag', async () => {
    npmProject();
    const id = `sha256:${'b'.repeat(64)}`;
    const f = fake((args) => (args[0] === 'image' ? ok({ tail: `${id}\n` }) : ok()));
    await runContainerGate(request(), settings(), LABEL, { exec: f.exec });
    expect(f.runs().length).toBeGreaterThan(0);
    for (const c of f.runs()) {
      expect(c.args).toContain(id);
      expect(c.args).not.toContain(settings().image);
    }
  });

  it('N5: link targets are checked as the container follows them: no absolute target, `..` only leading and inside', () => {
    expect(linkTargetProblem('src', 0)).toBeNull();
    expect(linkTargetProblem('./a/b', 0)).toBeNull();
    expect(linkTargetProblem('../../..', 3)).toBeNull();
    expect(linkTargetProblem('../README.md', 1)).toBeNull();
    expect(linkTargetProblem('../x', 0)).toMatch(/points outside/);
    expect(linkTargetProblem('..\\..\\x', 1)).toMatch(/points outside/);
    // The review's chain: q -> e/f/g/p/../../../cache, where p -> ../../.. (the host resolves p by its own rules).
    expect(linkTargetProblem('e/f/g/p/../../../cache', 0)).toMatch(/steps back/);
    expect(linkTargetProblem('a\\..\\b', 0)).toMatch(/steps back/);
    for (const abs of ['/etc/passwd', '\\\\?\\C:\\x', 'C:\\Users\\x', 'c:x', '']) expect(linkTargetProblem(abs, 5), abs).toMatch(/absolute target/);
  });

  it('N5: the scan refuses a checkout link that steps back after a name', () => {
    mkdirSync(join(dir, 'e'));
    try { symlinkSync('e/../e', join(dir, 'q'), 'dir'); } catch { return; /* no symlink privilege on this host */ }
    try {
      expect(checkoutCopyProblem(dir)).toBe('the checkout has a link whose target steps back (..) after a name');
    } finally {
      unlinkSync(join(dir, 'q'));
    }
  });

  it('N6: superscript COM/LPT device names are refused on win32', () => {
    for (const p of ['a/COM\u00b9', 'lpt\u00b2.txt', 'com\u00b3.log']) expect(safeRelPath(p, 'win32'), p).toBeNull();
    expect(safeRelPath('a/COM\u00b9', 'linux')).toBe('a/COM\u00b9');
  });

  it('N6: a path component that cannot be checked (not missing) refuses the copy back; nothing is written', () => {
    const long = 'a'.repeat(300);
    const problem = applyCopyBack(dir, tarOf([{ path: `${long}/x.txt`, data: 'x' }]), process.platform);
    expect(problem).not.toBeNull();
    if (process.platform === 'linux') expect(problem).toBe('a path could not be checked');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('L2: a ran result carries the image id', async () => {
    const id = `sha256:${'a'.repeat(64)}`;
    const f = fake((args) => (args[0] === 'image' ? ok({ tail: `${id}\n` }) : ok()));
    expect(await runContainerGate(request(), settings(), LABEL, { exec: f.exec })).toMatchObject({ ran: true, imageId: id });
  });

  it('review-499c: an inspect without a sha256:<64 hex> id is unavailable; no container runs the tag', async () => {
    npmProject();
    for (const tail of ['node:22-bookworm-slim\n', 'sha256:abc\n', `sha256:${'A'.repeat(64)}\n`]) {
      const f = fake((args) => (args[0] === 'image' ? ok({ tail }) : ok()));
      const r = await runContainerGate(request(), settings(), LABEL, { exec: f.exec });
      expect(r, tail).toMatchObject({ ran: false, unavailable: true });
      expect(!r.ran && r.reason).toMatch(/could not read the image id of .* pin a digest/);
      expect(f.runs()).toEqual([]);
    }
  });
});

describe('helpers', () => {
  it('containerArgv: node scripts as `node <args>`, host paths in the checkout mapped, configured commands as configured', () => {
    expect(containerArgv({ argv: [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', 'a.test.ts'], exe: process.execPath, args: ['node_modules/vitest/vitest.mjs', 'run', 'a.test.ts'], cwd: dir })).toEqual(['node', 'node_modules/vitest/vitest.mjs', 'run', 'a.test.ts']);
    expect(containerArgv({ argv: ['npm', 'test'], exe: process.execPath, args: [join(dir, 'npm-cli.js'), 'test'], cwd: dir })).toEqual(['npm', 'test']);
    expect(containerArgv({ argv: ['node', join(dir, 'scripts', 'x.mjs')], exe: 'node', args: [join(dir, 'scripts', 'x.mjs')], cwd: dir })).toEqual(['node', '/work/src/scripts/x.mjs']);
  });

  it('mountArg quotes a field with a comma or a quote', () => {
    expect(mountArg(['type=bind', 'source=C:\\a,b', 'target=/in'])).toBe('type=bind,"source=C:\\a,b",target=/in');
    expect(mountArg(['source=x"y'])).toBe('"source=x""y"');
  });

  it('containerRunLabel is stable, per checkout and run, [a-z0-9-] only', () => {
    expect(containerRunLabel(dir, 7)).toMatch(/^[0-9a-f]{10}-issue-7$/);
    expect(containerRunLabel(dir, 7)).toBe(containerRunLabel(dir, 7));
    expect(containerRunLabel(join(dir, 'other'), 7)).not.toBe(containerRunLabel(dir, 7));
    expect(containerRunLabel(dir, 'heal-0123abcd')).toMatch(/-heal-0123abcd$/);
  });

  it('clean removes only this run\'s containers and volumes, by label and name prefix', () => {
    const calls: string[][] = [];
    const out: Record<string, string> = {
      ps: `omg-gate-${LABEL}-aa\nomg-gate-${LABEL}-aa-install\njaktis-runner\nomg-gate-other-issue-1-bb\n`,
      volume: `omg-gate-${LABEL}-aa\nomg-gate-cache-0123456789abcdef\nsome-volume\n`,
    };
    out.network = `omg-gate-${LABEL}-aa-net\nbridge\njaktis_default\n`;
    const r = cleanRunContainers('docker', LABEL, (bin, args) => { calls.push([bin, ...args]); return { status: 0, stdout: args[0] === 'ps' ? out.ps : args[1] === 'ls' ? out[args[0]] ?? '' : '' }; });
    expect(r.removed).toEqual([`omg-gate-${LABEL}-aa`, `omg-gate-${LABEL}-aa-install`, `omg-gate-${LABEL}-aa-net`, `omg-gate-${LABEL}-aa`]);
    expect(calls.filter((c) => c[1] === 'ps' || c[2] === 'ls').every((c) => c.includes(`label=omg.run=${LABEL}`))).toBe(true);
    expect(calls.filter((c) => c.includes('rm')).map((c) => c.at(-1))).toEqual([`omg-gate-${LABEL}-aa`, `omg-gate-${LABEL}-aa-install`, `omg-gate-${LABEL}-aa-net`, `omg-gate-${LABEL}-aa`]);
    expect(calls.some((c) => c.some((a) => /prune/.test(a)))).toBe(false);
    const down = cleanRunContainers('docker', LABEL, () => ({ status: 1, stdout: '' }));
    expect(down).toMatchObject({ removed: [], problem: expect.stringContaining('did not answer') });
  });

  it('defaultContainerExec: a runtime that is not installed is a spawn error, not a status', async () => {
    const r = await defaultContainerExec(join(dir, 'no-such-runtime'), ['version'], { timeoutMs: 10_000 });
    expect(r.status).toBeNull();
    expect(r.spawnError).toBeDefined();
  });
});

describe('inspectGateImageId', () => {
  it('reads the id with image inspect only (no pull); undefined when the image or its id is missing', async () => {
    const calls: string[][] = [];
    const exec = (r: ContainerExecResult): ContainerExec => async (_bin, args) => { calls.push([...args]); return r; };
    expect(await inspectGateImageId({ runtime: 'docker', image: 'node:24-bookworm' }, exec(ok({ tail: `${IMAGE_ID}\n` })))).toBe(IMAGE_ID);
    expect(calls).toEqual([['image', 'inspect', '--format', '{{.Id}}', 'node:24-bookworm']]);
    expect(await inspectGateImageId({ runtime: 'docker', image: 'x' }, exec(ok({ status: 1, tail: 'No such image' })))).toBeUndefined();
    expect(await inspectGateImageId({ runtime: 'docker', image: 'x' }, exec(ok({ tail: 'garbage' })))).toBeUndefined();
  });
});
