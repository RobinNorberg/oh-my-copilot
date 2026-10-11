import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactTokens } from '../notifications/redact.js';
import * as srcNotifications from '../notifications/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'copilot', 'notification.mjs');
type Dispatch = { event: string; data: Record<string, unknown> };
type Hook = {
  notificationFor(payload: unknown, env?: NodeJS.ProcessEnv, redact?: (s: string) => string): Dispatch | null;
  cooldownPath(stateRoot: string, sessionId: string): string | null;
  takeCooldown(path: string, type: string, question: string, nowMs?: number, windowMs?: number): boolean;
  commandBinary(commandLine: string): string;
  permissionPromptSupported(notifications: unknown): boolean;
  runNotificationHook(env?: NodeJS.ProcessEnv, deps?: {
    readInput?: () => Promise<string>;
    load?: () => Promise<{ notifications: unknown; dispatchNotificationInBackground: (event: string, data: unknown) => void }>;
  }): Promise<void>;
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
        question: 'Permission needed: Run command: ping',
        profileName: 'work',
        replyable: false,
      },
    });
  });

  it.each([
    ['curl -H "Authorization: Bearer eyJhbGciOi.secret" https://api.example.com', 'curl'],
    ['git push https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git', 'git'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 cp a s3://b', 'aws'],
    ["$env:OPENAI_API_KEY = 'sk-live-123'; node app.js", 'node'],
    ['C:\\tools\\bin\\mysql.exe -u root -pHunter22 db', 'mysql.exe'],
    ['"/usr/local/bin/docker" login -p dockpw', 'docker'],
    ['echo hunter2 | sudo -S rm -rf /', 'echo'],
  ])('sends only the binary of a permission prompt command, never its arguments: %s', async (command, binary) => {
    const { notificationFor } = await hook;
    const question = String(notificationFor({ ...permissionPrompt, message: `Run command: ${command}` }, {}, redactTokens)?.data.question);
    expect(question).toBe(`Permission needed: Run command: ${binary}`);
  });

  it('sends title and category only for non-command permission prompts and odd binaries', async () => {
    const { notificationFor, commandBinary } = await hook;
    const q = (message: string) => notificationFor({ ...permissionPrompt, message }, {}, redactTokens)?.data.question;
    expect(q('Write file: C:\\secret\\keys.txt')).toBe('Permission needed: Write file');
    expect(q('no category here password=x')).toBe('Permission needed');
    expect(q('Run command: ghp_16C7e42F292c6912E7710c838347Ae178B4a --x')).toBe('Permission needed: Run command: ghp_****');
    expect(commandBinary('  ')).toBe('');
    expect(commandBinary('FOO=1 BAR=2 ./scripts/run.sh --flag')).toBe('run.sh');
    expect(commandBinary('<weird> x')).toBe('');
  });

  it('caps and redacts elicitation (ask_user) text', async () => {
    const { notificationFor, QUESTION_MAX_CHARS } = await hook;
    const long = String(notificationFor({ ...elicitation, message: `Use ${'x'.repeat(500)}?` }, {}, redactTokens)?.data.question);
    expect(long).toHaveLength(QUESTION_MAX_CHARS);
    expect(long.startsWith('Question: Use xxx')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    const secret = String(notificationFor({ ...elicitation, message: 'Use {"password":"hunter2"} or X-API-Key: k3y?' }, {}, redactTokens)?.data.question);
    expect(secret).not.toContain('hunter2');
    expect(secret).not.toContain('k3y');
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

  it('resolves the dist dispatch modules for a permission prompt, failing closed on a stale dist (OMC_NOTIFY=0, OMC_DEBUG_HOOKS=1)', async () => {
    const { permissionPromptSupported } = await hook;
    // The committed dist/ is rebuilt at release; until then it can predate the source.
    const distCapable = permissionPromptSupported(await import(pathToFileURL(join(REPO_ROOT, 'dist', 'notifications', 'index.js')).href));
    const state = tmp();
    const run = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ ...permissionPrompt, cwd: state }),
      encoding: 'utf8',
      env: { ...process.env, OMC_NOTIFY: '0', OMC_DEBUG_HOOKS: '1', OMC_STATE_DIR: state, OMC_TEAM_WORKER: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(distCapable
      ? '[omg-hook] Notification: OMC_NOTIFY=0, not dispatched'
      : '[omg-hook] Notification: dist/notifications predates non-replyable prompts or current redaction, permission prompt not dispatched');
    expect(run.stderr).not.toContain('failed:');
  });

  describe('fails closed on a stale dist build', () => {
    // dist/notifications as of v5.9 (before NOTIFICATION_CAPS): weaker redactor, no marker.
    const staleNotifications = { redactTokens: (text: string) => text.replace(/(Bearer\s+)\S+/gi, '$1****') };
    const run = async (payload: unknown, notifications: unknown) => {
      const { runNotificationHook } = await hook;
      const dispatch = vi.fn();
      const state = tmp();
      await runNotificationHook({}, {
        readInput: async () => JSON.stringify({ ...(payload as object), cwd: state }),
        load: async () => ({ notifications, dispatchNotificationInBackground: dispatch }),
      });
      return dispatch.mock.calls;
    };

    it('the source notify module proves both capabilities, a stale one neither', async () => {
      const { permissionPromptSupported } = await hook;
      expect(permissionPromptSupported(srcNotifications)).toBe(true);
      expect(permissionPromptSupported(staleNotifications)).toBe(false);
      expect(permissionPromptSupported({ ...staleNotifications, NOTIFICATION_CAPS: { nonReplyable: true } })).toBe(false);
      expect(permissionPromptSupported({ NOTIFICATION_CAPS: { nonReplyable: true }, redactTokens: srcNotifications.redactTokens })).toBe(true);
      expect(permissionPromptSupported({ NOTIFICATION_CAPS: { nonReplyable: true }, redactTokens: () => { throw new Error('x'); } })).toBe(false);
      expect(permissionPromptSupported(undefined)).toBe(false);
    });

    it('sends a permission prompt through a capable build, non-replyable and without arguments', async () => {
      const dispatch = await run({ ...permissionPrompt, sessionId: 'sess-capable' }, srcNotifications);
      expect(dispatch).toHaveLength(1);
      expect(dispatch[0]![0]).toBe('ask-user-question');
      expect(dispatch[0]![1]).toMatchObject({ question: 'Permission needed: Run command: ping', replyable: false });
    });

    it('sends no permission prompt through a stale build, but keeps ask_user notifications', async () => {
      expect(await run({ ...permissionPrompt, sessionId: 'sess-stale' }, staleNotifications)).toHaveLength(0);
      expect(await run({ ...permissionPrompt, sessionId: 'sess-stale2' }, { ...staleNotifications, NOTIFICATION_CAPS: { nonReplyable: true } })).toHaveLength(0);
      const ask = await run({ ...elicitation, sessionId: 'sess-stale-ask' }, staleNotifications);
      expect(ask).toHaveLength(1);
      expect(ask[0]![1]).toMatchObject({ question: 'Question: Which database?' });
    });
  });
});
