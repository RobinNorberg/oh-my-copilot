import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, hardenWindowsExeSearch, resolveBareExe } from '../windows-search.js';
import { defaultExec, scrubShipEnv } from '../../ship/exec.js';
import { defaultCopilotRunDeps } from '../../copilot-run/job.js';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CJS = createRequire(import.meta.url)(join(ROOT, 'scripts', 'lib', 'windows-search.cjs'));
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const isWin = process.platform === 'win32';
const WIN_REASON = 'the current-directory executable search exists only on Windows';
/** libuv honours the variable for no-shell spawns only from 1.48 (Node 22); older Node relies on resolveBareExe(). */
const uvHonoursVariable = (() => {
    const [major, minor] = (process.versions.uv ?? '0.0').split('.').map(Number);
    return major > 1 || (major === 1 && minor >= 48);
})();
const isVariable = (key) => key.toUpperCase() === VARIABLE.toUpperCase();
/** The env minus every case variant of the variable: Claude Code's shell sets it, which would make these tests pass vacuously. */
function withoutVariable(env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !isVariable(key)));
}
describe(`hardenWindowsExeSearch / childEnv, real processes (skipped off win32: ${WIN_REASON})`, () => {
    let saved;
    let plant;
    let scripts;
    beforeEach(() => {
        saved = { ...process.env };
        for (const key of Object.keys(process.env))
            if (isVariable(key))
                delete process.env[key];
        plant = mkdtempSync(join(tmpdir(), 'omg-winsearch-plant-'));
        scripts = mkdtempSync(join(tmpdir(), 'omg-winsearch-scripts-'));
    });
    afterEach(() => {
        for (const key of Object.keys(process.env))
            delete process.env[key];
        Object.assign(process.env, saved);
        rmSync(plant, { recursive: true, force: true });
        rmSync(scripts, { recursive: true, force: true });
    });
    /** hostname.exe stands in for a planted binary: it exits 0 when it runs. */
    function plantExe() {
        copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(plant, 'zzprobe.exe'));
    }
    /** A bare-name spawn from this process with the planted folder as cwd. */
    const probeHere = (env) => spawnSync('zzprobe', [], { cwd: plant, encoding: 'utf8', windowsHide: true, ...(env ? { env } : {}) });
    /** Runs a node child in the planted folder that spawns `zzprobe` by bare name, optionally hardening first. */
    function probeChild(harden) {
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
        const run = (env) => spawnSync('zzprobe', { cwd: plant, encoding: 'utf8', shell: true, env, windowsHide: true });
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
        for (const impl of [childEnv, CJS.childEnv])
            expect(impl({ PATH: 'x' })).toEqual({ PATH: 'x' });
    });
});
describe('every Node entry point hardens the Windows executable search', () => {
    const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
    const hardens = (rel) => /windows-search\.(js|mjs|cjs)['"]/.test(read(rel)) && /^\s*hardenWindowsExeSearch\(\);/m.test(read(rel));
    // A bundled library, not a process: skill-bridge.cjs is require()d by skill-injector.mjs.
    const LIBRARY_BUNDLES = new Set(['src/hooks/learner/bridge.ts']);
    // fork: entry points upstream does not ship (the `omg` bin, the Copilot hook dispatcher and
    // adapter preload, the setup scripts the omc-setup skill runs).
    const FORK_ENTRY_POINTS = [
        'bin/oh-my-copilot.js',
        'scripts/copilot/dispatch.cjs',
        'scripts/lib/copilot-hook-adapter.cjs',
        'scripts/setup-claude-md.mjs',
        'scripts/setup-config.mjs',
        'scripts/setup-progress.mjs',
    ];
    function entryPoints() {
        const found = new Set(FORK_ENTRY_POINTS);
        // Sources of every esbuild bundle (bridge/*.cjs, bridge/team.js); the package bins load bridge/cli.cjs.
        for (const name of readdirSync(join(ROOT, 'scripts')).filter((n) => /^build-.*\.mjs$/.test(n))) {
            for (const m of read(`scripts/${name}`).matchAll(/entryPoints:\s*\[([^\]]*)\]/g)) {
                for (const src of m[1].matchAll(/['"]([^'"]+)['"]/g))
                    if (!LIBRARY_BUNDLES.has(src[1]))
                        found.add(src[1]);
            }
        }
        // Claude Code hooks. Exec form lists the runner in args; the old shell
        // command listed it inside command. Either form must still see scripts/run.cjs.
        const hooksManifest = JSON.parse(read('hooks/hooks.json'));
        for (const groups of Object.values(hooksManifest.hooks ?? {})) {
            for (const group of groups) {
                for (const hook of group.hooks ?? []) {
                    const command = hook.command ?? '';
                    const shell = command.match(/node "\$\{CLAUDE_PLUGIN_ROOT\}"\/([^ "]+)/);
                    if (shell)
                        found.add(shell[1]);
                    for (const arg of hook.args ?? []) {
                        if (arg.replace(/\\/g, '/').endsWith('/scripts/run.cjs'))
                            found.add('scripts/run.cjs');
                    }
                }
            }
        }
        // Scripts that skills and commands run with `node <root>/scripts/x.mjs`, plus skill-local scripts.
        for (const dir of ['skills', 'commands']) {
            if (!existsSync(join(ROOT, dir)))
                continue;
            const walk = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
            for (const file of walk(join(ROOT, dir))) {
                const rel = relative(ROOT, file).replace(/\\/g, '/');
                if (/\/scripts\/[^/]+\.(mjs|cjs|js)$/.test(rel))
                    found.add(rel);
                if (!rel.endsWith('.md'))
                    continue;
                for (const m of readFileSync(file, 'utf8').matchAll(/\bnode\s+"?[^\s"]*?\b(scripts\/[\w./-]+\.(?:mjs|cjs|js))/g)) {
                    if (existsSync(join(ROOT, m[1])))
                        found.add(m[1]);
                }
            }
        }
        // Legacy installs copy templates/hooks/*.mjs to the host hooks dir, and node runs each one directly.
        for (const name of readdirSync(join(ROOT, 'templates', 'hooks')).filter((n) => n.endsWith('.mjs')))
            found.add(`templates/hooks/${name}`);
        found.add('scripts/run-provider-advisor.js'); // `omg ask` spawns it
        found.add('src/hud/index.ts'); // the HUD statusline wrapper imports dist/hud/index.js
        return [...found].sort();
    }
    it('finds the known entry points', () => {
        const found = entryPoints();
        for (const known of ['scripts/run.cjs', 'src/cli/index.ts', 'src/cli/team.ts', 'src/mcp/standalone-server.ts', 'src/mcp/team-server.ts',
            'src/team/runtime-cli.ts', 'scripts/cleanup-orphans.mjs', 'templates/hooks/pre-tool-use.mjs']) {
            expect(found).toContain(known);
        }
    });
    it('the fork-only entry points match how they are launched', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.bin.omg).toBe('bin/oh-my-copilot.js');
        const copilotHooks = read('copilot/hooks.json');
        expect(copilotHooks).toContain('scripts/copilot/dispatch.cjs');
        expect(copilotHooks).toContain('scripts/lib/copilot-hook-adapter.cjs');
        const skills = read('skills/omc-setup/SKILL.md') + ['01-install-claude-md.md', '02-configure.md', '03-integrations.md', '04-welcome.md']
            .map((name) => read(`skills/omc-setup/phases/${name}`)).join('');
        for (const script of ['setup-claude-md.mjs', 'setup-config.mjs', 'setup-progress.mjs'])
            expect(skills).toContain(`scripts/${script}`);
    });
    it('each entry point imports and calls hardenWindowsExeSearch()', () => {
        expect(entryPoints().filter((rel) => !hardens(rel))).toEqual([]);
    });
    it('the installed hook copy of the helper matches scripts/lib', () => {
        expect(read('templates/hooks/lib/windows-search.mjs')).toBe(read('scripts/lib/windows-search.mjs'));
    });
});
describe('resolveBareExe PATHEXT filtering', () => {
    it.skipIf(process.platform !== 'win32')('falls back to .COM;.EXE when PATHEXT holds only .CMD/.BAT', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omg-pathext-'));
        try {
            writeFileSync(join(dir, 'tool.exe'), '');
            expect(resolveBareExe('tool', { PATH: dir, PATHEXT: '.CMD;.BAT' })?.toLowerCase()).toBe(join(dir, 'tool.exe').toLowerCase());
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=windows-search.test.js.map