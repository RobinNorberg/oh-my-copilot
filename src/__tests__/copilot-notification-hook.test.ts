import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'copilot', 'notification.mjs');
type Hook = {
  notificationFor(payload: unknown, env?: NodeJS.ProcessEnv): { event: string; data: Record<string, unknown> } | null;
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

describe('copilot notification hook', () => {
  it('turns a permission prompt into the ask-user-question notification', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(permissionPrompt, { OMC_NOTIFY_PROFILE: 'work' })).toEqual({
      event: 'ask-user-question',
      data: {
        sessionId: permissionPrompt.sessionId,
        projectPath: 'C:\\proj',
        question: 'Permission needed: Run command: ping -n 3 127.0.0.1',
        profileName: 'work',
      },
    });
  });

  it('covers elicitation dialogs (the ask_user tool) and falls back to a generic question', async () => {
    const { notificationFor } = await hook;
    const out = notificationFor({ ...permissionPrompt, notification_type: 'elicitation_dialog', title: '', message: '' }, {});
    expect(out?.data.question).toBe('User input requested');
  });

  it('ignores other types, team workers and payloads without a session', async () => {
    const { notificationFor } = await hook;
    expect(notificationFor(shellCompleted, {})).toBeNull();
    expect(notificationFor({ ...permissionPrompt, notification_type: 'agent_idle' }, {})).toBeNull();
    expect(notificationFor(permissionPrompt, { OMC_TEAM_WORKER: 'team/worker-1' })).toBeNull();
    expect(notificationFor({ ...permissionPrompt, sessionId: undefined }, {})).toBeNull();
    expect(notificationFor(null, {})).toBeNull();
  });

  it('exits 0 with no stdout for any input (fire and forget)', () => {
    for (const input of [JSON.stringify(shellCompleted), 'not json', '']) {
      const run = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, OMC_NOTIFY: '0' } });
      expect(run.status, input).toBe(0);
      expect(run.stdout, input).toBe('');
    }
  });
});
