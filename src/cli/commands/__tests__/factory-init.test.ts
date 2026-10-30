import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  buildRouteTableNarrow,
  checkFactoryRoutes,
  factoryCommand,
  migrateFactoryRoutes,
  runFactoryInit,
  validateFactoryPrerequisites,
} from '../factory.js';
import { readProjectRoutes } from '../../../hooks/session-end/chain-enqueuer.js';

const tempRoots: string[] = [];

/** Isolated git repo: getOmcRoot resolves `.omc` inside it, like the real project. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-factory-init-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function seedPrerequisites(dir: string): void {
  mkdirSync(join(dir, '.omg', 'state'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n', 'utf8');
  writeFileSync(join(dir, 'GLOSSARY.md'), '---\ndocumentLanguage: en\n---\n# Glossary\n', 'utf8');
}

function routesPath(dir: string): string {
  return join(dir, '.omg', 'factory-routes.json');
}

describe('buildRouteTableNarrow', () => {
  it('is exactly the listener intake route table', () => {
    expect(buildRouteTableNarrow()).toEqual({ 'success:intake': { stage: 'harbor', skill: 'harbor' } });
  });
});

describe('retired full-pipeline template', () => {
  it('is no longer exported', async () => {
    expect('buildRouteTableFull' in (await import('../factory.js'))).toBe(false);
  });
});

describe('validateFactoryPrerequisites', () => {
  it('reports missing .omg/state/ and the yard faces, and passes when all exist', () => {
    const dir = tempDir();
    const missing = validateFactoryPrerequisites(dir);
    expect(missing).toEqual({ ok: false, missing: ['.omg/state/', 'CLAUDE.md', 'GLOSSARY.md'] });

    seedPrerequisites(dir);
    expect(validateFactoryPrerequisites(dir)).toEqual({ ok: true, missing: [] });
  });

  it('no longer requires docs/design/', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    expect(existsSync(join(dir, 'docs', 'design'))).toBe(false);
    expect(validateFactoryPrerequisites(dir).ok).toBe(true);
  });
});

describe('runFactoryInit', () => {
  it('writes the narrow starter table by default and it round-trips through the route reader', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    const result = runFactoryInit({ cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(existsSync(routesPath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
    expect(readProjectRoutes(dir)).toEqual(buildRouteTableNarrow());
  });

  it('refuses narrow: false (--no-narrow) with a pointer to docs/REFERENCE.md and writes nothing', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    const result = runFactoryInit({ cwd: dir, narrow: false });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('--no-narrow');
    expect(result.message).toContain('diagnose');
    expect(result.message).toContain('omg factory run <issue>');
    expect(result.message).toContain('docs/REFERENCE.md');
    expect(existsSync(routesPath(dir))).toBe(false);
  });

  it('refuses narrow: false even with --force and leaves an existing table untouched', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    const existing = { 'success:*': { stage: 'mine', skill: 'mine' } };
    writeFileSync(routesPath(dir), JSON.stringify(existing), 'utf8');
    const result = runFactoryInit({ cwd: dir, narrow: false, force: true });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(existing);
  });

  it('refuses to overwrite an existing table (content untouched) and --force replaces it', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    const existing = { 'success:*': { stage: 'mine', skill: 'mine' } };
    writeFileSync(routesPath(dir), JSON.stringify(existing), 'utf8');

    const refused = runFactoryInit({ cwd: dir });
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toContain('--force');
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(existing);

    const forced = runFactoryInit({ cwd: dir, force: true });
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
  });

  it('refuses without GLOSSARY.md, points at drydock, and writes nothing', () => {
    const dir = tempDir();
    seedPrerequisites(dir);
    rmSync(join(dir, 'GLOSSARY.md'));
    const result = runFactoryInit({ cwd: dir });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('GLOSSARY.md');
    expect(result.message).toContain('drydock');
    expect(result.message).not.toContain('docs/design');
    expect(existsSync(routesPath(dir))).toBe(false);
  });

  it('refuses and writes nothing when prerequisites are missing', () => {
    const dir = tempDir();
    const result = runFactoryInit({ cwd: dir });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('.omg/state/');
    expect(existsSync(routesPath(dir))).toBe(false);
  });
});

const OLD_TEMPLATE = {
  'success:intake': { stage: 'intent', skill: 'intent' },
  'success:intent': { stage: 'launch', skill: 'launch' },
  'success:launch': { stage: 'diagnose', skill: 'diagnose' },
  'failed:ci': { stage: 'diagnose', skill: 'diagnose' },
};

function writeRoutes(dir: string, table: unknown): string {
  mkdirSync(join(dir, '.omg'), { recursive: true });
  const raw = typeof table === 'string' ? table : `${JSON.stringify(table, null, 2)}\n`;
  writeFileSync(routesPath(dir), raw, 'utf8');
  return raw;
}

function backups(dir: string): string[] {
  return readdirSync(join(dir, '.omg')).filter((name) => name.startsWith('factory-routes.json.bak-'));
}

describe('checkFactoryRoutes (init --check)', () => {
  it('classifies every route of the old template with its replacement and exits 1', () => {
    const dir = tempDir();
    writeRoutes(dir, OLD_TEMPLATE);
    const result = checkFactoryRoutes(dir);
    expect(result.exitCode).toBe(1);
    expect(result.rows).toEqual([
      expect.objectContaining({ key: 'success:intake', skill: 'intent', status: 'deprecated', replacement: 'success:intake -> harbor' }),
      expect.objectContaining({ key: 'success:intent', skill: 'launch', status: 'captain', replacement: expect.stringContaining('/oh-my-copilot:launch') }),
      expect.objectContaining({ key: 'success:launch', skill: 'diagnose', status: 'retired', replacement: expect.stringContaining('omg factory heal scan') }),
      expect.objectContaining({ key: 'failed:ci', skill: 'diagnose', status: 'retired', replacement: expect.stringContaining('omg factory heal scan') }),
    ]);
    expect(result.message).toContain('success:launch');
    expect(result.message).toContain('retired');
    expect(result.message).toContain('--migrate');
  });

  it('is read-only', () => {
    const dir = tempDir();
    const raw = writeRoutes(dir, OLD_TEMPLATE);
    checkFactoryRoutes(dir);
    expect(readFileSync(routesPath(dir), 'utf8')).toBe(raw);
    expect(backups(dir)).toEqual([]);
  });

  it('exits 0 for a narrow harbor table and marks the terminal stop route', () => {
    const dir = tempDir();
    writeRoutes(dir, { 'success:intake': { stage: 'harbor', skill: 'harbor' }, 'success:*': { stage: 'done', skill: 'stop' } });
    const result = checkFactoryRoutes(dir);
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((r) => r.status)).toEqual(['ok', 'terminal']);
  });

  it('flags unknown skills, and accepts a project skill under .copilot/skills', () => {
    const dir = tempDir();
    writeRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(checkFactoryRoutes(dir).rows[0]).toMatchObject({ status: 'unknown' });
    // Unknown is reported, not a migration failure.
    expect(checkFactoryRoutes(dir).exitCode).toBe(0);
    mkdirSync(join(dir, '.copilot', 'skills', 'spec'), { recursive: true });
    writeFileSync(join(dir, '.copilot', 'skills', 'spec', 'SKILL.md'), '---\nname: spec\n---\n', 'utf8');
    expect(checkFactoryRoutes(dir).rows[0]).toMatchObject({ status: 'ok' });
  });

  it('classifies hand-edited variants by canonical name and flags entries the enqueuer ignores', () => {
    const dir = tempDir();
    writeRoutes(dir, {
      'success:*': { stage: 'next', skill: ' Diagnose ' },
      'failed:*': { stage: 'next', skill: 'oh-my-copilot:LAUNCH' },
      'success:other': { stage: 'next' },
      'failed:clear': 'diagnose',
      success: { other: { stage: 'x', skill: 'x' } },
      'failed:crash': { stage: '../evil', skill: 'harbor' },
    });
    const rows = checkFactoryRoutes(dir).rows;
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['success:*', 'retired'],
      ['failed:*', 'captain'],
      ['success:other', 'invalid'],
      ['failed:clear', 'invalid'],
      ['success', 'invalid'],
      ['failed:crash', 'invalid'],
    ]);
  });

  it('reports a missing table (exit 0) and refuses a malformed one (exit 1)', () => {
    const dir = tempDir();
    expect(checkFactoryRoutes(dir)).toMatchObject({ exitCode: 0, rows: [] });
    writeRoutes(dir, '{ not json');
    expect(checkFactoryRoutes(dir)).toMatchObject({ exitCode: 1, message: expect.stringContaining('not a JSON object') });
    writeRoutes(dir, '[]');
    expect(checkFactoryRoutes(dir).exitCode).toBe(1);
  });
});

describe('migrateFactoryRoutes (init --migrate)', () => {
  const NOW = new Date('2026-10-30T12:34:56.000Z');
  const BAK = 'factory-routes.json.bak-2026-10-30T12-34-56Z';

  it('refuses without --yes outside a TTY and writes nothing', async () => {
    const dir = tempDir();
    const raw = writeRoutes(dir, OLD_TEMPLATE);
    const result = await migrateFactoryRoutes({ cwd: dir, isTTY: false, now: NOW });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--yes');
    expect(readFileSync(routesPath(dir), 'utf8')).toBe(raw);
    expect(backups(dir)).toEqual([]);
  });

  it('refuses a symlinked routes file and leaves the link and its target untouched', async () => {
    const dir = tempDir();
    const real = join(dir, 'shared-routes.json');
    const raw = `${JSON.stringify(OLD_TEMPLATE, null, 2)}\n`;
    writeFileSync(real, raw);
    mkdirSync(join(dir, '.omg'), { recursive: true });
    try {
      symlinkSync(real, routesPath(dir), 'file');
    } catch (error) {
      // Windows without Developer Mode cannot create file symlinks.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const result = await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/is a symlink/);
    expect(lstatSync(routesPath(dir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(raw);
    expect(backups(dir)).toEqual([]);
  });

  it('rewrites the old template to the narrow table after writing a .bak of the original', async () => {
    const dir = tempDir();
    const raw = writeRoutes(dir, OLD_TEMPLATE);
    const result = await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW });
    expect(result.exitCode).toBe(0);
    expect(backups(dir)).toEqual([BAK]);
    expect(readFileSync(join(dir, '.omg', BAK), 'utf8')).toBe(raw);
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual({ 'success:intake': { stage: 'harbor', skill: 'harbor' } });
    expect(readProjectRoutes(dir)).toEqual({ 'success:intake': { stage: 'harbor', skill: 'harbor' } });
    expect(result.message).toContain(BAK);
    expect(checkFactoryRoutes(dir).exitCode).toBe(0);
  });

  it('keeps unrelated routes verbatim and drops case/prefix variants of refused skills', async () => {
    const dir = tempDir();
    const mine = { stage: 'review', skill: 'review', verify: ['npm test'] };
    writeRoutes(dir, {
      'success:*': mine,
      'failed:*': { stage: 'next', skill: ' /oh-my-copilot:Diagnose' },
      'failed:clear': { stage: 'next', skill: 'DRYDOCK' },
      'success:other': { stage: 'next' },
    });
    expect((await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW })).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual({ 'success:*': mine, 'success:other': { stage: 'next' } });
  });

  it('asks on a TTY: a decline writes nothing, a yes migrates', async () => {
    const dir = tempDir();
    const raw = writeRoutes(dir, OLD_TEMPLATE);
    const questions: string[] = [];
    const declined = await migrateFactoryRoutes({ cwd: dir, isTTY: true, confirm: async (q) => { questions.push(q); return false; }, now: NOW });
    expect(declined.exitCode).toBe(1);
    expect(questions).toHaveLength(1);
    expect(readFileSync(routesPath(dir), 'utf8')).toBe(raw);
    expect(backups(dir)).toEqual([]);
    const accepted = await migrateFactoryRoutes({ cwd: dir, isTTY: true, confirm: async () => true, now: NOW });
    expect(accepted.exitCode).toBe(0);
    expect(backups(dir)).toHaveLength(1);
  });

  it('never overwrites an existing backup', async () => {
    const dir = tempDir();
    writeRoutes(dir, OLD_TEMPLATE);
    writeFileSync(join(dir, '.omg', BAK), 'older backup', 'utf8');
    const result = await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(dir, '.omg', BAK), 'utf8')).toBe('older backup');
    expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(OLD_TEMPLATE);
  });

  it('writes nothing when the table is already narrow, missing, or malformed', async () => {
    const dir = tempDir();
    expect((await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW })).exitCode).toBe(0);
    expect(existsSync(routesPath(dir))).toBe(false);
    const narrow = writeRoutes(dir, { 'success:intake': { stage: 'harbor', skill: 'harbor' } });
    expect(await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW })).toMatchObject({ exitCode: 0, message: expect.stringContaining('nothing to migrate') });
    expect(readFileSync(routesPath(dir), 'utf8')).toBe(narrow);
    writeRoutes(dir, '{ not json');
    expect((await migrateFactoryRoutes({ cwd: dir, yes: true, isTTY: false, now: NOW })).exitCode).toBe(1);
    expect(backups(dir)).toEqual([]);
  });
});

describe('omg factory chain status (Q7 rename)', () => {
  it('registers chain status and keeps factory status as an alias', () => {
    const cmd = factoryCommand();
    const chain = cmd.commands.find((c) => c.name() === 'chain');
    expect(chain?.commands.map((c) => c.name())).toContain('status');
    const legacy = cmd.commands.find((c) => c.name() === 'status');
    expect(legacy?.description()).toMatch(/alias of omg factory chain status/i);
  });

  it('init exposes --check, --migrate and --yes', () => {
    const init = factoryCommand().commands.find((c) => c.name() === 'init');
    expect(init?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--check', '--migrate', '--yes']));
  });
});
