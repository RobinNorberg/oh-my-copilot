import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import setup, { snapshot } from './global-state-guard.js';

const REAL = '0f8fad5b-d9cb-469f-a165-70867728950e';
const JOB = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function put(path: string, content = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('global state guard', () => {
  let repo: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omg-state-guard-')));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('snapshots fixture sessions only: UUID sessions, session-end runs/, discovery and lock files are real state', () => {
    put(join(repo, '.omg', 'state', 'sessions', 'fixture-sess', 'ralph-state.json'));
    put(join(repo, '.omg', 'state', 'sessions', REAL, 'ralph-state.json'));
    put(join(repo, '.omc', 'sessions', 'fixture-sess.json'));
    put(join(repo, '.omc', 'sessions', `${REAL}.json`));
    const jobs = join(repo, '.omg', 'state', 'session-end-jobs');
    put(join(jobs, 'fixture-sess.json'));
    put(join(jobs, `${REAL}.json`));
    put(join(jobs, `${REAL}.json.lock`));
    put(join(jobs, 'discovery.json'));
    put(join(jobs, 'discovery.json.lock'));
    put(join(jobs, 'runs', JOB, 'cleanup', '1', 'nonce', 'result.json'));

    expect([...snapshot(repo).keys()].sort()).toEqual([
      '.omc/sessions/fixture-sess.json',
      '.omg/state/session-end-jobs/fixture-sess.json',
      '.omg/state/sessions/fixture-sess',
    ]);
  });

  it('the teardown fails on a new or changed fixture session and passes on real state alone', () => {
    put(join(repo, '.omg', 'state', 'sessions', 'old-fixture', 'a.json'));
    process.chdir(repo);
    const cleanTeardown = setup();
    put(join(repo, '.omg', 'state', 'sessions', REAL, 'a.json'));
    put(join(repo, '.omg', 'state', 'session-end-jobs', 'runs', JOB, 'result.json'));
    expect(() => cleanTeardown()).not.toThrow();

    const leakTeardown = setup();
    put(join(repo, '.omg', 'state', 'sessions', 'old-fixture', 'b.json'));
    put(join(repo, '.omg', 'state', 'sessions', 'new-fixture', 'a.json'));
    expect(leakTeardown).toThrow(/fixture session state into the repository's own state dir \(2\)/);
    expect(leakTeardown).toThrow(/\.omg\/state\/sessions\/old-fixture/);
    expect(leakTeardown).toThrow(/\.omg\/state\/sessions\/new-fixture/);
  });
});
