/**
 * Fork (psmux): createTeamSession / killTeamSession / ownership against a
 * psmux-shaped fake. The fake sits behind child_process, so the real exec
 * layer translation (-S <namespace path> -> -L <ns>) is exercised.
 *
 * psmux 3.3.8 traits modelled: constant `#{socket_path}`, one server pid per
 * session, pane ids per server (colliding across sessions), TAB printed as a
 * space in `new-session -P -F` output, `if-shell` always taking the false
 * branch, no server left by `start-server`, and a per-namespace warm server
 * that only `kill-server` removes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSession { id: string; name: string; pid: number; panes: string[]; nextPane: number }
interface FakeNamespace { sessions: FakeSession[]; warm: boolean }

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  namespaces: new Map<string, { sessions: Array<{ id: string; name: string; pid: number; panes: string[]; nextPane: number }>; warm: boolean }>(),
  alive: new Map<number, string>(),
  nextPid: 5000,
  failOn: null as null | ((argv: string[]) => boolean),
}));

const PSMUX_DEFAULT_SOCKET = 'C:\\Users\\fake\\.psmux/default';

function namespace(name: string): FakeNamespace {
  let ns = fake.namespaces.get(name);
  if (!ns) {
    ns = { sessions: [], warm: false };
    fake.namespaces.set(name, ns);
  }
  return ns;
}

function startSession(nsName: string, name: string, paneCount = 1): FakeSession {
  const pid = fake.nextPid++;
  fake.alive.set(pid, `win32:${pid * 1000 + 7}`);
  const session: FakeSession = { id: '$0', name, pid, panes: [], nextPane: 1 };
  for (let i = 0; i < paneCount; i++) session.panes.push(`%${session.nextPane++}`);
  const ns = namespace(nsName);
  ns.sessions.push(session);
  ns.warm = true;
  return session;
}

function noServer(nsName: string): Error {
  return Object.assign(new Error(`Command failed: tmux`), {
    stdout: '',
    stderr: `psmux: no server running on session '${nsName}__default'\n`,
  });
}

function optionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function findSession(ns: FakeNamespace, target: string | undefined): FakeSession | undefined {
  if (!target) return ns.sessions.at(-1);
  if (target.startsWith('%')) return [...ns.sessions].reverse().find(s => s.panes.includes(target));
  if (target.startsWith('$')) return [...ns.sessions].reverse().find(s => s.id === target);
  const name = target.replace(/^=/, '').split(':')[0];
  return ns.sessions.find(s => s.name === name);
}

function render(format: string, session: FakeSession, pane: string): string {
  return format
    .replace(/#\{pane_id\}/g, pane)
    .replace(/#\{pid\}/g, String(session.pid))
    .replace(/#\{socket_path\}/g, PSMUX_DEFAULT_SOCKET)
    .replace(/#\{session_id\}/g, session.id)
    .replace(/#\{session_name\}/g, session.name)
    .replace(/#\{window_width\}/g, '200')
    .replace(/#\{window_id\}/g, '@1')
    .replace(/#\{window_index\}/g, '0')
    .replace(/#\{pane_dead\}/g, '0')
    .replace(/#\{pane_current_command\}/g, 'cmd')
    .replace(/#S/g, session.name)
    .replace(/#I/g, '0');
}

function runFakePsmux(argvIn: string[]): string {
  fake.calls.push([...argvIn]);
  let nsName = 'default';
  let argv = argvIn;
  if (argv[0] === '-L') {
    nsName = argv[1]!;
    argv = argv.slice(2);
  } else if (argv[0] === '-S') {
    // psmux accepts -S but ignores it: the default namespace answers.
    argv = argv.slice(2);
  }
  if (fake.failOn?.(argv)) throw Object.assign(new Error('Command failed: boom'), { stdout: '', stderr: 'boom' });
  const ns = namespace(nsName);
  const command = argv[0];
  const format = optionValue(argv, '-F');
  switch (command) {
    case '-V':
      return 'tmux 3.3.8 / psmux 3.3.8\n';
    case 'start-server':
      return '';
    case 'ls':
    case 'list-sessions':
      return ns.sessions.map(s => (format ? render(format, s, s.panes[0] ?? '') : `${s.name}: 1 windows`) + '\n').join('');
    case 'new-session': {
      const session = startSession(nsName, optionValue(argv, '-s') ?? 'unnamed');
      // psmux prints TAB as a space in -P output.
      return format ? `${render(format, session, session.panes[0]!).replace(/\t/g, ' ')}\n` : '';
    }
    case 'kill-server':
      if (ns.sessions.length === 0 && !ns.warm) throw noServer(nsName);
      for (const s of ns.sessions) fake.alive.delete(s.pid);
      ns.sessions = [];
      ns.warm = false;
      return '';
    case 'if-shell':
      // The PowerShell condition is always mangled on psmux 3.3.8.
      return `${String(argv.at(-1)).replace(/^display-message -p /, '').replace(/'/g, '')}\n`;
    default:
      break;
  }
  if (ns.sessions.length === 0) throw noServer(nsName);
  const target = optionValue(argv, '-t');
  const session = findSession(ns, target);
  switch (command) {
    case 'display-message': {
      if (!session) throw Object.assign(new Error('Command failed'), { stdout: '', stderr: `can't find ${target}` });
      const pane = target?.startsWith('%') ? target : session.panes[0]!;
      return `${render(String(argv.at(-1)), session, pane)}\n`;
    }
    case 'split-window': {
      if (!session) throw Object.assign(new Error('Command failed'), { stdout: '', stderr: `can't find ${target}` });
      const pane = `%${session.nextPane++}`;
      session.panes.push(pane);
      return format ? `${render(format, session, pane)}\n` : '';
    }
    case 'list-panes': {
      if (!session) throw Object.assign(new Error('Command failed'), { stdout: '', stderr: `can't find ${target}` });
      return session.panes.map(pane => `${render(format ?? '#{pane_id}', session, pane)}\n`).join('');
    }
    case 'list-windows':
      return ns.sessions.map(s => `${render(format ?? '#{window_id}', s, s.panes[0] ?? '')}\n`).join('');
    case 'kill-session':
      // Like psmux, an unmatched id is still exit 0.
      if (session) {
        fake.alive.delete(session.pid);
        ns.sessions = ns.sessions.filter(s => s !== session);
      }
      return '';
    case 'kill-window': {
      // Each fake session has exactly one window (@1).
      const owner = ns.sessions.at(-1);
      if (owner && target === '@1') {
        fake.alive.delete(owner.pid);
        ns.sessions = ns.sessions.filter(s => s !== owner);
      }
      return '';
    }
    case 'kill-pane':
      if (session && target) session.panes = session.panes.filter(p => p !== target);
      return '';
    default:
      return '';
  }
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_command: string, argv: string[], options: unknown, callback?: (error: Error | null, result?: unknown) => void) => {
      const cb = typeof options === 'function' ? options as typeof callback : callback;
      try {
        // Resolve like the real execFile's custom promisify ({ stdout, stderr }).
        cb?.(null, { stdout: runFakePsmux(argv), stderr: '' });
      } catch (error) {
        cb?.(error as Error);
      }
      return {} as never;
    }),
    execFileSync: vi.fn((_command: string, argv: string[]) => runFakePsmux(argv)),
  };
});

// The adapter only ever runs on Windows and derives its namespace directory
// from os.homedir() at import time; give it a Windows-shaped home so the suite
// does not depend on the host OS (a POSIX home such as /home/runner would
// yield a drive-less `\home\runner\.psmux\...` path under the mocked win32).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => 'C:\\Users\\runner' };
});

vi.mock('../../platform/executable-resolution.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../platform/executable-resolution.js')>(),
  resolveExecutable: vi.fn(() => 'C:\\psmux\\tmux.exe'),
}));

vi.mock('../team-owner-epoch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../team-owner-epoch.js')>();
  return {
    ...actual,
    currentStrictProcessStartIdentity: vi.fn((pid: number = process.pid) => (
      pid === process.pid ? 'win32:1' : fake.alive.get(pid) ?? null
    )),
    observeProcessIdentity: vi.fn((record: { pid: number; process_started_at: string }) => {
      const ticks = fake.alive.get(record.pid);
      if (!ticks) return 'dead';
      return ticks === record.process_started_at ? 'matching' : 'unknown';
    }),
  };
});

vi.mock('../runtime-owner-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime-owner-client.js')>(),
  resolveRuntimeCliPath: vi.fn(() => { throw new Error('guard runtime must not be resolved on psmux'); }),
}));

import { win32 } from 'path';
import { PSMUX_NS_DIR, __setPsmuxDetectionForTests, psmuxNamespaceOf } from '../psmux-adapter.js';
import {
  TeamSessionCreationError,
  createTeamSession,
  killTeamSession,
  verifyTeamTargetOwnership,
} from '../tmux-session.js';
import type { MailboxNotificationTarget } from '../mailbox-notification-guard.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.stubEnv('MSYSTEM', '');
  vi.stubEnv('MINGW_PREFIX', '');
  vi.stubEnv('TMUX', '');
  vi.stubEnv('TMUX_PANE', '');
  vi.stubEnv('PSMUX_SESSION', '');
  vi.stubEnv('CMUX_SURFACE_ID', '');
  vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
  vi.stubEnv('OMC_TEAM_SHELL_READY_TIMEOUT_MS', '200');
  __setPsmuxDetectionForTests(true);
  fake.calls.length = 0;
  fake.namespaces.clear();
  fake.alive.clear();
  fake.nextPid = 5000;
  fake.failOn = null;
  // The user's own default-namespace session; its pane ids collide with ours.
  startSession('default', 'user', 3);
});

afterEach(() => {
  __setPsmuxDetectionForTests(undefined);
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
});

function nsOf(socketPath: string): string {
  const ns = psmuxNamespaceOf(socketPath);
  if (!ns) throw new Error(`not a namespace path: ${socketPath}`);
  return ns;
}

function commandsIn(ns: string): string[][] {
  return fake.calls.filter(argv => argv[0] === '-L' && argv[1] === ns).map(argv => argv.slice(2));
}

describe('createTeamSession on psmux', () => {
  it('creates a detached session in a fresh private namespace without keepalive or if-shell', async () => {
    const session = await createTeamSession('tm', 1, 'C:\\repo');

    expect(session.sessionMode).toBe('detached-session');
    expect(session.workerPaneIds).toHaveLength(1);
    const identity = session.tmuxServerIdentity!;
    expect(win32.dirname(identity.socket_path)).toBe(PSMUX_NS_DIR);
    const ns = nsOf(identity.socket_path);
    const created = fake.namespaces.get(ns)!.sessions[0]!;
    expect(identity.server_pid).toBe(created.pid);
    expect(identity.process_started_at).toBe(`win32:${created.pid * 1000 + 7}`);
    expect(session.sessionName).toBe(`${created.name}:0`);
    expect(session.leaderPaneId).toBe('%1');
    expect(session.workerPaneIds).toEqual(['%2']);

    // Apart from the `tmux -V` availability probe, every call is
    // namespace-bound; nothing reaches the default namespace.
    expect(fake.calls.filter(argv => argv[0] !== '-V').every(argv => argv[0] === '-L' && argv[1] === ns)).toBe(true);
    const flat = fake.calls.flat();
    expect(flat).not.toContain('start-server');
    expect(flat).not.toContain('exit-empty');
    expect(flat).not.toContain('if-shell');
    // The emptiness check precedes creation.
    expect(commandsIn(ns)[0]).toEqual(['ls']);
    expect(commandsIn(ns)[1]![0]).toBe('new-session');
    expect(fake.namespaces.get('default')!.sessions.map(s => s.name)).toEqual(['user']);
  });

  it('stays detached when launched inside psmux', async () => {
    vi.stubEnv('TMUX', 'C:\\Users\\fake\\.psmux/default,1,0');
    vi.stubEnv('TMUX_PANE', '%1');
    vi.stubEnv('PSMUX_SESSION', 'user');

    const session = await createTeamSession('tm', 1, 'C:\\repo');

    expect(session.sessionMode).toBe('detached-session');
    expect(nsOf(session.tmuxServerIdentity!.socket_path)).not.toBe('default');
    expect(fake.calls.some(argv => argv[0] !== '-L' && argv[0] !== '-V')).toBe(false);
    expect(fake.namespaces.get('default')!.sessions[0]!.panes).toEqual(['%1', '%2', '%3']);
  });

  it('disposes the namespace and reports verified cleanup when a step after new-session fails', async () => {
    fake.failOn = argv => argv[0] === 'split-window';

    const error = await createTeamSession('tm', 1, 'C:\\repo').catch(e => e);

    expect(error).toBeInstanceOf(TeamSessionCreationError);
    expect((error as TeamSessionCreationError).cleanupStatus).toBe('verified');
    expect(String((error as Error).message)).not.toContain('tmux_creation_cleanup_unverified');
    const ns = [...fake.namespaces.keys()].find(name => name.startsWith('omg-'))!;
    expect(commandsIn(ns).map(argv => argv[0])).toEqual(expect.arrayContaining(['kill-session', 'kill-server']));
    expect(fake.namespaces.get(ns)).toEqual({ sessions: [], warm: false });
    expect(fake.namespaces.get('default')!.sessions).toHaveLength(1);
  });

  it('disposes the namespace when new-session itself fails', async () => {
    fake.failOn = argv => argv[0] === 'new-session';

    const error = await createTeamSession('tm', 1, 'C:\\repo').catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('tmux_creation_cleanup_unverified');
    const ns = [...fake.namespaces.keys()].find(name => name.startsWith('omg-'))!;
    expect(commandsIn(ns).map(argv => argv[0])).toEqual(['ls', 'new-session', 'kill-server', 'ls']);
  });
});

describe('killTeamSession on psmux', () => {
  it('kills the session, then the namespace server (warm server included)', async () => {
    const session = await createTeamSession('tm', 1, 'C:\\repo');
    const ns = nsOf(session.tmuxServerIdentity!.socket_path);
    fake.calls.length = 0;

    const cleaned = await killTeamSession(session.sessionName, session.workerPaneIds, session.leaderPaneId, {
      sessionMode: session.sessionMode,
      tmuxServerIdentity: session.tmuxServerIdentity,
    });

    expect(cleaned).toBe(true);
    const commands = commandsIn(ns).map(argv => argv[0]);
    expect(commands.indexOf('kill-session')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('kill-server')).toBeGreaterThan(commands.indexOf('kill-session'));
    expect(commands.at(-1)).toBe('ls');
    expect(fake.namespaces.get(ns)).toEqual({ sessions: [], warm: false });
    expect(fake.calls.every(argv => argv[0] === '-L' && argv[1] === ns)).toBe(true);
  });

  it('ends the namespace when runtime shutdown cleans the owned session:0 window', async () => {
    const session = await createTeamSession('tm', 1, 'C:\\repo');
    const ns = nsOf(session.tmuxServerIdentity!.socket_path);
    fake.calls.length = 0;

    // runtime-v2 shutdown maps an owned `name:0` target to dedicated-window.
    const cleaned = await killTeamSession(session.sessionName, [], session.leaderPaneId, {
      sessionMode: 'dedicated-window',
      tmuxServerIdentity: session.tmuxServerIdentity,
    });

    expect(cleaned).toBe(true);
    const commands = commandsIn(ns).map(argv => argv[0]);
    expect(commands).toContain('kill-window');
    expect(commands.indexOf('kill-server')).toBeGreaterThan(commands.indexOf('kill-window'));
    expect(fake.namespaces.get(ns)).toEqual({ sessions: [], warm: false });
  });

  it('ends a namespace whose session server already died (warm server left)', async () => {
    const session = await createTeamSession('tm', 1, 'C:\\repo');
    const ns = nsOf(session.tmuxServerIdentity!.socket_path);
    const nsState = fake.namespaces.get(ns)!;
    fake.alive.delete(nsState.sessions[0]!.pid);
    nsState.sessions = [];
    expect(nsState.warm).toBe(true);

    expect(await killTeamSession(session.sessionName, [], session.leaderPaneId, {
      sessionMode: 'dedicated-window',
      tmuxServerIdentity: session.tmuxServerIdentity,
    })).toBe(true);
    expect(fake.namespaces.get(ns)).toEqual({ sessions: [], warm: false });
  });

  it('never sends a destructive command to a same-name successor namespace', async () => {
    const first = await createTeamSession('tm', 1, 'C:\\repo');
    expect(await killTeamSession(first.sessionName, first.workerPaneIds, first.leaderPaneId, {
      sessionMode: first.sessionMode,
      tmuxServerIdentity: first.tmuxServerIdentity,
    })).toBe(true);
    const successor = await createTeamSession('tm', 1, 'C:\\repo');
    const successorNs = nsOf(successor.tmuxServerIdentity!.socket_path);
    expect(successorNs).not.toBe(nsOf(first.tmuxServerIdentity!.socket_path));
    fake.calls.length = 0;

    // Replaying the old identity's cleanup.
    await killTeamSession(first.sessionName, first.workerPaneIds, first.leaderPaneId, {
      sessionMode: first.sessionMode,
      tmuxServerIdentity: first.tmuxServerIdentity,
    });

    expect(commandsIn(successorNs)).toEqual([]);
    expect(fake.namespaces.get(successorNs)!.sessions).toHaveLength(1);
  });
});

describe('verifyTeamTargetOwnership on psmux', () => {
  it('resolves colliding pane ids only inside the team namespace', async () => {
    const session = await createTeamSession('tm', 1, 'C:\\repo');
    const ns = nsOf(session.tmuxServerIdentity!.socket_path);
    const target = (paneId: string) => ({
      provider: 'tmux',
      providerTarget: session.sessionName,
      recipient: 'worker',
      recipientRole: 'worker',
      paneId,
      tmuxServerIdentity: session.tmuxServerIdentity,
    }) as MailboxNotificationTarget;
    fake.calls.length = 0;

    // %2 exists in both the user's default-namespace session and the team.
    expect((await verifyTeamTargetOwnership(target('%2'))).kind).toBe('owned');
    // %3 exists only in the user's session.
    expect((await verifyTeamTargetOwnership(target('%3'))).kind).toBe('foreign');
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every(argv => argv[0] === '-L' && argv[1] === ns)).toBe(true);
  });
});
