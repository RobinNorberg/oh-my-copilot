import { describe, it, expect } from 'vitest';
import { rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutoresearchMissionContract } from '../contracts.js';
import {
  assertModeStartAllowed,
  assertResetSafeWorktree,
  buildAutoresearchInstructions,
  getAutoresearchMissionArtifactLayout,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
} from '../runtime.js';
import { readModeState, writeModeState } from '../../lib/mode-state-io.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-runtime-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

describe('getAutoresearchMissionArtifactLayout', () => {
  it('returns canonical layout paths for a given project root, slug, and run id', () => {
    const layout = getAutoresearchMissionArtifactLayout('/project', 'my-mission', 'run-001');
    expect(layout.missionRoot).toBe(join('/project', '.omc', 'autoresearch', 'my-mission'));
    expect(layout.missionSpecFile).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'mission.md'));
    expect(layout.evaluatorReferenceFile).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'evaluator.json'));
    expect(layout.runsDir).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'runs'));
    expect(layout.runDir).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'runs', 'run-001'));
    expect(layout.evaluationsDir).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'runs', 'run-001', 'evaluations'));
    expect(layout.decisionLogFile).toBe(join('/project', '.omc', 'autoresearch', 'my-mission', 'runs', 'run-001', 'decision-log.md'));
  });
});

describe('autoresearch startup exclusivity', () => {
  it('blocks startup when a session-scoped ralph state is active', async () => {
    const repo = await initRepo();
    try {
      expect(writeModeState('ralph', { active: true }, repo, 'session-a')).toBe(true);

      await expect(assertModeStartAllowed('autoresearch', repo)).rejects.toThrow(
        'Cannot start autoresearch: ralph is already active',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('blocks startup when legacy shared exclusive-mode state is active', async () => {
    const repo = await initRepo();
    try {
      expect(writeModeState('autopilot', { active: true }, repo)).toBe(true);

      await expect(assertModeStartAllowed('autoresearch', repo)).rejects.toThrow(
        'Cannot start autoresearch: autopilot is already active',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
