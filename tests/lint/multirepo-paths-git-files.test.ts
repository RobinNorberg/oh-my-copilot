import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'ci', 'check-multirepo-paths.mjs');
const RAW_JOIN = "import { join } from 'node:path';\nexport const p = (dir: string) => join(dir, '.omg', 'state', 'x.json');\n";

describe('multirepo path gate scans git ls-files, not the folder', () => {
  let repo: string;

  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };
  const gate = () => spawnSync(process.execPath, [GATE, '--root', repo], { encoding: 'utf8', windowsHide: true });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'path-gate-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    write('.gitignore', 'scratch/\n.omc/*\n');
    write('src/ok.ts', 'export const ok = 1;\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes when the raw construction is only in ignored local files (.omc/, scratch/)', () => {
    write('.omc/handoffs/x.ts', RAW_JOIN);
    write('scratch/y.mjs', RAW_JOIN.replace(': string', ''));
    const r = gate();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails on a committed (tracked) violation', () => {
    write('src/tracked.ts', RAW_JOIN);
    expect(spawnSync('git', ['add', 'src/tracked.ts'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: repo }).status).toBe(0);
    const r = gate();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/src[\\/]tracked\.ts:\d+/);
  });

  it('still fails on an untracked, unignored source file', () => {
    write('.omc/handoffs/x.ts', RAW_JOIN);
    write('src/x.ts', RAW_JOIN);
    const r = gate();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/src[\\/]x\.ts:\d+/);
    expect(r.stderr).not.toMatch(/handoffs/);
  });
});
