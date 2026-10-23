import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { doctorPayloads, formatHooksDoctorReport, runHooksDoctor, type HooksDoctorReport } from '../hooks.js';
import { compareCopilotVersions, TARGET_COPILOT_VERSION } from '../../../smoke/copilot-binary.js';
import { entryMatches, readCopilotHookManifest } from '../../../smoke/copilot-hook-manifest.js';
import type { SpawnSyncFn } from '../../../smoke/process-utils.js';
import { removeTempDir } from '../../../__tests__/helpers/platform.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await removeTempDir(dir);
  dirs.length = 0;
});

/**
 * A plugin root with one copilot/hooks.json entry per script: `ok` prints
 * JSON, `noisy` also writes stderr, `crash` exits 1, `garbage` prints text.
 */
function fakeRoot(scripts: Record<string, string>, opts: { missing?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'omg-hooks-doctor-root-'));
  dirs.push(root);
  mkdirSync(join(root, 'copilot'));
  mkdirSync(join(root, 'hooks'));
  mkdirSync(join(root, 'scripts'));
  const hooks: Record<string, unknown[]> = {};
  for (const [event, body] of Object.entries(scripts)) {
    writeFileSync(join(root, 'scripts', `${event}.cjs`), `require('fs').readFileSync(0, 'utf8');\n${body}\n`);
    hooks[event] = [{ type: 'command', exec: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/scripts/${event}.cjs`], timeoutSec: 10 }];
  }
  if (opts.missing) hooks[opts.missing] = [{ type: 'command', exec: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/scripts/gone.cjs`], timeoutSec: 10 }];
  writeFileSync(join(root, 'copilot', 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2));
  writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');
  return root;
}

/** Real spawnSync, except `copilot --version` for the fake binary. */
function withCopilot(version: string | null): SpawnSyncFn {
  return ((command: string, args: readonly string[], options: object) => {
    if (JSON.stringify([command, args]).includes('fake-copilot')) {
      return { status: 0, stdout: version ? `GitHub Copilot CLI ${version}.\n` : 'weird\n', stderr: '', pid: 1, output: [], signal: null };
    }
    return spawnSync(command, args, options);
  }) as unknown as SpawnSyncFn;
}

const deps = (over: Record<string, unknown> = {}) => ({
  spawnSync: withCopilot(TARGET_COPILOT_VERSION),
  resolveExecutable: (name: string) => (name === 'copilot' ? join(tmpdir(), 'fake-copilot.exe') : undefined),
  renderHooks: async (root: string) => readFileSync(join(root, 'copilot', 'hooks.json'), 'utf8'),
  randomUUID: () => 'uuid',
  ...over,
});

const byId = (report: HooksDoctorReport) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

describe('runHooksDoctor', () => {
  it('passes a clean manifest: node, version, sync, scripts and a dry dispatch per entry', async () => {
    const root = fakeRoot({ Stop: "process.stdout.write(JSON.stringify({ continue: true }))", Notification: '' });
    const report = await runHooksDoctor({ pluginRoot: root, env: process.env, deps: deps() });
    const c = byId(report);
    expect(report.ok).toBe(true);
    expect(c['node.path'].status).toBe('ok');
    expect(c['copilot.version'].status).toBe('ok');
    expect(c['manifest.sync'].status).toBe('ok');
    expect(c['scripts.exist'].detail).toContain('all 2 script paths');
    expect(c['dispatch.Stop'].detail).toMatch(/^exit 0 in \d+ ms \(10 s timeout\), output \{continue\}$/);
    expect(c['dispatch.Notification'].detail).toContain('no output');
  });

  it('surfaces hook stderr as a warning, and failures for a crash, garbage stdout or a missing script', async () => {
    const root = fakeRoot({
      Stop: "process.stderr.write('[omg-hook] Stop: persistent-mode.mjs exited 1\\n'); process.stdout.write('{}')",
      SessionEnd: 'process.exit(1)',
      PreCompact: "process.stdout.write('not json')",
    }, { missing: 'SessionStart' });
    const report = await runHooksDoctor({ pluginRoot: root, env: process.env, deps: deps() });
    const c = byId(report);
    expect(report.ok).toBe(false);
    expect(c['dispatch.Stop'].status).toBe('warn');
    expect(c['dispatch.Stop'].evidence).toContain('[omg-hook] Stop: persistent-mode.mjs exited 1');
    expect(c['dispatch.SessionEnd'].status).toBe('fail');
    expect(c['dispatch.SessionEnd'].detail).toMatch(/^exit 1 /);
    expect(c['dispatch.PreCompact'].status).toBe('fail');
    expect(c['dispatch.PreCompact'].detail).toContain('not JSON');
    expect(c['scripts.exist'].status).toBe('fail');
    expect(c['scripts.exist'].evidence).toContain('gone.cjs');
    expect(formatHooksDoctorReport(report)).toContain('failure(s)');
  });

  it('feeds each hook the recorded Copilot payload for its event', async () => {
    const root = fakeRoot({ PermissionRequest: "process.stdout.write(JSON.stringify({ continue: true }))" });
    const echo = join(root, 'scripts', 'PermissionRequest.cjs');
    writeFileSync(echo, "const p = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stderr.write(p.toolName + ' ' + p.sessionId);");
    const report = await runHooksDoctor({ pluginRoot: root, env: process.env, deps: deps() });
    expect(byId(report)['dispatch.PermissionRequest'].evidence).toBe('powershell omg-hooks-doctor-uuid');
  });

  it('runs one event with --event and none with --no-dispatch', async () => {
    const root = fakeRoot({ Stop: '', SessionEnd: '' });
    const one = await runHooksDoctor({ pluginRoot: root, env: process.env, event: 'Stop', deps: deps() });
    expect(one.checks.filter((c) => c.id.startsWith('dispatch.')).map((c) => c.id)).toEqual(['dispatch.Stop']);
    const unknown = await runHooksDoctor({ pluginRoot: root, env: process.env, event: 'Nope', deps: deps() });
    expect(byId(unknown)['dispatch.Nope'].status).toBe('fail');
    const none = await runHooksDoctor({ pluginRoot: root, env: process.env, dispatch: false, deps: deps() });
    expect(none.checks.some((c) => c.id.startsWith('dispatch'))).toBe(false);
  });

  it('fails the sync check when the generator renders something else', async () => {
    const root = fakeRoot({ Stop: '' });
    const report = await runHooksDoctor({ pluginRoot: root, env: process.env, dispatch: false, deps: deps({ renderHooks: async () => '{}\n' }) });
    expect(byId(report)['manifest.sync'].status).toBe('fail');
  });

  it('fails node.path and skips the dispatch when node cannot be run', async () => {
    const root = fakeRoot({ Stop: '' });
    const noNode = ((command: string, args: readonly string[], options: object) => (command === 'node'
      ? { status: null, stdout: '', stderr: '', pid: 0, output: [], signal: null, error: Object.assign(new Error('spawnSync node ENOENT'), { code: 'ENOENT' }) }
      : withCopilot(TARGET_COPILOT_VERSION)(command, args, options as never))) as unknown as SpawnSyncFn;
    const c = byId(await runHooksDoctor({ pluginRoot: root, env: process.env, deps: deps({ spawnSync: noNode }) }));
    expect(c['node.path'].status).toBe('fail');
    expect(c['node.path'].detail).toContain('ENOENT');
    expect(c.dispatch.detail).toBe('skipped: node is not on PATH');
  });

  it('warns for a Copilot CLI newer than the target, and when none is installed', async () => {
    const root = fakeRoot({ Stop: '' });
    const newer = byId(await runHooksDoctor({ pluginRoot: root, env: {}, dispatch: false, deps: deps({ spawnSync: withCopilot('1.0.103') }) }));
    expect(newer['copilot.version'].status).toBe('warn');
    expect(newer['copilot.version'].detail).toContain(`newer than the verified target (target ${TARGET_COPILOT_VERSION}`);
    const none = byId(await runHooksDoctor({ pluginRoot: root, env: {}, dispatch: false, deps: deps({ resolveExecutable: () => undefined, platform: 'linux' }) }));
    expect(none['copilot.version'].status).toBe('warn');
    expect(none['copilot.version'].detail).toContain('copilot not found');
  });
});

describe('the shipped manifest', () => {
  it('copilot/hooks.json is in sync with its generator', async () => {
    const report = await runHooksDoctor({ pluginRoot: REPO_ROOT, env: process.env, dispatch: false, deps: { resolveExecutable: () => undefined, platform: 'linux' } });
    expect(byId(report)['manifest.sync'].status).toBe('ok');
    expect(byId(report)['scripts.exist'].status).toBe('ok');
  });

  it('every registered event has a recorded payload that its entries match', () => {
    const manifest = readCopilotHookManifest(REPO_ROOT);
    const payloads = doctorPayloads('/project', 'sid');
    for (const [event, entries] of Object.entries(manifest.hooks)) {
      expect(payloads[event], event).toBeDefined();
      for (const entry of entries) expect(payloads[event].some((v) => entryMatches(entry, v.tool)), `${event} ${entry.matcher ?? ''}`).toBe(true);
    }
  });
});

describe('compareCopilotVersions', () => {
  it('orders x.y.z numerically and ignores prerelease suffixes', () => {
    expect(compareCopilotVersions('1.0.103', '1.0.91')).toBeGreaterThan(0);
    expect(compareCopilotVersions('1.0.91', '1.0.91-2')).toBe(0);
    expect(compareCopilotVersions('0.9.200', '1.0.0')).toBeLessThan(0);
  });
});
