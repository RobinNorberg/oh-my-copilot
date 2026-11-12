/**
 * container-gate.ts with an injected fake runtime: the argv of every
 * runtime call (no credential mount or env, network none in the run phase,
 * labels, names, cleanup scope), the verdict mapping, the install plan, and
 * the guarded copy back of a prepare check's writes. No container runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultGateImage, resolveGateIsolation, type GateContainerSettings } from '../../../copilot-run/sandbox.js';
import {
  applyCopyBack, cleanRunContainers, containerArgv, containerRunLabel, defaultContainerExec, installPlan, mountArg, readTar, runContainerGate,
  safeRelPath, type ContainerExec, type ContainerExecOptions, type ContainerExecResult,
} from '../container-gate.js';
import type { SandboxRunRequest } from '../sandbox-exec.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-container-gate-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings = (over: Partial<GateContainerSettings> = {}): GateContainerSettings => ({ ...resolveGateIsolation({ user: { factory: { run: { sandbox: { isolation: 'container' } } } }, base: undefined }).container!, ...over });
const ok = (over: Partial<ContainerExecResult> = {}): ContainerExecResult => ({ status: 0, tail: '', overflow: false, timedOut: false, ...over });

/** A fake runtime: `answer` per call (by the first argv words), every call recorded. */
function fake(answer: (args: readonly string[], o: ContainerExecOptions) => ContainerExecResult | Promise<ContainerExecResult> = () => ok()) {
  const calls: Array<{ bin: string; args: string[]; o: ContainerExecOptions }> = [];
  const exec: ContainerExec = async (bin, args, o) => { calls.push({ bin, args: [...args], o }); return answer(args, o); };
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
    expect(r.container).toEqual({ runtime: 'docker', image: 'node:22-bookworm-slim', memory: '4g', cpus: 2, pidsLimit: 1024, installTimeoutMinutes: 15 });
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
    expect(r).toEqual({ ran: true, status: 0, output: 'tests passed', timedOut: false });
    const name = `omg-gate-${LABEL}-1234abcd`;
    expect(f.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['version --format', 'image inspect', 'volume create', 'volume create', 'run --name', 'run --name', 'run --name', 'volume rm']);
    expect(f.calls.every((c) => c.bin === 'docker')).toBe(true);
    expect(f.calls[2].args).toEqual(['volume', 'create', '--label', `omg.run=${LABEL}`, '--label', 'omg.gate=1', name]);
    expect(f.calls[3].args.at(-1)).toMatch(/^omg-gate-cache-[0-9a-f]{16}$/);
    expect(f.calls.at(-1)!.args).toEqual(['volume', 'rm', '-f', name]);
    expect(f.runs().map((c) => nameOf(c.args))).toEqual([`${name}-copy`, `${name}-install`, name]);
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
      expect(a.join(' ')).not.toMatch(/docker\.sock|\.ssh|\.npmrc|\.gitconfig|SSH_AUTH|GH_TOKEN|GITHUB_TOKEN|gho_/);
      expect(values(a, '-e').map((e) => e.split('=')[0]).filter((k) => !['PATH', 'HOME', 'CI', 'npm_config_update_notifier', 'npm_config_fund', 'npm_config_audit', 'npm_config_cache'].includes(k))).toEqual([]);
      expect(values(a, '--env')).toEqual([]);
    }
    // The only host path mounted is the checkout, read-only, in the copy step (no PR code runs there).
    const binds = f.runs().flatMap((c) => values(c.args, '--mount').filter((m) => m.includes('type=bind')));
    expect(binds).toEqual([`type=bind,source=${dir},target=/in,readonly`]);
    const copy = f.step('-copy')!.args;
    expect(values(copy, '--network')).toEqual(['none']);
    expect(copy.slice(-3, -1)).toEqual(['sh', '-c']);
    expect(copy.at(-1)).not.toContain(dir);
    const install = f.step('-install')!.args;
    expect(values(install, '--network')).toEqual([]);
    expect(values(install, '--user')).toEqual(['1000:1000']);
    expect(install.slice(-2)).toEqual(['npm', 'ci']);
    const run = f.step('-1234abcd')!.args;
    expect(values(run, '--network')).toEqual(['none']);
    expect(values(run, '--user')).toEqual(['1000:1000']);
    expect(values(run, '--mount').some((m) => m.includes('cache'))).toBe(false);
    expect(run.slice(-3)).toEqual([settings().image, 'npm', 'test']);
    expect(values(run, '-w')).toEqual(['/work/src']);
  });

  it('no package.json: no install, no cache volume; podman is called as podman', async () => {
    const f = fake();
    const r = await runContainerGate(request({ argv: ['node', '--test'], exe: process.execPath, args: ['--test'] }), settings({ runtime: 'podman' }), LABEL, { exec: f.exec, id: () => 'ffffffff' });
    expect(r.ran).toBe(true);
    expect(f.calls.every((c) => c.bin === 'podman')).toBe(true);
    expect(f.runs().map((c) => nameOf(c.args))).toEqual([`omg-gate-${LABEL}-ffffffff-copy`, `omg-gate-${LABEL}-ffffffff`]);
    expect(f.calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'create')).toHaveLength(1);
    expect(f.runs()[1].args.slice(-2)).toEqual(['node', '--test']);
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
    expect((await at(ok({ status: 1, tail: 'FAIL greet' }))).r).toEqual({ ran: true, status: 1, output: 'FAIL greet', timedOut: false });
    const t = await at(ok({ status: 137, timedOut: true, tail: 'running' }));
    expect(t.r).toMatchObject({ ran: true, status: 124, timedOut: true });
    expect(t.f.calls.filter((c) => c.args[0] === 'kill').map((c) => c.args)).toEqual([['kill', `omg-gate-${LABEL}-00000001`]]);
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
    const r = cleanRunContainers('docker', LABEL, (bin, args) => { calls.push([bin, ...args]); return { status: 0, stdout: args[0] === 'ps' ? out.ps : args[0] === 'volume' && args[1] === 'ls' ? out.volume : '' }; });
    expect(r.removed).toEqual([`omg-gate-${LABEL}-aa`, `omg-gate-${LABEL}-aa-install`, `omg-gate-${LABEL}-aa`]);
    expect(calls.filter((c) => c[1] === 'ps' || c[2] === 'ls').every((c) => c.includes(`label=omg.run=${LABEL}`))).toBe(true);
    expect(calls.filter((c) => c.includes('rm')).map((c) => c.at(-1))).toEqual([`omg-gate-${LABEL}-aa`, `omg-gate-${LABEL}-aa-install`, `omg-gate-${LABEL}-aa`]);
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
