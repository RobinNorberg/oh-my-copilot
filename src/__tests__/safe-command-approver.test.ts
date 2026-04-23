import { execSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'safe-command-approver.mjs');

function runApprover(input: Record<string, unknown>): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node "${SCRIPT_PATH}"`, {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: (e.stdout ?? '').trim(), exitCode: e.status ?? 1 };
  }
}

describe('safe-command-approver hook', () => {
  it('auto-approves git status', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.permissionDecision).toBe('allow');
  });

  it('auto-approves npm run build', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });

  it('auto-approves dotnet test', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'dotnet test' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });

  it('auto-approves gh pr list', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr list' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });

  it('produces no output for unknown commands (defers to runtime)', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/something' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('rejects commands with shell metacharacters', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'git status && rm -rf /' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('produces no output for non-Bash tools', () => {
    const result = runApprover({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.txt', content: 'hello' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('auto-approves rg (ripgrep) read-only invocations', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'rg -n --type=ts "pattern" src/' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });

  it('auto-approves targeted vitest run', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run src/__tests__/foo.test.ts' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });

  it('auto-approves az account show', () => {
    const result = runApprover({
      tool_name: 'Bash',
      tool_input: { command: 'az account show' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).permissionDecision).toBe('allow');
  });
});
