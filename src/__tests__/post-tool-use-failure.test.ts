import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const NODE = process.execPath;
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'post-tool-use-failure.mjs');
const TEST_TMP_ROOT = join(REPO_ROOT, '.tmp-post-tool-use-failure-tests');

function runHook(input: Record<string, unknown>) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      NODE_ENV: 'test',
    },
    timeout: 15000,
  }).trim();

  return JSON.parse(raw) as {
    continue: boolean;
    suppressOutput?: boolean;
    hookSpecificOutput?: {
      hookEventName?: string;
      additionalContext?: string;
    };
  };
}

describe('post-tool-use-failure.mjs', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeRepoLocalTempDir() {
    mkdirSync(TEST_TMP_ROOT, { recursive: true });
    const cwd = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
    tempDirs.push(cwd);
    return cwd;
  }

  it('suppresses optional omx startup read method-not-found noise', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'mcp__omx_state__state_read',
      tool_input: { mode: 'deep-interview' },
      error: 'Method not found',
      cwd,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(errorPath)).toBe(false);
  });

  it('preserves real failures for the same optional startup reads', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'mcp__omx_state__state_read',
      tool_input: { mode: 'deep-interview' },
      error: 'Connection refused',
      cwd,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).not.toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      'Tool "mcp__omx_state__state_read" failed.',
    );

    expect(existsSync(errorPath)).toBe(true);
    const errorState = JSON.parse(readFileSync(errorPath, 'utf-8')) as {
      tool_name: string;
      error: string;
      retry_count: number;
    };
    expect(errorState.tool_name).toBe('mcp__omx_state__state_read');
    expect(errorState.error).toBe('Connection refused');
    expect(errorState.retry_count).toBe(1);
  });
});
