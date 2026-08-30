import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

import type { StatuslineStdin } from '../../hud/types.js';
import { readStdinCache, writeStdinCache } from '../../hud/stdin.js';

function makeStdin(overrides: Partial<StatuslineStdin> = {}): StatuslineStdin {
  return {
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/tmp' },
    cwd: '/tmp',
    transcript_path: '/tmp/session.jsonl',
    ...overrides,
  } as StatuslineStdin;
}

describe('HUD stdin cache path is session-scoped', () => {
  let tmpRoot: string;
  let originalCwd: string;
  const envKeys = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-hud-stdin-cache-'));
    // Make a real git repo so getWorktreeRoot() (which shells out to git
    // rev-parse) deterministically returns tmpRoot instead of leaking into
    // the surrounding workspace.
    execSync('git init --quiet', { cwd: tmpRoot });
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes to a session-scoped path when CLAUDE_SESSION_ID is set', () => {
    process.env.CLAUDE_SESSION_ID = 'test-session-aaa';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omcp', 'state', 'sessions', 'test-session-aaa', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
    const loaded = JSON.parse(readFileSync(expected, 'utf-8')) as StatuslineStdin;
    expect(loaded.cwd).toBe(tmpRoot);
  });

  it('falls back to the legacy flat path when no session env var is set', () => {
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omcp', 'state', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
    const sessionScoped = join(tmpRoot, '.omcp', 'state', 'sessions');
    expect(existsSync(sessionScoped)).toBe(false);
  });

  it('accepts CLAUDECODE_SESSION_ID as the session id source', () => {
    process.env.CLAUDECODE_SESSION_ID = 'test-session-bbb';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omcp', 'state', 'sessions', 'test-session-bbb', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
  });

  it('prevents two concurrent sessions from clobbering each other', () => {
    process.env.CLAUDE_SESSION_ID = 'session-alpha';
    const alpha = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/alpha.jsonl` });
    writeStdinCache(alpha);

    process.env.CLAUDE_SESSION_ID = 'session-beta';
    const beta = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/beta.jsonl` });
    writeStdinCache(beta);

    // Reading back from each session must return its own snapshot.
    process.env.CLAUDE_SESSION_ID = 'session-alpha';
    expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/alpha.jsonl`);

    process.env.CLAUDE_SESSION_ID = 'session-beta';
    expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/beta.jsonl`);
  });

  it('readStdinCache ignores a legacy flat file when a session id is set', () => {
    const stateDir = join(tmpRoot, '.omcp', 'state');
    mkdirSync(stateDir, { recursive: true });
    // Simulate a stale legacy cache written by an older build.
    const legacy = makeStdin({ cwd: '/legacy/cwd' });
    writeFileSync(join(stateDir, 'hud-stdin-cache.json'), JSON.stringify(legacy));

    process.env.CLAUDE_SESSION_ID = 'fresh-session';
    // Without a session file yet, read should miss rather than return the
    // legacy (cross-session) value.
    expect(readStdinCache()).toBeNull();
  });

  // Unsafe / malformed session ids must NOT escape the session-scoped directory.
  // `getStdinCachePath` delegates validation to the shared `getSessionStateDir`
  // helper (which calls `validateSessionId`), so any id that fails the repo-wide
  // contract should fall back to the legacy flat path rather than being
  // interpolated into a filesystem path.
  it.each([
    ['path traversal with ..', '../../../etc/passwd'],
    ['path traversal with parent only', '..'],
    ['forward slash', 'foo/bar'],
    ['backslash (Windows traversal)', 'foo\\bar'],
    ['leading underscore (regex first-char violation)', '_foo'],
    ['overlong id (>256 chars)', 'a'.repeat(300)],
  ])('rejects unsafe CLAUDE_SESSION_ID (%s) and falls back to the legacy path', (_label, unsafeId) => {
    process.env.CLAUDE_SESSION_ID = unsafeId;
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    // Nothing may be written to the session-scoped tree at all.
    const sessionsDir = join(tmpRoot, '.omcp', 'state', 'sessions');
    expect(existsSync(sessionsDir)).toBe(false);

    // And in particular, nothing outside the intended state dir.
    const etcProbe = join(tmpRoot, 'etc', 'passwd');
    expect(existsSync(etcProbe)).toBe(false);

    // Legacy flat fallback should be populated instead.
    const legacy = join(tmpRoot, '.omcp', 'state', 'hud-stdin-cache.json');
    expect(existsSync(legacy)).toBe(true);
  });

  it('treats whitespace-only CLAUDE_SESSION_ID as unset and falls back', () => {
    process.env.CLAUDE_SESSION_ID = '   ';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const sessionsDir = join(tmpRoot, '.omcp', 'state', 'sessions');
    expect(existsSync(sessionsDir)).toBe(false);
    const legacy = join(tmpRoot, '.omcp', 'state', 'hud-stdin-cache.json');
    expect(existsSync(legacy)).toBe(true);
  });

  it('falls through to CLAUDECODE_SESSION_ID when CLAUDE_SESSION_ID is empty', () => {
    // Regression: `??` alone would accept "" as defined and never consult
    // the secondary variable.
    process.env.CLAUDE_SESSION_ID = '';
    process.env.CLAUDECODE_SESSION_ID = 'secondary-session';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omcp', 'state', 'sessions', 'secondary-session', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
  });

  it('falls through to CLAUDECODE_SESSION_ID when CLAUDE_SESSION_ID is present but invalid', () => {
    // Regression: a non-empty-but-invalid primary must not silently bypass
    // a valid secondary. The previous implementation resolved the primary
    // first, then fell straight to the legacy path when validation threw,
    // never giving the secondary a chance.
    process.env.CLAUDE_SESSION_ID = '../../../etc/passwd';
    process.env.CLAUDECODE_SESSION_ID = 'valid-secondary';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expectedSecondary = join(
      tmpRoot, '.omcp', 'state', 'sessions', 'valid-secondary', 'hud-stdin-cache.json',
    );
    expect(existsSync(expectedSecondary)).toBe(true);

    // And in particular, the legacy flat path must NOT have been used —
    // otherwise concurrent sessions could still clobber each other.
    const legacy = join(tmpRoot, '.omcp', 'state', 'hud-stdin-cache.json');
    expect(existsSync(legacy)).toBe(false);

    // Safety probe: traversal from primary must not have escaped.
    const etcProbe = join(tmpRoot, 'etc', 'passwd');
    expect(existsSync(etcProbe)).toBe(false);
  });

  it('falls back to the legacy path only when every candidate is invalid', () => {
    process.env.CLAUDE_SESSION_ID = '../traverse';
    process.env.CLAUDECODE_SESSION_ID = 'foo/bar';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const legacy = join(tmpRoot, '.omcp', 'state', 'hud-stdin-cache.json');
    expect(existsSync(legacy)).toBe(true);
    const sessionsDir = join(tmpRoot, '.omcp', 'state', 'sessions');
    expect(existsSync(sessionsDir)).toBe(false);
  });
});
