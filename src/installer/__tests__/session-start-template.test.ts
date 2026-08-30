import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'templates', 'hooks', 'session-start.mjs');
const NODE = process.execPath;

describe('session-start template retired-state handling', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(join(fakeProject, '.omg', 'state'), { recursive: true });
    // Add .git so validateCwd accepts this directory as a valid workspace anchor
    mkdirSync(join(fakeProject, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runSessionStart(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...extraEnv,
      },
      timeout: 15000,
    }).trim();

    return JSON.parse(raw) as {
      continue: boolean;
      suppressOutput?: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
  }

  it('ignores retired ultrawork state from a different active session', () => {
    const now = new Date().toISOString();
    writeFileSync(
      join(fakeProject, '.omg', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: now,
        last_checked_at: now,
        original_prompt: 'Old task that should not bleed into session-b',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Old task that should not bleed into session-b');
  });

  it('keeps template session-start under budget when only a tiny omission remainder remains', () => {
    writeFileSync(
      join(fakeProject, '.omg', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-budget-owner',
        started_at: '2026-04-23T00:00:00.000Z',
        last_checked_at: '2026-04-23T00:05:00.000Z',
        original_prompt: 'budget '.repeat(520),
      }),
    );
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-copilot - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- preserve this startup guidance\n'.repeat(400)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-budget-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('compacts large OMC AGENTS guidance and caps aggregate session context', () => {
    mkdirSync(fakeProject, { recursive: true });
    const largeAgents = [
      '# oh-my-copilot - Intelligent Multi-Agent Orchestration',
      '<guidance_schema_contract>schema details</guidance_schema_contract>',
      '<operating_principles>keep this high value section</operating_principles>',
      '<agent_catalog>' + 'agent '.repeat(5000) + '</agent_catalog>',
      '<skills>' + 'skill '.repeat(5000) + '</skills>',
      '<team_compositions>' + 'team '.repeat(5000) + '</team_compositions>',
      '<verification>verify before claiming completion</verification>',
    ].join('\n\n');
    writeFileSync(join(fakeProject, 'AGENTS.md'), largeAgents);

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-large-agents',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[ROOT AGENTS.md LOADED]');
    expect(context).toContain('<operating_principles>keep this high value section</operating_principles>');
    expect(context).toContain('<verification>verify before claiming completion</verification>');
    expect(context).not.toContain('<agent_catalog>');
    expect(context).not.toContain('<skills>');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('does not restore retired ultrawork for the owning session', () => {
    writeFileSync(
      join(fakeProject, '.omg', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-owner',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Resume me',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Resume me');
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
  });

  it('does not warn for global fallback state from a different normalized project path', () => {
    mkdirSync(join(fakeHome, '.omg', 'state'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.omg', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Different project task',
        project_path: join(tempDir, 'other-project'),
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    expect(output.continue).toBe(true);
    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
  });

  it('keeps model routing override under budget for non-standard providers', () => {
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-copilot - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-bedrock-template',
      cwd: fakeProject,
    }, {
      CLAUDE_CODE_USE_BEDROCK: '1',
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[MODEL ROUTING OVERRIDE');
    expect(context).toContain('tier alias');
    expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
    expect(context).not.toContain('Do NOT pass the `model` parameter');
    expect(context).not.toContain('Omit it entirely');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
    const omcDir = join(fakeHome, '.claude', '.omg');
    mkdirSync(omcDir, { recursive: true });
    writeFileSync(
      join(omcDir, 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-visible',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v999.0.0');
    expect(output.systemMessage).toContain('/update');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
  });

  it('honors autoUpgradePrompt=false with passive systemMessage wording', () => {
    const omcDir = join(fakeHome, '.claude', '.omg');
    mkdirSync(omcDir, { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.omc-config.json'), JSON.stringify({ autoUpgradePrompt: false }));
    writeFileSync(
      join(omcDir, 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-passive',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    });

    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('To update later, run: omc update');
    expect(output.systemMessage).not.toContain('Run /update to upgrade now');
  });

});

// ==========================================================================
// E.2 — PID-aware liveness in session-start template (Wave E)
// ==========================================================================

describe('session-start template cwd validation (Wave B1)', () => {
  let tempDir: string;
  let fakeHome: string;
  let emptyCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-cwdval-'));
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    // A truly empty directory with no .omc-workspace or .git marker.
    // Keep it under fakeHome so validateCwd stops before ambient /tmp markers.
    emptyCwd = mkdtempSync(join(fakeHome, 'omc-empty-cwd-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(emptyCwd, { recursive: true, force: true });
  });

  function runSessionStartRaw(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...extraEnv,
      },
      timeout: 15000,
    });
    return {
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
      status: result.status,
    };
  }

  it('emits warning to stderr and outputs no-op JSON when cwd has no .omc-workspace or .git marker', () => {
    // emptyCwd is a real temp dir with no markers — cross-platform guaranteed
    const { stdout, stderr } = runSessionStartRaw({
      hook_event_name: 'SessionStart',
      session_id: 'session-empty-cwd',
      cwd: emptyCwd,
    });

    // Must warn on stderr
    expect(stderr).toContain('[OMC] session-start: refusing to use cwd');
    expect(stderr).toContain('no .omc-workspace or .git marker');

    // Output must be a valid JSON with continue:true and no hookSpecificOutput with state writes
    const parsed = JSON.parse(stdout) as { continue: boolean; hookSpecificOutput?: unknown };
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();

    // Must NOT have written any state files into the empty dir
    expect(existsSync(join(emptyCwd, '.omg'))).toBe(false);
  });

  it('does NOT warn or skip when cwd contains a .git directory', () => {
    const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-project-'));
    try {
      mkdirSync(join(gitProject, '.git'), { recursive: true });
      mkdirSync(join(gitProject, '.omg', 'state'), { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-git-cwd',
        cwd: gitProject,
      });

      // Should NOT emit the warning
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      // Should produce normal hook output (continue: true)
      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(gitProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd contains a .omc-workspace marker', () => {
    const wsProject = mkdtempSync(join(tmpdir(), 'omc-ws-project-'));
    try {
      writeFileSync(join(wsProject, '.omc-workspace'), '{}');
      mkdirSync(join(wsProject, '.omg', 'state'), { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-ws-cwd',
        cwd: wsProject,
      });

      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(wsProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd is a SUBDIRECTORY of a .git repo (walks up)', () => {
    const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-subdir-'));
    try {
      mkdirSync(join(gitProject, '.git'), { recursive: true });
      mkdirSync(join(gitProject, '.omg', 'state'), { recursive: true });
      const nested = join(gitProject, 'packages', 'app', 'src');
      mkdirSync(nested, { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-git-subdir',
        cwd: nested,
      });

      // A subdirectory of a real repo must be accepted, not rejected.
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(gitProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd is a nested SUBDIR whose only anchor is a .omc-workspace at an ancestor (no .git anywhere)', () => {
    const wsRoot = mkdtempSync(join(tmpdir(), 'omc-ws-ancestor-'));
    try {
      // Place .omc-workspace at the ancestor root (no .git anywhere)
      writeFileSync(join(wsRoot, '.omc-workspace'), '{}');
      // cwd is a deeply nested subdirectory — no .git, no .omc-workspace at this level
      const nested = join(wsRoot, 'packages', 'app', 'src');
      mkdirSync(nested, { recursive: true });

      const { stderr, stdout } = runSessionStartRaw(
        {
          hook_event_name: 'SessionStart',
          session_id: 'session-ws-ancestor-subdir',
          cwd: nested,
        },
        { HOME: fakeHome, USERPROFILE: fakeHome },
      );

      // validateCwd must walk up, find .omc-workspace at wsRoot, and accept
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
