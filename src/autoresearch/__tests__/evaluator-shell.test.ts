import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AutoresearchMissionContract } from '../contracts.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { runAutoresearchEvaluator } from '../runtime.js';

const mockSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function makeContract(command: string): AutoresearchMissionContract {
  return {
    missionDir: '/repo/missions/demo',
    repoRoot: '/repo',
    missionFile: '/repo/missions/demo/mission.md',
    sandboxFile: '/repo/missions/demo/sandbox.md',
    missionRelativeDir: 'missions/demo',
    missionContent: '# Mission\n',
    sandboxContent: '---\n---\n',
    missionSlug: 'missions-demo',
    sandbox: {
      frontmatter: {},
      evaluator: { command, format: 'json' },
      body: '',
    },
  } as AutoresearchMissionContract;
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockSpawnSync.mockReset();
  mockExistsSync.mockReset();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

describe('runAutoresearchEvaluator shell portability', () => {
  it('passes the command straight to the platform shell outside Windows', async () => {
    setPlatform('linux');
    vi.stubEnv('SHELL', '/bin/bash');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '{"pass":true,"score":3}', stderr: '' });

    const record = await runAutoresearchEvaluator(makeContract('FOO=1 ./eval.sh'), '/worktree');

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'FOO=1 ./eval.sh',
      [],
      expect.objectContaining({ cwd: '/worktree', shell: true }),
    );
    expect(record.status).toBe('pass');
    expect(record.score).toBe(3);
  });

  it('runs the POSIX command through Git Bash on Windows', async () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\bin');
    mockExistsSync.mockImplementation(
      (p: string) => p.replace(/\\/g, '/') === 'C:/Program Files/Git/bin/bash.exe',
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '{"pass":true}', stderr: '' });

    const record = await runAutoresearchEvaluator(makeContract('FOO=1 ./eval.sh'), 'C:\\worktree');

    const [file, args, options] = mockSpawnSync.mock.calls[0];
    expect(String(file).replace(/\\/g, '/')).toBe('C:/Program Files/Git/bin/bash.exe');
    expect(args).toEqual(['-lc', 'FOO=1 ./eval.sh']);
    expect(options).toMatchObject({ cwd: 'C:\\worktree', shell: false });
    expect(record.status).toBe('pass');
  });

  it('reports an actionable error on Windows with no POSIX shell instead of running cmd.exe', async () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('ProgramFiles', '');
    vi.stubEnv('ProgramFiles(x86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('SystemDrive', 'C:');
    mockExistsSync.mockReturnValue(false);

    const record = await runAutoresearchEvaluator(makeContract('./eval.sh'), 'C:\\worktree');

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(record.status).toBe('error');
    expect(record.exit_code).toBeNull();
    expect(record.stderr).toContain('Git for Windows');
    expect(record.stderr).toContain('shell-neutral');
  });
});
