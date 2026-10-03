import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Test fix for issue #4154: Windows no-tmux fallback should not use shell:true
// with args array, which triggers DEP0190 and breaks with Volta shims.
// Instead, host CLIs start through buildHostBinarySpawn: a native .exe is
// spawned directly with an argv array, and only a .cmd/.bat shim goes through
// COMSPEC /d /s /c with a quoteForCmd-quoted command line and
// windowsVerbatimArguments: true to prevent libuv re-quoting.

function sliceFunction(source: string, signature: string, nextMarker: string, fallbackLength: number): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf(nextMarker, start + 1);
  return source.slice(start, next > 0 ? next : start + fallbackLength);
}

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

describe('issue #4154 - Windows claude invocation fixes', () => {
  it('quoteForCmd should properly escape arguments with spaces and quotes', async () => {
    const { quoteForCmd } = await import('../../src/cli/tmux-utils.js');

    // Test cases for proper argument quoting
    expect(quoteForCmd('claude')).toBe('claude');
    expect(quoteForCmd('--version')).toBe('--version');

    // Arguments with spaces should be quoted
    expect(quoteForCmd('arg with spaces')).toBe('"arg with spaces"');

    // Arguments with quotes should be escaped
    expect(quoteForCmd('arg"with"quotes')).toBe('"arg""with""quotes"');

    // Empty string should be quoted
    expect(quoteForCmd('')).toBe('""');

    // Mixed special characters
    expect(quoteForCmd('C:\\Users\\user\\path')).toBe('C:\\Users\\user\\path');
    expect(quoteForCmd('C:\\Users\\user\\path with spaces')).toBe('"C:\\Users\\user\\path with spaces"');

    // A backslash before an embedded quote is doubled so the CRT does not read `\"`
    expect(quoteForCmd('a\\" --allow-all-tools \\"')).toBe('"a\\\\"" --allow-all-tools \\\\"""');
  });

  it('quoteForCmd should throw on multi-line strings (CR/LF) and on %', async () => {
    const { quoteForCmd } = await import('../../src/cli/tmux-utils.js');

    // Multi-line strings should throw from assertSafeCmdValue
    expect(() => quoteForCmd('line1\nline2')).toThrow();
    expect(() => quoteForCmd('line1\rline2')).toThrow();
    expect(() => quoteForCmd('%PATH%')).toThrow('cmd_argv_percent_unsupported');
  });

  it('buildHostBinarySpawn routes only .cmd shims through COMSPEC with windowsVerbatimArguments', () => {
    const code = sliceFunction(readSource('../../src/cli/tmux-utils.ts'), 'export function buildHostBinarySpawn(', '\nexport ', 1200);

    expect(code).toContain('resolveHostBinaryLaunch(binary)');
    expect(code).toContain('COMSPEC');
    expect(code).toContain("['/d', '/s', '/c'");
    expect(code).toContain('windowsVerbatimArguments: true');
    expect(code).toContain('windowsVerbatimArguments: false');
    expect(code).toContain('map(quoteForCmd)');
    expect(code).not.toMatch(/shell:/);
  });

  it('runClaudeDirect uses spawnSync through buildHostBinarySpawn on Windows', () => {
    const code = sliceFunction(readSource('../../src/cli/launch.ts'), 'function runClaudeDirect(', '\nfunction ', 2600);

    expect(code).toContain('buildHostBinarySpawn(binary, args)');
    expect(code).toContain('spawnSync(launch.command, launch.args');
    expect(code).toContain('windowsVerbatimArguments: launch.windowsVerbatimArguments');
    expect(code).toContain('9009');
    expect(code).not.toMatch(/shell:/);
  });

  it('isCopilotAvailable uses spawnSync through buildHostBinarySpawn on Windows', () => {
    const code = sliceFunction(readSource('../../src/cli/tmux-utils.ts'), 'export function isCopilotAvailable(', '\nexport ', 1200);

    expect(code).toContain("buildHostBinarySpawn(binary, ['--version'])");
    expect(code).toContain('spawnSync(launch.command, launch.args');
    expect(code).toContain('windowsVerbatimArguments: launch.windowsVerbatimArguments');
    expect(code).toContain('result.status === 0');
    expect(code).not.toMatch(/shell:/);
  });

  it('runAutoresearchSetupSession keeps the prompt on stdin on Windows for both hosts', () => {
    const source = readSource('../../src/cli/autoresearch-setup-session.ts');
    expect(source).toContain('export function runAutoresearchSetupSession(');
    const functionCode = sliceFunction(source, 'export function runAutoresearchSetupSession(', '\nexport ', 2200);
    const winBranch = functionCode.slice(
      functionCode.indexOf("if (process.platform === 'win32')"),
      functionCode.indexOf('return spawnSync(hostBinary'),
    );

    expect(winBranch).toContain("buildHostBinarySpawn(hostBinary, hostBinary === 'claude' ? ['-p'] : [])");
    expect(winBranch).toContain('input: prompt');
    expect(winBranch).toContain('windowsVerbatimArguments: launch.windowsVerbatimArguments');
    // The prompt never rides the Windows command line.
    expect(winBranch).not.toContain("'-p', prompt");
    expect(winBranch).not.toMatch(/shell:/);
  });

  it('verifies no problematic shell:true pattern with args in claude launches', async () => {
    const filesToCheck = [
      { path: '../../src/cli/launch.ts', name: 'launch.ts' },
      { path: '../../src/cli/tmux-utils.ts', name: 'tmux-utils.ts' },
      { path: '../../src/cli/autoresearch-setup-session.ts', name: 'autoresearch-setup-session.ts' },
    ];

    for (const file of filesToCheck) {
      const filePath = fileURLToPath(new URL(file.path, import.meta.url));
      const source = readFileSync(filePath, 'utf-8');

      // Check that source does not have the DEP0190-triggering pattern:
      // execFileSync/spawnSync('claude', args/[...], { shell: process.platform === 'win32' })
      // (The fork spawns the host binary through a variable, so match those too.)
      const problematicPattern = /(?:execFileSync|spawnSync)\s*\(\s*(?:['"](?:claude|copilot)['"]|binary|hostBinary)\s*,\s*(?:args|\[[\s\S]*?\])\s*,\s*{[\s\S]*?shell:\s*process\.platform\s*===\s*['"]win32['"]/;
      expect(
        problematicPattern.test(source),
        `${file.name} contains problematic shell:true pattern with args`
      ).toBe(false);
    }
  });

  it('verifies runClaudeDirect handles status 9009 (cmd.exe not found)', async () => {
    const code = sliceFunction(readSource('../../src/cli/launch.ts'), 'function runClaudeDirect(', '\nfunction ', 2600);

    // Should handle status 9009 (only meaningful on the cmd.exe route)
    expect(code).toContain('result.status === 9009');
    // Should handle ENOENT
    expect(code).toMatch(/\.code === 'ENOENT'/);
    // Should print the same error message (host binary name interpolated)
    expect(code).toContain('[omc] Error: ${binary} CLI not found in PATH.');
  });
});
