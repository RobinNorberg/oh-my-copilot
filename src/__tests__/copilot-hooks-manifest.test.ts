import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Copilot CLI runs the fork's hooks from the generated copilot/hooks.json (root
 * plugin.json `hooks`), never from upstream's hooks/hooks.json. Upstream's
 * `node "${CLAUDE_PLUGIN_ROOT}"/scripts/...` command form is split by pwsh on
 * Windows, so the generated file uses exec+args (no shell).
 *
 * Runtime requirement: `node` must be on PATH. A missing PreToolUse exec is
 * fail-closed in Copilot (every tool denied); `omg doctor` checks for it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

type CopilotHookEntry = {
  type: string;
  matcher?: string;
  exec: string;
  args: string[];
  env: Record<string, string>;
  timeoutSec?: number;
  [key: string]: unknown;
};
type CopilotHooksFile = { version: number; hooks: Record<string, CopilotHookEntry[]> };
type ClaudeHook = { type: string; command: string; timeout?: number; async?: boolean };
type ClaudeHooksFile = { hooks: Record<string, Array<{ matcher?: string; hooks: ClaudeHook[] }>> };
type Generator = {
  ADAPTER_ARG: string;
  DISPATCH_ARG: string;
  HOOK_SEPARATOR: string;
  buildCopilotHooks(source: unknown, options?: { preload?: boolean }): CopilotHooksFile;
  renderCopilotHooks(sourceText: string, options?: { preload?: boolean }): string;
};

const dispatcher = createRequire(import.meta.url)(join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs')) as {
  HOOK_SEPARATOR: string;
  parseDispatchArgv(argv: string[]): { event: string; hooks: Array<{ script: string; args: string[] }> };
};
const generator = import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'copilot', 'build-hooks.mjs')).href
) as Promise<Generator>;
const readText = (repoPath: string) => readFileSync(join(REPO_ROOT, repoPath), 'utf8');
const readJson = <T>(repoPath: string) => JSON.parse(readText(repoPath)) as T;

const sourceText = readText('hooks/hooks.json');
const source = JSON.parse(sourceText) as ClaudeHooksFile;
const generated = readJson<CopilotHooksFile>('copilot/hooks.json');
const allEntries = Object.entries(generated.hooks).flatMap(([event, entries]) =>
  entries.map(entry => ({ event, entry })));

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function renderArgs(args: string[], root: string): string[] {
  return args.map(arg => arg.split(ROOT_TOKEN).join(root));
}

function pwshAvailable(): boolean {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

describe('copilot/hooks.json generation', () => {
  it('is in sync with the generator output for hooks/hooks.json', async () => {
    const { renderCopilotHooks } = await generator;
    expect(readText('copilot/hooks.json')).toBe(renderCopilotHooks(sourceText));
  });

  it('uses exec node with the adapter preload, the dispatcher and the event first, and unquoted whole-path args', async () => {
    const { ADAPTER_ARG, DISPATCH_ARG } = await generator;
    expect(allEntries.length).toBeGreaterThan(0);
    for (const { event, entry } of allEntries) {
      expect(entry.type, event).toBe('command');
      expect(entry.exec, event).toBe('node');
      expect(entry.args.slice(0, 4), event).toEqual(['--require', ADAPTER_ARG, DISPATCH_ARG, event]);
      for (const arg of entry.args) {
        expect(arg, event).not.toMatch(/["']/);
        if (arg.includes(ROOT_TOKEN)) expect(arg, event).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/[^"\s]+$/);
      }
      expect(entry.env, event).toEqual({ OMC_HOOK_EVENT: event });
      expect(entry, event).not.toHaveProperty('async');
      expect(entry.matcher, event).not.toBe('*');
    }
  });

  it('references only files that exist in the plugin', () => {
    const referenced = new Set(allEntries.flatMap(({ entry }) =>
      entry.args.filter(arg => arg.startsWith(`${ROOT_TOKEN}/`)).map(arg => arg.slice(ROOT_TOKEN.length + 1))));
    expect(referenced).toContain('scripts/lib/copilot-hook-adapter.cjs');
    expect(referenced).toContain('scripts/copilot/dispatch.cjs');
    for (const repoPath of referenced) expect(existsSync(join(REPO_ROOT, repoPath)), repoPath).toBe(true);
  });

  it('emits one dispatcher entry per (event, matcher) group with its hooks, extra args and summed timeout', () => {
    const pattern = /^node "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/run\.cjs "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/(\S+)((?: \S+)*)$/;
    const expected = Object.entries(source.hooks).flatMap(([event, groups]) => groups
      .filter(group => !(event === 'SessionStart' && group.matcher && group.matcher !== '*'))
      .map(group => ({
        event,
        matcher: group.matcher && group.matcher !== '*' ? group.matcher : undefined,
        timeoutSec: group.hooks.reduce((sum, hook) => sum + (hook.timeout ?? 0), 0),
        hooks: group.hooks.map(hook => {
          const match = pattern.exec(hook.command);
          expect(match, hook.command).not.toBeNull();
          return { script: `${ROOT_TOKEN}/scripts/${match![1]}`, args: match![2].split(' ').filter(Boolean) };
        }),
      })));
    const actual = allEntries.map(({ event, entry }) => {
      const parsed = dispatcher.parseDispatchArgv(entry.args.slice(3));
      expect(parsed.event, event).toBe(event);
      return { event, matcher: entry.matcher, timeoutSec: entry.timeoutSec, hooks: parsed.hooks };
    });
    expect(actual).toEqual(expected);
    // The shapes this file relies on: multi-hook groups and an extra script arg.
    expect(actual.some(item => item.hooks.length > 1)).toBe(true);
    expect(actual.some(item => item.hooks.some(hook => hook.args.length > 0))).toBe(true);
    const counts = Object.fromEntries(Object.entries(generated.hooks).map(([event, entries]) => [event, entries.length]));
    expect(counts).toEqual({
      UserPromptSubmit: 1,
      SessionStart: 1,
      PreToolUse: 2,
      PermissionRequest: 1,
      PostToolUse: 1,
      PostToolUseFailure: 1,
      SubagentStart: 1,
      SubagentStop: 1,
      PreCompact: 1,
      Stop: 1,
      SessionEnd: 1,
    });
  });

  it('uses the dispatcher hook separator', async () => {
    const { HOOK_SEPARATOR } = await generator;
    expect(HOOK_SEPARATOR).toBe(dispatcher.HOOK_SEPARATOR);
  });

  it('drops SessionStart matcher groups (Copilot ignores SessionStart matchers)', () => {
    const sessionStart = generated.hooks.SessionStart ?? [];
    expect(sessionStart.length).toBeGreaterThan(0);
    for (const entry of sessionStart) expect(entry).not.toHaveProperty('matcher');
    const scripts = JSON.stringify(generated);
    expect(scripts).not.toContain('setup-init.mjs');
    expect(scripts).not.toContain('setup-maintenance.mjs');
  });

  it('keeps PreToolUse/PermissionRequest matchers that are not "*"', () => {
    // Only upstream's Bash-scoped git-guardrails entry (#4140-era) carries a PreToolUse matcher.
    expect(generated.hooks.PreToolUse.map(entry => entry.matcher)).toEqual([undefined, 'Bash']);
    expect(generated.hooks.PreToolUse[1].args.at(-1)).toMatch(/git-guardrails\.mjs$/);
    expect(generated.hooks.PermissionRequest.map(entry => entry.matcher)).toEqual(['Bash']);
  });

  it('throws on any command or field outside the upstream form', async () => {
    const { buildCopilotHooks } = await generator;
    const wrap = (hook: Record<string, unknown>) => ({ hooks: { Stop: [{ matcher: '*', hooks: [hook] }] } });
    const valid = { type: 'command', command: `node "${ROOT_TOKEN}"/scripts/run.cjs "${ROOT_TOKEN}"/scripts/x.mjs`, timeout: 5 };
    expect(() => buildCopilotHooks(wrap(valid))).not.toThrow();
    for (const foreign of [
      { ...valid, command: `node "${ROOT_TOKEN}/scripts/run.cjs" "${ROOT_TOKEN}/scripts/x.mjs"` },
      { ...valid, command: `node "${ROOT_TOKEN}"/scripts/x.mjs` },
      { ...valid, command: `bash "${ROOT_TOKEN}"/scripts/run.cjs "${ROOT_TOKEN}"/scripts/x.mjs` },
      { ...valid, type: 'prompt' },
      { ...valid, statusMessage: 'new upstream field' },
      // `--` separates hooks in the dispatcher argv, so it cannot be a hook arg.
      { ...valid, command: `${valid.command} --` },
    ]) {
      expect(() => buildCopilotHooks(wrap(foreign)), JSON.stringify(foreign)).toThrow();
    }
  });

  it('can omit the preload for diagnostics', async () => {
    const { buildCopilotHooks, DISPATCH_ARG } = await generator;
    const bare = buildCopilotHooks(source, { preload: false });
    for (const entries of Object.values(bare.hooks)) {
      for (const entry of entries) expect(entry.args[0]).toBe(DISPATCH_ARG);
    }
  });
});

describe('root plugin.json (Copilot CLI manifest)', () => {
  it('points Copilot at the generated hooks and mirrors the Claude manifest identity', () => {
    const rootManifest = readJson<Record<string, unknown>>('plugin.json');
    const claudeManifest = readJson<Record<string, unknown>>('.claude-plugin/plugin.json');
    const packageJson = readJson<Record<string, unknown>>('package.json');
    expect(rootManifest.hooks).toBe('./copilot/hooks.json');
    expect(rootManifest.mcpServers).toBe('./.mcp.json');
    expect(rootManifest.commands).toBe(claudeManifest.commands);
    expect(rootManifest.name).toBe(claudeManifest.name);
    expect(rootManifest.version).toBe(claudeManifest.version);
    expect(rootManifest.version).toBe(packageJson.version);
    for (const key of ['description', 'keywords', 'author', 'repository'] as const) {
      expect(rootManifest[key], `plugin.json ${key}`).toEqual(claudeManifest[key]);
    }
    // Default `skills/` discovery covers every skill; an explicit list would need syncing.
    expect(rootManifest).not.toHaveProperty('skills');
    expect(rootManifest).not.toHaveProperty('$schema');
  });

  it('ships the root manifest and generated hooks in the npm package', () => {
    const files = readJson<{ files: string[] }>('package.json').files;
    expect(files).toEqual(expect.arrayContaining(['plugin.json', 'copilot']));
  });
});

describe('exec form under a plugin root containing a space', () => {
  it('delivers each path as one argv element and emits the adapter output', () => {
    const root = mkdtempSync(join(tmpdir(), 'omg copilot hooks '));
    tempRoots.push(root);
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'copilot'), { recursive: true });
    copyFileSync(
      join(REPO_ROOT, 'scripts', 'lib', 'copilot-hook-adapter.cjs'),
      join(root, 'scripts', 'lib', 'copilot-hook-adapter.cjs'),
    );
    // Probe in place of the dispatcher: report argv through additionalContext.
    // (The adapter preload leaves the dispatcher's own output alone.)
    writeFileSync(join(root, 'scripts', 'copilot', 'dispatch.cjs'), [
      'process.stdout.write(JSON.stringify({',
      '  additionalContext: JSON.stringify(process.argv.slice(1)),',
      '}));',
      '',
    ].join('\n'));

    const { entry } = allEntries.find(item => item.entry.args.includes(dispatcher.HOOK_SEPARATOR))!;
    const result = spawnSync(process.execPath, renderArgs(entry.args, root), {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, ...entry.env },
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { additionalContext?: string };
    expect(typeof output.additionalContext).toBe('string');
    const argv = JSON.parse(output.additionalContext!) as string[];
    expect(argv).toEqual([
      resolve(root, 'scripts', 'copilot', 'dispatch.cjs'),
      ...renderArgs(entry.args.slice(3), root),
    ]);
  });
});

describe('why the Claude command form must never reach Copilot', () => {
  it('copilot/hooks.json has no shell command fields', () => {
    for (const { event, entry } of allEntries) {
      for (const field of ['command', 'powershell', 'bash']) expect(entry, event).not.toHaveProperty(field);
    }
  });

  it.skipIf(!pwshAvailable())('pwsh splits the upstream command form under a spaced root', () => {
    const root = mkdtempSync(join(tmpdir(), 'omg pwsh split '));
    tempRoots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'run.cjs'), "process.stdout.write('PROBE_REACHED');\n");
    writeFileSync(join(root, 'scripts', 'x.mjs'), '');
    const runPwsh = (command: string) => spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 30_000 },
    );

    const upstreamForm = `node "${ROOT_TOKEN}"/scripts/run.cjs "${ROOT_TOKEN}"/scripts/x.mjs`;
    expect(source.hooks.Stop[0].hooks[0].command.startsWith('node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ')).toBe(true);
    const split = runPwsh(upstreamForm.split(ROOT_TOKEN).join(root));
    expect(split.stdout).not.toContain('PROBE_REACHED');

    // Whole-path quoting (rejected option a) would work, at ~0.5 s of pwsh per hook.
    const quoted = runPwsh(`node "${root}/scripts/run.cjs" "${root}/scripts/x.mjs"`);
    expect(quoted.stdout).toContain('PROBE_REACHED');
  }, 60_000);
});
