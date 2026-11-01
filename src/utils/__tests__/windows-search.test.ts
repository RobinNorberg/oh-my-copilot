import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, hardenWindowsExeSearch } from '../windows-search.js';
import { defaultExec, scrubShipEnv } from '../../ship/exec.js';
import { defaultCopilotRunDeps } from '../../copilot-run/job.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CJS = createRequire(import.meta.url)(join(ROOT, 'scripts', 'lib', 'windows-search.cjs')) as { childEnv: typeof childEnv };
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const isWin = process.platform === 'win32';
const WIN_REASON = 'the current-directory executable search exists only on Windows';

/** libuv honours the variable for no-shell spawns only from 1.48 (Node 22); older Node relies on resolveBareExe(). */
const uvHonoursVariable = (() => {
  const [major, minor] = (process.versions.uv ?? '0.0').split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 48);
})();
const isVariable = (key: string) => key.toUpperCase() === VARIABLE.toUpperCase();
/** The env minus every case variant of the variable: Claude Code's shell sets it, which would make these tests pass vacuously. */
function withoutVariable(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isVariable(key)));
}

describe(`hardenWindowsExeSearch / childEnv, real processes (skipped off win32: ${WIN_REASON})`, () => {
  let saved: NodeJS.ProcessEnv;
  let plant: string;
  let scripts: string;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (isVariable(key)) delete process.env[key];
    plant = mkdtempSync(join(tmpdir(), 'omg-winsearch-plant-'));
    scripts = mkdtempSync(join(tmpdir(), 'omg-winsearch-scripts-'));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(plant, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  });

  /** hostname.exe stands in for a planted binary: it exits 0 when it runs. */
  function plantExe(): void {
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(plant, 'zzprobe.exe'));
  }
  /** A bare-name spawn from this process with the planted folder as cwd. */
  const probeHere = (env?: NodeJS.ProcessEnv) => spawnSync('zzprobe', [], { cwd: plant, encoding: 'utf8', windowsHide: true, ...(env ? { env } : {}) });

  /** Runs a node child in the planted folder that spawns `zzprobe` by bare name, optionally hardening first. */
  function probeChild(harden: boolean): { ran: boolean; code?: string } {
    plantExe();
    const child = join(scripts, 'child.cjs');
    writeFileSync(child, [
      `const { hardenWindowsExeSearch } = require(${JSON.stringify(join(ROOT, 'scripts', 'lib', 'windows-search.cjs'))});`,
      `if (process.argv[2] === 'harden') hardenWindowsExeSearch();`,
      `const r = require('child_process').spawnSync('zzprobe', [], { encoding: 'utf8', windowsHide: true });`,
      `process.stdout.write(JSON.stringify({ ran: !r.error && r.status === 0, code: r.error && r.error.code }));`,
    ].join('\n'));
    const res = spawnSync(process.execPath, [child, harden ? 'harden' : 'plain'], {
      cwd: plant, encoding: 'utf8', env: withoutVariable(process.env), windowsHide: true,
    });
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout);
  }

  it.skipIf(!isWin || !uvHonoursVariable)('(a) a child that hardens does not run an exe planted in its cwd', () => {
    expect(probeChild(false).ran).toBe(true); // red without the call: the plant runs
    expect(probeChild(true)).toEqual({ ran: false, code: 'ENOENT' });
  });

  it.skipIf(!isWin)('(b) childEnv (TS and CJS) keeps cmd.exe (shell: true) from running a planted .cmd', () => {
    writeFileSync(join(plant, 'zzprobe.cmd'), '@echo PLANTED\r\n');
    const run = (env: NodeJS.ProcessEnv) => spawnSync('zzprobe', { cwd: plant, encoding: 'utf8', shell: true, env, windowsHide: true });
    const stripped = withoutVariable(process.env);
    expect(run(stripped).stdout).toContain('PLANTED'); // red without childEnv
    for (const hardened of [run(childEnv(stripped)), run(CJS.childEnv(stripped))]) {
      expect(hardened.stdout).not.toContain('PLANTED');
      expect(hardened.status).not.toBe(0);
    }
  });

  it.skipIf(!isWin)('the factory engine / ship runner (defaultExec) does not run an exe planted in a lane worktree', () => {
    plantExe();
    // red: the same spawn with the engine's child env, from an unhardened process, runs the plant
    expect(probeHere(scrubShipEnv(process.env)).status).toBe(0);
    const res = defaultExec('zzprobe', [], { cwd: plant });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('ENOENT');
    expect(process.env[VARIABLE]).toBe('1');
  });

  it.skipIf(!isWin || !uvHonoursVariable)('the copilot-run host deps harden the host process before any job spawns', () => {
    plantExe();
    expect(probeHere().status).toBe(0); // red: an unhardened host runs the plant
    defaultCopilotRunDeps();
    expect(probeHere().error?.message).toContain('ENOENT');
  });

  it.skipIf(!isWin)('hardenWindowsExeSearch replaces every case variant with one =1 entry, idempotently', () => {
    process.env.nodefaultcurrentdirectoryinexepath = '0';
    hardenWindowsExeSearch();
    hardenWindowsExeSearch();
    expect(Object.keys(process.env).filter(isVariable)).toEqual([VARIABLE]);
    expect(process.env[VARIABLE]).toBe('1');
  });

  it.skipIf(!isWin)('childEnv (TS and CJS) returns a copy with case variants dropped and =1 set', () => {
    for (const impl of [childEnv, CJS.childEnv]) {
      const input = { PATH: 'x', nodefaultcurrentdirectoryinexepath: '' };
      expect(impl(input)).toEqual({ PATH: 'x', [VARIABLE]: '1' });
      expect(input).toEqual({ PATH: 'x', nodefaultcurrentdirectoryinexepath: '' });
    }
  });

  it.skipIf(isWin)('childEnv (TS and CJS) is an unchanged copy off win32', () => {
    for (const impl of [childEnv, CJS.childEnv]) expect(impl({ PATH: 'x' })).toEqual({ PATH: 'x' });
  });
});

describe('every fork-only Node entry point hardens the Windows executable search', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  // Entry points upstream oh-my-claudecode does not ship; the shared ones (scripts/run.cjs,
  // src/cli/index.ts, the MCP servers, ...) are hardened by the upstream change.
  const FORK_ENTRY_POINTS = [
    'bin/oh-my-copilot.js',
    'scripts/copilot/dispatch.cjs',
    'scripts/lib/copilot-hook-adapter.cjs',
    'scripts/setup-claude-md.mjs',
    'scripts/setup-config.mjs',
    'scripts/setup-progress.mjs',
  ];

  it('the list matches how they are launched', () => {
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> };
    expect(pkg.bin.omg).toBe('bin/oh-my-copilot.js');
    const copilotHooks = read('copilot/hooks.json');
    expect(copilotHooks).toContain('scripts/copilot/dispatch.cjs');
    expect(copilotHooks).toContain('scripts/lib/copilot-hook-adapter.cjs');
    const skills = read('skills/omc-setup/SKILL.md') + ['01-install-claude-md.md', '02-configure.md', '03-integrations.md', '04-welcome.md']
      .map((name) => read(`skills/omc-setup/phases/${name}`)).join('');
    for (const script of ['setup-claude-md.mjs', 'setup-config.mjs', 'setup-progress.mjs']) expect(skills).toContain(`scripts/${script}`);
  });

  it('each imports the helper and calls hardenWindowsExeSearch()', () => {
    expect(FORK_ENTRY_POINTS.filter((rel) => !/windows-search\.(mjs|cjs)['"]/.test(read(rel)) || !/^\s*hardenWindowsExeSearch\(\);/m.test(read(rel)))).toEqual([]);
  });
});
