/**
 * A real git repository with no origin for the local (offline) forge tests of
 * setup, check, board and enqueue: the backlog is real files, git runs for
 * real, and every spawn is recorded so a test can assert no gh, az or
 * copilot ran. OMC_HOME is pointed at a temp dir, so the forge stateDir and
 * the mirror path never touch the real ~/.omg.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import { createForge } from '../../../forge/index.js';
import { defaultExec, type Exec } from '../../../ship/exec.js';
import type { FactoryCheckDeps } from '../cli.js';

export interface LocalRepo {
  root: string;
  home: string;
  calls: Array<{ cmd: string; args: string[] }>;
  exec: Exec;
  out: string[];
  err: string[];
}

const run = (root: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
};

/** `git init -b main` with one commit; no origin. */
export function localRepo(): LocalRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-local-surface-')));
  const home = mkdtempSync(join(tmpdir(), 'omg-local-home-'));
  vi.stubEnv('OMC_HOME', home);
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 'test@example.com');
  run(root, 'config', 'user.name', 'test');
  run(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# r\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'init');
  const calls: LocalRepo['calls'] = [];
  // check/board read the toplevel from process.cwd(): answer it for this repository.
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args] });
    const cwd = args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? root : opts?.cwd;
    return defaultExec(cmd, args, { ...opts, ...(cwd ? { cwd } : {}) });
  };
  return { root, home, calls, exec, out: [], err: [] };
}

export function writeFile(repo: LocalRepo, path: string, text: string): void {
  const file = join(repo.root, ...path.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

export function commitAll(repo: LocalRepo, message = 'change'): void {
  run(repo.root, 'add', '-A');
  run(repo.root, 'commit', '-q', '-m', message);
}

/** The project config of a local-forge repository (what `setup --forge local` writes). */
export const LOCAL_PROJECT_CONFIG = { factory: { forge: { kind: 'local' }, intake: { source: { type: 'local-backlog' } } } };

export function backlogItem(title: string, state: 'open' | 'closed' = 'open', extra = ''): string {
  return `---\ntitle: ${JSON.stringify(title)}\nstate: ${state}\n---\n${extra}Do it.\n\n## Acceptance\n- [ ] \`npm test\` passes\n`;
}

export function checkDeps(repo: LocalRepo, project: unknown = LOCAL_PROJECT_CONFIG): FactoryCheckDeps {
  return {
    exec: repo.exec,
    base: () => 'main',
    trustedUser: () => ({ ship: { trustedBases: ['main'] } }),
    projectConfig: () => project,
    createForge,
    isTTY: () => false,
    confirm: async () => false,
    out: (line) => repo.out.push(line),
    err: (line) => repo.err.push(line),
  };
}

/** Every spawned program, by base name: the offline surfaces run git only. */
export function programs(repo: LocalRepo): string[] {
  return [...new Set(repo.calls.map((c) => c.cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')))];
}
