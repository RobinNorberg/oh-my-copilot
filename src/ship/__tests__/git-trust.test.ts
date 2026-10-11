import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { defaultExec, guardExec } from '../exec.js';
import { loadBaseKnownFlaky, loadTrustedShipConfig, readBaseFile } from '../config.js';
import { listChangedFiles, protectedChanges } from '../merge.js';

/**
 * The trust layer against a real git: replace refs, injected git config and
 * renames, run through defaultExec (scrubbed environment) behind the guard.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe('trusted reads against a real git', () => {
  let dir: string;
  let up: string;
  let clone: string;
  let baseSha: string;
  const exec = guardExec(defaultExec);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-ship-git-'));
    up = join(dir, 'up');
    clone = join(dir, 'clone');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'dev');
    write(up, '.copilot/omg.jsonc', '{ "ship": { "allowAdminMerge": false } }\n');
    write(up, '.github/known-flaky-tests.json', '{ "tests": [] }\n');
    write(up, '.github/workflows/ci.yml', 'name: CI\n');
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'base');
    baseSha = git(up, 'rev-parse', 'HEAD');
    git(dir, 'clone', '-q', up, clone);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('H1: `git replace <config blob> <evil>` in the checkout does not change what the trusted read sees', () => {
    const good = git(clone, 'rev-parse', `${baseSha}:.copilot/omg.jsonc`);
    const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone, encoding: 'utf8', input: '{ "ship": { "allowAdminMerge": true, "advisoryChecks": ["Test"] } }\n',
    }).trim();
    const flakyGood = git(clone, 'rev-parse', `${baseSha}:.github/known-flaky-tests.json`);
    const flakyEvil = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone, encoding: 'utf8', input: '{ "tests": [{ "file": "src/a.test.ts", "title": "anything" }] }\n',
    }).trim();
    git(clone, 'replace', good, evil);
    git(clone, 'replace', flakyGood, flakyEvil);
    try {
      // The attack works against a plain read...
      expect(git(clone, 'show', 'origin/dev:.copilot/omg.jsonc')).toContain('"allowAdminMerge": true');
      // ...but not against the engine's.
      const config = loadTrustedShipConfig({ exec, root: clone, base: 'dev', baseSha, strict: true, user: null, project: {}, warn: () => {} });
      expect(config.allowAdminMerge).toBe(false);
      expect(config.advisoryChecks).not.toContain('Test');
      expect(config.trustedBaseCommit).toBe(baseSha);
      expect(loadBaseKnownFlaky(exec, clone, config.trustedBaseCommit, config.knownFlakyFile)).toEqual([]);
    } finally {
      git(clone, 'replace', '-d', good);
      git(clone, 'replace', '-d', flakyGood);
    }
  });

  it('a file absent at the base commit reads as null; an unknown commit throws', () => {
    expect(readBaseFile(exec, clone, baseSha, 'nope.json')).toBeNull();
    write(clone, 'untracked.json', '{}');
    try {
      expect(readBaseFile(exec, clone, baseSha, 'untracked.json')).toBeNull();
    } finally {
      rmSync(join(clone, 'untracked.json'));
    }
    expect(() => readBaseFile(exec, clone, 'e'.repeat(40), '.copilot/omg.jsonc')).toThrow(/base commit eeeeeeeeeeee is not in the local object store/);
  });

  it('H1: a base sha GitHub did not report fails closed', () => {
    const other = 'e'.repeat(40);
    expect(() => loadTrustedShipConfig({ exec, root: clone, base: 'dev', baseSha: other, strict: true, user: null, project: {}, warn: () => {} }))
      .toThrow(/refs\/remotes\/origin\/dev is [0-9a-f]{40}, but GitHub reports dev at e{40}.*fail closed/);
  });

  it('H1: injected GIT_CONFIG_* variables never reach the engine\'s git', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'ship.probe', GIT_CONFIG_VALUE_0: 'injected' });
      expect(execFileSync('git', ['config', '--get', 'ship.probe'], { cwd: clone, encoding: 'utf8' }).trim()).toBe('injected');
      const res = defaultExec('git', ['config', '--get', 'ship.probe'], { cwd: clone });
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('H3: a rename out of .github/workflows/, a non-ASCII path and 350 files are all listed', () => {
    git(clone, 'checkout', '-q', '-b', 'feat/x');
    mkdirSync(join(clone, 'docs'));
    git(clone, 'mv', '.github/workflows/ci.yml', 'docs/ci.yml');
    const nonAscii = 'src/ünïcödé-名前.ts';
    write(clone, nonAscii, 'export {};\n');
    for (let i = 0; i < 350; i++) write(clone, `src/gen/f${i}.ts`, `export const f${i} = ${i};\n`);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'move ci out of workflows');
    const head = git(clone, 'rev-parse', 'HEAD');

    // What gh pr diff --name-only showed: rename detection hides the old path.
    expect(git(clone, 'diff', '--name-only', '-M', `${baseSha}...${head}`).split('\n')).not.toContain('.github/workflows/ci.yml');

    const files = listChangedFiles(exec, clone, baseSha, head);
    expect(files).not.toBeNull();
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('docs/ci.yml');
    expect(files).toContain(nonAscii);
    expect(files).toHaveLength(353);
    expect(protectedChanges(files!)).toEqual(['.github/workflows/ci.yml']);
    // Any read failure is null (fail closed).
    expect(listChangedFiles(exec, clone, 'f'.repeat(40), head)).toBeNull();
    expect(listChangedFiles(exec, clone, 'origin/dev', head)).toBeNull();
  });
});
