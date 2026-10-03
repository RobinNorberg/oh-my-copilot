import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

// Host-binary resolution is pinned per test: a .cmd shim (cmd.exe route) by default.
const resolution = vi.hoisted(() => ({
  resolveHostBinaryLaunch: vi.fn((binary: string) => ({ file: binary, viaCmd: true })),
}));
vi.mock('../../platform/executable-resolution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/executable-resolution.js')>();
  return { ...actual, resolveHostBinaryLaunch: resolution.resolveHostBinaryLaunch };
});

import {
  buildAutoresearchSetupPrompt,
  collectAutoresearchRepoSignals,
  runAutoresearchSetupSession,
} from '../autoresearch-setup-session.js';

describe('collectAutoresearchRepoSignals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects generic repo signals from package.json and mission examples', () => {
    const repo = mkdtempSync(join(tmpdir(), 'omc-autoresearch-signals-'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc --noEmit' } }), 'utf-8');
    mkdirSync(join(repo, 'missions', 'demo'), { recursive: true });
    writeFileSync(join(repo, 'missions', 'demo', 'sandbox.md'), '---\nevaluator:\n  command: npm run test\n  format: json\n---\n', 'utf-8');

    const signals = collectAutoresearchRepoSignals(repo);

    expect(signals.lines).toContain('package.json script test: vitest run');
    expect(signals.lines).toContain('existing mission example: missions/demo');
    expect(signals.lines).toContain('existing mission evaluator: npm run test');
  });
});

describe('buildAutoresearchSetupPrompt', () => {
  it('includes repo signals and clarification answers', () => {
    const prompt = buildAutoresearchSetupPrompt({
      repoRoot: '/repo',
      missionText: 'Improve search relevance',
      clarificationAnswers: ['Prefer evaluator based on vitest smoke tests'],
      repoSignals: { lines: ['package.json script test: vitest run'] },
    });

    expect(prompt).toContain('Mission request: Improve search relevance');
    expect(prompt).toContain('Clarification 1: Prefer evaluator based on vitest smoke tests');
    expect(prompt).toContain('package.json script test: vitest run');
  });
});

describe('runAutoresearchSetupSession', () => {
  const realPlatform = process.platform;
  // Argv-shape cases describe the POSIX branch; the win32 COMSPEC branch has its own tests.
  const onPosix = () => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  beforeEach(() => {
    vi.stubEnv('COPILOT_CLI', '');
    vi.stubEnv('COPILOT_AGENT_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.mocked(spawnSync).mockReset();
    vi.unstubAllEnvs();
  });

  it('runs a copilot .cmd shim via COMSPEC on win32 with the prompt on stdin, never argv', () => {
    vi.stubEnv('COPILOT_CLI', '1');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"missionText":"Improve launch flow","evaluatorCommand":"npm run test:run -- launch","evaluatorSource":"inferred","confidence":0.86,"slug":"launch-flow","readyToLaunch":true}',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Fix the bug\\" --allow-all-tools \\" %PATH%' });

    const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
    expect(file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', '"copilot"']);
    expect(options).toEqual(expect.objectContaining({
      windowsVerbatimArguments: true,
      input: expect.stringContaining('--allow-all-tools'),
    }));
  });

  it('spawns a native copilot.exe directly on win32 with the prompt on stdin', () => {
    vi.stubEnv('COPILOT_CLI', '1');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\bin\\copilot.exe', viaCmd: false });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"missionText":"Improve launch flow","evaluatorCommand":"npm run test:run -- launch","evaluatorSource":"inferred","confidence":0.86,"slug":"launch-flow","readyToLaunch":true}',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' });

    const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
    expect(file).toBe('C:\\bin\\copilot.exe');
    expect(args).toEqual([]);
    expect(options).toEqual(expect.objectContaining({ windowsVerbatimArguments: false, input: expect.stringContaining('\n') }));
  });

  it('spawns the Copilot CLI when the host is Copilot', () => {
    onPosix();
    vi.stubEnv('COPILOT_CLI', '1');
    vi.mocked(spawnSync).mockReturnValue({
      status: 3,
      stdout: '',
      stderr: 'bad',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(() => runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' })).toThrow(/copilot_autoresearch_setup_failed:3/);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe('copilot');
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(['-p', expect.any(String)]);
  });

  it('parses validated JSON from claude print mode', () => {
    onPosix();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"missionText":"Improve launch flow","evaluatorCommand":"npm run test:run -- launch","evaluatorSource":"inferred","confidence":0.86,"slug":"launch-flow","readyToLaunch":true}',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' });

    expect(result.slug).toBe('launch-flow');
    expect(result.readyToLaunch).toBe(true);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe('claude');
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(['-p', expect.any(String)]);
  });

  it('fails when claude returns non-zero', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 2,
      stdout: '',
      stderr: 'bad',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(() => runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' })).toThrow(/claude_autoresearch_setup_failed:2/);
  });

  it('runs claude -p via COMSPEC on win32 with the multi-line prompt on stdin (#4154)', () => {
    const originalPlatform = process.platform;
    const originalComspec = process.env.COMSPEC;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"missionText":"Improve launch flow","evaluatorCommand":"npm run test:run -- launch","evaluatorSource":"inferred","confidence":0.86,"slug":"launch-flow","readyToLaunch":true}',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' });

    const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
    expect(file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', '"claude -p"']);
    expect(options).toEqual(expect.objectContaining({
      cwd: '/repo',
      encoding: 'utf-8',
      windowsVerbatimArguments: true,
      input: expect.stringContaining('\n'),
    }));
    expect(options).not.toHaveProperty('shell');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalComspec;
  });
});
