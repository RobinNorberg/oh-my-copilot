import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, hardenWindowsExeSearch } from '../windows-search.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const isWin = process.platform === 'win32';
const WIN_REASON = 'the current-directory executable search exists only on Windows';

/** The env minus every case variant of the variable: Claude Code's shell sets it, which would make these tests pass vacuously. */
function withoutVariable(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== VARIABLE.toUpperCase()));
}

describe(`hardenWindowsExeSearch / childEnv, real processes (skipped off win32: ${WIN_REASON})`, () => {
  let saved: NodeJS.ProcessEnv;
  let plant: string;
  let scripts: string;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === VARIABLE.toUpperCase()) delete process.env[key];
    }
    plant = mkdtempSync(join(tmpdir(), 'omg-winsearch-plant-'));
    scripts = mkdtempSync(join(tmpdir(), 'omg-winsearch-scripts-'));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(plant, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  });

  /** Runs a node child in the planted folder that spawns `zzprobe` by bare name, optionally hardening first. */
  function probeChild(harden: boolean): { ran: boolean; code?: string } {
    // hostname.exe stands in for a planted binary: it exits 0 when it runs.
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(plant, 'zzprobe.exe'));
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

  it.skipIf(!isWin)('(a) a child that hardens does not run an exe planted in its cwd', () => {
    expect(probeChild(false).ran).toBe(true); // red without the call: the plant runs
    expect(probeChild(true)).toEqual({ ran: false, code: 'ENOENT' });
  });

  it.skipIf(!isWin)('(b) childEnv keeps cmd.exe (shell: true) from running a planted .cmd', () => {
    writeFileSync(join(plant, 'zzprobe.cmd'), '@echo PLANTED\r\n');
    const run = (env: NodeJS.ProcessEnv) => spawnSync('zzprobe', { cwd: plant, encoding: 'utf8', shell: true, env, windowsHide: true });
    const stripped = withoutVariable(process.env);
    expect(run(stripped).stdout).toContain('PLANTED'); // red without childEnv
    const hardened = run(childEnv(stripped));
    expect(hardened.stdout).not.toContain('PLANTED');
    expect(hardened.status).not.toBe(0);
  });

  it.skipIf(!isWin)('hardenWindowsExeSearch replaces every case variant with one =1 entry, idempotently', () => {
    process.env.nodefaultcurrentdirectoryinexepath = '0';
    hardenWindowsExeSearch();
    hardenWindowsExeSearch();
    const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === VARIABLE.toUpperCase());
    expect(keys).toEqual([VARIABLE]);
    expect(process.env[VARIABLE]).toBe('1');
  });

  it.skipIf(!isWin)('childEnv returns a copy with case variants dropped and =1 set', () => {
    const input = { PATH: 'x', nodefaultcurrentdirectoryinexepath: '' };
    const out = childEnv(input);
    expect(out).toEqual({ PATH: 'x', [VARIABLE]: '1' });
    expect(input).toEqual({ PATH: 'x', nodefaultcurrentdirectoryinexepath: '' });
  });
});

describe('every Node entry point hardens the Windows executable search', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const hardens = (rel: string) => /windows-search\.(js|mjs|cjs)['"]/.test(read(rel)) && /^\s*hardenWindowsExeSearch\(\);/m.test(read(rel));
  // Bundled libraries, not processes: skill-bridge.cjs is require()d by skill-injector.mjs.
  const LIBRARY_BUNDLES = new Set(['src/hooks/learner/bridge.ts']);

  function entryPoints(): string[] {
    const found = new Set<string>();
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> };
    for (const bin of Object.values(pkg.bin)) if (!bin.startsWith('bridge/')) found.add(bin);
    // Sources of every esbuild bundle (bridge/*.cjs, bridge/team.js, dist/hooks/*.cjs).
    for (const name of readdirSync(join(ROOT, 'scripts')).filter((n) => /^build-.*\.mjs$/.test(n))) {
      for (const m of read(`scripts/${name}`).matchAll(/entryPoints:\s*\[([^\]]*)\]/g)) {
        for (const src of m[1].matchAll(/['"]([^'"]+)['"]/g)) if (!LIBRARY_BUNDLES.has(src[1])) found.add(src[1]);
      }
    }
    // Claude Code hooks: the script node runs first (the runner).
    for (const m of read('hooks/hooks.json').matchAll(/"command":\s*"node \\"\$\{CLAUDE_PLUGIN_ROOT\}\\"\/([^ "\\]+)/g)) found.add(m[1]);
    // Copilot hooks: the --require preload and the script node runs.
    const copilot = JSON.parse(read('copilot/hooks.json')) as { hooks: Record<string, Array<{ exec?: string; args?: string[] }>> };
    for (const entries of Object.values(copilot.hooks)) {
      for (const entry of entries) {
        if (entry.exec !== 'node' || !entry.args) continue;
        const args = entry.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
        const req = args.indexOf('--require');
        if (req >= 0) found.add(args[req + 1]);
        found.add(args.find((a, i) => !a.startsWith('-') && i !== req + 1)!);
      }
    }
    // Scripts skills and commands run with `node <root>/scripts/x.mjs`, plus skill-local scripts.
    for (const dir of ['skills', 'commands']) {
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        if (/\/scripts\/[^/]+\.(mjs|cjs|js)$/.test(rel)) found.add(rel);
        if (!rel.endsWith('.md')) continue;
        for (const m of readFileSync(file, 'utf8').matchAll(/\bnode\s+"?[^\s"]*?\b(scripts\/[\w./-]+\.(?:mjs|cjs|js))/g)) {
          if (existsSync(join(ROOT, m[1]))) found.add(m[1]);
        }
      }
    }
    found.add('src/hud/index.ts'); // the HUD statusline wrapper imports dist/hud/index.js
    return [...found].sort();
  }

  it('finds the known entry points', () => {
    const found = entryPoints();
    for (const known of ['bin/oh-my-copilot.js', 'scripts/run.cjs', 'scripts/copilot/dispatch.cjs', 'scripts/lib/copilot-hook-adapter.cjs',
      'src/cli/index.ts', 'src/mcp/standalone-server.ts', 'src/mcp/team-server.ts', 'src/team/runtime-cli.ts', 'scripts/setup-claude-md.mjs']) {
      expect(found).toContain(known);
    }
  });

  it('each entry point imports and calls hardenWindowsExeSearch()', () => {
    expect(entryPoints().filter((rel) => !hardens(rel))).toEqual([]);
  });

  it('the shipped bridge bundles that hooks, skills and the MCP config run contain the hardening', () => {
    const bundles = ['bridge/cli.cjs', 'bridge/mcp-server.cjs', 'bridge/team-mcp.cjs', 'bridge/team-bridge.cjs', 'bridge/runtime-cli.cjs', 'bridge/claude-md-coordinator.cjs', 'bridge/team.js'];
    expect(bundles.filter((rel) => !/\bhardenWindowsExeSearch\(\);/.test(read(rel)))).toEqual([]);
  });
});
