import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactTokens } from '../notifications/redact.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'copilot', 'notification.mjs');
type Dispatch = { event: string; data: Record<string, unknown> };
type Hook = {
  notificationFor(payload: unknown, env?: NodeJS.ProcessEnv, redact?: (s: string) => string): Dispatch | null;
  cooldownPath(stateRoot: string, sessionId: string): string | null;
  takeCooldown(path: string, type: string, question: string, nowMs?: number, windowMs?: number): boolean;
  QUESTION_MAX_CHARS: number;
  COOLDOWN_MS: number;
};
const hook = import(pathToFileURL(SCRIPT).href) as Promise<Hook>;

// Payloads as Copilot CLI 1.0.91 sent them to a probe hook (SDK session, 2026-10-11).
const permissionPrompt = {
  sessionId: '5c4f4cb2-ebde-4e8a-8275-dffbae112deb',
  timestamp: 1791715263465,
  cwd: 'C:\\proj',
  message: 'Run command: ping -n 3 127.0.0.1',
  title: 'Permission needed',
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
};
const shellCompleted = {
  ...permissionPrompt,
  message: 'Shell command "Run loopback ping in the background" (shellId: 0) has completed successfully.',
  title: 'Run loopback ping in the background',
  notification_type: 'shell_completed',
};
const elicitation = { ...permissionPrompt, notification_type: 'elicitation_dialog', title: 'Question', message: 'Which database?' };

const tmpDirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'omg-notif-')); tmpDirs.push(d); return d; };
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('copilot notification hook', () => {
  it('turns a permission prompt into a non-replyable ask-user-question notification', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(permissionPrompt, { OMC_NOTIFY_PROFILE: 'work' }, redactTokens)).toEqual({
      event: 'ask-user-question',
      data: {
        sessionId: permissionPrompt.sessionId,
        projectPath: 'C:\\proj',
        question: 'Permission needed: Run command: ping -n 3 127.0.0.1',
        profileName: 'work',
        replyable: false,
      },
    });
  });

  it.each([
    ['curl -H "Authorization: Bearer eyJhbGciOi.secret" https://api.example.com', 'eyJhbGciOi.secret'],
    ['git push https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git', '16C7e42F292c6912E7710c838347Ae178B4a'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 cp a s3://b', 'wJalrXUtnFEMI/K7MDENG'],
  ])('redacts the command line before the notify path: %s', async (command, secret) => {
    const { notificationFor } = await hook;
    const question = String(notificationFor({ ...permissionPrompt, message: `Run command: ${command}` }, {}, redactTokens)?.data.question);
    expect(question).not.toContain(secret);
    expect(question).toContain('****');
    expect(question.startsWith(`Permission needed: Run command: ${command.split(/[ =]/)[0]}`)).toBe(true);
  });

  it('caps the text, keeping the title and the command binary', async () => {
    const { notificationFor, QUESTION_MAX_CHARS } = await hook;
    const question = String(notificationFor({ ...permissionPrompt, message: `Run command: node ${'x'.repeat(500)}` }, {}, redactTokens)?.data.question);
    expect(question).toHaveLength(QUESTION_MAX_CHARS);
    expect(question.startsWith('Permission needed: Run command: node xxx')).toBe(true);
    expect(question.endsWith('…')).toBe(true);
  });

  it('fails closed without a redactor', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(permissionPrompt, {})).toBeNull();
  });

  it('keeps elicitation dialogs (the ask_user tool) replyable and falls back to a generic question', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(elicitation, {}, redactTokens)?.data).not.toHaveProperty('replyable');
    const out = notificationFor({ ...elicitation, title: '', message: '' }, {}, redactTokens);
    expect(out?.data.question).toBe('User input requested');
  });

  it('ignores other types, team workers and payloads without a session', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(shellCompleted, {}, redactTokens)).toBeNull();
    expect(notificationFor({ ...permissionPrompt, notification_type: 'agent_idle' }, {}, redactTokens)).toBeNull();
    expect(notificationFor(permissionPrompt, { OMC_TEAM_WORKER: 'team/worker-1' }, redactTokens)).toBeNull();
    expect(notificationFor({ ...permissionPrompt, sessionId: undefined }, {}, redactTokens)).toBeNull();
    expect(notificationFor(null, {}, redactTokens)).toBeNull();
  });

  it('rate-limits permission prompts and dedupes identical questions per session within the window', async () => {
    const { cooldownPath, takeCooldown, COOLDOWN_MS } = await hook;
    const root = tmp();
    expect(cooldownPath(root, '../escape')).toBeNull();
    const a = cooldownPath(root, 'sess-a')!;
    const b = cooldownPath(root, 'sess-b')!;
    expect(a).toBe(join(root, 'state', 'sessions', 'sess-a', 'notification-input-cooldown.json'));
    const t0 = 1_000_000;
    expect(takeCooldown(a, 'permission_prompt', 'cmd 1', t0)).toBe(true);
    expect(takeCooldown(a, 'permission_prompt', 'cmd 2', t0 + 1_000)).toBe(false);
    expect(takeCooldown(b, 'permission_prompt', 'cmd 1', t0 + 1_000)).toBe(true);
    expect(takeCooldown(a, 'elicitation_dialog', 'Which?', t0 + 1_000)).toBe(true);
    expect(takeCooldown(a, 'elicitation_dialog', 'Which?', t0 + 2_000)).toBe(false);
    expect(takeCooldown(a, 'elicitation_dialog', 'Other?', t0 + 2_000)).toBe(true);
    expect(takeCooldown(a, 'permission_prompt', 'cmd 3', t0 + COOLDOWN_MS)).toBe(true);
  });

  it('exits 0 with no stdout for any input (fire and forget)', () => {
    for (const input of [JSON.stringify(shellCompleted), 'not json', '']) {
      const run = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, OMC_NOTIFY: '0' } });
      expect(run.status, input).toBe(0);
      expect(run.stdout, input).toBe('');
    }
  });

  it('resolves the dist dispatch modules for a permission prompt (OMC_NOTIFY=0, OMC_DEBUG_HOOKS=1)', () => {
    const state = tmp();
    const run = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ ...permissionPrompt, cwd: state }),
      encoding: 'utf8',
      env: { ...process.env, OMC_NOTIFY: '0', OMC_DEBUG_HOOKS: '1', OMC_STATE_DIR: state, OMC_TEAM_WORKER: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('[omg-hook] Notification: OMC_NOTIFY=0, not dispatched');
    expect(run.stderr).not.toContain('failed:');
  });
});
